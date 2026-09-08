'use strict';

const qqmusic = require('./providers/qqmusic');
const netease = require('./providers/netease');
const mock = require('./providers/mock');
const plugin = require('./providers/plugin');
const { TtlLruCache } = require('../utils/lru');
const { config } = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('music:provider');

const REGISTRY = new Map(
  [qqmusic, netease, mock, plugin].map((p) => [p.name, p]),
);

const searchCache = new TtlLruCache({ maxEntries: 300, defaultTtlMs: config.cache.searchTtlMs });
const urlCache = new TtlLruCache({ maxEntries: 300, defaultTtlMs: config.cache.urlTtlMs });
const lyricCache = new TtlLruCache({ maxEntries: 300, defaultTtlMs: config.cache.lyricTtlMs });

function providerOrder(preferred) {
  const order = [preferred, 'qqmusic', 'netease'];
  return [...new Set(order)].filter((n) => REGISTRY.has(n));
}

function isMockOnly() {
  return config.music.primary === 'mock';
}

/**
 * 搜索：主源优先，失败自动降级到备用源。
 * @returns {Promise<{tracks:object[], provider:string}>}
 */
async function search(kw, { page = 1, pageSize = 30 } = {}) {
  const key = `s:${config.music.primary}:${kw}:${page}:${pageSize}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  let lastErr = null;
  for (const name of providerOrder(config.music.primary)) {
    const provider = REGISTRY.get(name);
    try {
      const tracks = await provider.search(kw, { page, pageSize });
      const result = { tracks, provider: name };
      searchCache.set(key, result);
      return result;
    } catch (err) {
      lastErr = err;
      log.warn(`搜索源 ${name} 失败，尝试降级`, err);
    }
  }
  throw new Error(`所有音乐源搜索失败: ${lastErr?.message ?? '未知错误'}`);
}

/**
 * 跨源匹配：在目标源搜索 "标题 歌手"，返回首个结果。
 */
async function crossMatch(providerName, track) {
  const provider = REGISTRY.get(providerName);
  if (!provider) return null;
  const query = [track.title, track.artist].filter(Boolean).join(' ');
  if (!query.trim()) return null;
  const { tracks } = await searchOn(providerName, query, 5);
  if (tracks.length === 0) return null;
  const normalizedTitle = String(track.title).replace(/\s+/g, '').toLowerCase();
  const exact = tracks.find((t) => String(t.title).replace(/\s+/g, '').toLowerCase() === normalizedTitle);
  return exact ?? tracks[0];
}

async function searchOn(providerName, kw, pageSize = 5) {
  const key = `m:${providerName}:${kw}:${pageSize}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  const result = await REGISTRY.get(providerName).search(kw, { pageSize });
  const wrapped = { tracks: result, provider: providerName };
  searchCache.set(key, wrapped);
  return wrapped;
}

/**
 * 解析可播放地址：
 *  - plugin/mock 源只走自身（用户定向/测试源，不参与自动降级）
 *  - 其余：先试曲目自身来源，再跨源降级到其他源
 * quality 为房间级音质档位，参与缓存键与上游取流参数。
 * @returns {Promise<{url:string, trial:boolean}|null>} 全部失败返回 null
 */
async function resolveUrl(track, { quality } = {}) {
  const cacheKey = `u:${track.source}:${track.trackId}:${quality ?? ''}`;
  const cached = urlCache.get(cacheKey);
  if (cached !== undefined) return cached && cached.url ? cached : null;

  const solo = track.source === 'mock' || track.source === 'plugin';
  const pool = solo ? [track.source] : providerOrder(config.music.primary);
  // 曲目自身来源放最前
  const chain = [...new Set([track.source, ...pool])].filter((n) => REGISTRY.has(n));

  for (const name of chain) {
    let target = track.source === name ? track : null;
    try {
      if (!target) {
        target = await crossMatch(name, track);
        if (!target) continue;
      }
      const result = await REGISTRY.get(name).playUrl(target.trackId, { quality, raw: target.raw });
      if (result && result.url) {
        const value = { url: result.url, trial: Boolean(result.trial) };
        urlCache.set(cacheKey, value);
        log.info(`解析播放地址成功 source=${name} quality=${quality ?? 'high'} title=${track.title}`);
        return value;
      }
      urlCache.set(cacheKey, null); // 该源明确不可播，缓存空结果避免反复请求
    } catch (err) {
      log.warn(`解析播放地址失败 source=${name} track=${track.trackId}`, err);
    }
  }
  urlCache.set(cacheKey, null);
  return null;
}

/**
 * 歌词：曲目自身来源优先，失败跨源匹配（plugin/mock 只走自身）。
 * @returns {Promise<string>} LRC 文本，可能为空串
 */
async function fetchLyric(track) {
  const cacheKey = `l:${track.source}:${track.trackId}`;
  const cached = lyricCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const solo = track.source === 'mock' || track.source === 'plugin';
  const pool = solo ? [track.source] : providerOrder(config.music.primary);
  const chain = [...new Set([track.source, ...pool])].filter((n) => REGISTRY.has(n));
  for (const name of chain) {
    try {
      const target = track.source === name ? track : await crossMatch(name, track);
      if (!target) continue;
      const text = await REGISTRY.get(name).lyric(target.trackId, { raw: target.raw });
      if (text) {
        lyricCache.set(cacheKey, text);
        return text;
      }
    } catch (err) {
      log.warn(`歌词获取失败 source=${name} track=${track.trackId}`, err);
    }
  }
  lyricCache.set(cacheKey, '');
  return '';
}

/** 按名称直接搜索（REST 显式选源用） */
async function searchNamed(name, kw, opts = {}) {
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`未知音乐源: ${name}`);
  const tracks = await p.search(kw, opts);
  return { tracks, provider: name };
}

function clearCaches() {
  searchCache.clear();
  urlCache.clear();
  lyricCache.clear();
}

module.exports = { search, searchNamed, resolveUrl, fetchLyric, clearCaches, isMockOnly, REGISTRY };
