'use strict';

/**
 * 本地 Mock 音乐源：仅用于单元/集成测试，不发起任何网络请求。
 * 目录固定，搜索按关键词包含匹配。
 */
const CATALOG = [
  { source: 'mock', trackId: 'm001', title: '测试之歌一', artist: ' Mock乐队', album: '测试专辑A', picUrl: 'https://cdn.mock.local/pic/m001.jpg', durationSec: 180 },
  { source: 'mock', trackId: 'm002', title: '测试之歌二', artist: 'Mock乐队', album: '测试专辑A', picUrl: 'https://cdn.mock.local/pic/m002.jpg', durationSec: 240 },
  { source: 'mock', trackId: 'm003', title: '雨天', artist: '测试歌手', album: '测试专辑B', picUrl: 'https://cdn.mock.local/pic/m003.jpg', durationSec: 200 },
  { source: 'mock', trackId: 'm004', title: '晴天测试版', artist: '测试歌手', album: '测试专辑B', picUrl: '', durationSec: 150 },
];

function search(kw) {
  const needle = String(kw).trim().toLowerCase();
  if (!needle) return [];
  return CATALOG.filter(
    (t) => t.title.toLowerCase().includes(needle) || t.artist.toLowerCase().includes(needle) || t.album.toLowerCase().includes(needle),
  );
}

function playUrl(trackId) {
  const hit = CATALOG.find((t) => t.trackId === String(trackId));
  if (!hit) return null;
  // 特殊 id：模拟版权缺失场景，供测试降级链
  if (trackId === 'm004') return null;
  return { url: `https://cdn.mock.local/stream/${trackId}.mp3`, trial: trackId === 'm002' };
}

function lyric(trackId) {
  const hit = CATALOG.find((t) => t.trackId === String(trackId));
  if (!hit) return '';
  return `[ti:${hit.title}]\n[00:00.00]${hit.title} - ${hit.artist}\n[00:05.00]这是测试歌词第一行\n[00:10.00]这是测试歌词第二行\n[00:15.00]这是测试歌词第三行\n`;
}

module.exports = { name: 'mock', search, playUrl, lyric, CATALOG };
