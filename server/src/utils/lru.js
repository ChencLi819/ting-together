'use strict';

/**
 * 带 TTL 与容量上限的 LRU 缓存。用于音乐源搜索结果/播放地址/歌词。
 */
class TtlLruCache {
  constructor({ maxEntries = 500, defaultTtlMs = 60000, now = Date.now }) {
    if (maxEntries < 1) throw new Error('maxEntries 至少为 1');
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.now = now;
    /** @type {Map<string, {value:*, expiresAt:number}>} */
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // 触发 LRU 语义：重新插入到队尾
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (ttlMs <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { TtlLruCache };
