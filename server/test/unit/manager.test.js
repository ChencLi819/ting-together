'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { RoomManager } = require('../../src/room/manager');

let t = 1_000_000;
const now = () => t;

test('建房/加入/邀请码大小写不敏感', () => {
  const mgr = new RoomManager({ now });
  const { room, membership } = mgr.createRoom('小张');
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.equal(membership.isHost, true);

  const joined = mgr.joinRoom(room.code.toLowerCase(), '小李');
  assert.equal(joined.ok, true);
  assert.equal(joined.membership.roomId, room.id);
  assert.equal(joined.membership.isHost, false);

  assert.equal(mgr.joinRoom('ZZZZZZ', '路人').code, 'NOT_FOUND');
  assert.equal(mgr.getByCode(room.code).id, room.id);
});

test('空闲清理：离线超时清理，在线保留', () => {
  const mgr = new RoomManager({ now });
  const { room, membership } = mgr.createRoom('小张');
  void membership;
  mgr.joinRoom(room.code, '小李');

  t += 30 * 60 * 1000; // 半小时无活动
  assert.equal(mgr.purgeIdle({ idleMs: 3600000, maxAgeMs: 86400000 }), 0, '未超时不清');

  t += 40 * 60 * 1000; // 70 分钟无活动
  assert.equal(mgr.purgeIdle({ idleMs: 3600000, maxAgeMs: 86400000 }), 1, '离线超时应清理');
  assert.equal(mgr.size, 0);
});

test('maxAge 强制清理长寿房间（即使仍在线）', () => {
  const mgr = new RoomManager({ now });
  const { room } = mgr.createRoom('小张');
  room.setOnline(room.hostUserId, true);
  t += 25 * 60 * 60 * 1000;
  assert.equal(mgr.purgeIdle({ idleMs: 3600000, maxAgeMs: 86400000 }), 1);
});
