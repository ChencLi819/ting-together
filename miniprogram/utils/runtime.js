'use strict';

/**
 * 运行时单例容器：房间传输通道（socket / 轮询降级）与同步引擎跨页共享。
 */
const { createSocket } = require('./socket');
const { createPollingTransport } = require('./polling');
const { createSyncEngine } = require('./sync');

let socket = null; // 活跃传输通道（socket 或 polling，接口同构）
let engine = null;

function initSocket(handlers) {
  socket = createSocket(handlers);
  return socket;
}

/** 轮询降级通道（connectContainer 不可用时由房间页切换） */
function initPolling(handlers) {
  socket = createPollingTransport(handlers);
  return socket;
}

function getSocket() {
  return socket;
}

function initEngine(sendCtl) {
  if (!engine) {
    engine = createSyncEngine({ sendCtl });
  }
  return engine;
}

function getEngine() {
  return engine;
}

function teardown() {
  if (socket) {
    socket.close();
    socket = null;
  }
  if (engine) {
    engine.stop();
    engine = null;
  }
}

module.exports = { initSocket, initPolling, getSocket, initEngine, getEngine, teardown };
