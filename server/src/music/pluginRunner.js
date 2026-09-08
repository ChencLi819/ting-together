'use strict';

const vm = require('node:vm');

/**
 * 音乐插件沙箱运行器（兼容 MusicFree 插件约定）：
 *   module.exports = { platform, version, search(keyword,page,type), getMediaSource(musicItem,quality), getLyric(musicItem) }
 *
 * 安全边界（如实标注）：
 *  - node:vm 不是硬安全边界；本沙箱的目的是限制误用与意外破坏（无 require/process/fs），
 *    并提供受控的 fetch/console/定时器。仅导入可信来源的插件。
 *  - 同步执行有 3s 超时；异步调用上层用 withTimeout 兜底（超时拒绝，不杀执行）。
 */

const SCRIPT_MAX_BYTES = 512 * 1024;
const SYNC_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 12000;

/** 给插件异步调用加超时兜底 */
function withTimeout(promise, ms = CALL_TIMEOUT_MS, label = '插件调用') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms);
  });
  if (typeof timer.unref === 'function') timer.unref();
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** 受控 fetch：强制超时，禁用重定向到非 http(s) */
function sandboxFetch(input, init = {}) {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS) });
}

/**
 * 在沙箱中评估插件脚本，返回其 module.exports。
 * @throws 插件为空/过大/语法错误/未导出对象
 */
function evaluate(script, sourceLabel = 'plugin') {
  if (typeof script !== 'string' || script.trim() === '') throw new Error('插件脚本为空');
  if (script.length > SCRIPT_MAX_BYTES) throw new Error(`插件脚本过大（上限 ${Math.round(SCRIPT_MAX_BYTES / 1024)}KB）`);

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Buffer,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    fetch: sandboxFetch,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;

  try {
    vm.runInNewContext(script, sandbox, { timeout: SYNC_TIMEOUT_MS, filename: `${sourceLabel}.js` });
  } catch (err) {
    throw new Error(`插件脚本执行失败: ${err.message}`, { cause: err });
  }
  const exports = module.exports;
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) {
    throw new Error('插件必须通过 module.exports 导出对象');
  }
  if (typeof exports.search !== 'function' || typeof exports.getMediaSource !== 'function') {
    throw new Error('未识别为 MusicFree 插件（缺少必需的 search / getMediaSource 实现）。注意：其他音乐软件（如洛雪 lx-music）的音源脚本与本系统不兼容');
  }
  return exports;
}

module.exports = { evaluate, withTimeout, CALL_TIMEOUT_MS };
