'use strict';

const { fetchJson } = require('../../utils/http');
const { config } = require('../../config');

const SEARCH_URL = 'https://music.163.com/api/search/get/web';
const PLAYER_URL = 'https://music.163.com/api/song/enhance/player/url';
const LYRIC_URL = 'https://music.163.com/api/song/lyric';

/**
 * 请求头：默认游客身份（os=pc）。
 * 配置了 NCM_COOKIE 时携带 MUSIC_U，用自有账号权益解锁完整曲目。
 */
function buildHeaders() {
  const cookieParts = ['os=pc', 'appver=2.10.13'];
  if (config.music.neteaseCookie) {
    cookieParts.unshift(`MUSIC_U=${config.music.neteaseCookie}`);
  }
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Referer: 'https://music.163.com/',
    Cookie: cookieParts.join('; '),
  };
}

function normalizeSong(raw) {
  const artist = (raw.artists ?? []).map((a) => a.name).filter(Boolean).join('/');
  const track = {
    source: 'netease',
    trackId: String(raw.id ?? ''),
    title: String(raw.name ?? '').trim(),
    artist,
    album: String(raw.album?.name ?? ''),
    picUrl: String(raw.album?.picUrl ?? ''),
    durationSec: Number.isFinite(Number(raw.duration)) ? Math.max(0, Math.round(Number(raw.duration) / 1000)) : 0,
  };
  if (!track.trackId || !track.title) return null;
  return track;
}

/** 搜索歌曲（无需加密的旧版 web 接口）。 */
async function search(kw, { page = 1, pageSize = 30 } = {}) {
  const offset = (Math.max(1, page) - 1) * Math.min(60, pageSize);
  const qs = new URLSearchParams({ s: String(kw), type: '1', limit: String(Math.min(60, pageSize)), offset: String(offset) });
  const json = await fetchJson(`${SEARCH_URL}?${qs}`, { headers: buildHeaders() });
  if (json.code !== 200) throw new Error(`NCM 搜索接口异常 code=${json.code}`);
  const songs = json.result?.songs ?? [];
  return songs.map(normalizeSong).filter(Boolean);
}

/** 音质档位 → 网易云 br 参数（standard=128k / high=320k / lossless=FLAC·需VIP） */
const BR_MAP = { standard: 128000, high: 320000, lossless: 999000 };

/** 构造取流接口地址（纯函数，便于测试档位映射；br 非法时兜底 320k） */
function buildPlayerUrl(trackId, br) {
  const effectiveBr = Number.isFinite(br) && br > 0 ? br : 320000;
  const qs = new URLSearchParams({ ids: `[${String(trackId)}]`, br: String(effectiveBr) });
  return `${PLAYER_URL}?${qs}`;
}

/**
 * 取播放地址。免费可播返回 {url, trial}；无版权/试听片段会带 trial 标记。
 * quality 档位映射到 br 参数；无损档需要账号有相应权益，否则上游自动降级返回低档音质。
 */
async function playUrl(trackId, { quality } = {}) {
  const br = BR_MAP[quality] ?? 320000;
  const json = await fetchJson(buildPlayerUrl(trackId, br), { headers: buildHeaders() });
  if (json.code !== 200) throw new Error(`NCM 取流接口异常 code=${json.code}`);
  const info = json.data?.[0];
  if (!info || !info.url) return null;
  const url = String(info.url).replace(/^http:/, 'https:');
  const trial = Boolean(info.freeTrialInfo);
  return { url, trial };
}

/** 歌词（LRC 文本）。 */
async function lyric(trackId) {
  const qs = new URLSearchParams({ id: String(trackId), lv: '1', kv: '1', tv: '-1' });
  const json = await fetchJson(`${LYRIC_URL}?${qs}`, { headers: buildHeaders() });
  if (!json || json.code !== 200 || !json.lrc?.lyric) return '';
  return String(json.lrc.lyric);
}

module.exports = { name: 'netease', search, playUrl, lyric, normalizeSong, buildHeaders, buildPlayerUrl, BR_MAP };
