'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchRaw } = require('../utils/http');
const runner = require('./pluginRunner');
const { createLogger } = require('../logger');

const log = createLogger('music:pluginStore');

// 数据文件路径可用环境变量覆盖（测试隔离用），默认随服务端数据目录持久化
const DATA_FILE = process.env.PLUGIN_DATA_FILE || path.join(__dirname, '..', '..', 'data', 'plugin.json');
const URL_MAX = 300;

let state = load();
let exportsCache = null;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && parsed.id && typeof parsed.script === 'string') return parsed;
  } catch {
    /* 无存档或损坏：视为未导入 */
  }
  return null;
}

function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
}

function publicInfo() {
  if (!state) return null;
  return { id: state.id, name: state.name, version: state.version, url: state.url, installedAt: state.installedAt };
}

/**
 * 从 URL 导入插件：下载 → 沙箱校验 → 提取元信息 → 持久化。
 * @returns {Promise<object>} 插件公开信息（不含脚本）
 */
async function importFromUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url) || url.length > URL_MAX) {
    throw new Error('插件地址需为合法的 http(s) URL');
  }
  const res = await fetchRaw(url, { timeoutMs: 10000, retries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`插件下载失败 (HTTP ${res.status})`);
  const exports = runner.evaluate(res.text ?? '', 'imported-plugin');
  const id = crypto.createHash('sha1').update(`${url}|${exports.platform ?? ''}`).digest('hex').slice(0, 12);
  state = {
    id,
    name: String(exports.platform ?? '未命名插件').slice(0, 32),
    version: String(exports.version ?? '').slice(0, 16),
    url,
    script: res.text ?? '',
    installedAt: Date.now(),
  };
  exportsCache = null; // 重导入必须重建导出缓存
  persist();
  log.info('插件已导入', { id: state.id, name: state.name });
  return publicInfo();
}

/** 当前插件信息（无则 null） */
function get() {
  return publicInfo();
}

/** 当前插件的沙箱导出对象（无则 null；评估失败抛错） */
function getExports() {
  if (!state) return null;
  if (!exportsCache) exportsCache = runner.evaluate(state.script, state.id);
  return exportsCache;
}

function clear() {
  state = null;
  exportsCache = null;
  try {
    fs.rmSync(DATA_FILE, { force: true });
  } catch {
    /* 忽略删除异常 */
  }
}

module.exports = { importFromUrl, get, getExports, clear, publicInfo };
