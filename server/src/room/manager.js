'use strict';

const { Room } = require('./room');
const { randomHex, roomCode } = require('../utils/id');

/**
 * 房间注册表：建房、按邀请码加入、空闲清理。
 */
class RoomManager {
  constructor({ limits = {}, now = Date.now } = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} code -> roomId */
    this.codes = new Map();
    this.limits = limits;
    this.now = now;
    this.resolveHandler = null; // 由 app 装配：room 发出 needs-resolve 时触发取流
  }

  /** 建房并注册房主，签发 {userId, token} */
  createRoom(hostName) {
    let id = '';
    let code = '';
    let room = null;
    // 极小概率撞码，重试若干次
    for (let i = 0; i < 5; i += 1) {
      id = `r${randomHex(8)}`;
      code = roomCode();
      if (!this.codes.has(code)) break;
    }
    const userId = `u${randomHex(8)}`;
    const token = randomHex(24);
    room = new Room({ id, code, hostUserId: userId, now: this.now, limits: this.limits });
    const added = room.addMember({ userId, name: hostName, token });
    if (!added.ok) throw new Error(`建房失败: ${added.message}`);
    room.on('needs-resolve', () => {
      if (this.resolveHandler) this.resolveHandler(room);
    });
    room.on('broadcast', () => {
      if (this.broadcastHandler) this.broadcastHandler(room);
    });
    this.rooms.set(id, room);
    this.codes.set(code, id);
    return { room, membership: { userId, name: hostName, token, code, isHost: true } };
  }

  /** 注册取流触发器（app.js 装配到 hub） */
  setResolveHandler(fn) {
    this.resolveHandler = fn;
  }

  /** 注册状态广播器（app.js 装配到 hub） */
  setBroadcastHandler(fn) {
    this.broadcastHandler = fn;
  }

  /** 按邀请码加入，签发 {userId, token} */
  joinRoom(code, name) {
    const roomId = this.codes.get(String(code).toUpperCase());
    if (!roomId) return { ok: false, code: 'NOT_FOUND', message: '房间不存在或邀请码有误' };
    const room = this.rooms.get(roomId);
    const userId = `u${randomHex(8)}`;
    const token = randomHex(24);
    const added = room.addMember({ userId, name, token });
    if (!added.ok) return added;
    return { ok: true, membership: { userId, name, token, roomId: room.id, code: room.code, isHost: false } };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  getByCode(code) {
    const roomId = this.codes.get(String(code).toUpperCase());
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  /**
   * 清理空闲房间：无在线成员且超过 idleMs，或总时长超过 maxAgeMs。
   * @returns {number} 清理数量
   */
  purgeIdle({ idleMs = 3600000, maxAgeMs = 86400000 } = {}) {
    const nowMs = this.now();
    let removed = 0;
    for (const [id, room] of this.rooms) {
      const noOnline = room.onlineMembers().length === 0;
      const idle = noOnline && nowMs - room.lastActivityAt > idleMs;
      const aged = nowMs - room.createdAt > maxAgeMs;
      if (idle || aged) {
        this.rooms.delete(id);
        this.codes.delete(room.code);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.rooms.size;
  }
}

module.exports = { RoomManager };
