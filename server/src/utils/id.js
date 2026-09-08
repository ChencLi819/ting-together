'use strict';

const crypto = require('node:crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符 I/O/0/1

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 房间邀请码：6 位易读字符 */
function roomCode() {
  const buf = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

/** 匿名用户展示名，如 乐迷#A3F2 */
function guestName() {
  return `乐迷#${randomHex(2).toUpperCase()}`;
}

module.exports = { randomHex, roomCode, guestName };
