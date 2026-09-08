'use strict';

/** 轻量发布订阅 store：跨页面共享房间状态 */
function createStore(initial) {
  const data = { ...initial };
  const listeners = new Set();

  function get() {
    return data;
  }

  function set(patch) {
    const keys = Object.keys(patch);
    for (const k of keys) data[k] = patch[k];
    for (const fn of listeners) {
      try {
        fn(data, keys);
      } catch (e) {
        // 订阅方异常不阻断其他订阅方
      }
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function reset() {
    Object.keys(data).forEach((k) => delete data[k]);
    Object.assign(data, initial);
  }

  return { get, set, subscribe, reset };
}

const store = createStore({
  profile: { name: '' },
  membership: null, // { roomId, code, userId, token, name, isHost }
  room: null,       // 服务端房间快照（playback/queue/users/mode/seq）
  chat: [],         // 聊天与系统消息
  connected: false,
  lyric: { lines: [], sourceKey: '' },
});

module.exports = store;
