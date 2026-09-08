'use strict';

const WebSocket = require('ws');

const P = require('./protocol');
const { RoomManager } = require('../room/manager');
const { RateLimiter } = require('../utils/rateLimiter');
const { config } = require('../config');
const { createLogger } = require('../logger');
const provider = require('../music/provider');

const log = createLogger('ws:hub');

/**
 * WebSocket 枢纽：
 *  - 连接 → hello 鉴权（5s 超时）→ 加入房间会话
 *  - 心跳：ping/pong 帧保活，两倍周期无响应断开
 *  - 限流：聊天/点歌按 userId 滑动窗口
 *  - 广播：状态变化按房间合并（80ms 窗口），聊天即时
 *  - 播放地址：当前曲目缺 url 时异步解析，成功填充并广播，失败自动切歌
 */
class Hub {
  constructor({ manager, wss, limits } = {}) {
    if (!(manager instanceof RoomManager)) throw new Error('Hub 需要 RoomManager 实例');
    this.manager = manager;
    this.wss = wss;
    this.limits = limits ?? {
      chat: { windowMs: config.rate.chat.windowMs, max: config.rate.chat.max },
      enqueue: { windowMs: config.rate.enqueue.windowMs, max: config.rate.enqueue.max },
    };
    this.chatLimiter = new RateLimiter(this.limits.chat);
    this.enqueueLimiter = new RateLimiter(this.limits.enqueue);
    /** @type {Map<WebSocket, {room:Room, userId:string, name:string}>} */
    this.sessions = new Map();
    /** @type {Map<string, Set<WebSocket>>} roomId -> sockets */
    this.roomSockets = new Map();
    /** @type {Map<string, number>} roomId -> coalesce timer */
    this.pendingBroadcast = new Map();
    /** @type {Set<()=>void>} 停止钩子 */
    this.stops = new Set();

    wss.on('connection', (ws, req) => this.#onConnection(ws, req));
  }

  // ---------------------------------------------------------------- 连接

  #onConnection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => log.warn('ws 连接错误', { error: err.message, url: req?.url }));

    // 5 秒内必须完成 hello
    const helloTimer = setTimeout(() => {
      if (!this.sessions.has(ws)) {
        P.sendSafe(ws, P.outError('HELLO_TIMEOUT', '请在 5 秒内完成加入房间的握手'));
        ws.close();
      }
    }, config.ws.helloTimeoutMs);
    ws.once('close', () => clearTimeout(helloTimer));

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (isBinary) {
        P.sendSafe(ws, P.outError('BAD_MESSAGE', '仅支持文本 JSON 消息'));
        return;
      }
      this.#onMessage(ws, data);
    });

    ws.on('close', () => this.#onClose(ws));
  }

  #onClose(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session) return;
    const { room, userId } = session;
    this.#dropSocket(room.id, ws);
    const sockets = this.roomSockets.get(room.id);
    const stillConnected = Boolean(sockets && [...sockets].some((other) => this.sessions.get(other)?.userId === userId));
    if (!stillConnected) {
      const member = room.members.get(userId);
      if (room.setOnline(userId, false)) {
        room.addSysMsg(`${member?.name ?? userId} 离开了房间`);
      }
      this.broadcastState(room);
    }
    log.info('用户断开', { roomId: room.id, userId });
  }

  #attachSocket(roomId, ws) {
    let set = this.roomSockets.get(roomId);
    if (!set) {
      set = new Set();
      this.roomSockets.set(roomId, set);
    }
    set.add(ws);
  }

  #dropSocket(roomId, ws) {
    const set = this.roomSockets.get(roomId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.roomSockets.delete(roomId);
  }

  // ---------------------------------------------------------------- 消息

  #onMessage(ws, data) {
    if (data.length > config.ws.maxMessageBytes) {
      P.sendSafe(ws, P.outError('BAD_MESSAGE', '消息过大'));
      return;
    }
    let raw;
    try {
      raw = JSON.parse(data.toString('utf8'));
    } catch {
      P.sendSafe(ws, P.outError('BAD_MESSAGE', '消息不是合法 JSON'));
      return;
    }
    const check = P.validateIncoming(raw);
    if (!check.ok) {
      P.sendSafe(ws, P.outError('BAD_MESSAGE', check.error));
      return;
    }
    const msg = check.value;

    // hello 之外的类型必须在会话建立之后
    const session = this.sessions.get(ws);
    if (msg.type === 'hello') {
      this.#handleHello(ws, msg);
      return;
    }
    if (!session) {
      P.sendSafe(ws, P.outError('NO_SESSION', '请先完成 hello 握手'));
      return;
    }
    // 心跳和任意已认证消息都证明该成员仍活跃，供结束栅栏计数使用。
    session.room.touchMember(session.userId);
    if (msg.type === 'ping') {
      P.sendSafe(ws, P.outPong());
      return;
    }
    if (msg.type === 'sync-req') {
      P.sendSafe(ws, P.outState(session.room.snapshot()));
      return;
    }
    if (msg.type === 'chat') {
      this.#handleChat(session, msg);
      return;
    }
    if (msg.type === 'ctl') {
      this.#handleControl(session, msg);
      return;
    }
    if (msg.type === 'enqueue') {
      this.#handleEnqueue(session, msg);
      return;
    }
    if (msg.type === 'dequeue') {
      this.#handleDequeue(session, msg);
      return;
    }
    if (msg.type === 'play-queue') {
      this.#handlePlayQueue(session, msg);
      return;
    }
    if (msg.type === 'mode') {
      this.#handleMode(session, msg);
      return;
    }
    if (msg.type === 'quality') {
      this.#handleQuality(session, msg);
      return;
    }
  }

  #handleHello(ws, msg) {
    if (this.sessions.has(ws)) {
      P.sendSafe(ws, P.outError('BAD_MESSAGE', '已握手，请勿重复 hello'));
      return;
    }
    // 找到房间：userId + token 校验。遍历在线房间匹配成员（规模小，直接查）
    let room = null;
    let member = null;
    for (const r of this.manager.rooms.values()) {
      const m = r.verifyToken({ userId: msg.userId, token: msg.token });
      if (m) {
        room = r;
        member = m;
        break;
      }
    }
    if (!room || !member) {
      P.sendSafe(ws, P.outError('AUTH_FAILED', '房间或令牌无效，请重新创建/加入房间'));
      return;
    }
    if (!member.online && room.onlineMembers().length >= room.maxUsers) {
      P.sendSafe(ws, P.outError('ROOM_FULL', '房间在线人数已满'));
      return;
    }
    const firstJoin = !member.online;
    room.setOnline(member.id, true);
    if (firstJoin) {
      room.addSysMsg(`${member.name} 加入了房间`);
    }
    this.sessions.set(ws, { ws, room, userId: member.id, name: member.name });
    this.#attachSocket(room.id, ws);
    P.sendSafe(ws, P.outWelcome(member.id, member.name, room.snapshot()));
    this.broadcastState(room);
    log.info('用户加入', { roomId: room.id, userId: member.id, online: room.onlineMembers().length });
    // 加入后若当前曲目缺播放地址，触发解析
    this.maybeResolve(room);
  }

  #handleChat(session, msg) {
    const { room, userId } = session;
    if (!this.chatLimiter.tryConsume(`${room.id}:${userId}:chat`)) {
      P.sendSafe(session.ws, P.outError('RATE_LIMIT', '发言太快了，休息一下'));
      return;
    }
    const result = room.addChat(userId, msg.text);
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    this.#broadcastToRoom(room, P.outChat(result.msg));
  }

  #handleControl(session, msg) {
    const { room, userId } = session;
    let result;
    switch (msg.action) {
      case 'ready':
        result = room.clientReady(userId, msg.trackId);
        break;
      case 'end':
        result = room.clientEnd(userId, msg.trackId);
        break;
      case 'pause':
        result = room.clientPause(userId, msg.positionSec);
        break;
      case 'resume':
        result = room.clientResume(userId, msg.positionSec);
        break;
      case 'seek':
        result = room.clientSeek(userId, msg.positionSec);
        break;
      case 'skip':
        result = room.skipCurrent(userId, msg.trackId);
        break;
      case 'prev':
        result = room.playPrevious(userId);
        break;
      default:
        P.sendSafe(session.ws, P.outError('BAD_PARAMS', `不支持的控制动作: ${msg.action}`));
        return;
    }
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    // skip/prev 会切歌：补一次取流触发（其余状态广播由房间 broadcastHandler 统一触发）
    if ((msg.action === 'skip' || msg.action === 'prev') && result.changed) {
      this.maybeResolve(room);
    }
  }

  #handleEnqueue(session, msg) {
    const { room, userId } = session;
    if (!this.enqueueLimiter.tryConsume(`${room.id}:${userId}:enqueue`)) {
      P.sendSafe(session.ws, P.outError('RATE_LIMIT', '点歌太频繁啦，稍等片刻'));
      return;
    }
    const result = room.enqueue(userId, msg.track);
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    if (!result.nowPlaying) {
      P.sendSafe(session.ws, P.outSys(room.addSysMsg(`已加入《${msg.track.title}》到点歌队列`)));
    }
    this.broadcastState(room);
    this.maybeResolve(room);
  }

  #handleDequeue(session, msg) {
    const { room, userId } = session;
    const result = room.dequeue(userId, msg.qid);
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    this.broadcastState(room);
  }

  #handlePlayQueue(session, msg) {
    const { room, userId } = session;
    const result = room.playQueued(userId, msg.qid);
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    this.broadcastState(room);
    this.maybeResolve(room);
  }

  #handleMode(session, msg) {
    const { room, userId } = session;
    const result = room.setMode(userId, msg.mode);
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    this.broadcastState(room);
  }

  #handleQuality(session, msg) {
    const { room, userId } = session;
    const result = room.setQuality(userId, msg.level);
    if (!result.ok) {
      P.sendSafe(session.ws, P.outError(result.code, result.message));
      return;
    }
    if (result.changed) {
      this.broadcastState(room);
      // 音质变化后当前曲目需按新音质重新取流
      this.maybeResolve(room);
    }
  }

  // ------------------------------------------------------------ 播放地址解析

  /** 若当前曲目缺播放地址（或音质已变）则启动异步解析（防并发：room.resolving） */
  maybeResolve(room) {
    if (!room.needsUrlResolve()) return;
    if (!room.startResolve()) return;
    const track = room.playback.track; // v2：曲目嵌套在 playback.track
    const trackId = track.trackId;
    const source = track.source;
    const quality = room.quality;
    provider
      .resolveUrl(track, { quality })
      .then((result) => {
        const changed = room.finishResolve(trackId, result, quality, source);
        if (changed) {
          this.broadcastState(room);
          this.maybeResolve(room); // 失败自动切歌后，新曲目可能也需要解析
        }
      })
      .catch((err) => {
        log.error('播放地址解析异常', { roomId: room.id, trackId, error: err.message });
        const changed = room.finishResolve(trackId, null, quality, source);
        if (changed) this.broadcastState(room);
      });
  }

  // ------------------------------------------------------------ 广播

  #broadcastToRoom(room, payload) {
    const sockets = this.roomSockets.get(room.id);
    if (!sockets) return;
    const text = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(text);
        } catch (err) {
          log.warn('广播发送失败', err);
        }
      }
    }
  }

  /**
   * 状态广播合并：同一房间的多次变化在窗口内只发一次。
   * 发给房间内全部连接（包括触发者）：触发者的 welcome 已含同 seq 快照，
   * 重复一份无害；若按触发者排除，合并窗口会让其他成员丢失唯一一次广播。
   */
  broadcastState(room) {
    const key = room.id;
    if (this.pendingBroadcast.has(key)) return;
    const timer = setTimeout(() => {
      this.pendingBroadcast.delete(key);
      this.#broadcastToRoom(room, P.outState(room.snapshot()));
    }, config.ws.stateBroadcastCoalesceMs);
    this.pendingBroadcast.set(key, timer);
  }

  /** 心跳保活，返回停止函数 */
  startHeartbeat() {
    const interval = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, config.ws.heartbeatIntervalMs);
    const stop = () => clearInterval(interval);
    this.stops.add(stop);
    return stop;
  }

  stop() {
    for (const stop of this.stops) {
      try {
        stop();
      } catch {
        /* 忽略停止异常 */
      }
    }
    this.stops.clear();
    for (const timer of this.pendingBroadcast.values()) clearTimeout(timer);
    this.pendingBroadcast.clear();
  }
}

module.exports = { Hub };
