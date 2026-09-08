'use strict';

/**
 * LRC 歌词解析（纯函数，供页面与服务端测试共用）。
 */

const LINE_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * 解析 LRC 文本 → [{ timeSec, text }]（按时间升序，含元信息行过滤）。
 * 支持一行多时间标签：[00:01.5][01:02.5]歌词
 */
function parseLrc(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const lines = [];
  const srcLines = text.split(/\r?\n/);
  for (const raw of srcLines) {
    LINE_RE.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = LINE_RE.exec(raw)) !== null) {
      const min = Number.parseInt(m[1], 10);
      const sec = Number.parseInt(m[2], 10);
      const fracRaw = m[3] ?? '0';
      const frac = Number.parseInt(fracRaw, 10) / 10 ** fracRaw.length;
      const timeSec = min * 60 + sec + frac;
      if (Number.isFinite(timeSec)) stamps.push(timeSec);
    }
    if (stamps.length === 0) continue;
    const textPart = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const timeSec of stamps) {
      lines.push({ timeSec, text: textPart });
    }
  }
  lines.sort((a, b) => a.timeSec - b.timeSec);
  return lines;
}

/**
 * 找到当前应高亮的行号：最后一个 timeSec <= pos 的行；pos 早于第一行返回 0；无行返回 -1。
 */
function currentLineIndex(lines, posSec) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].timeSec <= posSec + 1e-6) idx = i;
    else break;
  }
  return idx;
}

/** 根据实测矩形计算滚动位置，让目标歌词的中心与可视区域中心重合。 */
function centeredScrollTop({ currentScrollTop, viewportTop, viewportHeight, lineTop, lineHeight }) {
  const values = [currentScrollTop, viewportTop, viewportHeight, lineTop, lineHeight].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[4] < 0) return 0;
  const [scrollTop, viewTop, viewHeight, targetTop, targetHeight] = values;
  return Math.max(0, scrollTop + targetTop - viewTop - (viewHeight - targetHeight) / 2);
}

module.exports = { parseLrc, currentLineIndex, centeredScrollTop };
