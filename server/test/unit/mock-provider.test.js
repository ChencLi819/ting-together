'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.MUSIC_PROVIDER = 'mock';
const mock = require('../../src/music/providers/mock');
const provider = require('../../src/music/provider');

test('mock 源：搜索按关键词匹配', () => {
  const tracks = mock.search('雨');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].trackId, 'm003');
  assert.equal(mock.search('不存在的歌').length, 0);
  assert.equal(mock.search('').length, 0);
});

test('mock 源：播放地址与歌词', () => {
  const url = mock.playUrl('m001');
  assert.equal(url.url, 'https://cdn.mock.local/stream/m001.mp3');
  assert.equal(mock.playUrl('m002').trial, true, 'm002 应标记为试听');
  assert.equal(mock.playUrl('m004'), null, 'm004 模拟无版权');
  assert.equal(mock.playUrl('unknown'), null);
  assert.ok(mock.lyric('m001').startsWith('[ti:'));
  assert.equal(mock.lyric('unknown'), '');
});

test('门面：mock 主源下搜索与解析不外呼真实源', async () => {
  const res = await provider.search('雨');
  assert.equal(res.provider, 'mock');
  assert.ok(res.tracks.length > 0);

  const url = await provider.resolveUrl({ source: 'mock', trackId: 'm001', title: '测试之歌一', artist: '' });
  assert.equal(url.url, 'https://cdn.mock.local/stream/m001.mp3');

  const noUrl = await provider.resolveUrl({ source: 'mock', trackId: 'm004', title: '晴天测试版', artist: '' });
  assert.equal(noUrl, null, 'mock 无版权曲目直接返回 null');

  const lyric = await provider.fetchLyric({ source: 'mock', trackId: 'm001', title: '', artist: '' });
  assert.ok(lyric.includes('测试歌词'));
});

test('门面：缓存命中（第二次不重复解析）', async () => {
  const first = await provider.resolveUrl({ source: 'mock', trackId: 'm002', title: '测试之歌二', artist: '' });
  const second = await provider.resolveUrl({ source: 'mock', trackId: 'm002', title: '测试之歌二', artist: '' });
  assert.equal(first.url, second.url);
  assert.equal(first.trial, true);
});
