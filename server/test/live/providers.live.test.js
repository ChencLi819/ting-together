'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// 真实第三方音乐源连通性（G6 门禁）：需要外网；离线环境可用 SKIP_LIVE=1 跳过
// 设计原则：断言「产品能力端到端可用」（搜索→取流→歌词），单家上游限频时由
// 门面降级链兜底，避免门禁随第三方情绪闪断。
const netease = require('../../src/music/providers/netease');
const provider = require('../../src/music/provider');

test('门面搜索：任一上游可用即返回曲目', async () => {
  const { tracks, provider: hit } = await provider.search('周杰伦 晴天', { pageSize: 10 });
  assert.ok(tracks.length > 0, '搜索应返回结果');
  assert.ok(['qqmusic', 'netease'].includes(hit), `命中源应为真实源，实际: ${hit}`);
  const first = tracks[0];
  assert.ok(first.trackId && first.title, '曲目应含 trackId/title');
});

test('网易云直连：搜索+取流可用（降级链的兜底骨干）', async () => {
  const songs = await netease.search('晴天 周杰伦', { pageSize: 5 });
  assert.ok(songs.length > 0);
  const url = await netease.playUrl(songs[0].trackId);
  assert.ok(url && url.url, 'NCM 应返回播放地址');
  assert.match(url.url, /^https:/, '播放地址必须为 https');

  // 无损档：有 VIP 权益时返回 FLAC/高码率；无权益时上游自动降级返回低档，
  // 两种情况都只需保证接口可调用且返回 https 地址。
  const lossless = await netease.playUrl(songs[0].trackId, { quality: 'lossless' });
  assert.ok(lossless === null || /^https:/.test(lossless.url), '无损档应返回 https 地址或 null');
});

test('降级链：解析出可播放地址且音频真实可达', async () => {
  const { tracks } = await provider.search('周杰伦', { pageSize: 5 });
  assert.ok(tracks.length > 0);
  let resolved = null;
  let resolvedTrack = null;
  for (const track of tracks) {
    const result = await provider.resolveUrl(track);
    if (result && result.url) {
      resolved = result;
      resolvedTrack = track;
      break;
    }
  }
  assert.ok(resolved, '前 5 首中至少一首应能解析出播放地址（QQ vkey 或跨源网易云）');
  assert.match(resolved.url, /^https:/);

  // 播放地址必须真实可流式访问
  const head = await fetch(resolved.url, { method: 'HEAD' });
  assert.equal(head.status, 200, `音频应可访问: ${resolved.url.slice(0, 80)}`);
  assert.match(head.headers.get('content-type') || '', /audio|octet-stream/, 'Content-Type 应为音频');

  // 歌词链路
  const lyric = await provider.fetchLyric(resolvedTrack);
  assert.equal(typeof lyric, 'string', '歌词应返回字符串（可能为空）');
});
