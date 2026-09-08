'use strict';

const { api } = require('../../utils/request');
const config = require('../../utils/config');
const { setServerBase, getServerBase } = require('../../utils/config');
const session = require('../../utils/session');
const store = require('../../utils/store');
const { navigateToRoom } = require('../../utils/navigation');

function membershipFromResponse(res, isHost) {
  if (!res || !res.roomId || !res.code || !res.userId || !res.token) {
    throw Object.assign(new Error('服务端返回的房间信息不完整，请检查云托管版本'), { code: 'BAD_ROOM_RESPONSE' });
  }
  return {
    roomId: res.roomId,
    code: res.code,
    userId: res.userId,
    token: res.token,
    name: res.name,
    isHost,
  };
}

function showEntryError(scope, err, fallback) {
  console.error(`[${scope}]`, err);
  const message = (err && err.message) || fallback;
  if (err && (err.code === 'BAD_ROOM_RESPONSE' || err.code === 'NAVIGATION_FAILED')) {
    wx.showModal({ title: '无法进入房间', content: message, showCancel: false });
    return;
  }
  wx.showToast({ title: message, icon: 'none', duration: 3000 });
}

Page({
  data: {
    name: '',
    code: '',
    creating: false,
    joining: false,
    lastRoom: null,
    serverBase: '',
    cloudMode: false,
  },

  onLoad() {
    const profile = session.loadProfile();
    this.setData({
      name: profile.name,
      serverBase: getServerBase(),
      cloudMode: config.isCloudMode(),
    });
    this.refreshLastRoom();
  },

  onShow() {
    this.setData({ serverBase: getServerBase() });
    this.refreshLastRoom();
  },

  /** 检查上次房间是否还在，展示“回到房间”入口 */
  refreshLastRoom() {
    const membership = session.loadMembership();
    if (!membership || !membership.code) {
      this.setData({ lastRoom: null });
      return;
    }
    api
      .roomPreview(membership.code)
      .then((info) => {
        this.setData({
          lastRoom: {
            code: membership.code,
            desc: info && info.currentTitle ? `正在播放 ${info.currentTitle}` : `${info ? info.onlineCount : 0} 人在线`,
          },
        });
      })
      .catch((err) => {
        if (session.shouldDiscardMembership(err)) {
          session.saveMembership(null);
          this.setData({ lastRoom: null });
          return;
        }
        // 临时断网/服务重启不能抹掉仍有效的房间身份。
        this.setData({
          lastRoom: {
            code: membership.code,
            desc: '暂时无法连接，可点击重试',
          },
        });
      });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
    session.saveProfile({ name: e.detail.value });
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value.toUpperCase() });
  },

  onCreateRoom() {
    if (this.data.creating) return;
    const name = this.data.name.trim() || `乐迷${Math.floor(Math.random() * 900 + 100)}`;
    session.saveProfile({ name });
    store.set({ profile: { name } });
    this.setData({ creating: true });
    api
      .createRoom(name)
      .then((res) => {
        const membership = membershipFromResponse(res, true);
        session.saveMembership(membership);
        store.set({ membership });
        return navigateToRoom(res.code);
      })
      .catch((err) => {
        showEntryError('create-room', err, '创建失败');
      })
      .finally(() => {
        this.setData({ creating: false });
      });
  },

  onJoinRoom() {
    if (this.data.joining) return;
    const code = this.data.code.trim().toUpperCase();
    if (code.length !== 6) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' });
      return;
    }
    const name = this.data.name.trim() || `乐迷${Math.floor(Math.random() * 900 + 100)}`;
    session.saveProfile({ name });
    store.set({ profile: { name } });
    this.setData({ joining: true });
    api
      .joinRoom(code, name)
      .then((res) => {
        const membership = membershipFromResponse(res, false);
        session.saveMembership(membership);
        store.set({ membership });
        return navigateToRoom(res.code);
      })
      .catch((err) => {
        showEntryError('join-room', err, '加入失败');
      })
      .finally(() => {
        this.setData({ joining: false });
      });
  },

  onBackRoom() {
    const membership = session.loadMembership();
    if (!membership) return;
    store.set({ membership });
    navigateToRoom(membership.code).catch((err) => {
      console.error('[navigation] 回到房间失败', err);
      wx.showToast({ title: err.message || '进入房间失败', icon: 'none' });
    });
  },

  onServerSetting() {
    if (config.isCloudMode()) {
      // 云调用模式：服务端地址由云托管通道接管，无需配置
      wx.showModal({
        title: '云调用模式',
        content: config.getCloudEnvId() ? ('云托管环境：' + config.getCloudEnvId()) : '已通过微信云托管通道连接，无需配置服务端地址',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.showModal({
      title: '服务端地址',
      editable: true,
      placeholderText: getServerBase(),
      content: getServerBase(),
      success: (res) => {
        if (!res.confirm) return;
        const value = (res.content || '').trim();
        if (!value) return;
        if (setServerBase(value)) {
          this.setData({ serverBase: getServerBase() });
          wx.showToast({ title: '已保存', icon: 'success' });
        } else {
          wx.showToast({ title: '地址需以 http(s):// 开头', icon: 'none' });
        }
      },
    });
  },
});
