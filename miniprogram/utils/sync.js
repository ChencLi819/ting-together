'use strict';

/**
 * 客户端同步引擎（v2：显示跟随音频 + 仅在权威时间线变更时对齐）
 * 音频后端：BackgroundAudioManager（支持锁屏/后台播放）
 *
 * 显示：播放中直接采用 audio.currentTime（音频一秒一秒走，所见即所听）；
 *       暂停/加载中：跟随服务器快照位置。
 * 同步：暂停/恢复/用户 seek 等权威锚点变化时立即对齐；稳定播放中不硬 seek，
 *       避免把网络快照或流媒体 currentTime 抖动放大成可听见的跳变。
 * v2 协议适配：状态机由快照驱动（loading → ready → playing/paused）；
 *              onEnded 带假结束过滤（缓冲停顿的误报不上报）。
 */
/** 服务器时间线的当前进度（快照位置 + 本地外推；锚点固定，无逐轮抖动） */
function targetPosition(pb, nowMs) {
  if (!pb) return 0;
  if (pb.status === 'playing') {
    const pos = (pb.positionSec || 0) + Math.max(0, (nowMs - (pb.receivedAt || nowMs)) / 1000);
    return pb.durationSec > 0 ? Math.min(pos, pb.durationSec) : Math.max(0, pos);
  }
  return pb.positionSec || 0;
}

function createSyncEngine({ sendCtl } = {}) {
  const audio = wx.getBackgroundAudioManager();
  let state = null;          // 最近一次房间快照
  let loadedKey = '';        // 已装载的音频 key（source:trackId:url）
  let readySentKey = '';     // 已上报 ready 的曲目 key
  let stopped = true;
  let lastTimeUpdateAt = 0; // 最近一次 onTimeUpdate 的本地时刻（播放态判定依据）
  let lastAudioTimeSec = NaN;

  function trackKey(pb) {
    if (!pb || !pb.trackId) return '';
    return `${pb.source}:${pb.trackId}:${pb.url}`;
  }

  function setAudioMeta(pb) {
    audio.title = pb.title || '一起听';
    audio.epname = pb.album || '一起听';
    audio.singer = pb.artist || '';
    if (pb.picUrl) {
      audio.coverImgUrl = pb.picUrl;
    }
  }

  function loadTrack(pb) {
    loadedKey = trackKey(pb);
    readySentKey = '';
    setAudioMeta(pb);
    lastAudioTimeSec = NaN;
    lastTimeUpdateAt = 0;
    audio.src = pb.url; // BG 后端：设置 src 即自动播放
  }

  function stopLoadedAudio() {
    if (!loadedKey && stopped) return;
    try {
      audio.stop();
    } catch (e) {
      // 忽略，状态仍重置；后续有 URL 时会重新装载
    }
    stopped = true;
    loadedKey = '';
    readySentKey = '';
    lastAudioTimeSec = NaN;
    lastTimeUpdateAt = 0;
  }

  function sameMedia(a, b) {
    return Boolean(a && b && trackKey(a) === trackKey(b));
  }

  function isLegacy(pb) {
    return Boolean(pb && pb.protocolVersion === 1);
  }

  function timelineChanged(previous, current) {
    if (!sameMedia(previous, current)) return false;
    if (isLegacy(previous) || isLegacy(current)) {
      return previous.status !== current.status || Number(previous.anchorMs) !== Number(current.anchorMs);
    }
    const previousStart = Number(previous.startAtSec) || 0;
    const currentStart = Number(current.startAtSec) || 0;
    return previous.status !== current.status || Math.abs(previousStart - currentStart) > 0.05;
  }

  /** 应用服务端快照（WS / 轮询通道都汇到这里） */
  function applyState(snapshot) {
    const now = Date.now();
    const previousPb = state && state.playback;
    state = snapshot;
    const pb = snapshot.playback;
    if (pb) pb.receivedAt = now; // 快照到达时刻：外推基准

    if (!pb || !pb.trackId) {
      // 没有曲目：停掉本地音频
      stopLoadedAudio();
      return;
    }
    if (!pb.url) {
      // 地址未解析完成（切歌/切音质）：旧流不能继续在后台播放
      stopLoadedAudio();
      return;
    }

    const key = trackKey(pb);
    if (key !== loadedKey) {
      // 新曲目（点歌/切歌/插播/中途进房）：装载并从对齐点起步
      stopped = false;
      loadTrack(pb);
      // 设置 BackgroundAudioManager.src 会自动播放；loading/paused 必须压住，
      // 等 canplay 完成 seek 并由服务端进入 playing 后再启动。
      if (pb.status !== 'playing' && !audio.paused) audio.pause();
      else if (pb.status === 'playing' && audio.paused) audio.play();
      return;
    }

    // 同曲：按服务端播放态校正
    if (pb.status === 'paused') {
      if (!audio.paused) audio.pause();
      if (timelineChanged(previousPb, pb)) {
        trySeek(Number.isFinite(pb.positionSec) ? pb.positionSec : pb.startAtSec);
      }
      return;
    }
    if (pb.status === 'playing') {
      // 只有暂停/恢复/seek 改变时间线锚点时才立即对齐；普通轮询快照
      // positionSec 会自然增长，不能据此反复 seek。
      if (timelineChanged(previousPb, pb)) {
        const pos = targetPosition(pb, now);
        const cur = Number(audio.currentTime);
        if (!Number.isFinite(cur) || Math.abs(cur - pos) > 0.25) trySeek(pos);
      }
      // 防御：状态已 playing 但 ready 上报被丢（通道未就绪期）→ 补报
      if (!isLegacy(pb) && readySentKey !== trackKey(pb) && sendCtl) {
        readySentKey = trackKey(pb);
        sendCtl('ready', { trackId: pb.trackId });
      }
      if (audio.paused) audio.play();
    }
  }

  function trySeek(pos) {
    if (!Number.isFinite(pos) || pos < 0) return;
    try {
      audio.seek(pos);
      // 显式 seek 后重置观测基准，避免把命令本身误报为音频时钟跳变。
      lastAudioTimeSec = NaN;
      lastTimeUpdateAt = 0;
    } catch (e) {
      // 忽略，等待下一轮校正
    }
  }

  function onTimeUpdate() {
    const nowMs = Date.now();
    const pb = state && state.playback;
    if (!pb || !pb.url) return;
    if (pb.status !== 'playing') return;
    const cur = Number(audio.currentTime);
    if (!Number.isFinite(cur)) return;
    if (lastTimeUpdateAt > 0 && Number.isFinite(lastAudioTimeSec)) {
      const wallDelta = Math.max(0, (nowMs - lastTimeUpdateAt) / 1000);
      const audioDelta = cur - lastAudioTimeSec;
      if (Math.abs(audioDelta - wallDelta) > 1) {
        console.warn('[jump-audio] 音频时钟异常: ' + lastAudioTimeSec.toFixed(2) + '→' + cur.toFixed(2)
          + ' audioΔ=' + audioDelta.toFixed(2) + ' wallΔ=' + wallDelta.toFixed(2) + ' paused=' + audio.paused);
      }
    }
    lastAudioTimeSec = cur;
    lastTimeUpdateAt = nowMs;
  }

  function onEnded() {
    const pb = state && state.playback;
    const dur = pb && pb.durationSec > 0 ? pb.durationSec : 0;
    const cur = Number(audio.currentTime);
    // 假结束过滤：缓冲停顿可能触发假 onEnded（进度远未到曲尾）→ 忽略，等待音频恢复
    if (dur > 0 && Number.isFinite(cur) && cur < dur - 2) {
      return;
    }
    if (pb && pb.trackId && sendCtl) {
      // 上报播完（服务端走结束栅栏：收齐全员 end 或 3s 兜底后切下一首）
      sendCtl('end', { trackId: pb.trackId });
    }
  }

  function onAudioError() {
    // 携带曲目 ID：双端同时报错或旧流迟到报错时，服务端只跳过对应曲目。
    const pb = state && state.playback;
    if (pb && pb.trackId && sendCtl) {
      sendCtl('skip', { trackId: pb.trackId });
    }
  }

  // ---- 用户主动操作 ----
  function userTogglePlay() {
    const pb = state && state.playback;
    if (!pb || !pb.url) return;
    // 用户意图必须和按钮展示使用同一个权威状态。开发者工具的音频实现
    // 在缓冲或不支持当前流时可能长期报告 paused=true，不能据此反向决定动作。
    if (pb.status === 'paused') {
      const pos = Number(audio.currentTime) || targetPosition(pb, Date.now());
      audio.play();
      if (sendCtl) sendCtl(isLegacy(pb) ? 'play' : 'resume', { positionSec: Math.round(pos * 10) / 10 });
    } else if (pb.status === 'playing') {
      const pos = Number(audio.currentTime) || targetPosition(pb, Date.now());
      if (!audio.paused) audio.pause();
      if (sendCtl) sendCtl('pause', { positionSec: Math.round(pos * 10) / 10 });
    }
  }

  function userSeek(pos) {
    const pb = state && state.playback;
    if (!pb || !pb.url) return;
    trySeek(pos);
    if (sendCtl) sendCtl('seek', { positionSec: Math.round(pos * 10) / 10 });
  }

  function userPrev() {
    if (sendCtl) sendCtl('prev');
  }

  function userNext() {
    if (sendCtl) sendCtl('skip');
  }

  function stop() {
    stopped = true;
    loadedKey = '';
    readySentKey = '';
    state = null;
    try {
      audio.stop();
    } catch (e) {
      // 忽略
    }
  }

  /** 装载完成后，在 canplay 时 seek 到起始点并上报 ready（首个 ready 启动时间线） */
  audio.onCanplay(() => {
    const pb = state && state.playback;
    if (!pb || !pb.url) return;
    const startPos = pb.status === 'playing' ? (pb.positionSec || 0) : (pb.startAtSec || 0);
    if (readySentKey !== trackKey(pb)) {
      readySentKey = trackKey(pb);
      // 新曲 canplay 可能紧跟上一曲 seek，不能被全局冷却时间拦掉。
      trySeek(startPos);
      if (!isLegacy(pb) && sendCtl) sendCtl('ready', { trackId: pb.trackId });
    }
  });

  audio.onTimeUpdate(onTimeUpdate);
  audio.onEnded(onEnded);
  audio.onError(onAudioError);
  if (audio.onPrev) audio.onPrev(() => userPrev());
  if (audio.onNext) audio.onNext(() => userNext());

  return {
    applyState,
    targetPosition,
    userTogglePlay,
    userSeek,
    userPrev,
    userNext,
    stop,
    /** 供 UI 读取当前应显示的进度（秒）：播放中直接跟随音频，所见即所听 */
    displayPosition() {
      const pb = state && state.playback;
      if (!pb) return 0;
      const cur = Number(audio.currentTime);
      if (pb.status === 'playing' && !audio.paused && Number.isFinite(cur) && cur > 0) {
        return cur;
      }
      return targetPosition(pb, Date.now());
    },
    /** 供 UI 判断音频是否已装载（未装载 = 加载中） */
    isLoaded() {
      const pb = state && state.playback;
      if (!pb) return false;
      return Boolean(pb.url) && trackKey(pb) === loadedKey;
    },
    get lastTimeUpdateAt() {
      return lastTimeUpdateAt;
    },
    get audio() {
      return audio;
    },
  };
}

module.exports = { createSyncEngine };
