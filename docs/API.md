# REST API（v1）

Base：`http(s)://<server>`；除健康检查外统一前缀 `/api/v1`。请求/响应均为 UTF-8 JSON。
错误结构：`{ "code": "…", "message": "…" }`，HTTP 状态码语义化（400/404/413/429/500）。

## 健康检查

### `GET /healthz`
```json
{ "ok": true, "uptime": 120, "rooms": 3 }
```

## 房间

### `POST /api/v1/rooms` — 创建房间
请求：`{ "name": "小张" }`（name ≤ 24 字，缺省自动生成「乐迷#xxxx」）
响应 200：
```json
{ "roomId": "r…", "code": "AB2CD9", "userId": "u…", "token": "48位hex", "name": "小张", "isHost": true }
```

### `POST /api/v1/rooms/join` — 按邀请码加入
请求：`{ "code": "AB2CD9", "name": "小李" }`（code 大小写不敏感）
响应 200：同建房（`isHost: false`）。
错误：`404 NOT_FOUND`（房间不存在）、`ROOM_FULL`（满员）。

### `GET /api/v1/rooms/:code` — 房间预览（加入前）
响应 200：`{ "code", "memberCount", "onlineCount", "mode", "currentTitle" }`

### HTTP 轮询降级通道

- `POST /api/v1/rooms/state`：请求体携带 `code, userId, token`，返回完整快照。
- `POST /api/v1/rooms/action`：除上述凭据外，动作体与 WebSocket 上行消息一致；支持 `ctl/enqueue/dequeue/play-queue/chat/mode/quality/sync-req`，并共用同一协议校验。

## 音乐

### 音乐插件（MusicFree 兼容）

- `POST /api/v1/music/plugin` — 导入插件：`{ "url": "插件JS的URL" }` → 200 `{ "plugin": { id, name, version, url, installedAt } }`。服务端下载 JS、沙箱校验（需 `search`/`getMediaSource` 实现）并持久化（重启保留）。配置 `PLUGIN_IMPORT_TOKEN` 后须带 `x-plugin-token` 请求头。
- `GET /api/v1/music/plugin` — 当前插件信息（未导入为 `null`）。
- `DELETE /api/v1/music/plugin` — 移除插件；与导入共用 `x-plugin-token` 管理鉴权。
- 插件约定：`module.exports = { platform, version, search(keyword,page,type), getMediaSource(musicItem, quality), getLyric?(musicItem) }`；quality 档位 standard|high|super（lossless→super）。
- 搜索传 `source=plugin`；歌词用 `POST /api/v1/music/lyric` 传 `{ source:'plugin', raw: <musicItem> }`。
- ⚠️ 插件 JS 在服务端 `node:vm` 沙箱执行（无 require/fs/process，fetch 受控超时）。vm 非硬安全边界，**仅导入可信来源的插件**。

### `GET /api/v1/music/search?kw=&page=1&size=30&source=auto` — 搜索（点歌入口）
`source`（可选）：`auto`（默认，主源+自动降级链）| `netease`（直连网易云）| `plugin`（已导入插件）。
响应 200：
```json
{ "provider": "qqmusic", "tracks": [ { "source": "qqmusic", "trackId": "0039MnYb0qxYhV", "title": "晴天", "artist": "周杰伦", "album": "叶惠美", "picUrl": "https://…", "durationSec": 269, "vipLikely": true } ] }
```
说明：搜索在主源失败时自动降级到备用源，`provider` 字段标明实际命中的源；`vipLikely` 提示该曲在 QQ 侧为版权曲目（可能只能靠跨源降级或无播放地址）。限流 60 次/min/IP。

### `GET /api/v1/music/lyric?source=&id=&title=&artist=` — 歌词（LRC 文本）
响应 200：`{ "lyric": "[ti:晴天]\n[00:01.50]…" }`（可能为空串）。`title/artist` 用于跨源匹配兜底。

### `GET /api/v1/music/url?source=&id=&quality=` — 播放地址（调试/预加载）
响应 200：`{ "url": "https://…", "trial": false }`；`404 NO_URL` 表示该曲无可用播放源。
可选 `quality=standard|high|lossless`（缺省 high/320k；无损需账号权益，上游会自动降级）。
> 正常听歌流程不需要此接口：播放地址由服务端解析后随 WS `state` 快照下发，保证双端同源同曲。

## 约定

- 所有 id 类参数仅允许 `[A-Za-z0-9_-]{1,64}`；封面地址必须 https，否则置空。
- 点歌后的播放控制优先走 WebSocket；云 WS 不可用时自动走 HTTP 轮询降级通道（见 `docs/PROTOCOL.md`）。
