'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const SYNC_PATH = require.resolve('../../../miniprogram/utils/sync');

function makeAudio() {
  const handlers = {};
  let src = '';
  return {
    paused: true,
    currentTime: 0,
    seeks: [],
    stopCount: 0,
    playCount: 0,
    pauseCount: 0,
    get src() {
      return src;
    },
    set src(value) {
      src = value;
      this.paused = false;
    },
    play() {
      this.paused = false;
      this.playCount += 1;
    },
    pause() {
      this.paused = true;
      this.pauseCount += 1;
    },
    stop() {
      this.paused = true;
      this.stopCount += 1;
      src = '';
    },
    seek(pos) {
      this.currentTime = pos;
      this.seeks.push(pos);
    },
    onCanplay(fn) { handlers.canplay = fn; },
    onTimeUpdate(fn) { handlers.timeupdate = fn; },
    onEnded(fn) { handlers.ended = fn; },
    onError(fn) { handlers.error = fn; },
    onPrev(fn) { handlers.prev = fn; },
    onNext(fn) { handlers.next = fn; },
    emit(name) {
      if (handlers[name]) handlers[name]();
    },
  };
}

function playback(overrides = {}) {
  return {
    source: 'mock',
    trackId: 'm001',
    title: '测试曲目',
    artist: '测试歌手',
    album: '',
    picUrl: '',
    durationSec: 180,
    status: 'playing',
    startAtSec: 0,
    positionSec: 10,
    url: 'https://cdn.test/m001.mp3',
    ...overrides,
  };
}

let audio;

beforeEach(() => {
  audio = makeAudio();
  global.wx = { getBackgroundAudioManager: () => audio };
  delete require.cache[SYNC_PATH];
});

afterEach(() => {
  delete global.wx;
  delete require.cache[SYNC_PATH];
});

test('同步引擎：切歌或切音质等待 URL 时立即停止旧音频', () => {
  const { createSyncEngine } = require(SYNC_PATH);
  const engine = createSyncEngine();

  engine.applyState({ playback: playback() });
  assert.equal(audio.src, 'https://cdn.test/m001.mp3');

  engine.applyState({ playback: playback({ trackId: 'm002', status: 'loading', positionSec: 0, url: '' }) });
  assert.equal(audio.stopCount, 1, '新曲目尚未取到 URL 时旧音频必须停止');
  assert.equal(engine.isLoaded(), false);

  engine.stop();
});

test('同步引擎：远端暂停与 seek 快照会立即对齐，但普通轮询快照不会反复 seek', () => {
  const { createSyncEngine } = require(SYNC_PATH);
  const engine = createSyncEngine();

  engine.applyState({ playback: playback({ startAtSec: 0, positionSec: 10 }) });
  audio.emit('canplay');
  audio.currentTime = 12;
  audio.seeks.length = 0;

  engine.applyState({ playback: playback({ status: 'paused', startAtSec: 8, positionSec: 8 }) });
  assert.equal(audio.paused, true);
  assert.deepEqual(audio.seeks, [8], '远端暂停位置必须同步到本机');

  audio.seeks.length = 0;
  engine.applyState({ playback: playback({ status: 'playing', startAtSec: 50, positionSec: 50 }) });
  assert.deepEqual(audio.seeks, [50], '远端恢复/seek 的新锚点必须同步到本机');

  audio.seeks.length = 0;
  engine.applyState({ playback: playback({ status: 'playing', startAtSec: 50, positionSec: 51.5 }) });
  assert.deepEqual(audio.seeks, [], '同一锚点的周期快照不得触发重复 seek');

  engine.stop();
});

test('同步引擎：音频错误携带曲目 ID，避免双端错误连续跳过多首', () => {
  const { createSyncEngine } = require(SYNC_PATH);
  const sent = [];
  const engine = createSyncEngine({ sendCtl: (action, extra) => sent.push({ action, extra }) });
  engine.applyState({ playback: playback() });

  audio.emit('error');

  assert.deepEqual(sent.at(-1), { action: 'skip', extra: { trackId: 'm001' } });
  engine.stop();
});

test('同步引擎：稳定播放期只观测音频时钟，不因周期快照做硬 seek', () => {
  const realNow = Date.now;
  let nowMs = 100000;
  Date.now = () => nowMs;
  try {
    const { createSyncEngine } = require(SYNC_PATH);
    const engine = createSyncEngine();
    engine.applyState({ playback: playback({ startAtSec: 0, positionSec: 10 }) });
    audio.emit('canplay');
    audio.seeks.length = 0;

    // 越过旧实现的 3 秒 seek 冷却，再模拟流媒体时钟与服务器外推值相差很大。
    nowMs += 4000;
    audio.currentTime = 25;
    audio.emit('timeupdate');
    assert.deepEqual(audio.seeks, []);

    engine.stop();
  } finally {
    Date.now = realNow;
  }
});

test('同步引擎兼容旧协议：不发送 ready，播放态和进度跟随真实音频', () => {
  const { createSyncEngine } = require(SYNC_PATH);
  const sent = [];
  const engine = createSyncEngine({ sendCtl: (action, extra) => sent.push({ action, extra }) });
  const legacyPlaying = playback({
    protocolVersion: 1,
    status: 'playing',
    startAtSec: 9,
    positionSec: 9,
    anchorMs: 12345,
  });

  engine.applyState({ playback: legacyPlaying });
  audio.emit('canplay');
  assert.equal(audio.paused, false, '旧协议 playing 快照应直接开始播放');
  assert.equal(sent.some((msg) => msg.action === 'ready'), false, '旧服务不支持 ready');

  audio.currentTime = 13.6;
  assert.equal(engine.displayPosition(), 13.6, 'UI 进度应读取正在播放的音频 currentTime');

  engine.applyState({ playback: { ...legacyPlaying, status: 'paused', isPlaying: false, positionSec: 13.6, startAtSec: 13.6, anchorMs: 23456 } });
  engine.userTogglePlay();
  assert.equal(sent.at(-1).action, 'play', '旧协议恢复动作应使用 play 而不是 resume');
  engine.stop();
});

test('旧协议周期快照：anchorMs 未变化时不得反复 seek', () => {
  const { createSyncEngine } = require(SYNC_PATH);
  const engine = createSyncEngine();
  const legacy = playback({ protocolVersion: 1, status: 'playing', startAtSec: 10, positionSec: 10, anchorMs: 555 });
  engine.applyState({ playback: legacy });
  audio.emit('canplay');
  audio.currentTime = 11;
  audio.seeks.length = 0;

  engine.applyState({ playback: { ...legacy, startAtSec: 11.5, positionSec: 11.5, anchorMs: 555 } });
  assert.deepEqual(audio.seeks, []);
  engine.stop();
});

test('播放按钮按服务器状态决策，不能被模拟器不可靠的 audio.paused 反向误导', () => {
  const { createSyncEngine } = require(SYNC_PATH);
  const sent = [];
  const engine = createSyncEngine({ sendCtl: (action, extra) => sent.push({ action, extra }) });

  engine.applyState({ playback: playback({ protocolVersion: 1 }) });
  audio.paused = true; // 微信模拟器在缓冲/不支持音频时可能仍报告 paused=true
  engine.userTogglePlay();
  assert.equal(sent.at(-1).action, 'pause', '服务器为 playing 时，点击必须始终上报 pause');

  engine.applyState({ playback: playback({ protocolVersion: 1, status: 'paused', positionSec: 12, anchorMs: 777 }) });
  audio.paused = false; // 反向模拟本地状态滞后
  engine.userTogglePlay();
  assert.equal(sent.at(-1).action, 'play', '服务器为 paused 时，点击必须始终上报 play');
  engine.stop();
});
