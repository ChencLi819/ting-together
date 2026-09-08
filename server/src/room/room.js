'use strict';

/**
 * 房间状态机（纯逻辑，不触碰 IO，时间可注入便于测试）。
 *
 * 播放模型（v2：起播握手 + 结束栅栏，播放中服务端不干预）：
 *   1) 点歌/切歌 → 新曲目进入 loading（服务端解析地址）→ 广播
 *   2) 客户端完整加载/seek 到起始点 → 上报 ready
 *      → 首个 ready 即启动时间线（startedAtMs），广播 playing
 *      （其余后就绪的客户端按 positionSec 追齐后播放，无追跳）
 *   3) 播放中：客户端完全本地走表（各自音频即真相），服务端不管
 *   4) 暂停/seek：发起端上报自己的位置 → 服务端广播（另一端对齐该位置）
 *   5) 结束：客户端上报 end → 收齐全员 end（或首个 end 后 3s 兜底）→ 切下一首
 *   双端偏差只存在于单首歌内，歌与歌交界处天然清零。
 *
 * 事件（供 Hub/REST 转发广播）：
 *   'broadcast'      → 房间状态变化（WS 广播；轮询模式下次快照自然可见）
 *   'needs-resolve'  → 当前曲目缺少播放地址，需要异步解析
 */
const { EventEmitter } = require('node:events');

const ERR = {
  ROOM_FULL: 'ROOM_FULL',
  BAD_PARAMS: 'BAD_PARAMS',
  PERMISSION: 'PERMISSION',
  NOT_FOUND: 'NOT_FOUND',
};

const CTL_ACTIONS = ['ready', 'end', 'pause', 'resume', 'seek', 'skip', 'prev'];
const QUALITY_LEVELS = ['standard', 'high', 'lossless'];
const END_BARRIER_MS = 3000; // 首个 end 后等待其余端上报的兜底时长
const POLLING_PRESENCE_TTL_MS = 15000; // HTTP 轮询每 1.5s 刷新，短时断网不立即踢下线

class Room extends EventEmitter {
  constructor({ id, code, hostUserId, now = Date.now, limits = {}, hostOnlyControl = false }) {
    super();
    this.id = id;
    this.code = code;
    this.now = now;
    this.maxUsers = limits.maxUsers ?? 8;
    this.chatHistoryLimit = limits.chatHistoryLimit ?? 50;
    this.queueLimit = limits.queueLimit ?? 200;
    this.maxHistory = 50;

    this.createdAt = now();
    this.hostUserId = hostUserId;
    this.mode = hostOnlyControl ? 'host' : 'free';
    this.quality = 'high'; // standard(128k) | high(320k) | lossless(FLAC·需VIP)
    this.lastActivityAt = this.createdAt;
    this.resolveHandler = null;

    /** @type {Map<string, {id:string, name:string, token:string, online:boolean, joinedAt:number}>} */
    this.members = new Map();

    /** 播放态（v2 握手模型） */
    this.playback = null;
    this.playbackTimer = null; // 结束栅栏兜底定时器

    this.currentSeq = 0;
    /** @type {Array<{qid:string, track:object, requestedBy:string, requestedByName:string, addedAt:number}>} */
    this.queue = [];
    /** @type {Array<{track:object, playedAt:number}>} */
    this.history = [];
    /** @type {Array<{id:string, kind:'user'|'sys', userId?, name?, text, ts}>} */
    this.chatLog = [];
    this.resolving = false;
  }

  // ---------------------------------------------------------------- 基础

  touch() {
    this.lastActivityAt = this.now();
  }

  bumpSeq() {
    this.currentSeq += 1;
    return this.currentSeq;
  }

  #emitBroadcast() {
    this.emit('broadcast');
  }

  #maybeEmitResolve() {
    if (this.needsUrlResolve()) this.emit('needs-resolve');
  }

  // ---------------------------------------------------------------- 用户

  addMember({ userId, name, token }) {
    if (this.members.has(userId)) {
      const member = this.members.get(userId);
      member.token = token;
      return { ok: true, member };
    }
    if (this.members.size >= this.maxUsers) {
      return { ok: false, code: ERR.ROOM_FULL, message: `房间人数已满（上限 ${this.maxUsers} 人）` };
    }
    const member = { id: userId, name, token, online: false, joinedAt: this.now() };
    this.members.set(userId, member);
    this.touch();
    return { ok: true, member };
  }

  /** 成员活跃标记（任意认证动作刷新；用于结束栅栏计数） */
  touchMember(userId) {
    const member = this.members.get(userId);
    if (member) member.lastSeenAt = this.now();
  }

  /** HTTP 轮询通道没有 close 事件，用短租约维护可见在线态。 */
  touchPollingMember(userId) {
    const member = this.members.get(userId);
    if (!member) return;
    const nowMs = this.now();
    member.lastSeenAt = nowMs;
    member.pollSeenAt = nowMs;
  }

  presentMembers() {
    const cutoff = this.now() - POLLING_PRESENCE_TTL_MS;
    return [...this.members.values()].filter((m) => m.online || (m.pollSeenAt ?? -Infinity) >= cutoff);
  }

  /** 活跃成员数（60s 内有动作） */
  activeMemberCount() {
    const cutoff = this.now() - 60000;
    let n = 0;
    for (const m of this.members.values()) {
      if (m.online || (m.lastSeenAt ?? m.joinedAt) >= cutoff) n += 1;
    }
    return Math.max(1, n); // 至少按 1 人计，避免栅栏永不满足
  }

  verifyToken({ userId, token }) {
    const member = this.members.get(userId);
    if (!member || member.token !== token) return null;
    return member;
  }

  setOnline(userId, online) {
    const member = this.members.get(userId);
    if (!member || member.online === online) return false;
    member.online = online;
    this.touch();
    this.bumpSeq();
    if (!online) this.maybeMigrateHost();
    return true;
  }

  onlineMembers() {
    return [...this.members.values()].filter((m) => m.online);
  }

  maybeMigrateHost() {
    const host = this.hostUserId ? this.members.get(this.hostUserId) : undefined;
    const present = this.presentMembers();
    if (host && present.some((m) => m.id === host.id)) return false;
    const candidates = present.sort((a, b) => a.joinedAt - b.joinedAt);
    if (candidates.length === 0) return false;
    this.hostUserId = candidates[0].id;
    this.addSysMsg(`房主已移交 给 ${candidates[0].name}`);
    this.bumpSeq();
    return true;
  }

  isHost(userId) {
    return this.hostUserId === userId;
  }

  #requireControl(userId) {
    if (this.mode === 'host' && !this.isHost(userId)) {
      return { ok: false, code: ERR.PERMISSION, message: '当前为点播模式，仅房主可控制播放' };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ 播放模型 v2

  /** 新回合：曲目进入 loading（等地址解析 + 客户端加载上报 ready） */
  #newPlayback(track, startAtSec = 0) {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.playback = {
      track,
      status: 'loading',
      startAtSec,
      startedAtMs: null,
      readySet: new Set(),
      endSet: new Set(),
      url: '',
      urlTrial: false,
      urlQuality: '',
      pausedBy: '',
    };
    this.bumpSeq();
    this.#maybeEmitResolve();
    this.#emitBroadcast();
  }

  /** 供迟到者/暂停态计算当前应处的位置 */
  currentPositionSec() {
    const pb = this.playback;
    if (!pb) return 0;
    if (pb.status === 'playing' && pb.startedAtMs) {
      const pos = pb.startAtSec + Math.max(0, (this.now() - pb.startedAtMs) / 1000);
      return pb.track.durationSec > 0 ? Math.min(pos, pb.track.durationSec) : pos;
    }
    return pb.startAtSec;
  }

  #trackOf(pb) {
    // v2 播放态中曲目即 pb.track（嵌套结构），其余字段为播放控制态
    return pb.track;
  }

  /** 广播用播放视图 */
  playbackView() {
    const pb = this.playback;
    if (!pb) return null;
    return {
      ...pb.track,
      status: pb.status,
      startAtSec: pb.startAtSec,
      positionSec: Number(this.currentPositionSec().toFixed(2)),
      url: pb.url || '',
      urlTrial: Boolean(pb.urlTrial),
      urlQuality: pb.urlQuality || '',
    };
  }

  /**
   * 客户端上报就绪（完整加载并 seek 到位）。
   * 首个 ready 启动时间线（startedAtMs）；后续 ready 者按 positionSec 追齐（在自身缓冲期内 seek，无追跳）。
   */
  clientReady(userId, trackId) {
    this.touch();
    this.touchMember(userId);
    const pb = this.playback;
    if (!pb || pb.track.trackId !== trackId) return { ok: true, changed: false };
    if (pb.status !== 'loading') return { ok: true, changed: false };
    pb.readySet.add(userId);

    if (!pb.startedAtMs) {
      // 首个就绪者定义时间线起点
      pb.status = 'playing';
      pb.startedAtMs = this.now();
      this.bumpSeq();
      this.#emitBroadcast();
    }
    return { ok: true, changed: false };
  }

  /**
   * 客户端上报播完（结束栅栏）：
   * 收齐全员 end → 立即切歌；否则首个 end 后 3s 兜底切歌（防个别端无响应卡死）。
   */
  clientEnd(userId, trackId) {
    this.touch();
    this.touchMember(userId);
    const pb = this.playback;
    if (!pb || pb.track.trackId !== trackId) return { ok: true, changed: false };
    if (pb.status === 'loading') return { ok: true, changed: false }; // 尚未开始就 end：忽略
    pb.endSet.add(userId);

    const need = Math.max(1, this.activeMemberCount());
    if (pb.endSet.size >= need) {
      this.#advance('自然播完');
      return { ok: true, changed: true };
    }
    if (!this.playbackTimer) {
      this.playbackTimer = setTimeout(() => {
        this.playbackTimer = null;
        if (this.playback && this.playback.track.trackId === trackId) {
          this.#advance('自然播完');
          this.#emitBroadcast();
        }
      }, END_BARRIER_MS);
    }
    return { ok: true, changed: false };
  }

  /** 播放器暂停（发起端上报自己的位置，广播全员对齐） */
  clientPause(userId, positionSec) {
    this.touch();
    this.touchMember(userId);
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    const pb = this.playback;
    if (!pb || pb.status !== 'playing') return { ok: true, changed: false };
    const user = this.members.get(userId);
    pb.status = 'paused';
    pb.startAtSec = Number.isFinite(positionSec) && positionSec >= 0 ? positionSec : this.currentPositionSec();
    pb.startedAtMs = null;
    pb.pausedBy = user ? user.name : userId;
    this.bumpSeq();
    this.addSysMsg(`${pb.pausedBy} 暂停了播放`);
    this.#emitBroadcast();
    return { ok: true, changed: true };
  }

  /** 播放器恢复（从上报位置继续，全员对齐该位置） */
  clientResume(userId, positionSec) {
    this.touch();
    this.touchMember(userId);
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    const pb = this.playback;
    if (!pb || pb.status !== 'paused') return { ok: true, changed: false };
    const user = this.members.get(userId);
    const pos = Number.isFinite(positionSec) && positionSec >= 0 ? positionSec : pb.startAtSec;
    pb.status = 'playing';
    pb.startAtSec = pos;
    pb.startedAtMs = this.now();
    pb.pausedBy = '';
    this.bumpSeq();
    this.addSysMsg(`${user ? user.name : userId} 恢复了播放`);
    this.#emitBroadcast();
    return { ok: true, changed: true };
  }

  /** 播放器 seek（发起端位置即新时间线位置，广播全员对齐） */
  clientSeek(userId, positionSec) {
    this.touch();
    this.touchMember(userId);
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    const pb = this.playback;
    if (!pb) return { ok: false, code: ERR.NOT_FOUND, message: '当前没有播放曲目' };
    if (!Number.isFinite(positionSec) || positionSec < 0) {
      return { ok: false, code: ERR.BAD_PARAMS, message: 'positionSec 非法' };
    }
    const user = this.members.get(userId);
    pb.startAtSec = pb.track.durationSec > 0 ? Math.min(positionSec, pb.track.durationSec) : positionSec;
    if (pb.status === 'playing') pb.startedAtMs = this.now();
    this.bumpSeq();
    const mm = Math.floor(pb.startAtSec / 60);
    const ss = String(Math.floor(pb.startAtSec % 60)).padStart(2, '0');
    this.addSysMsg(`${user ? user.name : userId} 跳转到了 ${mm}:${ss}`);
    this.#emitBroadcast();
    return { ok: true, changed: true };
  }

  /** 切下一首（跳过当前，原曲入历史） */
  skipCurrent(userId, expectedTrackId) {
    this.touch();
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    if (!this.playback) return { ok: true, changed: false };
    // 音频错误会带上其所属曲目。两个客户端同时报错或旧播放器事件迟到时，
    // 后到的请求不能把已经切换出的下一首也跳过。
    if (expectedTrackId && this.playback.track.trackId !== expectedTrackId) {
      return { ok: true, changed: false };
    }
    const user = this.members.get(userId);
    const okNext = this.#advance(`被 ${user ? user.name : userId} 跳过`);
    if (!okNext) return { ok: true, changed: true };
    this.#emitBroadcast();
    return { ok: true, changed: true };
  }

  /** 上一首：当前回到队首，历史回退 */
  playPrevious(userId) {
    this.touch();
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    if (this.playback) {
      this.queue.unshift({
        qid: `q${this.currentSeq}_${Math.floor(this.now())}`,
        track: this.#trackOf(this.playback),
        requestedBy: '',
        requestedByName: '',
        addedAt: this.now(),
      });
    }
    const prev = this.history.pop();
    if (!prev) {
      if (this.playback) this.#newPlayback(this.#trackOf(this.playback), 0);
      this.#emitBroadcast();
      return { ok: true, changed: true };
    }
    this.#newPlayback(prev.track, 0);
    this.addSysMsg(`回到上一首：${prev.track.title}`);
    this.#emitBroadcast();
    return { ok: true, changed: true };
  }

  /** 结束栅栏到点/条件满足：推进下一首 */
  #advance(reason) {
    const pb = this.playback;
    if (!pb) return false;
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.history.push({ track: this.#trackOf(pb), playedAt: this.now() });
    if (this.history.length > this.maxHistory) this.history.shift();

    const next = this.queue.shift();
    if (!next) {
      this.playback = null;
      this.bumpSeq();
      this.addSysMsg(`《${pb.track.title}》${reason}，队列已空，播放结束`);
      this.#emitBroadcast();
      return false;
    }
    this.addSysMsg(`《${pb.track.title}》${reason}，接下来播放 ${next.track.title}（${next.requestedByName || '系统'} 点歌）`);
    this.#newPlayback(next.track, 0);
    return true;
  }

  // ------------------------------------------------------------ 点歌队列

  enqueue(userId, rawTrack) {
    this.touch();
    const user = this.members.get(userId);
    if (!user) return { ok: false, code: ERR.NOT_FOUND, message: '请先加入房间' };
    const track = {
      source: String(rawTrack.source),
      trackId: String(rawTrack.trackId),
      title: String(rawTrack.title).slice(0, 100),
      artist: String(rawTrack.artist ?? '').slice(0, 100),
      album: String(rawTrack.album ?? '').slice(0, 100),
      picUrl: String(rawTrack.picUrl ?? ''),
      durationSec: Number.isFinite(Number(rawTrack.durationSec)) ? Math.max(0, Math.round(Number(rawTrack.durationSec))) : 0,
    };
    if (rawTrack.raw) track.raw = rawTrack.raw;

    const entry = {
      qid: `q${this.currentSeq}_${Math.floor(this.now())}_${Math.floor(Math.random() * 1e6)}`,
      track,
      requestedBy: userId,
      requestedByName: user.name,
      addedAt: this.now(),
    };

    if (!this.playback) {
      this.#newPlayback(track, 0);
      this.addSysMsg(`${user.name} 点歌《${track.title}》，开始加载`);
      return { ok: true, nowPlaying: true };
    }
    if (this.queue.length >= this.queueLimit) {
      return { ok: false, code: ERR.BAD_PARAMS, message: `点歌队列已满（上限 ${this.queueLimit} 首）` };
    }
    this.queue.push(entry);
    this.bumpSeq();
    this.#emitBroadcast();
    return { ok: true, qid: entry.qid, nowPlaying: false };
  }

  dequeue(userId, qid) {
    this.touch();
    const idx = this.queue.findIndex((e) => e.qid === qid);
    if (idx === -1) return { ok: false, code: ERR.NOT_FOUND, message: '点歌不存在或已被移除' };
    const entry = this.queue[idx];
    if (entry.requestedBy !== userId && !this.isHost(userId)) {
      return { ok: false, code: ERR.PERMISSION, message: '只能移除自己点的歌（房主可移除任意）' };
    }
    this.queue.splice(idx, 1);
    this.bumpSeq();
    this.#emitBroadcast();
    return { ok: true };
  }

  /** 队列插播：点击队列歌曲立即播放（当前曲入历史） */
  playQueued(userId, qid) {
    this.touch();
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    const idx = this.queue.findIndex((e) => e.qid === qid);
    if (idx === -1) return { ok: false, code: ERR.NOT_FOUND, message: '点歌不存在或已被移除' };
    const entry = this.queue.splice(idx, 1)[0];
    if (this.playback) {
      this.history.push({ track: this.#trackOf(this.playback), playedAt: this.now() });
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    const user = this.members.get(userId);
    this.addSysMsg(`${user ? user.name : userId} 把《${entry.track.title}》提前到立即播放`);
    this.#newPlayback(entry.track, 0);
    this.#emitBroadcast();
    return { ok: true };
  }

  // ------------------------------------------------------------ 播放地址

  needsUrlResolve() {
    return Boolean(this.playback && !this.playback.url && !this.resolving);
  }

  startResolve() {
    if (!this.playback || this.playback.url || this.resolving) return false;
    this.resolving = true;
    return true;
  }

  finishResolve(trackId, result, requestedQuality = this.quality, requestedSource = this.playback?.track.source) {
    this.resolving = false;
    const matchesCurrentRequest = Boolean(
      this.playback
      && this.playback.track.trackId === trackId
      && this.playback.track.source === requestedSource
      && this.quality === requestedQuality
    );
    if (!matchesCurrentRequest) {
      // 切歌或切音质发生在异步取流期间：丢弃旧结果，并立即唤起当前请求。
      this.#maybeEmitResolve();
      return false;
    }
    if (result && result.url) {
      this.playback.url = result.url;
      this.playback.urlTrial = Boolean(result.trial);
      this.playback.urlQuality = this.quality;
      this.bumpSeq();
      this.#emitBroadcast();
      return true;
    }
    this.addSysMsg(`《${this.playback.track.title}》暂时无法播放（版权或网络原因），已自动切歌`);
    this.#advance('无法播放');
    this.#emitBroadcast();
    return true;
  }

  // ------------------------------------------------------------ 音质

  setQuality(userId, level) {
    this.touch();
    const perm = this.#requireControl(userId);
    if (!perm.ok) return perm;
    if (!QUALITY_LEVELS.includes(level)) {
      return { ok: false, code: ERR.BAD_PARAMS, message: 'quality 必须是 standard|high|lossless' };
    }
    if (this.quality === level) return { ok: true, changed: false };
    this.quality = level;
    this.bumpSeq();
    if (this.playback) {
      this.playback.url = '';
      this.playback.urlTrial = false;
      this.playback.urlQuality = '';
    }
    const text = level === 'lossless' ? '已切换为无损音质（需 VIP）' : level === 'high' ? '已切换为高品音质 320k' : '已切换为标准音质 128k';
    this.addSysMsg(text);
    this.#emitBroadcast();
    this.#maybeEmitResolve();
    return { ok: true, changed: true };
  }

  // ------------------------------------------------------------ 聊天

  addChat(userId, text) {
    this.touch();
    const user = this.members.get(userId);
    if (!user) return { ok: false, code: ERR.NOT_FOUND, message: '请先加入房间' };
    const msg = {
      id: `c${this.currentSeq}_${Math.floor(this.now())}_${Math.floor(Math.random() * 1e6)}`,
      kind: 'user',
      userId,
      name: user.name,
      text: String(text).slice(0, 300),
      ts: this.now(),
    };
    this.chatLog.push(msg);
    if (this.chatLog.length > this.chatHistoryLimit) this.chatLog.splice(0, this.chatLog.length - this.chatHistoryLimit);
    return { ok: true, msg };
  }

  addSysMsg(text) {
    const msg = {
      id: `s${this.currentSeq}_${Math.floor(this.now())}_${Math.floor(Math.random() * 1e6)}`,
      kind: 'sys',
      text: String(text).slice(0, 300),
      ts: this.now(),
    };
    this.chatLog.push(msg);
    if (this.chatLog.length > this.chatHistoryLimit) this.chatLog.splice(0, this.chatLog.length - this.chatHistoryLimit);
    return msg;
  }

  recentChat(limit = 20) {
    return this.chatLog.slice(-limit);
  }

  // ------------------------------------------------------------ 快照

  snapshot(nowMs = this.now(), { withChat = true } = {}) {
    const view = {
      roomId: this.id,
      code: this.code,
      hostUserId: this.hostUserId,
      hostName: this.members.get(this.hostUserId)?.name ?? '',
      mode: this.mode,
      quality: this.quality,
      seq: this.currentSeq,
      playback: this.playbackView(),
      queue: this.queue.map((e) => ({ qid: e.qid, track: e.track, requestedBy: e.requestedBy, requestedByName: e.requestedByName, addedAt: e.addedAt })),
      users: this.presentMembers().map((m) => ({ id: m.id, name: m.name })),
      memberCount: this.members.size,
      serverNowMs: nowMs,
    };
    if (withChat) view.chat = this.recentChat();
    return view;
  }

  setMode(userId, mode) {
    if (!this.isHost(userId)) return { ok: false, code: ERR.PERMISSION, message: '仅房主可切换模式' };
    if (mode !== 'free' && mode !== 'host') return { ok: false, code: ERR.BAD_PARAMS, message: 'mode 必须是 free|host' };
    if (this.mode === mode) return { ok: true, changed: false };
    this.mode = mode;
    this.bumpSeq();
    this.addSysMsg(mode === 'host' ? '已切换为点播模式（仅房主控制播放）' : '已切换为自由模式（大家都能控制播放）');
    this.#emitBroadcast();
    return { ok: true, changed: true };
  }

  isIdle(nowMs = this.now()) {
    return this.presentMembers().length === 0 && nowMs - this.lastActivityAt > 10 * 60 * 1000;
  }
}

module.exports = { Room, ERR, CTL_ACTIONS, QUALITY_LEVELS, END_BARRIER_MS, POLLING_PRESENCE_TTL_MS };
