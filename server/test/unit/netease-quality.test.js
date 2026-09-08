'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// 纯函数离线测试：档位映射与 URL 构造（不发任何网络请求）
const netease = require('../../src/music/providers/netease');

test('音质档位 → br 参数映射', () => {
  assert.equal(netease.BR_MAP.standard, 128000);
  assert.equal(netease.BR_MAP.high, 320000);
  assert.equal(netease.BR_MAP.lossless, 999000);
});

test('取流地址按档位携带 br，非法/缺省兜底 320k', () => {
  assert.match(netease.buildPlayerUrl('2652820720', 128000), /br=128000/);
  assert.match(netease.buildPlayerUrl('2652820720', 320000), /br=320000/);
  assert.match(netease.buildPlayerUrl('2652820720', 999000), /br=999000/);
  assert.match(netease.buildPlayerUrl('2652820720'), /br=320000/, '缺省兜底 320k');
  assert.match(netease.buildPlayerUrl('2652820720', NaN), /br=320000/, '非法值兜底 320k');
  assert.match(netease.buildPlayerUrl('2652820720', -1), /br=320000/, '负数兜底 320k');
  assert.ok(netease.buildPlayerUrl('2652820720', 320000).startsWith('https://music.163.com/api/song/enhance/player/url'));
});
