'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');

const { config, validateConfig } = require('./config');
const { RoomManager } = require('./room/manager');
const { Hub } = require('./ws/hub');
const { createRestHandler } = require('./http/rest');

/**
 * 组装完整服务端（HTTP + REST + WebSocket + 房间），可注入用于集成测试。
 * @returns {{server, wss, hub, manager, stop: Function}}
 */
function createApp() {
  validateConfig();
  const manager = new RoomManager({
    limits: {
      maxUsers: config.room.maxUsers,
      chatHistoryLimit: config.room.chatHistoryLimit,
      queueLimit: config.room.queueLimit,
    },
  });

  const rest = createRestHandler({ manager });
  const server = http.createServer((req, res) => {
    rest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'INTERNAL', message: '服务内部错误' }));
      }
      void err;
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: config.ws.maxMessageBytes });
  const hub = new Hub({ manager, wss });
  // 房间状态机发出 needs-resolve 时触发云端取流（WS 与轮询两条通道共用）
  manager.setResolveHandler((room) => hub.maybeResolve(room));
  manager.setBroadcastHandler((room) => hub.broadcastState(room));
  const stopHeartbeat = hub.startHeartbeat();

  const purgeTimer = setInterval(() => {
    manager.purgeIdle({ idleMs: config.room.idleMs, maxAgeMs: 24 * 60 * 60 * 1000 });
  }, 60000);
  purgeTimer.unref();

  function stop() {
    stopHeartbeat();
    hub.stop();
    clearInterval(purgeTimer);
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        ws.terminate();
      }
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1000).unref();
    });
  }

  return { server, wss, hub, manager, stop };
}

module.exports = { createApp };
