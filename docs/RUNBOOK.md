# 运维手册（RUNBOOK）

## 1. 本地开发

```bash
npm install && npm install --prefix server
npm start                    # http://0.0.0.0:3100，默认音乐源 qqmusic
MUSIC_PROVIDER=mock npm start  # 用本地 mock 源（无外网依赖，联调/演示）
```

### 微信开发者工具

- 安装建议路径：`D:\AgentWorkSpace\Tools\WeChatDevTools\`（本项目约定专业软件装 D 盘）。
- 导入项目：选择仓库根目录（读取 `project.config.json`，`miniprogramRoot` 已指向 `miniprogram/`）。
- 关键设置：详情 → 本地设置 → 勾选「不校验合法域名」「不校验 HTTPS 证书」。
- 真机预览：首页「服务端」改为电脑局域网 IP（如 `http://192.168.1.100:3100`），手机与电脑同网段；Windows 防火墙需放行 3100 端口。

## 2. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` / `HOST` | 3100 / 0.0.0.0 | 监听地址 |
| `LOG_LEVEL` | info | debug\|info\|warn\|error |
| `MUSIC_PROVIDER` | qqmusic | qqmusic\|netease\|mock（搜索主源；播放地址始终走降级链） |
| `NCM_COOKIE` | 空 | 网易云自有账号的 `MUSIC_U` cookie 值；配置后以该账号权益解析完整曲目（VIP 曲从试听片段变全曲）。仅个人使用场景，凭据只存 `.env`，泄露等于交出账号，需定期更新 |
| `ROOM_MAX_USERS` | 8 | 房间人数上限（≥2） |
| `ROOM_IDLE_MS` | 3600000 | 无在线成员的房间空闲回收阈值 |
| `CHAT_RATE_*` / `ENQUEUE_RATE_*` | 6/2s、8/10s | 聊天与点歌限流 |
| `NODE_ENV=production` | development | 生产标记 |

配置在启动时全量校验（fail fast），非法值直接拒绝启动。

## 3. 生产部署要点

1. **域名与证书**：小程序正式环境要求 HTTPS。在 nginx/网关终结 TLS 后转发到本服务；同时升级 WebSocket（`Upgrade` 头透传）。
2. **小程序后台配置**：request 合法域名 + socket 合法域名均加上你的 https 域名。
   音乐播放地址**不需要**配置任何白名单：`BackgroundAudioManager.src / InnerAudioContext.src`
   不走小程序域名校验，只要是我们返回的 https 音频直连即可（服务端已统一归一化 https）。
3. **进程守护**：`pm2 start server/src/index.js --name ting-together` 或 systemd；停止用 SIGTERM（服务端已实现优雅停机，最多 5s）。
4. **容量参考**：单进程房间状态全内存；按 2C4G 估算可承载数百并发房间。跨实例/重启持久化（房间快照落盘/Redis）为后续扩展点。
5. **日志**：stdout/stderr 输出 JSON 行，建议按行采集（如 Loki/ELK）；`level=error` 走 stderr 便于告警分流。

## 4. 健康检查与告警

- `GET /healthz` → 200 `{"ok":true}`；负载均衡探针直接用该端点。
- 上游音源故障表现为搜索/取流降级（自动切换），日志关键字：`搜索源 … 失败，尝试降级`、`解析播放地址失败`。

## 5. 自有 VIP 账号接入（个人使用场景）

若你本人有网易云 VIP，可让点歌走你账号的权益，显著提升版权覆盖率：

1. 浏览器登录 `music.163.com` → F12 → Application → Cookies → 复制 `MUSIC_U` 的值；
2. 写入 `server/.env`（`NCM_COOKIE=值`，参考 `.env.example`），重启服务端；
3. 效果：降级链里的网易云取流从「试听片段」变为你账号可播的完整曲目（320k）。

边界与风险：
- 仅限**自有账号 + 房间内好友共听**的个人场景；不要对外提供公共服务（等于用你的账号向公众分发版权内容）。
- `MUSIC_U` 是账号凭据：不入库、不进日志、不写进小程序端；长期未登录会过期，过期后 VIP 曲目回落为试听片段，更新 cookie 即可。
- 本项目不接入盗版解析类第三方接口：法律风险高且随时失效；如需商业化，接正版曲库（见 `DEPLOY.md` 第 6 节）。

### 5.5 音乐插件（MusicFree 兼容，点歌页可选源）

点歌页第三个源「插件」：输入 MusicFree 格式插件的 JS URL 即可导入（服务端下载、沙箱加载、持久化到 `server/data/plugin.json`，重启保留）。公网服务配置了 `PLUGIN_IMPORT_TOKEN` 时，首次返回 403 后小程序会继续询问管理令牌；令牌只用于本次请求，不写入本地存储。

- 插件约定：`module.exports = { platform, version, search(keyword, page, type), getMediaSource(musicItem, quality), getLyric?(musicItem) }`；
  音质档位 standard|high|super（本项目 lossless 映射到 super）；搜索返回 `{ isEnd, data: [musicItem] }`。
- 曲目点歌时携带插件原始 musicItem（`raw`，≤4KB），服务端取流/歌词时原样回传给插件。
- 示例插件：仓库 `examples/musicfree-demo-plugin.js`（包装本服务端聚合搜索）；社区插件去 MusicFree 官方文档/插件仓库找 raw JS 地址。
- ⚠️ **安全边界**：插件 JS 在服务端 `node:vm` 沙箱执行——无 require/fs/process、fetch 强制超时、脚本 ≤512KB、同步执行 3s 超时、调用 12s 超时。**但 vm 不是硬安全边界**，仅导入可信来源的插件；不要在公网多租户环境开放导入接口。

## 6. 常见问题

| 现象 | 处置 |
|------|------|
| 点歌后一直「加载中」 | 看日志是否所有源均无版权（`已自动切歌`）；换歌或配置 `MUSIC_PROVIDER` 试试另一源 |
| 真机连不上服务端 | 检查首页服务端地址是否局域网 IP、防火墙 3100、同一 WiFi |
| 试听片段 | 免费源的版权限制，界面已标注「试听片段」，属预期行为 |
| 双端进度偶发偏差 | 暂停/恢复/拖动会按权威锚点立即对齐；稳定播放期不硬 seek。若仍跳变，在真机 vConsole 搜索 `[jump-audio]` 与 `[jump-ui]`，分别判断音频管线或渲染层 |
| 测试含外网用例失败 | `npm run verify` 可用 `SKIP_LIVE=1` 跳过真实音源门禁（其余门禁照常） |

## 6. 质量门禁（CI 就绪）

```bash
npm run verify          # 10 道门禁，exit 0 = 达标（G6 真实音源可用 SKIP_LIVE=1 跳过）
npm test && npm run lint
```

建议流水线顺序：`lint → unit → integration → verify(SKIP_LIVE=1) → 部署 → 线上 healthz 探活`。
