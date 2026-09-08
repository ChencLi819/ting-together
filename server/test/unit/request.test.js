'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const CONFIG_PATH = require.resolve('../../../miniprogram/utils/config');
const REQUEST_PATH = require.resolve('../../../miniprogram/utils/request');

afterEach(() => {
  delete global.wx;
  delete require.cache[CONFIG_PATH];
  delete require.cache[REQUEST_PATH];
});

test('插件导入：管理令牌通过云调用请求头传递', async () => {
  let captured = null;
  global.wx = {
    getStorageSync() { return ''; },
    cloud: {
      callContainer(options) {
        captured = options;
        options.success({ statusCode: 200, data: { plugin: { name: '测试插件' } } });
      },
    },
  };
  delete require.cache[CONFIG_PATH];
  delete require.cache[REQUEST_PATH];
  const { api } = require(REQUEST_PATH);

  await api.importPlugin('https://plugins.test/music.js', 'admin-secret');
  assert.equal(captured.header['x-plugin-token'], 'admin-secret');
  assert.equal(captured.header['content-type'], 'application/json');
});

test('云调用返回 JSON 字符串时解析为对象，加入房间可读取 code/token', async () => {
  global.wx = {
    getStorageSync() { return ''; },
    cloud: {
      callContainer(options) {
        options.success({
          statusCode: 200,
          data: JSON.stringify({ roomId: 'r1', code: 'ABCDEF', userId: 'u1', token: 'tk', name: '访客' }),
        });
      },
    },
  };
  delete require.cache[CONFIG_PATH];
  delete require.cache[REQUEST_PATH];
  const { api } = require(REQUEST_PATH);

  const joined = await api.joinRoom('ABCDEF', '访客');
  assert.equal(joined.code, 'ABCDEF');
  assert.equal(joined.token, 'tk');
});
