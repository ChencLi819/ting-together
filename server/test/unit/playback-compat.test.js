'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeRoomSnapshot, playbackViewState } = require('../../../miniprogram/utils/playback');

test('旧协议快照：isPlaying/anchorMs 归一为统一播放状态', () => {
  const legacy = {
    seq: 3,
    serverNowMs: 10000,
    playback: {
      source: 'mock',
      trackId: 'm001',
      title: '旧协议歌曲',
      durationSec: 180,
      isPlaying: true,
      positionSec: 12.5,
      anchorMs: 9000,
      url: 'https://cdn.test/m001.mp3',
    },
  };

  const normalized = normalizeRoomSnapshot(legacy);
  assert.equal(normalized.playback.status, 'playing');
  assert.equal(normalized.playback.protocolVersion, 1);
  assert.equal(normalized.playback.startAtSec, 12.5);
  assert.equal(normalized.playback.anchorMs, 9000);
  assert.equal(legacy.playback.status, undefined, '不得修改传输层原始快照');
});

test('新协议快照保持 loading/playing/paused 语义', () => {
  const modern = { playback: { trackId: 'm001', status: 'loading', startAtSec: 4, positionSec: 4, url: '' } };
  const normalized = normalizeRoomSnapshot(modern);
  assert.equal(normalized.playback.status, 'loading');
  assert.equal(normalized.playback.protocolVersion, 2);
  assert.equal(normalized.playback.startAtSec, 4);
});

test('播放控件展示：loading 准备中，playing 显示暂停，paused 显示播放', () => {
  assert.deepEqual(playbackViewState({ status: 'loading', url: 'https://audio.test/a.mp3' }), {
    playing: false,
    loading: true,
    disabled: true,
  });
  assert.deepEqual(playbackViewState({ status: 'playing', url: 'https://audio.test/a.mp3' }), {
    playing: true,
    loading: false,
    disabled: false,
  });
  assert.deepEqual(playbackViewState({ status: 'paused', url: 'https://audio.test/a.mp3' }), {
    playing: false,
    loading: false,
    disabled: false,
  });
});
