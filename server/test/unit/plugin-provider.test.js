'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 插件持久化文件隔离到临时目录（测试前设定）
process.env.PLUGIN_DATA_FILE = path.join(os.tmpdir(), `ting-plugin-test-${process.pid}.json`);

const pluginProvider = require('../../src/music/providers/plugin');
const runner = require('../../src/music/pluginRunner');
const store = require('../../src/music/pluginStore');

/** fixture：同时充当「被插件调用的音乐 API」与「插件脚本托管」 */
const fxBase = { v: '' };
let lastQuality = '';
let srv = null;

before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/plugin.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(buildPluginJs());
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/search') {
      res.end(JSON.stringify({ tracks: [{ trackId: 'fx1', title: '插件测试歌', artist: 'F', album: 'A', durationSec: 180 }] }));
    } else if (u.pathname === '/url') {
      lastQuality = u.searchParams.get('q') ?? '';
      res.end(JSON.stringify({ url: `http://127.0.0.1:9/fx/${u.searchParams.get('id')}.mp3`, trial: false }));
    } else if (u.pathname === '/lyric') {
      res.end(JSON.stringify({ lyric: '[00:01.00]插件歌词' }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  fxBase.v = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  srv.close();
  try {
    fs.rmSync(process.env.PLUGIN_DATA_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
});

/** 延迟构造：fxBase.v 在 before() 里才赋值，脚本必须现取现用 */
function buildPluginJs() {
  return `
module.exports = {
  platform: '测试插件',
  version: '1.0.0',
  async search(keyword, page) {
    const r = await fetch('${fxBase.v}/search?kw=' + encodeURIComponent(keyword) + '&page=' + page);
    const j = await r.json();
    return { isEnd: true, data: j.tracks.map(t => ({ id: t.trackId, title: t.title, artist: t.artist, duration: t.durationSec })) };
  },
  async getMediaSource(musicItem, quality) {
    const r = await fetch('${fxBase.v}/url?id=' + encodeURIComponent(musicItem.id) + '&q=' + quality);
    const j = await r.json();
    return { url: j.url, trial: j.trial };
  },
  async getLyric(musicItem) {
    const r = await fetch('${fxBase.v}/lyric?id=' + encodeURIComponent(musicItem.id));
    const j = await r.json();
    return { rawLrc: j.lyric };
  },
};
`;
}

test('沙箱：合法插件可评估，必需实现与危险用法校验生效', () => {
  const exports = runner.evaluate(buildPluginJs(), 'test');
  assert.equal(exports.platform, '测试插件');
  assert.equal(typeof exports.search, 'function');

  assert.throws(() => runner.evaluate('module.exports = 42;', 'bad'), /导出对象/);
  assert.throws(() => runner.evaluate('module.exports = {};', 'bad2'), /search \/ getMediaSource/);
  assert.throws(() => runner.evaluate('while(true){}', 'loop'), /执行失败|超时/);
  // 评估期就调用 require：沙箱无 require，应立即失败
  assert.throws(
    () => runner.evaluate('const fs = require("fs"); module.exports = { platform: "x", search() {}, getMediaSource() {} };', 'needreq'),
    /执行失败/,
  );
});

test('插件全链路：导入→搜索→取流（档位映射）→歌词', async () => {
  const info = await store.importFromUrl(`${fxBase.v}/plugin.js`);
  assert.equal(info.name, '测试插件');
  assert.equal(info.version, '1.0.0');
  assert.ok(info.url.startsWith(fxBase.v), '记录插件来源地址');
  assert.equal(info.script, undefined, '公开信息不泄露脚本内容');

  const tracks = await pluginProvider.search('插件测试歌', { page: 1 });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].trackId, 'fx1');
  assert.equal(tracks[0].source, 'plugin');
  assert.ok(tracks[0].raw && tracks[0].raw.id === 'fx1', 'raw musicItem 应保留');

  const url = await pluginProvider.playUrl(tracks[0].trackId, { quality: 'lossless', raw: tracks[0].raw });
  assert.match(url.url, /fx\/fx1\.mp3$/);
  assert.equal(lastQuality, 'super', 'lossless 应映射为 MusicFree 的 super');

  const lyric = await pluginProvider.lyric(tracks[0].trackId, { raw: tracks[0].raw });
  assert.match(lyric, /插件歌词/);
});

test('插件导入：非法地址/坏脚本应被拒绝', async () => {
  await assert.rejects(() => store.importFromUrl('ftp://x'), /合法/);
  await assert.rejects(() => store.importFromUrl(`${fxBase.v}/not-found`), /下载失败/);
  // fixture /search 返回 JSON 而非插件脚本 → 沙箱评估应失败
  await assert.rejects(() => store.importFromUrl(`${fxBase.v}/search?kw=x`));
});
