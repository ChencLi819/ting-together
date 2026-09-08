'use strict';

const store = require('../../utils/store');
const session = require('../../utils/session');
const runtime = require('../../utils/runtime');
const { api } = require('../../utils/request');
const { formatTime, formatClock } = require('../../utils/format');
const lyricUtil = require('../../utils/lyric');
const { normalizeRoomSnapshot, playbackViewState } = require('../../utils/playback');

const TICK_MS = 400;
const CHAT_LIMIT = 200;
const QUALITY_TEXT = { standard: '标准 128k', high: '高品 320k', lossless: '无损' };

Page({
  data: {
    code: '',
    myUserId: '',
    isHost: false,
    room: null,
    users: [],
    usersShow: [],
    qualityText: '高品 320k',
    track: null,
    playing: false,
    playbackLoading: false,
    playbackControlDisabled: true,
    coverOk: true,
    lyricMode: false,
    lyricLines: [],
    lyricIndex: -1,
    posText: '00:00',
    durationText: '00:00',
    sliderValue: 0,
    sliderMax: 0,
    dragging: false,
    queue: [],
    chat: [],
    tab: 'queue',
    chatText: '',
    connected: false,
    lastChatAnchor: '',
  },

  onLoad(options) {
    const membership = store.get().membership || session.loadMembership();
    if (!membership) {
      wx.reLaunch({ url: '/pages/index/index' });
      return;
    }
    const code = (options && options.code) || membership.code;
    const myUserId = membership.userId;
    this.membership = membership;
    this.roomState = null;
    this.loadedTrackKey = '';
    this._idxCache = -1;

    this.setData({ code, myUserId });

    // 同步引擎：本地动作通过 sendCtl 上报服务端
    this.engine = runtime.initEngine((action, extra) => this.sendCtl(action, extra));

    const hello = {
      type: 'hello',
      token: membership.token,
      userId: myUserId,
      name: membership.name,
      code: membership.code,
    };

    // WebSocket 会话（云调用通道不可用时自动切换 HTTP 轮询降级）
    const handlers = {
      onWelcome: (userId, name, snapshot) => {
        this.applySnapshot(snapshot);
      },
      onState: (snapshot) => {
        this.applySnapshot(snapshot);
      },
      onChat: (msg) => this.appendChat(msg),
      onSys: (msg) => this.appendChat(msg),
      onError: (code_, message) => this.onSocketError(code_, message),
      onOpen: () => {
        this.setData({ connected: true });
        this.socket.send({ type: 'sync-req' });
      },
      onDown: () => {
        this.setData({ connected: false });
      },
      onUnsupported: () => this.switchToPolling(handlers, hello),
    };
    this.socket = runtime.initSocket(handlers);
    this.socket.connect(hello);

    this.unsubscribeStore = store.subscribe(() => {
      // store 主要供搜索页读取房间信息；房间页自身以 this.roomState 为准
    });

    this.ticker = setInterval(() => this.tick(), TICK_MS);
  },

  /** WebSocket 不可用（如 connectContainer 空壳）：切换 HTTP 轮询降级通道 */
  switchToPolling(handlers, hello) {
    console.warn('[room] 切换 HTTP 轮询降级模式');
    this.socket = runtime.initPolling(handlers);
    this.socket.connect(hello);
  },

  onUnload() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.unsubscribeStore) this.unsubscribeStore();
    runtime.teardown();
    store.set({ room: null, chat: [], connected: false });
  },

  // ------------------------------------------------------------ 服务端状态

  applySnapshot(snapshot) {
    if (!snapshot) return;
    snapshot = normalizeRoomSnapshot(snapshot);
    this.roomState = snapshot;
    const myUserId = this.data.myUserId;
    const isHost = snapshot.hostUserId === myUserId;
    const pb = snapshot.playback;

    const track = pb
      ? {
          source: pb.source,
          trackId: pb.trackId,
          title: pb.title,
          artist: pb.artist,
          album: pb.album,
          picUrl: pb.picUrl,
          durationSec: pb.durationSec,
          status: pb.status,
          url: pb.url,
          urlTrial: pb.urlTrial,
        }
      : null;

    const queue = snapshot.queue.map((e) => ({
      qid: e.qid,
      requestedByName: e.requestedByName,
      removable: e.requestedBy === myUserId || isHost,
      track: {
        ...e.track,
        durationText: e.track.durationSec ? formatTime(e.track.durationSec) : '',
      },
    }));

    const trackKey = track ? `${track.source}:${track.trackId}` : '';
    const playbackUi = playbackViewState(track);
    const coverOk = trackKey === this.loadedTrackKey ? this.data.coverOk : true;
    this.loadedTrackKey = trackKey;

    // —— 轻量化：大对象仅在内容变化时更新（真机渲染减负，避免周期性 JS 卡顿）——
    const usersSig = (snapshot.users || []).map(function (u) { return u.id; }).join(',');
    // 房主迁移会改变同一队列项的 removable 权限，签名必须包含权限态。
    const queueSig = (isHost ? 'host:' : 'member:') + queue.map(function (q) { return q.qid + ':' + (q.removable ? '1' : '0'); }).join(',');
    const patch = {
      isHost: isHost,
      mode: snapshot.mode,
      qualityText: QUALITY_TEXT[snapshot.quality] || snapshot.quality || '高品',
      track: track,
      playing: playbackUi.playing,
      playbackLoading: playbackUi.loading,
      playbackControlDisabled: playbackUi.disabled,
      coverOk: coverOk,
      sliderMax: track && track.durationSec > 0 ? Math.floor(track.durationSec) : 0,
      durationText: track ? formatTime(track.durationSec) : '00:00'
    };
    if (usersSig !== this._usersSig) {
      this._usersSig = usersSig;
      patch.users = snapshot.users || [];
      patch.usersShow = (snapshot.users || []).slice(0, 3);
    }
    if (queueSig !== this._queueSig) {
      this._queueSig = queueSig;
      patch.queue = queue;
    }
    this.setData(patch);

    // 快照内携带的最近聊天（含系统消息）按 id 去重合并，保证切歌/音质/房主移交等系统消息可见
    if (snapshot.chat && snapshot.chat.length) {
      this.mergeChat(snapshot.chat);
    }

    if (track && trackKey !== this.lyricTrackKey) {
      this.loadLyric(track);
    }
    if (!track) {
      this.lyricTrackKey = '';
      this.setData({ lyricLines: [], lyricIndex: -1 });
    }

    store.set({ room: snapshot });
    this.engine.applyState(snapshot);
  },

  loadLyric(track) {
    this.lyricTrackKey = `${track.source}:${track.trackId}`;
    const key = this.lyricTrackKey;
    this.setData({ lyricLines: [], lyricIndex: -1 });
    api
      .fetchLyric(track)
      .then((res) => {
        if (key !== this.lyricTrackKey) return; // 已切歌
        this.lyricLines = lyricUtil.parseLrc(res.lyric || '');
        this.setData({ lyricLines: this.lyricLines });
      })
      .catch(() => {
        if (key === this.lyricTrackKey) this.setData({ lyricLines: [], lyricIndex: -1 });
      });
  },

  // ------------------------------------------------------------ 聊天

  toChatVM(msg) {
    return {
      id: msg.id,
      kind: msg.kind,
      name: msg.name || '',
      text: msg.text,
      self: msg.kind === 'user' && msg.userId === this.data.myUserId,
      tsText: formatClock(msg.ts || Date.now()),
    };
  },

  /** 按 id 去重合并消息（实时推送与快照兜底共用） */
  mergeChat(msgs) {
    const chat = this.data.chat.slice();
    const seen = new Set(chat.map((m) => m.id));
    let added = false;
    for (const msg of msgs) {
      if (!msg || !msg.id || seen.has(msg.id)) continue;
      seen.add(msg.id);
      chat.push(this.toChatVM(msg));
      added = true;
    }
    if (!added) return;
    while (chat.length > CHAT_LIMIT) chat.shift();
    store.set({ chat });
    this.setData({
      chat,
      lastChatAnchor: `chat-${chat.length - 1}`,
    });
  },

  appendChat(msg) {
    if (!msg || !msg.id) return;
    this.mergeChat([msg]);
  },

  onChatInput(e) {
    this.setData({ chatText: e.detail.value });
  },

  onSendChat() {
    const text = this.data.chatText.trim();
    if (!text) return;
    if (this.socket.send({ type: 'chat', text })) {
      this.setData({ chatText: '' });
    }
  },

  // ------------------------------------------------------------ 控制

  sendCtl(action, extra = {}) {
    const socket = runtime.getSocket();
    if (!socket) return false;
    return socket.send({ type: 'ctl', action, ...extra });
  },

  onTogglePlay() {
    if (!this.data.track || this.data.playbackControlDisabled) return;
    this.engine.userTogglePlay();
  },

  onPrev() {
    this.engine.userPrev();
  },

  onNext() {
    this.engine.userNext();
  },

  onSliderChanging(e) {
    this.setData({ dragging: true, sliderValue: e.detail.value });
  },

  onSliderChange(e) {
    this.setData({ dragging: false });
    if (!this.data.track || !this.data.track.url) return;
    this.engine.userSeek(Number(e.detail.value));
  },

  onSwitchMode() {
    wx.showActionSheet({
      itemList: ['自由模式：大家都能控制', '点播模式：仅房主控制'],
      success: (res) => {
        const mode = res.tapIndex === 0 ? 'free' : 'host';
        this.socket.send({ type: 'mode', mode });
      },
    });
  },

  /** 房间级音质：双端同源才能同步，切换由服务端重取流并广播 */
  onSwitchQuality() {
    wx.showActionSheet({
      itemList: ['标准 128k', '高品 320k', '无损 FLAC（需 VIP）'],
      success: (res) => {
        const level = ['standard', 'high', 'lossless'][res.tapIndex];
        if (level) this.socket.send({ type: 'quality', level });
      },
    });
  },

  // ------------------------------------------------------------ 队列

  /** 点击队列歌曲：立即插播（服务端把当前曲压入历史，可被“上一首”找回） */
  onPlayQueue(e) {
    const { qid } = e.detail;
    if (!qid) return;
    this.socket.send({ type: 'play-queue', qid });
  },

  onRemoveQueue(e) {
    const { qid } = e.detail;
    if (!qid) return;
    this.socket.send({ type: 'dequeue', qid });
  },

  onGoSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  // ------------------------------------------------------------ UI 杂项

  onTabQueue() {
    this.setData({ tab: 'queue' });
  },

  onTabChat() {
    this.setData({ tab: 'chat' });
  },

  onLeaveRoom() {
    wx.showModal({
      title: '退出房间',
      content: '退出后可凭邀请码随时再加入；房间在无人停留时自动清理',
      confirmText: '退出',
      success: (res) => {
        if (!res.confirm) return;
        wx.navigateBack({
          fail: () => wx.reLaunch({ url: '/pages/index/index' }),
        });
      },
    });
  },

  onToggleLyric() {
    if (!this.data.track) return;
    this.setData({ lyricMode: !this.data.lyricMode });
  },

  onCopyCode() {
    wx.setClipboardData({
      data: this.data.code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }),
    });
  },

  onCoverError() {
    this.setData({ coverOk: false });
  },

  onSocketError(code, message) {
    wx.showToast({ title: message || code, icon: 'none' });
    if (code === 'AUTH_FAILED' || code === 'ROOM_FULL') {
      session.saveMembership(null);
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 800);
    }
  },

  // ------------------------------------------------------------ 心跳刷新

  tick() {
    const track = this.data.track;
    if (!track) return;
    const patch = {};
    // 旋钮角度：播放时按 24s/圈 累计（角度值在 data 中，不受渲染重置影响）
    if (track.url && this.data.playing) {
      this._discAngle = ((this._discAngle || 0) + (TICK_MS / 1000) * 15) % 360;
      patch.discAngle = Math.round(this._discAngle);
    }
    if (track.url && !this.data.dragging) {
      const pos = this.engine.displayPosition();
      if (this._lastUiPos !== undefined && Math.abs(pos - this._lastUiPos) > 1.5) {
        console.warn('[jump-ui] 显示进度跳变: ' + this._lastUiPos.toFixed(2) + '→' + pos.toFixed(2) + ' (0.4s 内) paused=' + this.engine.audio.paused);
      }
      this._lastUiPos = pos;
      patch.sliderValue = Math.floor(pos);
      patch.posText = formatTime(pos);
    } else if (!track.url) {
      // 切音质重取流时 status 仍可能是 playing；track 上不存在旧版 isPlaying 字段。
      patch.posText = formatTime(track.status === 'playing' ? this.engine.displayPosition() : 0);
    }
    if (this.lyricLines && this.lyricLines.length && track.url) {
      const idx = lyricUtil.currentLineIndex(this.lyricLines, this.engine.displayPosition());
      if (idx !== this._idxCache) {
        this._idxCache = idx;
        patch.lyricIndex = idx;
      }
    }
    if (Object.keys(patch).length > 0) this.setData(patch);
  },
});
