'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');

// 必须在引入任何服务端模块之前设定，保证 config 以 mock 源初始化、插件数据文件隔离
process.env.MUSIC_PROVIDER = 'mock';
process.env.PLUGIN_DATA_FILE = require('node:path').join(require('node:os').tmpdir(), `ting-plugin-it-${process.pid}.json`);
process.env.PLUGIN_IMPORT_TOKEN = 'it-token-123';

const { createApp } = require('../../src/app');

let app = null;
let base = null;
let wsBase = null;

before(async () => {
  app = createApp();
  // WHATWG fetch 会拒绝 6000/666x/10080 等“bad ports”；Windows 的 listen(0)
  // 偶尔会分配到其中之一，导致产品无误但整套集成测试随机全红。
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const candidate = `http://127.0.0.1:${app.server.address().port}`;
    try {
      const probe = await fetch(`${candidate}/healthz`);
      if (!probe.ok) throw new Error(`集成测试服务探活失败: HTTP ${probe.status}`);
      ready = true;
      break;
    } catch (err) {
      const isBlockedPort = err && err.cause && err.cause.message === 'bad port';
      if (!isBlockedPort) throw err;
      await new Promise((resolve) => app.server.close(resolve));
    }
  }
  const addr = app.server.address();
  if (!ready || !addr) throw new Error('无法分配 fetch 可用的集成测试端口');
  base = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}/ws`;
});

after(async () => {
  if (app) await app.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试用 WS 客户端：收集消息 + 持久游标轮询断言（每次等待只看新消息） */
class TestClient {
  constructor() {
    this.messages = [];
    this.cursor = 0;
    this.closed = false;
  }

  static async connect(hello, { timeoutMs = 3000 } = {}) {
    const client = new TestClient();
    client.ws = new WebSocket(wsBase);
    client.wire();
    await new Promise((resolve, reject) => {
      client.ws.on('open', resolve);
      client.ws.on('error', reject);
      setTimeout(() => reject(new Error('WS 连接超时')), timeoutMs);
    });
    client.send(hello);
    const welcome = await client.waitFor((m) => m.type === 'welcome' || m.type === 'error', timeoutMs);
    assert.equal(welcome.type, 'welcome', `hello 应成功: ${JSON.stringify(welcome)}`);
    return client;
  }

  /** 挂载消息/关闭监听（TestClient.connect 与手工建连都需调用） */
  wire() {
    this.ws.on('message', (data) => {
      try {
        this.messages.push(JSON.parse(data.toString('utf8')));
      } catch {
        /* 忽略非 JSON */
      }
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  clear() {
    this.messages.length = 0;
    this.cursor = 0;
  }

  /** 轮询等待满足条件的消息：从上次消费位置继续（持久游标），返回第一条匹配 */
  async waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.messages.length) {
        const msg = this.messages[this.cursor];
        this.cursor += 1;
        if (pred(msg)) return msg;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待消息超时(${timeoutMs}ms)，已收: ${JSON.stringify(this.messages.slice(-4))}`);
      }
      await sleep(20);
    }
  }

  async waitState(pred, timeoutMs = 3000) {
    return this.waitFor((m) => {
      if (m.type !== 'state' || !m.state) return false;
      try {
        return Boolean(pred(m.state));
      } catch {
        // 房间无在播曲目时 playback 为 null，谓词可能解引用失败；按不匹配继续扫
        return false;
      }
    }, timeoutMs);
  }

  async latestState(pred, timeoutMs = 3000) {
    const msg = await this.waitState(pred, timeoutMs);
    return msg.state;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function createRoom(name) {
  const res = await fetch(`${base}/api/v1/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function joinRoom(code, name) {
  const res = await fetch(`${base}/api/v1/rooms/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  return { status: res.status, body: await res.json() };
}

async function pollingAction(membership, action) {
  const res = await fetch(`${base}/api/v1/rooms/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: membership.code,
      userId: membership.userId,
      token: membership.token,
      ...action,
    }),
  });
  return { status: res.status, body: await res.json() };
}

const MOCK_TRACK = (id) => ({
  source: 'mock',
  trackId: id,
  title: `测试之歌${id}`,
  artist: 'Mock乐队',
  album: '测试专辑A',
  picUrl: '',
  durationSec: 180,
});

test('全链路：建房→加入→双端同步点歌/控制/聊天/切歌/离开/重入', async () => {
  // ---- REST 建房与加入
  const host = await createRoom('小张');
  assert.ok(host.code && host.token && host.userId);
  const guestRes = await joinRoom(host.code, '小李');
  assert.equal(guestRes.status, 200);
  const guest = guestRes.body;
  assert.equal(guest.isHost, false);

  // 房间预览
  const preview = await fetch(`${base}/api/v1/rooms/${host.code}`);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).memberCount, 2);

  // ---- 双端握手
  const hostClient = await TestClient.connect({ type: 'hello', token: host.token, userId: host.userId, name: host.name });
  const guestClient = await TestClient.connect({ type: 'hello', token: guest.token, userId: guest.userId, name: guest.name });
  const hostSnap = await hostClient.latestState((s) => s.users.length === 2, 4000);
  assert.equal(hostSnap.hostUserId, host.userId, '房主应为创建者');

  // ---- 点歌：mock 曲目自动开播并异步解析播放地址
  guestClient.send({ type: 'enqueue', track: MOCK_TRACK('m001') });
  const first = await hostClient.latestState((s) => s.playback && s.playback.url, 5000);
  assert.equal(first.playback.trackId, 'm001');
  assert.equal(first.playback.url, 'https://cdn.mock.local/stream/m001.mp3');
  assert.equal(first.playback.status, 'loading', '解析完成但时间线未启动');
  // v2 起播握手：双端上报 ready，首个 ready 启动时间线
  hostClient.send({ type: 'ctl', action: 'ready', trackId: 'm001' });
  guestClient.send({ type: 'ctl', action: 'ready', trackId: 'm001' });
  const started = await hostClient.waitState((s) => s.playback.status === 'playing', 3000);
  assert.ok(started.state.playback.positionSec <= 1.5, '起播对齐点应在起点附近');
  await guestClient.waitState((s) => s.playback && s.playback.url === first.playback.url && s.playback.status === 'playing', 3000);

  // ---- 聊天：双向可见
  guestClient.send({ type: 'chat', text: '这首歌不错！' });
  const chatMsg = await hostClient.waitFor((m) => m.type === 'chat' && m.msg.text === '这首歌不错！');
  assert.equal(chatMsg.msg.name, '小李');
  await guestClient.waitFor((m) => m.type === 'chat' && m.msg.text === '这首歌不错！');

  // ---- 控制同步：暂停/seek/恢复（v2：上报位置即全员对齐点）
  guestClient.send({ type: 'ctl', action: 'pause', positionSec: 30 });
  const paused = await hostClient.waitState((s) => s.playback.status === 'paused', 3000);
  assert.ok(Math.abs(paused.state.playback.positionSec - 30) < 0.5, '暂停位置应对齐上报值');
  guestClient.send({ type: 'ctl', action: 'seek', positionSec: 60 });
  await hostClient.waitState((s) => Math.abs(s.playback.positionSec - 60) < 0.5, 3000);
  guestClient.send({ type: 'ctl', action: 'resume', positionSec: 60 });
  const resumed = await hostClient.waitState((s) => s.playback.status === 'playing', 3000);
  assert.ok(resumed.state.playback.positionSec >= 59.5, '恢复后从对齐点继续');

  // ---- 排队第二首并自然播完接歌
  guestClient.send({ type: 'enqueue', track: MOCK_TRACK('m002') });
  await hostClient.waitState((s) => s.queue.length === 1, 3000);
  // 结束栅栏：双端都上报 end 才切歌
  hostClient.send({ type: 'ctl', action: 'end', trackId: 'm001' });
  guestClient.send({ type: 'ctl', action: 'end', trackId: 'm001' });
  const second = await hostClient.latestState((s) => s.playback && s.playback.trackId === 'm002' && s.playback.url, 5000);
  assert.equal(second.playback.url, 'https://cdn.mock.local/stream/m002.mp3');
  assert.equal(second.playback.urlTrial, true, 'm002 为试听片段');

  // ---- 移除点歌：权限校验
  hostClient.send({ type: 'enqueue', track: MOCK_TRACK('m003') });
  const queued = await guestClient.waitState((s) => s.queue.length === 1 && s.queue[0].track.trackId === 'm003', 3000);
  guestClient.send({ type: 'dequeue', qid: queued.state.queue[0].qid });
  const denied = await guestClient.waitFor((m) => m.type === 'error', 3000);
  assert.equal(denied.code, 'PERMISSION', '非本人点歌不可移除');
  hostClient.send({ type: 'dequeue', qid: queued.state.queue[0].qid });
  await guestClient.waitState((s) => s.queue.length === 0, 3000);

  // ---- 音质调节：房间级，切换后按新音质重新取流（mock 源对档位不敏感，验证状态流转）
  guestClient.send({ type: 'quality', level: 'lossless' });
  const afterQuality = await hostClient.latestState((s) => s.quality === 'lossless' && s.playback && s.playback.url, 5000);
  assert.equal(afterQuality.playback.urlQuality, 'lossless', '切换音质后应按新音质重新取流');
  assert.equal(afterQuality.playback.trackId, 'm002', '音质切换不应换曲');

  // ---- 队列插播：点击队列歌曲立即播放，原曲入历史
  hostClient.send({ type: 'enqueue', track: MOCK_TRACK('m003') });
  const queuedM3 = await guestClient.waitState((s) => s.queue.length === 1 && s.queue[0].track.trackId === 'm003', 3000);
  guestClient.send({ type: 'play-queue', qid: queuedM3.state.queue[0].qid });
  const jumped = await hostClient.latestState((s) => s.playback && s.playback.trackId === 'm003' && s.playback.url, 5000);
  assert.equal(jumped.playback.status, 'loading', '插播后进入加载');
  assert.equal(jumped.queue.length, 0, '被插播的歌应移出队列');
  hostClient.send({ type: 'ctl', action: 'ready', trackId: 'm003' });
  guestClient.send({ type: 'ctl', action: 'ready', trackId: 'm003' });
  await hostClient.waitState((s) => s.playback.status === 'playing', 3000);

  // ---- 房主离开 → 房主迁移
  hostClient.close();
  const migrated = await guestClient.waitFor(
    (m) => (m.type === 'sys' && m.msg.text.includes('房主已移交')) || (m.type === 'state' && m.state.hostUserId === guest.userId),
    4000,
  );
  assert.ok(migrated, '应发生房主迁移');

  // ---- 访客重入（同一成员身份可重连）；此时在播曲目为插播的 m003
  guestClient.clear();
  const rejoin = await TestClient.connect({ type: 'hello', token: guest.token, userId: guest.userId, name: guest.name });
  assert.equal(rejoin.messages[0].type, 'welcome');
  await rejoin.waitState((s) => s.playback && s.playback.trackId === 'm003' && s.playback.urlQuality === 'lossless', 3000);
  rejoin.close();
  guestClient.close();
});

test('异常路径：坏令牌/坏消息/限流/人数上限', async () => {
  const host = await createRoom('小王');
  const guestRes = await joinRoom(host.code, '小赵');
  const guest = guestRes.body;

  // 坏令牌
  const bad = new TestClient();
  bad.ws = new WebSocket(wsBase);
  bad.wire();
  await new Promise((resolve) => bad.ws.on('open', resolve));
  bad.send({ type: 'hello', token: 'wrong-token', userId: guest.userId, name: guest.name });
  const authErr = await bad.waitFor((m) => m.type === 'error', 3000);
  assert.equal(authErr.code, 'AUTH_FAILED');
  bad.close();

  // 坏消息类型
  const hostClient = await TestClient.connect({ type: 'hello', token: host.token, userId: host.userId, name: host.name });
  hostClient.send({ type: 'hack', x: 1 });
  const badMsg = await hostClient.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE', 3000);
  assert.ok(badMsg.message);

  // 聊天限流（默认 6 条 / 2 秒）
  for (let i = 0; i < 9; i += 1) hostClient.send({ type: 'chat', text: `刷屏${i}` });
  const limited = await hostClient.waitFor((m) => m.type === 'error' && m.code === 'RATE_LIMIT', 3000);
  assert.ok(limited, '应触发聊天限流');

  // 人数上限（默认 8 人）：再加 6 人后第 9 个加入失败
  const joins = [];
  for (let i = 0; i < 7; i += 1) joins.push(joinRoom(host.code, `路人${i}`));
  const results = await Promise.all(joins);
  const failed = results.filter((r) => r.status !== 200);
  assert.ok(failed.length >= 1, '超出人数上限的加入应失败');
  assert.equal(failed[0].body.code, 'ROOM_FULL');

  hostClient.close();
});

test('WebSocket 重连重叠：旧连接关闭不能把仍在线的新连接标离线', async () => {
  const host = await createRoom('重连测试');
  const oldClient = await TestClient.connect({ type: 'hello', token: host.token, userId: host.userId, name: host.name });
  const newClient = await TestClient.connect({ type: 'hello', token: host.token, userId: host.userId, name: host.name });

  oldClient.close();
  await sleep(100);
  newClient.clear();
  newClient.send({ type: 'sync-req' });
  const state = await newClient.latestState(() => true, 3000);
  assert.ok(state.users.some((u) => u.id === host.userId), '新连接仍活跃时成员应保持在线');
  newClient.close();
});

test('REST：搜索/歌词/播放地址与健康检查', async () => {  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const search = await fetch(`${base}/api/v1/music/search?kw=${encodeURIComponent('雨')}`);
  assert.equal(search.status, 200);
  const searchData = await search.json();
  assert.equal(searchData.provider, 'mock');
  assert.ok(searchData.tracks.length > 0);

  // ---- REST：POST 形态（云调用链路统一走 POST）
  const searchPost = await fetch(`${base}/api/v1/music/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kw: '雨', source: 'mock' }),
  });
  assert.equal(searchPost.status, 200);
  const searchPostData = await searchPost.json();
  assert.equal(searchPostData.provider, 'mock');
  assert.ok(searchPostData.tracks.length > 0);

  const lyricPost = await fetch(`${base}/api/v1/music/lyric`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'mock', id: 'm001' }),
  });
  assert.equal(lyricPost.status, 200);
  assert.ok((await lyricPost.json()).lyric.includes('测试歌词'));

  const noKw = await fetch(`${base}/api/v1/music/search`);
  assert.equal(noKw.status, 400);

  const lyric = await fetch(`${base}/api/v1/music/lyric?source=mock&id=m001`);
  assert.equal(lyric.status, 200);
  assert.ok((await lyric.json()).lyric.includes('测试歌词'));

  const badLyric = await fetch(`${base}/api/v1/music/lyric?source=evil&id=m001`);
  assert.equal(badLyric.status, 400);

  const noUrl = await fetch(`${base}/api/v1/music/url?source=mock&id=m004`);
  assert.equal(noUrl.status, 404);
  assert.equal((await noUrl.json()).code, 'NO_URL');

  const missing = await fetch(`${base}/api/v1/whatever`);
  assert.equal(missing.status, 404);
});

test('HTTP 轮询通道：动作校验与音质切换和 WebSocket 一致', async () => {
  const host = await createRoom('轮询房主');

  const blankChat = await pollingAction(host, { type: 'chat', text: '   ' });
  assert.equal(blankChat.status, 400, '轮询通道也必须拒绝空聊天');

  const enqueue = await pollingAction(host, { type: 'enqueue', track: MOCK_TRACK('m001') });
  assert.equal(enqueue.status, 200);

  const quality = await pollingAction(host, { type: 'quality', level: 'lossless' });
  assert.equal(quality.status, 200, `轮询通道应支持音质切换: ${JSON.stringify(quality.body)}`);
  assert.equal(quality.body.snapshot.quality, 'lossless');
});

test('音乐插件：导入→搜索→点歌→自动取流→歌词 全链路', async () => {
  const fx = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/plugin.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`module.exports = {
        platform: '集成测试插件',
        version: '1.0.0',
        async search(kw, page) {
          const r = await fetch('http://127.0.0.1:${fx.address().port}/tracks?kw=' + encodeURIComponent(kw));
          const j = await r.json();
          return { isEnd: true, data: j.songs };
        },
        async getMediaSource(m, q) {
          const r = await fetch('http://127.0.0.1:${fx.address().port}/src?id=' + encodeURIComponent(m.id) + '&q=' + q);
          return { url: 'http://127.0.0.1:${fx.address().port}/audio/' + (await r.json()).file };
        },
        async getLyric(m) {
          return { rawLrc: '[00:01.00]集成插件歌词' };
        },
      };`);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/tracks') {
      res.end(JSON.stringify({ songs: [{ id: 'it-1', title: '集成插件歌', artist: 'IT', duration: 200 }] }));
    } else if (u.pathname === '/src') {
      res.end(JSON.stringify({ file: 'it-1.mp3' }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => fx.listen(0, '127.0.0.1', r));
  const fxBase = `http://127.0.0.1:${fx.address().port}`;
  let client = null;
  try {
    const host = await createRoom('小插');
    client = await TestClient.connect({ type: 'hello', token: host.token, userId: host.userId, name: host.name });

    // 导入插件：无令牌应 403，带令牌成功
    const noToken = await fetch(`${base}/api/v1/music/plugin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${fxBase}/plugin.js` }) });
    assert.equal(noToken.status, 403, '未携带管理令牌的插件导入应被拒绝');
    const imp = await fetch(`${base}/api/v1/music/plugin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-plugin-token': 'it-token-123' }, body: JSON.stringify({ url: `${fxBase}/plugin.js` }) });
    assert.equal(imp.status, 200);
    const imported = (await imp.json()).plugin;
    assert.equal(imported.name, '集成测试插件');

    // 插件搜索
    const searchRes = await fetch(`${base}/api/v1/music/search?source=plugin&kw=%E9%9B%86%E6%88%90`);
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.provider, 'plugin');
    assert.equal(searchData.tracks[0].trackId, 'it-1');
    assert.ok(searchData.tracks[0].raw.id === 'it-1');

    // 点歌（携带 raw）→ 服务端调插件取流并广播
    client.send({ type: 'enqueue', track: searchData.tracks[0] });
    const st = await client.latestState((s) => s.playback && s.playback.url, 5000);
    assert.equal(st.playback.trackId, 'it-1');
    assert.match(st.playback.url, /\/audio\/it-1\.mp3$/, '插件源应由插件解析播放地址');

    // 歌词（POST 通道，回传 raw）
    const lyricRes = await fetch(`${base}/api/v1/music/lyric`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'plugin', raw: st.playback.raw }) });
    assert.ok((await lyricRes.json()).lyric.includes('集成插件歌词'));

    const unauthorizedDelete = await fetch(`${base}/api/v1/music/plugin`, { method: 'DELETE' });
    assert.equal(unauthorizedDelete.status, 403, '删除插件与导入一样必须校验管理令牌');
    const pluginAfterDeleteAttempt = await fetch(`${base}/api/v1/music/plugin`);
    assert.ok((await pluginAfterDeleteAttempt.json()).plugin, '未授权删除不得改变插件状态');
    const authorizedDelete = await fetch(`${base}/api/v1/music/plugin`, {
      method: 'DELETE',
      headers: { 'x-plugin-token': 'it-token-123' },
    });
    assert.equal(authorizedDelete.status, 200);
  } finally {
    if (client) client.close();
    fx.close();
  }
});
