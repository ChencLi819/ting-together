# Ting Together（一起听）

一个原生微信小程序与 Node.js 服务端组成的多人同步听歌项目，提供房间、共享播放队列、播放状态同步、歌词、音质切换和房间聊天。

## 功能

- 通过 6 位邀请码创建或加入房间
- 共享播放、暂停、进度拖动、上一首和下一首
- 共享点歌队列与队列插播
- 房间聊天、成员在线状态和房主迁移
- 标准、高品、无损三档房间级音质
- QQ 音乐、网易云音乐及可信 MusicFree 插件源
- WebSocket 实时通道；不可用时自动降级为 HTTP 轮询
- 新旧播放协议兼容，适配已部署的旧版云端服务

## 技术栈

- 客户端：原生微信小程序
- 服务端：Node.js 20.19+、原生 HTTP、`ws`
- 部署：Docker、微信云托管或其他单实例容器平台
- 质量保障：Node Test Runner、ESLint、GitHub Actions

## 快速开始

### 1. 安装依赖

```bash
npm ci
npm ci --prefix server
```

### 2. 配置服务端

复制 `server/.env.example` 为 `server/.env`，按需调整环境变量。真实 `.env`、网易云 Cookie 和插件管理令牌不得提交到 Git。

最小本地配置：

```dotenv
PORT=3100
HOST=0.0.0.0
MUSIC_PROVIDER=qqmusic
```

### 3. 启动服务端

```bash
npm start
```

健康检查：`http://127.0.0.1:3100/healthz`。

### 4. 打开小程序

1. 在微信开发者工具中导入仓库根目录。
2. 本地直连时，将 `miniprogram/utils/config.js` 中的 `RUN_MODE` 改为 `lan`。
3. 开发者工具中开启“不校验合法域名”，或按微信要求配置合法域名。
4. 云托管发布前，将 `RUN_MODE` 恢复为 `cloud`，并核对 `CLOUD_ENV_ID`、`CLOUD_SERVICE` 与 `project.config.json` 中的 AppID。

## 验证

```bash
npm run lint
npm test
npm run test:live
npm run verify
```

- `npm test`：单元测试与本地集成测试
- `npm run test:live`：真实第三方音乐源连通测试，需要外网
- `npm run verify`：工程结构、语法、规范、测试、安全基线、生产要素和文档门禁
- 离线 CI 可使用 `SKIP_LIVE=1 npm run verify`

## 目录结构

```text
.
├── .github/              GitHub Actions 与依赖更新配置
├── docs/                 架构、协议、API、部署和运维文档
├── miniprogram/          微信小程序源码
├── scripts/              验收与服务端打包脚本
├── server/
│   ├── src/              REST、WebSocket、房间状态机与音乐源
│   └── test/             单元、集成和真实源测试
├── project.config.json   微信开发者工具工程配置
└── package.json          根工程命令与质量工具
```

## 部署

生成不含凭据和依赖目录的服务端部署包：

```bash
npm run pack:server
```

产物生成在 `dist/`，该目录不进入版本库。生产部署应满足：

- Node.js 20.19 或更高版本
- `NODE_ENV=production`
- 插件功能开放时必须配置高强度 `PLUGIN_IMPORT_TOKEN`
- 房间状态当前保存在进程内，服务副本数必须为 1
- 使用 HTTPS/WSS 或微信云托管内部通道
- 通过 `/healthz` 配置健康检查

完整步骤见 [部署指南](docs/DEPLOY.md) 与 [运行手册](docs/RUNBOOK.md)。

## “接口1”配置

搜索页中的“接口1”对应服务端的网易云音乐 Provider，代码标识为 `netease`。它不要求小程序用户登录网易云，所有搜索和取流请求均由服务端统一发起。

在 `server/.env` 或部署平台环境变量中配置：

```dotenv
# 将网易云设为默认音乐源
MUSIC_PROVIDER=netease

# 默认留空：游客模式，部分版权歌曲可能只有试听或无法播放
NCM_COOKIE=
```

如需使用项目维护者本人网易云账号的可播放权益，可在**部署平台环境变量**中将 `NCM_COOKIE` 设置为该账号 Cookie 中 `MUSIC_U` 的值。配置要求：

1. 仅设置 Cookie 的 `MUSIC_U` 值，不要复制整段 Cookie。
2. 不要把真实值写入 `server/.env.example`、README、源码、Issue 或提交记录。
3. 本地调试可写入已被 Git 忽略的 `server/.env`；生产环境优先使用云平台密钥/环境变量管理。
4. 该账号凭据会随接口1的上游请求发送给网易云，应使用专用账号并遵守对应服务条款。
5. 凭据泄露后立即退出相关会话、刷新 Cookie，并更新部署环境变量。

本发布目录未包含原工作区的 `server/.env`，也未包含任何真实 `MUSIC_U` 值。

## 数据与隐私

本项目不调用手机号、定位、通讯录、相机、麦克风或相册等微信敏感接口，但会处理实现功能所需的数据：

- 用户主动填写的昵称、聊天内容和搜索关键词
- 房间码、随机用户 ID 和房间身份令牌
- 用于请求限流与故障排查的网络请求信息
- 点播歌曲和播放控制记录

搜索关键词、歌曲标识、音频和封面请求可能由第三方音乐服务处理。正式发布前，运营者必须按照实际部署、日志和第三方服务情况完善《小程序用户隐私保护指引》，并提供清除本地数据或退出服务的方式。

## 安全

- 不要提交 `server/.env`、Cookie、令牌、日志、`server/data/` 或部署产物。
- `NCM_COOKIE` 属于网易云账号凭据，只能通过部署平台环境变量注入。
- MusicFree 插件会在服务端执行第三方 JavaScript；仅导入可信来源，并限制导入权限。
- 安全问题请通过仓库的 GitHub Security Advisory 私下报告，参见 [SECURITY.md](SECURITY.md)。

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [实时协议](docs/PROTOCOL.md)
- [REST API](docs/API.md)
- [部署指南](docs/DEPLOY.md)
- [运行手册](docs/RUNBOOK.md)

## 许可证

本仓库未附带开源许可证。在获得项目所有者明确授权前，不授予复制、修改、分发或商业使用权。
