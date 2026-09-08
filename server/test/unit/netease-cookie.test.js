'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// 必须在引入 config 前设定：模拟用户配置了自有 VIP 账号凭据
process.env.NCM_COOKIE = 'TEST_MUSIC_U_TOKEN_0123456789abcdef';

const netease = require('../../src/music/providers/netease');

test('NCM 自有账号：配置 NCM_COOKIE 后请求头携带 MUSIC_U', () => {
  const headers = netease.buildHeaders();
  assert.match(headers.Cookie, /MUSIC_U=TEST_MUSIC_U_TOKEN_0123456789abcdef/, '应携带 MUSIC_U 凭据');
  assert.match(headers.Cookie, /os=pc/, '保留游客态基础 cookie');
  assert.equal(headers.Referer, 'https://music.163.com/');
});

test('NCM 自有账号：未配置时不携带 MUSIC_U（默认游客态）', () => {
  process.env.NCM_COOKIE = '';
  // 必须同时清掉 config 与 netease 的模块缓存，否则旧 config 实例仍被引用
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/music/providers/netease')];
  const freshNetease = require('../../src/music/providers/netease');
  const headers = freshNetease.buildHeaders();
  assert.doesNotMatch(headers.Cookie, /MUSIC_U/, '无凭据时不应出现 MUSIC_U');
  assert.match(headers.Cookie, /os=pc/);
});
