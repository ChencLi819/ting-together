# 实时协议（PROTOCOL v2）

- 端点：`ws(s)://<server>/ws`（小程序端由 http(s) 服务端地址推导）。
- 编码：UTF-8 JSON 文本帧；单帧 ≤ 8KB；二进制帧直接拒绝。
- 鉴权：连接后 **5 秒内**必须发 `hello`，token 来自 REST 建房/加入的响应。

## 上行（客户端 → 服务端）

| type | 字段 | 说明 |
|------|------|------|
| `hello` | `token, userId, name` | 握手；成功回 `welcome` |
| `ctl` | `action ∈ ready\|end\|pause\|resume\|seek\|skip\|prev`；`positionSec?`（pause/resume/seek）；`trackId`（ready/end 必填，音频错误触发的 skip 携带） | 播放控制；trackId 用于丢弃迟到/重复事件 |
| `enqueue` | `track{source,trackId,title,artist?,album?,picUrl?,durationSec?}`；`source ∈ qqmusic|netease|mock|plugin`；**plugin 必须额外带 `raw`**（插件原始 musicItem，≤4KB，取流/歌词时原样回传给插件） | 点歌；plugin 源不参与自动降级，只走已导入插件 |
| `dequeue` | `qid` | 移除点歌（本人或房主） |
| `play-queue` | `qid` | 队列插播：立即播放该点歌（原曲入历史，可被“上一首”找回）；权限同播放控制 |
| `chat` | `text ≤ 300 字` | 聊天 |
| `mode` | `mode ∈ free\|host` | 切换控制模式（仅房主） |
| `quality` | `level ∈ standard\|high\|lossless` | 房间级音质（128k/320k/无损FLAC）；权限与播放控制一致，切换后当前曲目自动按新音质重取流 |
| `sync-req` | — | 请求最新房间快照（重连后必发） |
| `ping` | — | 应用层心跳（15s 一次），回 `pong` |

## 下行（服务端 → 客户端）

| type | 字段 | 说明 |
|------|------|------|
| `welcome` | `userId, name, state` | 握手成功，附带完整房间快照 |
| `state` | `state` | 房间快照（成员/模式/播放/队列），**seq 单调递增**，客户端丢弃 seq 更小的快照 |
| `chat` | `msg{id, kind:'user', userId, name, text, ts}` | 聊天消息（按 id 去重） |
| `sys` | `msg{id, kind:'sys', text, ts}` | 系统消息（加入/离开/点歌/切歌/房主移交） |
| `error` | `code, message` | 单条消息级错误，不打断会话（AUTH_FAILED/ROOM_FULL 除外，应回首页） |
| `pong` | — | 心跳应答 |

## state 快照结构

```json
{
  "roomId": "r…", "code": "AB2CD9", "hostUserId": "u…", "hostName": "小张",
  "mode": "free|host", "quality": "standard|high|lossless", "seq": 42,
  "playback": {
    "source": "qqmusic", "trackId": "0039MnYb0qxYhV", "title": "晴天", "artist": "周杰伦",
    "album": "叶惠美", "picUrl": "https://…", "durationSec": 269,
    "status": "loading|playing|paused", "startAtSec": 88.5, "positionSec": 88.5,
    "url": "https://…mp3", "urlTrial": false, "urlQuality": "high"
  },
  "queue": [ { "qid": "q…", "track": {…}, "requestedBy": "u…", "requestedByName": "小李" } ],
  "users": [ { "id": "u…", "name": "小张" } ],
  "memberCount": 2, "serverNowMs": 1788…, "chat": [ … 最近若干条 ]
}
```

## 客户端同步算法

```
url 为空                  → 停止旧流并显示“加载中”
曲目/URL 变化             → 重建音频；loading/paused 先压住自动播放
onCanplay                 → seek 到 startAtSec/positionSec，上报 ready
首个 ready                → 服务端建立 playing 时间线并广播
pause/resume/seek 锚点变化 → 客户端立即 seek 对齐
稳定 playing              → 本地音频时钟为真相，不根据周期快照硬 seek；异常只记录 [jump-audio]
onEnded                   → 上报 ctl end + trackId；活跃端收齐或 3 秒兜底后接歌
```

云 WebSocket 不可用时，客户端使用相同消息对象经 `POST /api/v1/rooms/action` 上报，并以
`POST /api/v1/rooms/state` 每 1.5 秒拉取快照；两条通道共用同一套协议校验。

### 已部署 v1 服务兼容

客户端会按快照字段自动识别协议：含 `status` 的快照按上述 v2 状态机处理；仅含
`isPlaying/anchorMs` 的旧快照会归一为 `playing|paused`。旧服务已自行启动时间线，客户端
不会向它发送不支持的 `ready`，恢复播放使用旧动作 `play`；稳定播放期间也不会因轮询中
持续变化的 `positionSec` 反复 seek。该兼容只在客户端边界生效，本地服务端仍严格使用 v2。

## 错误码

`BAD_MESSAGE`（校验失败）、`AUTH_FAILED`（令牌无效）、`ROOM_FULL`（满员）、`NO_SESSION`（未握手）、
`HELLO_TIMEOUT`、`PERMISSION`（点播模式/移除他人点歌）、`NO_TRACK`、`NOT_FOUND`、`RATE_LIMIT`、`BAD_PARAMS`。
