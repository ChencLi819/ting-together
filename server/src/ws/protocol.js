'use strict';

/**
 * WebSocket 消息协议（上行消息白名单 + 严格校验）。
 * 详见 docs/PROTOCOL.md。校验失败的整条消息丢弃并回 ERR。
 */

const IN_TYPES = ['hello', 'ctl', 'enqueue', 'dequeue', 'play-queue', 'chat', 'mode', 'quality', 'sync-req', 'ping'];
const CTL_ACTIONS = ['ready', 'end', 'pause', 'resume', 'seek', 'skip', 'prev'];
const TRACK_SOURCES = ['qqmusic', 'netease', 'mock', 'plugin'];
// 与 room.js 的 QUALITY_LEVELS 保持一致（房间级音质档位）
const QUALITY_LEVELS = ['standard', 'high', 'lossless'];

function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function strField(v, { max = 300, allowEmpty = false } = {}) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!allowEmpty && s === '') return null;
  if (s.length > max) return s.slice(0, max);
  return s;
}

function validateTrack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw.source;
  const trackId = strField(raw.trackId, { max: 64 });
  const title = strField(raw.title, { max: 100 });
  if (!TRACK_SOURCES.includes(source) || !trackId || !title) return null;
  const trackIdOk = /^[A-Za-z0-9_-]+$/.test(trackId);
  if (!trackIdOk) return null;
  // 插件源必须携带插件原始 musicItem（取流/歌词时原样回传给插件）
  let rawItem = null;
  if (source === 'plugin') {
    rawItem = raw.raw;
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return null;
    if (rawItem.id === undefined || rawItem.id === null) return null;
    try {
      if (JSON.stringify(rawItem).length > 4096) return null;
    } catch {
      return null;
    }
  }
  return {
    source,
    trackId,
    title,
    artist: strField(raw.artist, { max: 100, allowEmpty: true }) ?? '',
    album: strField(raw.album, { max: 100, allowEmpty: true }) ?? '',
    picUrl: typeof raw.picUrl === 'string' && /^https:\/\//.test(raw.picUrl) ? raw.picUrl : '',
    durationSec: finiteNum(raw.durationSec) && raw.durationSec >= 0 && raw.durationSec < 36000 ? Math.round(raw.durationSec) : 0,
    raw: rawItem,
  };
}

/**
 * 校验上行消息。返回 {ok:true, value} 或 {ok:false, error}
 */
function validateIncoming(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '消息必须是 JSON 对象' };
  }
  const type = raw.type;
  if (!IN_TYPES.includes(type)) {
    return { ok: false, error: `未知的消息类型: ${type}` };
  }
  switch (type) {
    case 'hello': {
      const token = strField(raw.token, { max: 64 });
      const userId = strField(raw.userId, { max: 32 });
      const name = strField(raw.name, { max: 24, allowEmpty: true });
      if (!token || !userId || !name) return { ok: false, error: 'hello 需要 token/userId/name' };
      return { ok: true, value: { type, token, userId, name } };
    }
    case 'ctl': {
      const action = raw.action;
      if (!CTL_ACTIONS.includes(action)) return { ok: false, error: `不支持的控制动作: ${action}` };
      const value = { type, action };
      if (action === 'ready' || action === 'end') {
        const trackId = strField(raw.trackId, { max: 64 });
        if (!trackId || !/^[A-Za-z0-9_-]+$/.test(trackId)) return { ok: false, error: 'trackId 非法' };
        value.trackId = trackId;
      }
      if (raw.positionSec !== undefined) {
        if (!finiteNum(raw.positionSec) || raw.positionSec < 0 || raw.positionSec > 36000) {
          return { ok: false, error: 'positionSec 非法' };
        }
        value.positionSec = raw.positionSec;
      }
      if (raw.trackId !== undefined) {
        const trackId = strField(raw.trackId, { max: 64 });
        if (!trackId || !/^[A-Za-z0-9_-]+$/.test(trackId)) return { ok: false, error: 'trackId 非法' };
        value.trackId = trackId;
      }
      return { ok: true, value };
    }
    case 'enqueue': {
      const track = validateTrack(raw.track);
      if (!track) return { ok: false, error: '点歌曲目信息非法' };
      return { ok: true, value: { type, track } };
    }
    case 'dequeue':
    case 'play-queue': {
      const qid = strField(raw.qid, { max: 64 });
      if (!qid || !/^[A-Za-z0-9_-]+$/.test(qid)) return { ok: false, error: 'qid 非法' };
      return { ok: true, value: { type, qid } };
    }
    case 'chat': {
      const text = strField(raw.text, { max: 300 });
      if (!text) return { ok: false, error: '聊天内容不能为空' };
      return { ok: true, value: { type, text } };
    }
    case 'mode': {
      const mode = raw.mode;
      if (mode !== 'free' && mode !== 'host') return { ok: false, error: 'mode 必须是 free|host' };
      return { ok: true, value: { type, mode } };
    }
    case 'quality': {
      const level = raw.level;
      if (!QUALITY_LEVELS.includes(level)) return { ok: false, error: 'level 必须是 standard|high|lossless' };
      return { ok: true, value: { type, level } };
    }
    case 'sync-req':
    case 'ping':
      return { ok: true, value: { type } };
    default:
      return { ok: false, error: '未知的消息类型' };
  }
}

/** 下行消息构造器 */
function outState(snapshot) {
  return { type: 'state', state: snapshot };
}
function outChat(msg) {
  return { type: 'chat', msg };
}
function outSys(msg) {
  return { type: 'sys', msg };
}
function outError(code, message) {
  return { type: 'error', code, message };
}
function outPong() {
  return { type: 'pong' };
}
function outWelcome(userId, name, snapshot) {
  return { type: 'welcome', userId, name, state: snapshot };
}

/** 安全发送：序列化失败/连接已断都不抛出 */
function sendSafe(ws, payload) {
  if (!ws || ws.readyState !== 1) return false; // 1 = WebSocket.OPEN
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  IN_TYPES,
  CTL_ACTIONS,
  TRACK_SOURCES,
  QUALITY_LEVELS,
  validateIncoming,
  validateTrack,
  outState,
  outChat,
  outSys,
  outError,
  outPong,
  outWelcome,
  sendSafe,
};
