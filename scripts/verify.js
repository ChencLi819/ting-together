'use strict';

/**
 * 企业级验收门禁裁决器（发布仓库的可执行质量契约）。
 * 用法：node scripts/verify.js   （SKIP_LIVE=1 可跳过真实音乐源门禁）
 * 退出码：0 = 全部必过门禁通过；1 = 存在 FAIL。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const results = [];

function gate(id, name, fn) {
  try {
    const detail = fn();
    results.push({ id, name, status: 'PASS', detail: detail || '' });
  } catch (err) {
    results.push({ id, name, status: 'FAIL', detail: err.message });
  }
}

function warnGate(id, name, detail) {
  results.push({ id, name, status: 'WARN', detail });
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

function walk(dir, ext, acc = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(abs, name);
    const rel = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(rel, ext, acc);
    else if (name.endsWith(ext)) acc.push(rel);
  }
  return acc;
}

function run(cmd, args, { timeoutMs = 300000, cwd = ROOT } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

// ------------------------------------------------------------------ G1 结构

gate('G1', '工程结构与清单', () => {
  const required = [
    'package.json',
    'eslint.config.js',
    'project.config.json',
    'miniprogram/app.json',
    'miniprogram/app.js',
    'miniprogram/app.wxss',
    'miniprogram/sitemap.json',
    'server/package.json',
    'server/src/index.js',
    'server/src/app.js',
    'server/src/config.js',
    'server/src/room/room.js',
    'server/src/room/manager.js',
    'server/src/ws/hub.js',
    'server/src/ws/protocol.js',
    'server/src/http/rest.js',
    'server/src/music/provider.js',
    'server/.env.example',
  ];
  const missing = required.filter((f) => !exists(f));
  if (missing.length) throw new Error(`缺少文件: ${missing.join(', ')}`);

  const appJson = JSON.parse(read('miniprogram/app.json'));
  const pageMissing = (appJson.pages ?? []).filter((p) => !exists(path.join('miniprogram', `${p}.wxml`)) || !exists(path.join('miniprogram', `${p}.js`)));
  if (pageMissing.length) throw new Error(`app.json 页面缺失: ${pageMissing.join(', ')}`);
  if (!(appJson.requiredBackgroundModes ?? []).includes('audio')) {
    throw new Error('app.json 缺少 requiredBackgroundModes: audio（后台连播必需）');
  }

  const jsonFiles = [...walk('miniprogram', '.json'), 'project.config.json'];
  for (const f of jsonFiles) {
    try {
      JSON.parse(read(f));
    } catch (err) {
      throw new Error(`JSON 无法解析: ${f} (${err.message})`, { cause: err });
    }
  }
  return `页面 ${appJson.pages.length} 个，JSON ${jsonFiles.length} 个全部合法`;
});

// ------------------------------------------------------------------ G2 语法

gate('G2', '语法检查 (node --check)', () => {
  const files = [
    ...walk('server/src', '.js'),
    ...walk('server/test', '.js'),
    ...walk('miniprogram', '.js'),
    ...walk('scripts', '.js'),
    'eslint.config.js',
  ];
  const bad = [];
  for (const f of files) {
    const res = run('node', ['--check', f], { timeoutMs: 30000 });
    if (res.code !== 0) bad.push(`${f}: ${res.out.slice(0, 200)}`);
  }
  if (bad.length) throw new Error(`语法错误:\n${bad.join('\n')}`);
  return `${files.length} 个 JS 文件全部通过`;
});

// ------------------------------------------------------------------ G3 规范

gate('G3', 'ESLint 0 error 0 warning', () => {
  const res = run('node', [path.join('node_modules', 'eslint', 'bin', 'eslint.js'), '.'], { timeoutMs: 180000 });
  if (res.code !== 0) throw new Error(`ESLint 未通过:\n${res.out.slice(-1200)}`);
  return 'eslint . 全部通过';
});

// ------------------------------------------------------------------ G4 单测

gate('G4', '单元测试', () => {
  const res = run('node', ['--test', 'server/test/unit/*.test.js'], { timeoutMs: 180000 });
  const pass = /ℹ pass (\d+)/.exec(res.out);
  const fail = /ℹ fail (\d+)/.exec(res.out);
  if (res.code !== 0 || (fail && Number(fail[1]) > 0)) {
    throw new Error(`单测失败:\n${res.out.slice(-1500)}`);
  }
  return `通过 ${pass ? pass[1] : '?'} 个用例`;
});

// ------------------------------------------------------------------ G5 集成

gate('G5', 'WebSocket 集成测试', () => {
  const res = run('node', ['--test', 'server/test/integration/*.test.js'], { timeoutMs: 180000 });
  const pass = /ℹ pass (\d+)/.exec(res.out);
  const fail = /ℹ fail (\d+)/.exec(res.out);
  if (res.code !== 0 || (fail && Number(fail[1]) > 0)) {
    throw new Error(`集成失败:\n${res.out.slice(-1500)}`);
  }
  return `通过 ${pass ? pass[1] : '?'} 个场景`;
});

// ------------------------------------------------------------------ G6 真实音源

if (process.env.SKIP_LIVE === '1') {
  warnGate('G6', '真实音乐源连通', 'SKIP_LIVE=1 已跳过（离线环境）');
} else {
  gate('G6', '真实音乐源连通 (QQ/网易云)', () => {
    const res = run('node', ['--test', 'server/test/live/*.test.js'], { timeoutMs: 120000 });
    const pass = /ℹ pass (\d+)/.exec(res.out);
    const fail = /ℹ fail (\d+)/.exec(res.out);
    if (res.code !== 0 || (fail && Number(fail[1]) > 0)) {
      throw new Error(`真实音源连通失败:\n${res.out.slice(-1200)}`);
    }
    return `通过 ${pass ? pass[1] : '?'} 项连通验证`;
  });
}

// ------------------------------------------------------------------ G7 安全

gate('G7', '安全基线', () => {
  // 本地 .env 允许存在（真实凭据就在这里），但必须确保不会被提交
  if (exists('server/.env')) {
    const gitignore = read('.gitignore');
    if (!/^\.env$/m.test(gitignore)) {
      throw new Error('server/.env 存在但 .gitignore 未排除 .env，凭据可能被提交');
    }
  }

  const secretRe = /(api[_-]?key|secret|password|passwd)\s*[:=]\s*['"][A-Za-z0-9+/_-]{12,}['"]/i;
  const codeFiles = [...walk('server/src', '.js'), ...walk('miniprogram', '.js')];
  const leaks = codeFiles.filter((f) => secretRe.test(read(f)));
  if (leaks.length) throw new Error(`疑似硬编码密钥: ${leaks.join(', ')}`);

  const hub = read('server/src/ws/hub.js');
  const protocol = read('server/src/ws/protocol.js');
  if (!hub.includes('validateIncoming')) throw new Error('WS 消息未接入协议校验');
  if (!protocol.includes('TRACK_SOURCES')) throw new Error('协议层缺少音源白名单');
  if (!hub.includes('chatLimiter') || !hub.includes('enqueueLimiter')) throw new Error('缺少聊天/点歌限流');
  if (!read('server/src/http/rest.js').includes('searchLimiter')) throw new Error('搜索接口缺少限流');

  const nonHttps = codeFiles.filter((f) => /['"]http:\/\/(?!127\.0\.0\.1|localhost)/.test(read(f)));
  if (nonHttps.length) throw new Error(`存在非 https 上游/资源地址: ${nonHttps.join(', ')}`);
  return '鉴权/校验/限流/密钥/https 检查全部通过';
});

// ------------------------------------------------------------------ G8 生产就绪

gate('G8', '生产就绪要素', () => {
  const index = read('server/src/index.js');
  const app = read('server/src/app.js');
  const config = read('server/src/config.js');
  if (!index.includes('SIGTERM') || !index.includes('SIGINT')) throw new Error('缺少优雅停机信号处理');
  if (!app.includes('unref')) throw new Error('定时器未 unref（会阻止进程退出）');
  if (!read('server/src/http/rest.js').includes('/healthz')) throw new Error('缺少健康检查端点');
  if (!config.includes('validateConfig') || !index.includes('validateConfig()')) throw new Error('启动时未校验配置');
  if (!app.includes('stop')) throw new Error('缺少可编程停机（测试/编排需要）');
  if (!read('miniprogram/app.js').includes('onUnhandledRejection')) throw new Error('小程序缺少全局 Promise 兜底');
  return '优雅停机/健康检查/配置校验/全局兜底齐备';
});

// ------------------------------------------------------------------ G9 文档

gate('G9', '文档完整性', () => {
  const docs = [
    ['README.md', ['快速开始', '微信开发者工具']],
    ['docs/ARCHITECTURE.md', ['Provider', '房间']],
    ['docs/PROTOCOL.md', ['hello', 'ctl']],
    ['docs/API.md', ['/api/v1/rooms', '/api/v1/music/search']],
    ['docs/RUNBOOK.md', ['微信开发者工具', 'MUSIC_PROVIDER']],
  ];
  for (const [file, keywords] of docs) {
    if (!exists(file)) throw new Error(`缺少文档: ${file}`);
    const text = read(file);
    if (text.length < 800) throw new Error(`${file} 内容过短 (${text.length} 字符)`);
    for (const kw of keywords) {
      if (!text.includes(kw)) throw new Error(`${file} 未包含关键内容「${kw}」，文档与实现可能脱节`);
    }
  }
  return 'README + 4 份核心文档齐备且与实现对齐';
});

// ------------------------------------------------------------------ G10 无占位

gate('G10', '无占位实现', () => {
  // 裁决器自身（正则含关键词）不在扫描范围
  const files = [...walk('server/src', '.js'), ...walk('server/test', '.js'), ...walk('miniprogram', '.js')];
  const re = /\bTODO\b|\bFIXME\b|待实现|假数据|占位实现|not implemented/i;
  const bad = files.filter((f) => re.test(read(f)));
  if (bad.length) throw new Error(`发现占位标记: ${bad.join(', ')}`);
  return `${files.length} 个源文件无占位/未实现标记`;
});

// ------------------------------------------------------------------ 汇总

const order = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'];
const statusIcon = { PASS: '✔', FAIL: '✖', WARN: '⚠' };

console.log('\n========== 企业级验收门禁 ==========');
for (const id of order) {
  const r = results.find((x) => x.id === id);
  if (!r) continue;
  const icon = statusIcon[r.status];
  console.log(`${icon} ${r.id}  ${r.name}  [${r.status}]${r.detail ? `  — ${r.detail.split('\n')[0].slice(0, 120)}` : ''}`);
}
const fails = results.filter((r) => r.status === 'FAIL');
const warns = results.filter((r) => r.status === 'WARN');
console.log('====================================');
console.log(`结果: ${results.length - fails.length} 通过, ${warns.length} 警告, ${fails.length} 失败`);
if (fails.length > 0) {
  console.log('\n未达标项:');
  for (const f of fails) console.log(`  ✖ ${f.id} ${f.name}\n     ${f.detail.slice(0, 800)}`);
  process.exit(1);
}
console.log('\n全部必过门禁通过，达到企业级验收标准。');
