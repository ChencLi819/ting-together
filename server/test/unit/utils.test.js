'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { RateLimiter } = require('../../src/utils/rateLimiter');
const { TtlLruCache } = require('../../src/utils/lru');
const { randomHex, roomCode, guestName } = require('../../src/utils/id');

test('限流器：滑动窗口内限次，窗口滑动后恢复', () => {
  let t = 0;
  const limiter = new RateLimiter({ windowMs: 1000, max: 3, now: () => t });
  assert.equal(limiter.tryConsume('k'), true);
  assert.equal(limiter.tryConsume('k'), true);
  assert.equal(limiter.tryConsume('k'), true);
  assert.equal(limiter.tryConsume('k'), false, '第 4 次应被限流');

  t += 1200;
  assert.equal(limiter.tryConsume('k'), true, '滑出窗口后应恢复');
  assert.equal(limiter.tryConsume('k'), true);
  assert.equal(limiter.tryConsume('k'), true);
  assert.equal(limiter.tryConsume('k'), false, '新窗口第 4 次应被限流');
});

test('限流器：key 之间互不影响，gc 清理空桶', () => {
  let t = 0;
  const limiter = new RateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(limiter.tryConsume('a'), true);
  assert.equal(limiter.tryConsume('b'), true);
  t += 2000;
  limiter.gc(t - 1000);
  assert.equal(limiter.tryConsume('a'), true);
});

test('TTL LRU：过期失效、容量淘汰、访问续命', () => {
  let t = 0;
  const cache = new TtlLruCache({ maxEntries: 2, defaultTtlMs: 100, now: () => t });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  t += 150;
  assert.equal(cache.get('a'), undefined, '过期后应失效');

  cache.set('a', 1);
  cache.set('b', 2);
  void cache.get('a'); // 访问 a，使 b 成为最久未用
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined, '超出容量应淘汰最久未用的 b');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('ID：格式与唯一性', () => {
  assert.match(randomHex(8), /^[0-9a-f]{16}$/);
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = roomCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 190, '邀请码应基本不重复');
  assert.match(guestName(), /^乐迷#[0-9A-F]{4}$/);
});
