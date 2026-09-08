'use strict';

const { createApp } = require('./app');
const { config, validateConfig } = require('./config');
const { createLogger } = require('./logger');

validateConfig();
const log = createLogger('server');

const app = createApp();
const { server, hub, manager } = app;


// 监听失败必须快速失败：端口被占等场景下僵尸进程比崩溃更危险
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log.error('端口已被占用，可能有另一个实例在运行', { port: config.http.port, code: err.code });
  } else {
    log.error('服务监听失败', err);
  }
  process.exit(1);
});

server.listen(config.http.port, config.http.host, () => {
  log.info('服务已启动', {
    host: config.http.host,
    port: config.http.port,
    env: config.env,
    musicProvider: config.music.primary,
    rooms: manager.size,
  });
});

async function shutdown(signal) {
  log.info('正在优雅停机', { signal });
  hub.stop();
  await app.stop();
  log.info('已停止，退出');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('未捕获异常', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', reason);
});
