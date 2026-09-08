'use strict';

const { request } = require('./request');

const POLL_INTERVAL_MS = 1500;

/**
 * HTTP 轮询降级通道：WebSocket（connectContainer）不可用时的兜底。
 * 与 socket 管理器同接口（connect/close/send/isOpen），房间页无感切换。
 *  - connect(hello) 后每 1.5s POST /rooms/state 拉快照
 *  - send(obj) 把动作（ctl/enqueue/chat/...）POST 到 /rooms/action，返回的快照回灌 onState
 *  - 聊天/系统消息随快照下发，由房间页按 id 去重合并
 */
function createPollingTransport({ onWelcome, onState, onChat, onSys, onError, onOpen, onDown } = {}) {
  void onChat;
  void onSys;
  let timer = null;
  let open = false;
  let stopped = true;
  let lastSeq = -1;
  let creds = null; // connect(hello) 时填充
  let helloObj = null;
  let pendingSends = []; // 通道就绪前排队的动作

  function baseBody(extra = {}) {
    if (!creds) return { ...extra };
    return { ...creds, ...extra };
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  function applySnapshot(snap) {
    if (stopped) return;
    const seq = typeof snap.seq === 'number' ? snap.seq : -1;
    if (seq >= 0 && seq < lastSeq) return; // 过期快照
    lastSeq = seq;
    if (!open) {
      open = true;
      if (onOpen) onOpen();
      if (onWelcome) onWelcome(helloObj.userId, helloObj.name, snap);
      // 补发排队中的动作（如 canplay 期的 ready 上报）
      const queued = pendingSends;
      pendingSends = [];
      for (const obj of queued) send(obj);
    }
    if (onState) onState(snap);
  }

  async function poll() {
    if (stopped) return;
    try {
      const snap = await request('/api/v1/rooms/state', { method: 'POST', data: baseBody(), timeoutMs: 8000 });
      applySnapshot(snap);
    } catch (err) {
      if (err && err.code === 'AUTH_FAILED') {
        // 令牌失效：关闭通道并通知（房间页会引导回首页）
        close();
        if (onError) onError(err.code, err.message);
        return;
      }
      // 网络抖动：容忍，继续下一轮（这里会把确切失败原因打进 Console）
      console.warn('[poll] state 轮询失败:', err && err.message ? err.message : err);
      if (open && onDown) onDown();
      open = false;
    } finally {
      schedule();
    }
  }

  function send(obj) {
    if (!open) {
      // 通道未就绪（首轮快照未完成）：排队，首次快照后按序补发
      if (!stopped) pendingSends.push(obj);
      return true;
    }
    const type = obj.type;
    if (type === 'ping' || type === 'sync-req') {
      // 触发一次即时轮询，尽快拿到最新状态
      if (timer) {
        clearTimeout(timer);
        timer = null;
        poll();
      }
      return true;
    }
    request('/api/v1/rooms/action', { method: 'POST', data: baseBody({ type, ...obj }), timeoutMs: 8000 })
      .then((res) => {
        if (res && res.snapshot) applySnapshot(res.snapshot);
      })
      .catch((err) => {
        if (onError && err && err.code && err.code !== 'NETWORK') onError(err.code, err.message);
      });
    return true;
  }

  function connect(h) {
    if (h) {
      creds = { code: h.code, userId: h.userId, token: h.token };
      helloObj = h;
    }
    stopped = false;
    open = false;
    lastSeq = -1;
    poll();
  }

  function close() {
    stopped = true;
    open = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { connect, close, send, get isOpen() { return open; } };
}

module.exports = { createPollingTransport, POLL_INTERVAL_MS };
