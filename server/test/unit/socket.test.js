'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const CONFIG_PATH = require.resolve('../../../miniprogram/utils/config');
const SOCKET_PATH = require.resolve('../../../miniprogram/utils/socket');

afterEach(() => {
  delete global.wx;
  delete require.cache[CONFIG_PATH];
  delete require.cache[SOCKET_PATH];
});

test('云 REST 可用但 connectContainer 缺失时，socket 明确降级到 HTTP 轮询', () => {
  global.wx = {
    getStorageSync() { return ''; },
    cloud: {
      callContainer() {},
    },
  };
  delete require.cache[CONFIG_PATH];
  delete require.cache[SOCKET_PATH];
  const config = require(CONFIG_PATH);
  const { createSocket } = require(SOCKET_PATH);

  assert.equal(config.isCloudMode(), true, '云模式只应依赖 REST 云调用能力');
  let unsupported = 0;
  const socket = createSocket({ onUnsupported: () => { unsupported += 1; } });
  socket.connect({ type: 'hello', token: 't', userId: 'u', name: 'n', code: 'ABCDEF' });
  assert.equal(unsupported, 1, '缺少云 WebSocket 能力时应立即切换轮询');
  socket.close();
});

test('connectContainer 创建抛错时同样降级，不做无限重连', () => {
  global.wx = {
    getStorageSync() { return ''; },
    cloud: {
      callContainer() {},
      connectContainer() { throw new Error('unsupported'); },
    },
  };
  delete require.cache[CONFIG_PATH];
  delete require.cache[SOCKET_PATH];
  const { createSocket } = require(SOCKET_PATH);

  let unsupported = 0;
  const socket = createSocket({ onUnsupported: () => { unsupported += 1; } });
  socket.connect({ type: 'hello', token: 't', userId: 'u', name: 'n', code: 'ABCDEF' });
  assert.equal(unsupported, 1);
  socket.close();
});
