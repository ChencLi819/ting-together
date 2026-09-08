'use strict';

/**
 * 打包服务端部署产物（微信云托管 / 任意容器平台上传用）。
 * 产物：dist/ting-server/  与  dist/ting-server.zip
 * 白名单拷贝：package.json / package-lock.json / src / Dockerfile / .dockerignore
 * 刻意排除：node_modules（Dockerfile 内安装）、.env（凭据不入部署包，走平台环境变量）、test、data
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'server');
const OUT_DIR = path.join(ROOT, 'dist', 'ting-server');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(rel) {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) {
    console.warn(`[pack] 跳过不存在的文件: ${rel}`);
    return;
  }
  const to = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(OUT_DIR, rel);
  fs.cpSync(from, to, { recursive: true });
}

console.log('[pack] 清理旧产物…');
rmrf(OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[pack] 拷贝白名单文件…');
copyFile('package.json');
copyFile('package-lock.json');
copyFile('Dockerfile');
copyFile('.dockerignore');
copyDir('src');

const manifest = {
  name: 'ting-together-server',
  packagedAt: new Date().toISOString(),
  files: ['package.json', 'package-lock.json', 'Dockerfile', '.dockerignore', 'src/**'],
  notes: [
    '凭据（NCM_COOKIE / PLUGIN_IMPORT_TOKEN 等）不入部署包，请在云托管环境变量中配置',
    '监听端口 3100；健康检查 /healthz',
  ],
};
fs.writeFileSync(path.join(OUT_DIR, 'pack-manifest.json'), JSON.stringify(manifest, null, 2));

// Windows 10+ 自带 bsdtar 可直接产出 zip；找不到则仅保留目录产物
const bsdtar = 'C:\\Windows\\System32\\tar.exe';
let zipPath = null;
if (fs.existsSync(bsdtar)) {
  zipPath = path.join(ROOT, 'dist', 'ting-server.zip');
  rmrf(zipPath);
  const res = spawnSync(bsdtar, ['-a', '-c', '-f', zipPath, '.'], { cwd: OUT_DIR, encoding: 'utf8' });
  if (res.status !== 0) {
    console.warn('[pack] zip 打包失败，仅保留目录产物:', res.stderr);
    zipPath = null;
  }
}

const size = (p) => {
  let total = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(p);
  return total;
};

console.log(`[pack] 目录产物: ${OUT_DIR} (${(size(OUT_DIR) / 1024).toFixed(0)} KB)`);
if (zipPath) console.log(`[pack] zip 产物: ${zipPath} (${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB)`);
console.log('[pack] 完成。上传到微信云托管时选择本目录或 zip；环境变量在平台侧配置。');
