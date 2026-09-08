'use strict';

const { fetchJson } = require('../../utils/http');
const { createLogger } = require('../../logger');

const log = createLogger('music:qqmusic');

const SEARCH_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const VKEY_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg?g_tk=5381&format=json';
const LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: 'https://y.qq.com/',
};

function coverUrl(albumMid) {
  if (!albumMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg?max_age=2592000`;
}

function normalizeSong(raw) {
  const singer = (raw.singer ?? []).map((s) => s.name).filter(Boolean).join('/');
  const track = {
    source: 'qqmusic',
    trackId: String(raw.mid ?? ''),
    title: String(raw.songname ?? raw.title ?? raw.name ?? '').trim(),
    artist: singer,
    album: String(raw.album?.name ?? ''),
    picUrl: coverUrl(raw.album?.mid),
    durationSec: Number.isFinite(Number(raw.interval)) ? Math.max(0, Math.round(Number(raw.interval))) : 0,
  };
  if (!track.trackId || !track.title) return null;
  // QQ 侧 VIP 曲目通常无法通过游客 vkey 取流，标记便于前端提示
  track.vipLikely = Boolean(raw.pay && (raw.pay.pay_play === 1 || raw.pay.pay_month === 1));
  return track;
}

/** 搜索歌曲（游客可用）。返回标准化 Track 列表；无结果返回 [] */
async function search(kw, { page = 1, pageSize = 30 } = {}) {
  const body = {
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { search_type: 0, query: String(kw), page_num: Math.max(1, page), num_per_page: Math.min(60, pageSize) },
    },
  };
  const json = await fetchJson(SEARCH_URL, { method: 'POST', headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (json.code !== 0 || json.req_1?.code !== 0) {
    throw new Error(`QQ 搜索接口异常 code=${json.code}/${json.req_1?.code}`);
  }
  const list = json.req_1?.data?.body?.song?.list ?? [];
  return list.map(normalizeSong).filter(Boolean);
}

/**
 * 游客取播放地址（vkey.GetVkeyServer）。仅对免费曲目有效；VIP 曲目返回 ''。
 */
async function playUrl(trackId, { guid } = {}) {
  const gid = guid || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => (b % 16).toString(16)).join('');
  const body = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: { guid: gid, songmid: [String(trackId)], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
    },
  };
  const json = await fetchJson(VKEY_URL, { method: 'POST', headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (json.code !== 0 || json.req_0?.code !== 0) {
    throw new Error(`QQ vkey 接口异常 code=${json.code}/${json.req_0?.code}`);
  }
  const info = json.req_0?.data?.midurlinfo?.[0];
  const sip = json.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/';
  if (!info || !info.purl) return null;
  const url = (sip + info.purl).replace(/^http:/, 'https:');
  return { url, trial: false };
}

/** 歌词（LRC 文本）。无歌词返回 '' */
async function lyric(trackId) {
  const qs = new URLSearchParams({
    songmid: String(trackId),
    pcachetime: String(Date.now()),
    g_tk: '5381',
    loginUin: '0',
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
  });
  const json = await fetchJson(`${LYRIC_URL}?${qs}`, { headers: BASE_HEADERS });
  if (!json || json.retcode !== 0 || !json.lyric) return '';
  try {
    return Buffer.from(json.lyric, 'base64').toString('utf8');
  } catch (err) {
    log.warn('QQ 歌词解码失败', err);
    return '';
  }
}

module.exports = { name: 'qqmusic', search, playUrl, lyric, normalizeSong };
