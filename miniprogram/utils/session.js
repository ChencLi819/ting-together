'use strict';

/** 成员信息与个人资料的本地持久化 */

const PROFILE_KEY = 'ting_profile';
const MEMBERSHIP_KEY = 'ting_membership';

function loadProfile() {
  try {
    const p = wx.getStorageSync(PROFILE_KEY);
    if (p && typeof p.name === 'string') return { name: p.name };
  } catch (e) {
    // 忽略存储异常
  }
  return { name: '' };
}

function saveProfile(profile) {
  try {
    wx.setStorageSync(PROFILE_KEY, { name: String(profile.name || '').slice(0, 24) });
  } catch (e) {
    // 忽略存储异常
  }
}

function loadMembership() {
  try {
    const m = wx.getStorageSync(MEMBERSHIP_KEY);
    if (m && m.code && m.userId && m.token) return m;
  } catch (e) {
    // 忽略存储异常
  }
  return null;
}

function saveMembership(membership) {
  try {
    if (membership) wx.setStorageSync(MEMBERSHIP_KEY, membership);
    else wx.removeStorageSync(MEMBERSHIP_KEY);
  } catch (e) {
    // 忽略存储异常
  }
}

/** 只有服务端明确确认身份/房间失效时才丢弃本地凭据；网络失败必须保留以便重连。 */
function shouldDiscardMembership(err) {
  if (!err || typeof err !== 'object') return false;
  return err.status === 404 || err.code === 'NOT_FOUND' || err.code === 'AUTH_FAILED';
}

module.exports = { loadProfile, saveProfile, loadMembership, saveMembership, shouldDiscardMembership };
