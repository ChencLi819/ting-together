'use strict';

const store = require('./utils/store');
const session = require('./utils/session');
const config = require('./utils/config');

App({
  onLaunch() {
    store.set({ profile: session.loadProfile() });
    // 云调用模式：初始化 wx.cloud（必须在任何 callContainer/connectContainer 之前）
    // init 本身可能负责注入 callContainer/connectContainer，不能先用这些能力判断是否初始化。
    if (config.RUN_MODE === 'cloud' && wx.cloud && wx.cloud.init) {
      try {
        wx.cloud.init({ env: config.getCloudEnvId() || undefined, traceUser: false });
      } catch (e) {
        console.error('[cloud-init]', e);
      }
    }
    // 全局错误兜底：上报到控制台；生产可接入自有监控
    if (wx.onError) {
      wx.onError((message) => {
        console.error('[global-error]', message);
      });
    }
    if (wx.onUnhandledRejection) {
      wx.onUnhandledRejection((res) => {
        console.error('[global-unhandled-rejection]', res && res.reason);
      });
    }
  },
});
