'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 简易 .env 加载器（无三方依赖）。已存在的环境变量优先，不覆盖。
 */
function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前值: "${raw}"`);
  }
  if (value < min || value > max) {
    throw new Error(`环境变量 ${name} 取值必须在 [${min}, ${max}]，当前值: ${value}`);
  }
  return value;
}

function enumEnv(name, fallback, allowed) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    throw new Error(`环境变量 ${name} 必须是 ${allowed.join('|')} 之一，当前值: "${raw}"`);
  }
  return raw;
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const config = {
  env: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  http: {
    host: process.env.HOST || '0.0.0.0',
    port: intEnv('PORT', 3100, { min: 1, max: 65535 }),
  },
  logLevel: enumEnv('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
  music: {
    primary: enumEnv('MUSIC_PROVIDER', 'qqmusic', ['qqmusic', 'netease', 'mock']),
    publicWsUrl: process.env.PUBLIC_WS_URL || '',
    /**
     * 网易云自有账号凭据（MUSIC_U cookie 值）。设置后用该账号的权益解析完整曲目。
     * 属个人凭据：仅放 .env，不入库不外传；账号长期未登录会过期，需更新。
     */
    neteaseCookie: process.env.NCM_COOKIE || '',
    /**
     * 插件导入管理令牌（可选）。设置后，导入/更换音乐插件必须携带 x-plugin-token 头。
     * 公网部署时强烈建议设置（导入接口等于"服务端加载并执行第三方 JS"）。
     */
    pluginImportToken: process.env.PLUGIN_IMPORT_TOKEN || '',
  },
  room: {
    maxUsers: intEnv('ROOM_MAX_USERS', 8, { min: 2, max: 64 }),
    idleMs: intEnv('ROOM_IDLE_MS', 3600000, { min: 60000, max: 86400000 * 7 }),
    chatHistoryLimit: 50,
    queueLimit: 200,
    /** 主机模式下允许点歌，但播放控制仅房主 */
    hostOnlyControlDefault: process.env.ROOM_HOST_ONLY === '1',
  },
  rate: {
    chat: {
      windowMs: intEnv('CHAT_RATE_WINDOW_MS', 2000, { min: 200, max: 60000 }),
      max: intEnv('CHAT_RATE_MAX', 6, { min: 1, max: 100 }),
    },
    enqueue: {
      windowMs: intEnv('ENQUEUE_RATE_WINDOW_MS', 10000, { min: 500, max: 600000 }),
      max: intEnv('ENQUEUE_RATE_MAX', 8, { min: 1, max: 100 }),
    },
  },
  ws: {
    /** hello 握手超时 */
    helloTimeoutMs: 5000,
    /** 服务器 ping 周期，两倍周期无响应则断开 */
    heartbeatIntervalMs: 15000,
    /** 单条上行消息最大字节数 */
    maxMessageBytes: 8192,
    /** 房间状态广播合并窗口，防止高频操作刷屏 */
    stateBroadcastCoalesceMs: 80,
  },
  cache: {
    searchTtlMs: 10 * 60 * 1000,
    urlTtlMs: 20 * 60 * 1000,
    lyricTtlMs: 24 * 60 * 60 * 1000,
  },
  outbound: {
    timeoutMs: 8000,
    retries: 1,
  },
};

function validateConfig() {
  if (!Number.isInteger(config.http.port) || config.http.port <= 0) {
    throw new Error('配置错误: PORT 非法');
  }
  if (config.room.maxUsers < 2) {
    throw new Error('配置错误: ROOM_MAX_USERS 至少为 2（双人一起听）');
  }
  if (config.ws.stateBroadcastCoalesceMs >= config.ws.helloTimeoutMs) {
    throw new Error('配置错误: 广播合并窗口必须小于握手超时');
  }
}

module.exports = { config, validateConfig, loadDotEnv };
