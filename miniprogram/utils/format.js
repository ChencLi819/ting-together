'use strict';

/** 兼容性安全的两位补零（避免 padStart 依赖基础库 polyfill） */
function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 秒 → mm:ss（负数/非法值按 0 处理） */
function formatTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '00:00';
  const total = Math.floor(n);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** 数组安全取值 */
function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

/** 时间戳 → 简短时刻文案（聊天列表用） */
function formatClock(ts, now = Date.now()) {
  const t = new Date(ts);
  const diff = now - ts;
  if (diff > 86400000 || diff < 0) {
    return `${t.getMonth() + 1}-${t.getDate()}`;
  }
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

module.exports = { formatTime, clamp, formatClock, pad2 };
