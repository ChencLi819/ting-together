'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const NAV_PATH = require.resolve('../../../miniprogram/utils/navigation');

afterEach(() => {
  delete global.wx;
  delete require.cache[NAV_PATH];
});

test('进入房间：navigateTo 失败时使用 redirectTo 兜底', async () => {
  const calls = [];
  global.wx = {
    navigateTo(options) {
      calls.push(['navigateTo', options.url]);
      options.fail({ errMsg: 'navigateTo:fail page limit exceeded' });
    },
    redirectTo(options) {
      calls.push(['redirectTo', options.url]);
      options.success();
    },
  };
  const { navigateToRoom } = require(NAV_PATH);

  await navigateToRoom('ABCDEF');
  assert.deepEqual(calls, [
    ['navigateTo', '/pages/room/room?code=ABCDEF'],
    ['redirectTo', '/pages/room/room?code=ABCDEF'],
  ]);
});

test('进入房间：两种导航都失败时返回明确错误', async () => {
  global.wx = {
    navigateTo(options) { options.fail({ errMsg: 'navigate failed' }); },
    redirectTo(options) { options.fail({ errMsg: 'redirect failed' }); },
  };
  const { navigateToRoom } = require(NAV_PATH);

  await assert.rejects(navigateToRoom('ABCDEF'), /进入房间页面失败.*redirect failed/);
});
