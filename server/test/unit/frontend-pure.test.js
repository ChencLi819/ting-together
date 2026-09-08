'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// 直接复用小程序端的纯函数模块，保证前后端行为一致
const { parseLrc, currentLineIndex, centeredScrollTop } = require('../../../miniprogram/utils/lyric');
const { formatTime, clamp, formatClock } = require('../../../miniprogram/utils/format');
const { shouldDiscardMembership } = require('../../../miniprogram/utils/session');
const { roomPresenceView } = require('../../../miniprogram/utils/playback');

test('LRC：解析、多时间标签、排序、元信息过滤', () => {
  const lrc = [
    '[ti:晴天]',
    '[ar:周杰伦]',
    '[00:01.50]第一句',
    '[00:10.00][00:35.20]副歌',
    '[00:05]中间句',
    '没有标签的行',
  ].join('\n');
  const lines = parseLrc(lrc);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].timeSec, 1.5);
  assert.equal(lines[0].text, '第一句');
  assert.equal(lines[1].timeSec, 5);
  assert.equal(lines[2].timeSec, 10);
  assert.equal(lines[2].text, '副歌');
  assert.equal(lines[3].timeSec, 35.2);
});

test('LRC：空文本与非法输入', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc('纯文本没有时间标签'), []);
});

test('当前行定位：二段式边界', () => {
  const lines = parseLrc('[00:01]A\n[00:05]B\n[00:09]C');
  assert.equal(currentLineIndex(lines, 0), -1, '第一行开始前无高亮');
  assert.equal(currentLineIndex(lines, 1), 0);
  assert.equal(currentLineIndex(lines, 4.9), 0);
  assert.equal(currentLineIndex(lines, 5), 1);
  assert.equal(currentLineIndex(lines, 99), 2, '最后一行持续高亮');
  assert.equal(currentLineIndex([], 1), -1);
});

test('歌词滚动：高亮行定位到可视区域正中并限制最小滚动位置', () => {
  assert.equal(centeredScrollTop({
    currentScrollTop: 120,
    viewportTop: 100,
    viewportHeight: 400,
    lineTop: 300,
    lineHeight: 40,
  }), 140);
  assert.equal(centeredScrollTop({
    currentScrollTop: 0,
    viewportTop: 100,
    viewportHeight: 400,
    lineTop: 110,
    lineHeight: 40,
  }), 0);
});

test('房间人数：优先使用在线人数，兼容仅有用户列表或成员总数的快照', () => {
  assert.deepEqual(roomPresenceView({ users: [{ id: 'u1' }], onlineCount: 2, memberCount: 3 }), {
    users: [{ id: 'u1' }],
    onlineCount: 2,
  });
  assert.equal(roomPresenceView({ users: [{ id: 'u1' }, { id: 'u2' }], memberCount: 3 }).onlineCount, 2);
  assert.equal(roomPresenceView({ memberCount: 3 }).onlineCount, 3);
});

test('时间格式化', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(65), '01:05');
  assert.equal(formatTime(600.7), '10:00');
  assert.equal(formatTime(-1), '00:00');
  assert.equal(formatTime(NaN), '00:00');
});

test('clamp 与时刻格式化', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(NaN, 1, 2), 1);
  const now = new Date('2026-09-07T10:30:00').getTime();
  assert.equal(formatClock(now, now), '10:30');
  const yesterday = now - 25 * 3600000;
  assert.match(formatClock(yesterday, now), /^\d{1,2}-\d{1,2}$/);
});

test('房间凭据：仅明确失效时清除，临时网络错误保留', () => {
  assert.equal(shouldDiscardMembership({ code: 'NOT_FOUND', status: 404 }), true);
  assert.equal(shouldDiscardMembership({ code: 'AUTH_FAILED', status: 403 }), true);
  assert.equal(shouldDiscardMembership({ code: 'NETWORK', message: 'timeout' }), false);
  assert.equal(shouldDiscardMembership({ code: 'HTTP', status: 503 }), false);
  assert.equal(shouldDiscardMembership(null), false);
});
