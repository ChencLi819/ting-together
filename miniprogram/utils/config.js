'use strict';

/**
 * 客户端配置（两种运行模式）：
 *
 * 1) 云调用模式（正式部署，推荐）：
 *    CLOUD_ENV_ID 填微信云托管环境 ID（控制台「设置 → 环境信息」里的 EnvID，形如 prod-xxxx）。
 *    留空时使用默认环境（当前账号只有一个环境时可用）。
 *    该模式下走 wx.cloud.callContainer / connectContainer，无需配置任何合法域名。
 *
 * 2) 直连模式（本地开发）：CLOUD_ENV_ID 留空且用 SERVER_BASE 指向局域网/本机服务端，
 *    需在开发者工具勾选「不校验合法域名」。
 */

const RUN_MODE = 'cloud'; // 'cloud' = 正式部署（云调用）| 'lan' = 本地直连开发
const CLOUD_ENV_ID = 'prod-d8glcae0951580192'; // 云托管环境 ID（控制台「设置 → 环境信息」）
const CLOUD_SERVICE = 'ting-together'; // 云托管服务名

const BASE_KEY = 'ting_server_base';
// 直连模式的默认地址（本地开发用）
const DEFAULT_BASE = 'http://127.0.0.1:3100';

function getCloudEnvId() {
  try {
    const saved = wx.getStorageSync('ting_cloud_env');
    if (typeof saved === 'string' && saved) return saved;
  } catch (e) {
    // 忽略存储异常
  }
  return CLOUD_ENV_ID;
}

/** 云调用模式：走微信内部通道，免合法域名 */
function isCloudMode() {
  // REST 云调用可用即可进入云模式；WebSocket 能力由 socket 层单独探测，
  // 缺失或不可用时降级为基于 callContainer 的 HTTP 轮询。
  return RUN_MODE === 'cloud' && Boolean(wx.cloud && wx.cloud.callContainer);
}

function getServerBase() {
  try {
    const saved = wx.getStorageSync(BASE_KEY);
    if (typeof saved === 'string' && /^https?:\/\/.+/.test(saved)) return saved.replace(/\/+$/, '');
  } catch (e) {
    // 存储异常时回退默认值
  }
  return DEFAULT_BASE;
}

function setServerBase(base) {
  const clean = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(clean)) return false;
  try {
    wx.setStorageSync(BASE_KEY, clean);
  } catch (e) {
    return false;
  }
  return true;
}

function restBase() {
  return getServerBase();
}

/** ws(s):// 地址由 http(s) 推导（仅直连模式使用） */
function wsBase() {
  return getServerBase().replace(/^http/, 'ws');
}

function wsUrl() {
  return `${wsBase()}/ws`;
}

module.exports = {
  RUN_MODE,
  getCloudEnvId,
  isCloudMode,
  CLOUD_SERVICE,
  getServerBase,
  setServerBase,
  restBase,
  wsUrl,
  DEFAULT_BASE,
  BASE_KEY,
};
