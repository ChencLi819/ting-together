# 微信小程序上线部署指南（DEPLOY）

本文回答：这个项目如何从「开发者工具里能跑」变成「别人能搜到/扫码使用」。
两条路线，按你的主体和预算选一条：

| | 方案 A：自建服务器（标准路线） | 方案 B：微信云托管（个人友好路线） |
|---|---|---|
| 需要 | 国内服务器 + **已备案** https 域名 + 证书 | 微信云托管容器（**免备案、免证书**） |
| WebSocket | nginx 透传 WSS | 云托管默认域名直连 WSS |
| 花费 | 服务器 + 域名（约 ¥100+/年 起） | 有免费额度，按量计费 |
| 适合 | 企业主体 / 已有备案资源 | 个人主体 / 快速上线给朋友用 |

> 结论先行：**个人主体、朋友间使用 → 直接走方案 B + 体验版，当天可上线**；要正式公开发布再按第 4 节提审。

---

## 0. 部署执行清单（本仓库已备好的东西）

**我方（工程侧，已就绪）：**
- 部署产物：`npm run pack:server` → 生成 `dist/ting-server.zip`（约 41KB，仅含 package.json/src/Dockerfile，**不含 node_modules/.env/凭据**，依赖由镜像构建时装）
- 容器：`server/Dockerfile`（监听 3100，内置 `/healthz` 健康检查）
- 安全：插件导入支持管理令牌 `PLUGIN_IMPORT_TOKEN`（公网必配；配置后导入需带请求头 `x-plugin-token`）

**你做（mp 后台，唯一需要微信登录的部分）：**
1. mp 后台 →「云开发」→ 开通环境（按量付费，有免费额度）
2. 云托管 → 新建服务（如 `ting-together`）→ 上传代码：选 `dist/ting-server.zip`
3. 服务设置：**监听端口 3100**；**副本数 = 1**（房间态在内存，多副本会拆散双人）；环境变量：
   - `NODE_ENV=production`
   - `MUSIC_PROVIDER=qqmusic`
   - `NCM_COOKIE=<你的 MUSIC_U>`（VIP 曲库，值从你浏览器 cookie 取，**不要提交进任何仓库**）
   - `PLUGIN_IMPORT_TOKEN=<一串随机长字符串>`（公网必配）
4. 开启公网访问/默认域名 → 浏览器访问 `https://<默认域名>/healthz` 确认 `{"ok":true}`
4.5 **实测必做**：mp 后台「开发设置 → 服务器域名」配置合法域名（云托管默认域名**不会**自动放行，真机报 request:fail url not in domain list）：
   - request 合法域名：`https://<默认域名>`
   - socket 合法域名：`wss://<默认域名>`（WebSocket 连房间用，漏配会在进房时报同样的错）
   - `tcloudbaseapp.com` 为腾讯已备案域名，可直接通过校验；改完手机端需杀掉小程序重进才生效
5. **把默认域名发我** → 我改 `miniprogram/utils/config.js` 的 `DEFAULT_BASE` → 你在开发者工具「上传」→ 后台设为体验版 → 拉朋友进体验成员

⚠️ 三个"不要"：不要把 `.env` 打进部署包；不要开多副本；NCM_COOKIE 过期（VIP 回落试听）就更新环境变量。

## 1. 前置准备（两条路线通用）

1. **注册小程序账号**：https://mp.weixin.qq.com → 立即注册 → 小程序 → 用未绑定过的邮箱。完成后在「设置 → 基础设置」拿到 **AppID**（替换 `project.config.json` 里的 `touristappid`）。
2. **类目选择（现实说明）**：「一起听」本质是音乐内容服务，而音乐/影音类目对个人主体是关闭的（需视听许可等资质），所以**在个人主体可选类目里没有精准归属**，只能挑错配最小的：优先「工具 > 效率」（列表需向下滚动查找），兜底「工具 > 信息查询」（官方定义为信息查询/订单服务，属轻度错配：驳回风险存在，但驳回后按提示改类目重提即可，非红线问题）。**不要**选音乐/影音/游戏类目——那是硬性错配或资质缺失。若目标是正式公开发布，真正的瓶颈不是类目措辞而是**内容合规**（第三方音乐源未授权，见第 6 节），建议先解决版权再走企业主体+合规类目提审。
   也**不要**选「游戏」类目：微信规则要求类目与实际功能一致，本产品没有游戏功能，按游戏类目提审要么驳回、要么要求提交游戏自审报告等无法提供的材料（个人主体注册小游戏另有单独通道，但那是"小游戏"产品形态，与本项目的"小程序"代码结构不通用）。
3. **用户隐私保护指引**：mp 后台「设置 → 服务内容声明 → 用户隐私保护指引」。本项目仅收集**用户自填昵称**，声明中勾选/填写对应项即可（不配置该指引无法过审，也无法上传体验版之后的版本）。
4. **本项目不涉及**：`wx.getUserProfile`、微信登录、支付、位置——都未使用，无需额外权限申请。

## 2. 方案 B：微信云托管（推荐个人用户）

云托管的好处：容器直接跑本项目的 Node 服务，微信自动提供默认域名（`*.tcloudbaseapp.com`，已在小程序信任域内），**不需要备案域名和证书**，request/socket 都能直连。

1. 开通：mp 后台「云开发 → 云托管」→ 创建环境（选按量付费，有免费额度）。
2. 新建服务 → 上传代码仓库/本地代码，**代码根目录选 `server/`**（本项目已带 `server/Dockerfile`，平台自动构建）。
3. 服务设置：
   - 监听端口：`3100`（与 Dockerfile `EXPOSE` 一致）；
   - 环境变量：`NODE_ENV=production`、`MUSIC_PROVIDER=qqmusic`；
   - 副本数 1 即可（房间状态在内存中，**不要开多副本**，否则双人可能落到不同实例——跨副本共享状态是后续扩展点）。
4. 拿到服务的「**默认域名**」，形如 `https://<env-id>.tcloudbaseapp.com/<path>`；WebSocket 地址把 `https` 换成 `wss`。
5. 改小程序端配置（见第 5 节），`DEFAULT_BASE` 填云托管默认域名。
6. 验证：浏览器访问 `https://<默认域名>/healthz` → `{"ok":true}`。

## 3. 方案 A：自建服务器

1. **服务器**：任意国内云主机（腾讯云/阿里云轻量即可），装 Node ≥ 20。
2. **域名与备案**：域名需完成 ICP 备案（微信后台只允许已备案域名）。
3. **部署服务端**：
   ```bash
   cd /opt/ting-together/server
   npm install --omit=dev
   NODE_ENV=production PORT=3100 pm2 start src/index.js --name ting-together
   pm2 save && pm2 startup      # 开机自启
   ```
4. **nginx 终结 TLS 并透传 WebSocket**（关键配置，缺 Upgrade 头则 WS 握手失败）：
   ```nginx
   server {
       listen 443 ssl;
       http2 on;
       server_name api.yourdomain.com;
       ssl_certificate     /etc/nginx/certs/fullchain.pem;
       ssl_certificate_key /etc/nginx/certs/privkey.pem;

       location / {
           proxy_pass http://127.0.0.1:3100;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;        # WebSocket 必需
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_read_timeout 300s;                       # 长连接（应用层 15s 心跳保活）
       }
   }
   ```
5. **小程序后台配置合法域名**（「开发管理 → 开发设置 → 服务器域名」，每月可修改次数有限，别反复改）：
   - request 合法域名：`https://api.yourdomain.com`
   - socket 合法域名：`wss://api.yourdomain.com`
6. 验证：`curl https://api.yourdomain.com/healthz`。

## 4. 小程序端改动清单（发布前必做）

| 文件 | 改动 |
|------|------|
| `project.config.json` | `"appid": "touristappid"` → 你的真实 AppID（也可只在开发者工具「详情 → 基本信息」里改） |
| `miniprogram/utils/config.js` | `DEFAULT_BASE` 改为生产地址（方案 A：`https://api.yourdomain.com`；方案 B：云托管默认域名）。**正式版会编译进包里，用户不可改**；首页的「服务端设置」入口可作为调试兜底保留 |
| 版本号 | `project.config.json` 补 `"version"` 或上传时填写 |

## 5. 发布流程（版本三阶）

1. **开发版**：开发者工具里直接预览/调试（仅自己可见）。
2. **体验版**（个人最实用）：工具「上传」→ mp 后台「版本管理 → 开发版本 → 选为体验版」→ 生成二维码 → 在「成员管理」把朋友加为**体验成员**（个人主体上限 15 人）→ 扫码即用，**无需审核**。双人一起听的小圈子用这一步就够。
3. **正式发布**：版本管理 → 提交审核（类目=工具、补充隐私指引、功能页面截图）→ 审核通过 → 全量发布。

## 6. 合规与风险提示（务必阅读）

- **音乐版权**：本项目音乐来自第三方公开接口（QQ/网易云的游客通道），属于**未授权内容源**。体验版/朋友间自用风险较低；**正式公开发布存在版权合规风险**，审核或投诉可能被下架。要商业化请接入正版曲库（如腾讯云正版曲库直通车、各版权方开放 API），服务端 Provider 抽象层就是为替换正版源预留的。
- 第三方接口无 SLA：接口变化可能导致取流失败，服务端已做降级与自动切歌，但需关注日志（`RUNBOOK.md` 第 5 节）。
- 云托管多副本/多实例会导致双人不同步（内存态房间），保持单副本。

## 7. 上线自检清单

- [ ] `/healthz` 通过生产域名返回 `{"ok":true}`
- [ ] 两台真机：建房 → 加入 → 点歌 → 双端同步播放 → 聊天收发
- [ ] 手机切后台 30s 回来能自动重连并恢复同步（重连 + sync-req 已实现）
- [ ] 小程序后台 request/socket 合法域名与线上地址一致
- [ ] 用户隐私保护指引已配置且与实际收集信息一致
- [ ] `MUSIC_PROVIDER` 已按线上实测选定（默认 qqmusic）
- [ ] pm2/云托管已配置，进程重启后房间会清空（预期行为，可在公告提示用户）
