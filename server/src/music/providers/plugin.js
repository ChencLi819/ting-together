'use strict';

const crypto = require('node:crypto');
const store = require('../pluginStore');
const { withTimeout } = require('../pluginRunner');

/**
 * MusicFree 插件源适配器：调用已导入插件的 search / getMediaSource / getLyric。
 * 音质映射：standard/high → 同名，lossless → super（MusicFree 档位）。
 * 曲目携带 raw（插件原始 musicItem），取流/歌词时原样回传给插件。
 */

const QUALITY_MAP = { standard: 'standard', high: 'high', lossless: 'super' };

function requirePlugin() {
  const api = store.getExports();
  if (!api) throw new Error('尚未导入音乐插件，请先在点歌页导入插件');
  return api;
}

/** 插件 musicItem → 标准化曲目（raw 原样保留供回传） */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const rawId = String(item.id ?? '');
  if (!rawId) return null;
  let trackId = rawId.slice(0, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(trackId)) {
    // 插件 id 可能含任意字符：不可用时降级为哈希 id（raw 已原样保留，回传不受影响）
    trackId = crypto.createHash('sha1').update(rawId).digest('hex').slice(0, 32);
  }
  let raw = item;
  try {
    if (JSON.stringify(item).length > 4096) {
      raw = { id: item.id, title: item.title, artist: item.artist, album: item.album, artwork: item.artwork, duration: item.duration };
    }
  } catch {
    raw = { id: item.id };
  }
  return {
    source: 'plugin',
    trackId,
    title: String(item.title ?? '').slice(0, 100),
    artist: String(item.artist ?? '').slice(0, 100),
    album: String(item.album ?? '').slice(0, 100),
    picUrl: /^https:\/\//.test(String(item.artwork ?? '')) ? String(item.artwork) : '',
    durationSec: Number.isFinite(Number(item.duration)) ? Math.max(0, Math.round(Number(item.duration))) : 0,
    raw,
  };
}

/** 搜索：调插件 search(keyword, page, type)，结果归一为标准曲目 */
async function search(kw, { page = 1 } = {}) {
  const api = requirePlugin();
  const res = await withTimeout(Promise.resolve(api.search(String(kw).slice(0, 60), page, 'music')), undefined, '插件搜索');
  const list = Array.isArray(res?.data) ? res.data : [];
  return list.map(normalizeItem).filter(Boolean);
}

/** 取流：调插件 getMediaSource(musicItem, quality) */
async function playUrl(trackId, { quality, raw } = {}) {
  const api = requirePlugin();
  const q = QUALITY_MAP[quality ?? 'high'] ?? 'high';
  const res = await withTimeout(Promise.resolve(api.getMediaSource(raw ?? { id: trackId }, q)), undefined, '插件取流');
  if (res && res.url) return { url: String(res.url), trial: Boolean(res.trial) };
  return null;
}

/** 歌词：调插件 getLyric(musicItem) → { rawLrc } */
async function lyric(trackId, { raw } = {}) {
  const api = requirePlugin();
  if (typeof api.getLyric !== 'function') return '';
  const res = await withTimeout(Promise.resolve(api.getLyric(raw ?? { id: trackId })), undefined, '插件歌词');
  return String(res?.rawLrc ?? res?.lrc ?? '');
}

module.exports = { name: 'plugin', search, playUrl, lyric, normalizeItem, QUALITY_MAP };
