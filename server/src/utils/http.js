'use strict';

const { config } = require('../config');

/**
 * 对第三方 API 的 HTTP 客户端：超时 + 受控重试。
 * 返回 { status, ok, headers, text, json }；网络错误/超时按 retries 重试，5xx 重试一次。
 */
async function fetchRaw(url, { method = 'GET', headers = {}, body = null, timeoutMs = config.outbound.timeoutMs, retries = config.outbound.retries } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`请求超时(${timeoutMs}ms): ${url}`)), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === null ? undefined : body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error(`上游 ${res.status}: ${url}`);
        continue;
      }
      return { status: res.status, ok: res.ok, headers: res.headers, text, json };
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`请求失败: ${url}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetchRaw(url, options);
  if (res.json === null) {
    const err = new Error(`上游返回非 JSON (HTTP ${res.status}): ${url}`);
    err.status = res.status;
    err.bodySnippet = (res.text || '').slice(0, 200);
    throw err;
  }
  res.json.__httpStatus = res.status;
  return res.json;
}

module.exports = { fetchRaw, fetchJson };
