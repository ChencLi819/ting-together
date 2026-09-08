'use strict';

const config = require('./config');

/**
 * 房间 WebSocket 管理器（双通道归一）：
 *  - 云调用模式：wx.cloud.connectContainer —— 事件式 API（task.on('open'|'message'|'error'|'close')）
 *  - 直连模式：wx.connectSocket —— SocketTask 式 API（task.onOpen / onMessage / ...）
 * 两条通道统一归一到内部 handleOpen/handleMessage/handleClose/handleError + send/close。
 *
 *  - 连接后自动 hello 握手；15s 心跳；断线指数退避自动重连（1s 起，封顶 15s，带抖动）
 *  - 状态快照按 seq 去重（丢弃过期状态）；聊天按消息 id 去重
 */
function createSocket({ onWelcome, onState, onChat, onSys, onError, onOpen, onDown, onUnsupported } = {}) {
  let task = null;
  let sendImpl = null;
  let closeImpl = null;
  let isOpen = false;
  let closedByUs = false;
  let helloMsg = null;
  let attempts = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastSeq = -1;
  const seenIds = new Set();

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (closedByUs || reconnectTimer || !helloMsg) return;
    attempts += 1;
    const base = Math.min(15000, 1000 * 2 ** Math.min(attempts, 4));
    const delay = base / 2 + Math.floor(Math.random() * (base / 2));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function send(obj) {
    if (!task || !isOpen || !sendImpl) return false;
    return sendImpl(obj);
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!isOpen) return;
      send({ type: 'ping' });
    }, 15000);
  }

  function handleMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case 'welcome': {
        lastSeq = msg.state && typeof msg.state.seq === 'number' ? msg.state.seq : -1;
        if (onWelcome) onWelcome(msg.userId, msg.name, msg.state);
        break;
      }
      case 'state': {
        const seq = msg.state && typeof msg.state.seq === 'number' ? msg.state.seq : -1;
        if (seq >= 0 && seq < lastSeq) return; // 过期快照
        lastSeq = seq;
        if (onState) onState(msg.state);
        break;
      }
      case 'chat':
      case 'sys': {
        const id = msg.msg && msg.msg.id;
        if (id) {
          if (seenIds.has(id)) return;
          seenIds.add(id);
          if (seenIds.size > 500) {
            // 控制去重集合大小
            const it = seenIds.values();
            for (let i = 0; i < 100; i += 1) seenIds.delete(it.next().value);
          }
        }
        if (msg.type === 'chat' && onChat) onChat(msg.msg);
        else if (msg.type === 'sys' && onSys) onSys(msg.msg);
        break;
      }
      case 'error': {
        if (onError) onError(msg.code, msg.message);
        break;
      }
      case 'pong':
      default:
        break;
    }
  }

  // ---- 通道归一后的内部处理 ----

  function handleOpen() {
    console.info('[ws] onOpen');
    isOpen = true;
    attempts = 0;
    if (helloMsg) send(helloMsg);
    startHeartbeat();
    if (onOpen) onOpen();
  }

  function handleMessageRaw(res) {
    // 不同通道的消息载荷形状可能不同，统一归一为字符串
    const payload = typeof res === 'string' ? res : res && typeof res.data === 'string' ? res.data : null;
    if (payload) handleMessage(payload);
  }

  function handleClose(res) {
    console.warn('[ws] onClose', res && res.code !== undefined ? `code=${res.code}` : '', res && res.reason ? res.reason : '');
    const wasOpen = isOpen;
    isOpen = false;
    clearTimers();
    if (closedByUs) return;
    if (wasOpen && onDown) onDown();
    scheduleReconnect();
  }

  function handleError(err) {
    console.warn('[ws] onError', err && err.errMsg ? err.errMsg : err);
    // onClose 一般也会触发；这里只兜底
    if (!closedByUs && !isOpen && !reconnectTimer) scheduleReconnect();
  }

  function open() {
    if (task) {
      try {
        if (closeImpl) closeImpl();
      } catch (e) {
        // 忽略关闭旧连接的异常
      }
      task = null;
      sendImpl = null;
      closeImpl = null;
    }
    isOpen = false;
    clearTimers();

    if (config.isCloudMode()) {
      // 云调用：connectContainer 是事件式 API（task.on(...)），不是 SocketTask
      if (!wx.cloud || typeof wx.cloud.connectContainer !== 'function') {
        console.warn('[ws] connectContainer 不存在，切换 HTTP 轮询降级通道');
        if (onUnsupported) onUnsupported();
        else scheduleReconnect();
        return;
      }
      try {
        task = wx.cloud.connectContainer({
          config: { env: config.getCloudEnvId() || undefined },
          service: config.CLOUD_SERVICE,
          path: '/ws',
        });
      } catch (err) {
        console.error('[ws] connectContainer 创建失败', err);
        task = null;
        if (onUnsupported) onUnsupported();
        else scheduleReconnect();
        return;
      }
      if (!task || typeof task.on !== 'function') {
        console.error('[ws] connectContainer 不可用（返回对象缺 on()），切换 HTTP 轮询降级通道');
        task = null;
        // 交给上层切换降级通道（避免无限重试）
        if (onUnsupported) {
          const cb = onUnsupported;
          cb();
          return;
        }
        scheduleReconnect();
        return;
      }
      task.on('open', handleOpen);
      task.on('message', handleMessageRaw);
      task.on('error', handleError);
      task.on('close', handleClose);
      sendImpl = (obj) => {
        let ok = true;
        task.send({ data: JSON.stringify(obj), fail() { ok = false; } });
        return ok;
      };
      closeImpl = () => {
        task.close({ code: 1000, reason: 'client leave' });
      };
    } else {
      task = wx.connectSocket({ url: config.wsUrl(), timeout: 8000 });
      task.onOpen(handleOpen);
      task.onMessage(handleMessageRaw);
      task.onClose(handleClose);
      task.onError(handleError);
      sendImpl = (obj) => {
        let ok = true;
        task.send({ data: JSON.stringify(obj), fail() { ok = false; } });
        return ok;
      };
      closeImpl = () => {
        task.close({ code: 1000, reason: 'client leave' });
      };
    }
  }

  function connect(hello) {
    helloMsg = hello;
    closedByUs = false;
    attempts = 0;
    open();
  }

  function close() {
    closedByUs = true;
    clearTimers();
    if (task && closeImpl) {
      try {
        closeImpl();
      } catch (e) {
        // 忽略
      }
    }
    task = null;
    sendImpl = null;
    closeImpl = null;
    isOpen = false;
  }

  return { connect, close, send, get isOpen() { return isOpen; } };
}

module.exports = { createSocket };
