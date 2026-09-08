'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Room, ERR, END_BARRIER_MS } = require('../../src/room/room');

function makeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function makeRoom(limits = {}, hostOnly = false) {
  const clock = makeClock();
  const room = new Room({
    id: 'r1',
    code: 'ABCDEF',
    hostUserId: 'host',
    now: clock.now,
    limits: { maxUsers: 8, chatHistoryLimit: 3, queueLimit: 5, ...limits },
    hostOnlyControl: hostOnly,
  });
  room.addMember({ userId: 'host', name: '房主', token: 'tk-host' });
  return { room, clock };
}

function join(room, userId, name = userId) {
  const res = room.addMember({ userId, name, token: `tk-${userId}` });
  assert.equal(res.ok, true, `成员 ${userId} 应加入成功`);
  room.setOnline(userId, true);
  return res;
}

const TRACK = (id, dur = 100) => ({
  source: 'mock',
  trackId: id,
  title: `歌曲${id}`,
  artist: '歌手',
  album: '专辑',
  picUrl: '',
  durationSec: dur,
});

test('成员：注册/鉴权/房间人数上限', () => {
  const { room } = makeRoom({ maxUsers: 2 });
  assert.equal(room.verifyToken({ userId: 'host', token: 'tk-host' }).id, 'host');
  assert.equal(room.verifyToken({ userId: 'host', token: 'wrong' }), null);
  assert.equal(room.verifyToken({ userId: 'ghost', token: 'x' }), null);

  join(room, 'u1');
  const full = room.addMember({ userId: 'u2', name: 'u2', token: 'tk' });
  assert.equal(full.ok, false);
  assert.equal(full.code, ERR.ROOM_FULL);
});

test('点歌：进入 loading，首个 ready 启动时间线', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  const res = room.enqueue('u1', TRACK('m001'));
  assert.equal(res.ok, true);
  assert.equal(res.nowPlaying, true);
  assert.equal(room.playback.status, 'loading');
  assert.equal(room.playback.startAtSec, 0);
  assert.equal(room.needsUrlResolve(), true);

  // 地址解析完成
  assert.equal(room.finishResolve('m001', { url: 'https://x/a.mp3', trial: false }), true);
  assert.equal(room.playback.url, 'https://x/a.mp3');

  // 客户端加载完成上报 ready → 时间线启动
  clock.advance(2000);
  room.clientReady('u1', 'm001');
  assert.equal(room.playback.status, 'playing');
  assert.ok(room.playback.startedAtMs, 'startedAtMs 应已设置');

  // positionSec 随时间推进
  clock.advance(5000);
  const view = room.playbackView();
  assert.ok(Math.abs(view.positionSec - 5) < 0.1, 'positionSec 应包含时间线推进');
  assert.ok(Math.abs(view.positionSec - 7) > 0.1);
});

test('双端 ready：后者不改时间线', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  join(room, 'u2');
  room.enqueue('u1', TRACK('m001'));
  room.finishResolve('m001', { url: 'https://x/a.mp3', trial: false });

  clock.advance(61000); // 让未活跃的幽灵成员（host）退出活跃计数
  room.touchMember('u1');
  room.touchMember('u2');
  room.clientReady('u1', 'm001'); // 首个 ready 启动时间线
  const startedAtMs = room.playback.startedAtMs;
  clock.advance(4000);

  room.clientReady('u2', 'm001'); // 后者：不改时间线
  assert.equal(room.playback.startedAtMs, startedAtMs, '时间线不应被后者重置');
  // u2 应按 positionSec 追齐（positionSec 已推进 ~3s）
  assert.ok(room.playbackView().positionSec > 2.5);
});

test('结束栅栏：双端齐 → 立即接歌', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  join(room, 'u2');
  clock.advance(61000);
  room.touchMember('u1');
  room.touchMember('u2');
  room.enqueue('u1', TRACK('m001'));
  room.finishResolve('m001', { url: 'https://x/a.mp3' });
  room.clientReady('u1', 'm001');
  room.enqueue('u1', TRACK('m002'));
  assert.equal(room.queue.length, 1);
  room.touchMember('u1');
  room.touchMember('u2');

  room.clientEnd('u1', 'm001'); // 1/2
  assert.equal(room.playback.track.trackId, 'm001', '未收齐 end 不应切歌');
  room.clientEnd('u2', 'm001'); // 2/2 → 接歌
  assert.equal(room.playback.track.trackId, 'm002');
  assert.equal(room.playback.status, 'loading', '新曲目应进入 loading');
  assert.equal(room.history[0].track.trackId, 'm001');
});

test('结束栅栏：3s 兜底切歌（node:test mock timers）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { room, clock } = makeRoom();
  join(room, 'u1');
  join(room, 'u2');
  clock.advance(61000);
  room.touchMember('u1');
  room.touchMember('u2'); // 模拟双端在线
  room.enqueue('u1', TRACK('m001'));
  room.finishResolve('m001', { url: 'https://x/a.mp3' });
  room.clientReady('u1', 'm001');

  room.clientEnd('u1', 'm001'); // 只有 1/2
  assert.equal(room.playback.track.trackId, 'm001', '兜底未到不应切歌');

  t.mock.timers.tick(END_BARRIER_MS + 1);
  assert.equal(room.playback, null, '兜底到点：队列空 → 播放结束');
  assert.equal(END_BARRIER_MS, 3000);
});

test('暂停/恢复：上报位置即全员对齐点', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001', 200));
  room.finishResolve('m001', { url: 'https://x/a.mp3' });
  room.clientReady('u1', 'm001');
  clock.advance(10000);

  room.clientPause('u1', 42);
  assert.equal(room.playback.status, 'paused');
  assert.equal(room.playback.startAtSec, 42);
  assert.equal(room.currentPositionSec(), 42, '暂停后位置冻结');

  clock.advance(30000);
  assert.equal(room.currentPositionSec(), 42, '暂停期间不推进');

  room.clientResume('u1', 42);
  assert.equal(room.playback.status, 'playing');
  clock.advance(1000);
  assert.ok(Math.abs(room.currentPositionSec() - 43) < 0.1, '恢复后继续推进');

  // 点播模式权限
  const room2 = makeRoom({}, true).room;
  join(room2, 'u1');
  room2.enqueue('host', TRACK('m001', 100));
  room2.finishResolve('m001', { url: 'https://x/a.mp3' });
  room2.clientReady('host', 'm001');
  assert.equal(room2.clientPause('u1', 10).code, ERR.PERMISSION);
  assert.equal(room2.clientResume('u1', 10).code, ERR.PERMISSION);
  assert.equal(room2.clientSeek('u1', 10).code, ERR.PERMISSION);
});

test('seek：上报位置即新时间线位置（按曲长封顶）', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001', 100));
  room.finishResolve('m001', { url: 'https://x/a.mp3' });
  room.clientReady('u1', 'm001');

  clock.advance(1000);
  room.clientSeek('u1', 80);
  assert.equal(room.playback.startAtSec, 80);
  clock.advance(5000);
  assert.equal(room.currentPositionSec(), 85, 'seek 后从新位置推进');

  room.clientSeek('u1', 500); // 超曲长封顶
  assert.equal(room.playback.startAtSec, 100);
  assert.equal(room.clientSeek('u1', -1).code, ERR.BAD_PARAMS);
});

test('skip/prev：原曲入历史、队列/历史回退', () => {
  const { room } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001'));
  room.enqueue('u1', TRACK('m002'));
  room.finishResolve('m001', { url: 'https://x/a.mp3' });
  room.clientReady('u1', 'm001');

  room.skipCurrent('u1'); // 跳过 m001 → m002 loading
  assert.equal(room.playback.track.trackId, 'm002');
  assert.equal(room.playback.status, 'loading');
  assert.equal(room.history[0].track.trackId, 'm001');

  room.playPrevious('u1'); // 上一首 → m001
  assert.equal(room.playback.track.trackId, 'm001');
  assert.equal(room.queue[0].track.trackId, 'm002', 'm002 应回到队首');
  assert.equal(room.playback.status, 'loading');

  // 无历史时的 prev：重播当前曲（从 0 开始）
  room.dequeue('u1', room.queue[0].qid); // 清空队列
  room.playPrevious('u1');
  assert.equal(room.playback.track.trackId, 'm001');
  assert.equal(room.playback.startAtSec, 0);
});

test('带曲目 ID 的 skip：过期或重复的音频错误不得跳过下一首', () => {
  const { room } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001'));
  room.enqueue('u1', TRACK('m002'));

  assert.equal(room.skipCurrent('u1', 'm001').changed, true);
  assert.equal(room.playback.track.trackId, 'm002');

  const stale = room.skipCurrent('u1', 'm001');
  assert.equal(stale.changed, false, '迟到的 m001 错误上报应被忽略');
  assert.equal(room.playback.track.trackId, 'm002');
});

test('取流竞态：旧曲或旧音质结果返回后，新请求仍可继续解析', () => {
  const { room } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001'));
  assert.equal(room.startResolve(), true);

  room.enqueue('u1', TRACK('m002'));
  room.skipCurrent('u1');
  assert.equal(room.playback.track.trackId, 'm002');
  assert.equal(room.finishResolve('m001', { url: 'https://x/stale.mp3' }, 'high', 'mock'), false);
  assert.equal(room.needsUrlResolve(), true, '旧曲请求结束后新曲必须重新进入可解析状态');

  assert.equal(room.startResolve(), true);
  room.setQuality('u1', 'lossless');
  assert.equal(room.finishResolve('m002', { url: 'https://x/high.mp3' }, 'high', 'mock'), false);
  assert.equal(room.playback.url, '', '旧音质结果不得冒充新音质 URL');
  assert.equal(room.needsUrlResolve(), true, '旧音质请求结束后应重新解析新音质');
});

test('队列插播：点击队列歌曲立即加载', () => {
  const { room } = makeRoom({ queueLimit: 2 });
  join(room, 'u1');
  join(room, 'u2');
  room.enqueue('u1', TRACK('m001'));
  room.enqueue('u1', TRACK('m002'));
  room.enqueue('u1', TRACK('m003'));
  assert.equal(room.queue.length, 2);

  const qid = room.queue[1].qid; // m003
  const ok = room.playQueued('u2', qid);
  assert.equal(ok.ok, true);
  assert.equal(room.playback.track.trackId, 'm003');
  assert.equal(room.playback.status, 'loading');
  assert.equal(room.queue.length, 1, '被插播的歌应移出队列');
  assert.equal(room.queue[0].track.trackId, 'm002');
  assert.equal(room.history[0].track.trackId, 'm001', '原曲应入历史');
  assert.equal(room.playQueued('u1', 'nope').code, ERR.NOT_FOUND);
});

test('音质：房间级切换、权限、触发重取流', () => {
  const { room } = makeRoom({}, true); // 点播模式
  join(room, 'u1');
  room.enqueue('host', TRACK('m001'));
  assert.equal(room.finishResolve('m001', { url: 'https://x/a.mp3', trial: false }, 'high'), true);
  assert.equal(room.playback.urlQuality, 'high');

  const denied = room.setQuality('u1', 'lossless');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, ERR.PERMISSION);

  const ok = room.setQuality('host', 'lossless');
  assert.equal(ok.ok, true);
  assert.equal(room.quality, 'lossless');
  assert.equal(room.playback.url, '', '切换音质后应清空旧地址');
  assert.equal(room.needsUrlResolve(), true, '音质不匹配应触发重取流');
  assert.equal(room.setQuality('host', 'lossless').changed, false);
  assert.equal(room.setQuality('host', 'hifi').code, ERR.BAD_PARAMS);
  assert.equal(room.snapshot().quality, 'lossless');

  room.setMode('host', 'free');
  assert.equal(room.setQuality('u1', 'standard').ok, true);
});

test('解析失败：自动切下一首并触发新曲解析', () => {
  const { room } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001'));
  room.enqueue('u1', TRACK('m002'));
  assert.equal(room.finishResolve('m001', null), true, '解析失败应切歌');
  assert.equal(room.playback.track.trackId, 'm002');
  assert.equal(room.playback.status, 'loading');
  assert.ok(room.recentChat().some((m) => m.text.includes('已自动切歌')));
});

test('clientEnd：未开始的曲目忽略', () => {
  const { room } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001')); // loading，未 ready
  const res = room.clientEnd('u1', 'm001');
  assert.equal(res.ok, true);
  assert.equal(room.playback.track.trackId, 'm001', 'loading 期的 end 不应切歌');
});

test('聊天：记录、上限、未加入成员拒绝', () => {
  const { room } = makeRoom(); // chatHistoryLimit=3
  join(room, 'u1');
  for (let i = 1; i <= 5; i += 1) room.addChat('u1', `msg${i}`);
  const log = room.recentChat(10).filter((m) => m.kind === 'user');
  assert.equal(log.length, 3, '超出上限的消息应被裁剪');
  assert.equal(log[2].text, 'msg5', '保留最新消息');
  assert.equal(room.addChat('stranger', 'hi').code, ERR.NOT_FOUND);
});

test('房主迁移：房主离线后移交最早加入的在线成员', () => {
  const { room } = makeRoom();
  room.setOnline('host', true);
  join(room, 'u1');
  join(room, 'u2');
  room.setOnline('host', false);
  assert.equal(room.hostUserId, 'u1', '应移交给最早加入的 u1');
  assert.ok(room.recentChat().some((m) => m.text.includes('房主已移交')));
});

test('轮询在线态：租约内成员互相可见，过期后可迁移房主', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  room.setOnline('u1', false); // 模拟无 WebSocket、仅 HTTP 轮询
  room.touchPollingMember('host');
  room.touchPollingMember('u1');
  assert.deepEqual(room.snapshot().users.map((u) => u.id).sort(), ['host', 'u1']);

  clock.advance(15001);
  room.touchPollingMember('u1');
  assert.equal(room.maybeMigrateHost(), true);
  assert.equal(room.hostUserId, 'u1');
  assert.deepEqual(room.snapshot().users.map((u) => u.id), ['u1']);
});

test('快照：v2 结构完整', () => {
  const { room, clock } = makeRoom();
  join(room, 'u1');
  room.enqueue('u1', TRACK('m001', 100));
  room.finishResolve('m001', { url: 'https://x/a.mp3' });
  room.clientReady('u1', 'm001');
  clock.advance(3000);

  const snap = room.snapshot();
  assert.equal(snap.code, 'ABCDEF');
  assert.equal(snap.hostName, '房主');
  assert.equal(snap.playback.status, 'playing');
  assert.equal(snap.playback.trackId, 'm001');
  assert.ok(Math.abs(snap.playback.positionSec - 3) < 0.1, '快照进度应包含时间线推进');
  assert.equal(snap.users.length, 1);
  assert.equal(snap.onlineCount, 1, '在线人数应与当前可见成员同步');
  assert.equal(snap.mode, 'free');
  assert.ok(Array.isArray(snap.chat));
});
