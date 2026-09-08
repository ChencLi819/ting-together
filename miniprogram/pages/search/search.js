'use strict';

const { api } = require('../../utils/request');
const runtime = require('../../utils/runtime');

const HISTORY_KEY = 'ting_search_history';
const HISTORY_LIMIT = 8;
const SOURCE_KEY = 'ting_search_source';
const PLUGIN_URL_KEY = 'ting_plugin_url';

Page({
  data: {
    kw: '',
    results: [],
    searching: false,
    searched: false,
    history: [],
    autoFocus: true,
    source: 'netease', // netease | plugin（网易云接口 | 音乐插件）
    pluginName: '',
  },

  onLoad() {
    this.addedKeys = new Set(); // 本次会话已点过的曲目
    let history = [];
    try {
      const saved = wx.getStorageSync(HISTORY_KEY);
      if (Array.isArray(saved)) history = saved.filter((k) => typeof k === 'string').slice(0, HISTORY_LIMIT);
    } catch (e) {
      // 忽略存储异常
    }
    let source = 'netease';
    try {
      const savedSource = wx.getStorageSync(SOURCE_KEY);
      if (savedSource === 'netease' || savedSource === 'plugin') source = savedSource;
    } catch (e) {
      // 忽略存储异常
    }
    this.setData({ history, source });
    if (source === 'plugin') this.refreshPlugin();
  },

  onInput(e) {
    this.setData({ kw: e.detail.value });
  },

  onHistoryTap(e) {
    const kw = e.currentTarget.dataset.kw;
    this.setData({ kw }, () => this.doSearch());
  },

  // ------------------------------------------------------------ 音乐源切换

  setSource(source) {
    this.setData({ source });
    try {
      wx.setStorageSync(SOURCE_KEY, source);
    } catch (e) {
      // 忽略存储异常
    }
  },

  onPickNetease() {
    this.setSource('netease');
  },

  // ------------------------------------------------------------ 音乐插件（MusicFree 兼容）

  /** 查询服务端当前插件（仅用于展示名字与状态） */
  refreshPlugin() {
    api
      .getPlugin()
      .then((res) => {
        this.setData({ pluginName: res.plugin ? res.plugin.name : '' });
      })
      .catch(() => {
        this.setData({ pluginName: '' });
      });
  },

  onPickPlugin() {
    api
      .getPlugin()
      .then((res) => {
        if (res.plugin) {
          this.setData({ pluginName: res.plugin.name });
          this.setSource('plugin');
          return;
        }
        this.importPluginModal(() => this.setSource('plugin'));
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '查询插件状态失败', icon: 'none' });
      });
  },

  /** 导入/更新插件：输入插件 JS 的 URL（MusicFree 插件约定），服务端下载并沙箱加载 */
  onImportPlugin() {
    this.importPluginModal(null);
  },

  importPluginModal(done) {
    let saved = '';
    try {
      const v = wx.getStorageSync(PLUGIN_URL_KEY);
      if (typeof v === 'string' && /^https?:\/\/\S+$/.test(v)) saved = v;
    } catch (e) {
      // 忽略存储异常
    }
    wx.showModal({
      title: '导入音乐插件',
      editable: true,
      content: saved,
      placeholderText: '插件 JS 的 URL',
      success: (res) => {
        if (!res.confirm) return;
        const url = (res.content || '').trim();
        if (!/^https?:\/\/\S{1,290}$/.test(url)) {
          wx.showToast({ title: '请输入 http(s):// 插件地址', icon: 'none' });
          return;
        }
        this.performPluginImport(url, done);
      },
    });
  },

  performPluginImport(url, done, adminToken = '') {
    wx.showLoading({ title: '导入中…', mask: true });
    api
      .importPlugin(url, adminToken)
      .then((out) => {
        try {
          wx.setStorageSync(PLUGIN_URL_KEY, url);
        } catch (e) {
          // 忽略存储异常
        }
        this.setData({ pluginName: out.plugin.name });
        wx.showToast({ title: `已导入：${out.plugin.name}`, icon: 'success' });
        if (done) done();
      })
      .catch((err) => {
        if (err && err.code === 'FORBIDDEN' && !adminToken) {
          this.promptPluginToken(url, done);
          return;
        }
        wx.showToast({ title: err.message || '插件导入失败', icon: 'none' });
      })
      .finally(() => {
        wx.hideLoading();
      });
  },

  /** 公网服务配置了 PLUGIN_IMPORT_TOKEN 时按需询问；令牌只用于本次请求，不落本地存储。 */
  promptPluginToken(url, done) {
    wx.showModal({
      title: '需要管理令牌',
      editable: true,
      placeholderText: '服务端 PLUGIN_IMPORT_TOKEN',
      confirmText: '继续导入',
      success: (res) => {
        if (!res.confirm) return;
        const token = (res.content || '').trim();
        if (!token) {
          wx.showToast({ title: '管理令牌不能为空', icon: 'none' });
          return;
        }
        this.performPluginImport(url, done, token);
      },
    });
  },

  onSearch() {
    this.doSearch();
  },

  saveHistory(kw) {
    const history = [kw, ...this.data.history.filter((k) => k !== kw)].slice(0, HISTORY_LIMIT);
    this.setData({ history });
    try {
      wx.setStorageSync(HISTORY_KEY, history);
    } catch (e) {
      // 忽略存储异常
    }
  },

  doSearch() {
    if (this.data.searching) return;
    const kw = this.data.kw.trim();
    if (!kw) {
      wx.showToast({ title: '先输入想听的歌吧', icon: 'none' });
      return;
    }
    this.setData({ searching: true });
    api
      .searchMusic(kw, 1, this.data.source)
      .then((res) => {
        const addedKeys = this.addedKeys;
        const results = (res.tracks || []).map((t) => ({
          track: { ...t, durationText: t.durationSec ? this.fmt(t.durationSec) : '' },
          added: addedKeys.has(`${t.source}:${t.trackId}`),
          vipLikely: Boolean(t.vipLikely),
        }));
        this.setData({ results, searched: true });
        this.saveHistory(kw);
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
        this.setData({ results: [], searched: true });
      })
      .finally(() => {
        this.setData({ searching: false });
      });
  },

  fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },

  onAdd(e) {
    const track = e.detail.track;
    const socket = runtime.getSocket();
    if (!socket || !socket.isOpen) {
      wx.showToast({ title: '房间连接已断开，请返回房间', icon: 'none' });
      return;
    }
    const ok = socket.send({ type: 'enqueue', track });
    if (!ok) {
      wx.showToast({ title: '发送失败，请重试', icon: 'none' });
      return;
    }
    const key = `${track.source}:${track.trackId}`;
    this.addedKeys = new Set([...(this.addedKeys || []), key]);
    const results = this.data.results.map((r) => (r.track.source === track.source && r.track.trackId === track.trackId ? { ...r, added: true } : r));
    this.setData({ results });
    wx.showToast({ title: '已点歌，马上唱～', icon: 'success' });
  },
});
