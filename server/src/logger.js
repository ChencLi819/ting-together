'use strict';

const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function serialize(extra) {
  if (extra === undefined) return undefined;
  if (extra instanceof Error) {
    return { name: extra.name, message: extra.message, stack: extra.stack };
  }
  return extra;
}

function write(level, module_, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    module: module_,
    msg,
    ...(extra !== undefined ? { data: serialize(extra) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

function createLogger(module_) {
  return {
    debug: (msg, extra) => write('debug', module_, msg, extra),
    info: (msg, extra) => write('info', module_, msg, extra),
    warn: (msg, extra) => write('warn', module_, msg, extra),
    error: (msg, extra) => write('error', module_, msg, extra),
  };
}

module.exports = { createLogger };
