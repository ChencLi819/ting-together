'use strict';

/**
 * 滑动窗口限流器：按 key（通常为 roomId:userId:动作）计数。
 */
class RateLimiter {
  constructor({ windowMs, max, now = Date.now }) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs 必须为正数');
    if (!Number.isFinite(max) || max <= 0) throw new Error('max 必须为正数');
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /** 命中返回 true（未超限并记录本次），否则 false */
  tryConsume(key) {
    const nowMs = this.now();
    const windowStart = nowMs - this.windowMs;
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length > 0 && arr[0] <= windowStart) arr.shift();
    if (arr.length >= this.max) {
      // 顺手清理空桶，避免长期运行内存泄漏
      if (this.hits.size > 10000) this.gc(windowStart);
      return false;
    }
    arr.push(nowMs);
    return true;
  }

  gc(windowStart) {
    for (const [key, arr] of this.hits) {
      while (arr.length > 0 && arr[0] <= windowStart) arr.shift();
      if (arr.length === 0) this.hits.delete(key);
    }
  }
}

module.exports = { RateLimiter };
