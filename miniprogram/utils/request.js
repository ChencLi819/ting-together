'use strict';

const config = require('./config');

function normalizeResponseData(data) {
  if (typeof data !== 'string') return data;
  const text = data.trim();
  if (!text) return data;
  try {
    return JSON.parse(text);
  } catch (e) {
    return data;
  }
}

/**
 * REST 请求封装：Promise 化 + 超时 + 错误规范化。
 * 云调用模式（正式部署）走 wx.cloud.callContainer，免合法域名；
 * 直连模式（本地开发）走 wx.request。
 * 错误对象形如 { code: 'NETWORK'|'HTTP'|'SERVER', message, status }
 */
function parseQuery(path) {
  const qIdx = path.indexOf('?');
  if (qIdx === -1) return { cleanPath: path, query: null };
  const query = {};
  for (const pair of path.slice(qIdx + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      query[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch (e) {
      query[k] = v;
    }
  }
  return { cleanPath: path.slice(0, qIdx), query };
}

function cloudRequest(path, { method = 'GET', data = null, timeoutMs = 10000, headers = {} } = {}) {
  // callContainer 的 path 不允许携带查询串：GET 的参数合并进 data（框架会转成 query）
  let cleanPath = path;
  let payload = data ?? undefined;
  if (path.indexOf('?') !== -1) {
    const { cleanPath: cp, query } = parseQuery(path);
    cleanPath = cp;
    payload = { ...query, ...(data ?? {}) };
  }
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      // 兼容不同基础库的签名差异：env 顶层 / config.env / service 全量提供
      env: config.getCloudEnvId() || undefined,
      config: { env: config.getCloudEnvId() || undefined },
      service: config.CLOUD_SERVICE,
      path: cleanPath,
      method,
      data: payload,
      header: { 'content-type': 'application/json', ...headers },
      timeout: timeoutMs,
      success(res) {
        const responseData = normalizeResponseData(res.data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
          return;
        }
        const body = responseData ?? {};
        reject({
          code: body.code || 'HTTP',
          status: res.statusCode,
          message: body.message || `请求失败 (HTTP ${res.statusCode})`,
        });
      },
      fail(err) {
        // 失败详情直接可见：是哪个请求、哪个路径
        const detail = err && err.errMsg ? err.errMsg : 'cloud call fail';
        reject({
          code: 'NETWORK',
          message: `网络异常: ${detail} [${method} ${cleanPath}]`,
        });
      },
    });
  });
}

function urlRequest(path, { method = 'GET', data = null, timeoutMs = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.restBase()}${path}`,
      method,
      data: data ?? undefined,
      timeout: timeoutMs,
      header: { 'content-type': 'application/json', ...headers },
      success(res) {
        const responseData = normalizeResponseData(res.data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
          return;
        }
        const body = responseData ?? {};
        reject({
          code: body.code || 'HTTP',
          status: res.statusCode,
          message: body.message || `请求失败 (HTTP ${res.statusCode})`,
        });
      },
      fail(err) {
        reject({
          code: 'NETWORK',
          message: err && err.errMsg ? `网络异常: ${err.errMsg}` : '网络异常，请检查服务端地址',
        });
      },
    });
  });
}

function request(path, options = {}) {
  if (config.isCloudMode()) return cloudRequest(path, options);
  return urlRequest(path, options);
}

/** 兼容性安全的 query 构造（部分基础库缺 URLSearchParams） */
function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

const api = {
  createRoom(name) {
    return request('/api/v1/rooms', { method: 'POST', data: { name } });
  },
  joinRoom(code, name) {
    return request('/api/v1/rooms/join', { method: 'POST', data: { code, name } });
  },
  roomPreview(code) {
    return request(`/api/v1/rooms/${encodeURIComponent(code)}`);
  },
  /** source: auto=主源+降级链 | netease=直连网易云 | plugin=已导入插件。统一 POST（云调用链路） */
  searchMusic(kw, page = 1, source = 'auto') {
    const data = { kw, page, size: 30 };
    if (source && source !== 'auto') data.source = source;
    return request('/api/v1/music/search', { method: 'POST', data });
  },
  /** 音乐插件（MusicFree 兼容）：查询当前 / 导入 */
  getPlugin() {
    return request('/api/v1/music/plugin');
  },
  importPlugin(url, adminToken = '') {
    const headers = adminToken ? { 'x-plugin-token': adminToken } : {};
    return request('/api/v1/music/plugin', { method: 'POST', data: { url }, headers });
  },
  fetchLyric(track) {
    const data = {
      source: track.source,
      id: track.trackId,
      title: track.title || '',
      artist: track.artist || '',
    };
    if (track.source === 'plugin' && track.raw) data.raw = track.raw;
    return request('/api/v1/music/lyric', { method: 'POST', data });
  },
};

module.exports = { request, api, qs, normalizeResponseData };
