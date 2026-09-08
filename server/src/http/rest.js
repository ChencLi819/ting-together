'use strict';

const crypto = require('node:crypto');
const { createLogger } = require('../logger');
const provider = require('../music/provider');
const pluginStore = require('../music/pluginStore');
const P = require('../ws/protocol');
const { config } = require('../config');
const { RateLimiter } = require('../utils/rateLimiter');

const log = createLogger('http:rest');

const MAX_BODY_BYTES = 64 * 1024;
const API_PREFIX = '/api/v1';

/**
 * 极简 REST 路由（无三方依赖）。
 * 返回 true 表示请求已处理。
 */
function createRestHandler({ manager }) {
  const searchLimiter = new RateLimiter({ windowMs: 60000, max: 60 });
  // 轮询降级通道限流：state 轮询约 1.5s 一次，聊天/点歌沿用与 WS 相同的默认限额
  const pollStateLimiter = new RateLimiter({ windowMs: 10000, max: 40 });
  const pollChatLimiter = new RateLimiter({ windowMs: config.rate.chat.windowMs, max: config.rate.chat.max });
  const pollEnqueueLimiter = new RateLimiter({ windowMs: config.rate.enqueue.windowMs, max: config.rate.enqueue.max });

  async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function canMutatePlugin(req) {
    const requiredToken = config.music.pluginImportToken;
    if (!requiredToken) return true;
    const provided = String(req.headers['x-plugin-token'] ?? '');
    const expectedHash = crypto.createHash('sha256').update(requiredToken).digest();
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    return crypto.timingSafeEqual(expectedHash, providedHash);
  }

  function publicRoomView(room) {
    const pb = room.playback;
    return {
      code: room.code,
      memberCount: room.members.size,
      onlineCount: room.onlineMembers().length,
      mode: room.mode,
      currentTitle: pb && pb.track ? `${pb.track.title} · ${pb.track.artist}` : '',
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    if (!pathname.startsWith(API_PREFIX) && pathname !== '/healthz') return false;
    const method = req.method ?? 'GET';
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? 'unknown').trim();

    try {
      // ---- 健康检查
      if (pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), rooms: manager.size });
        return true;
      }

      // ---- 建房
      if (pathname === `${API_PREFIX}/rooms` && method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 24) : `乐迷#${ip.slice(-4)}`;
        const { room, membership } = manager.createRoom(name);
        log.info('创建房间', { roomId: room.id, code: room.code });
        sendJson(res, 200, {
          roomId: room.id,
          code: room.code,
          userId: membership.userId,
          token: membership.token,
          name: membership.name,
          isHost: true,
        });
        return true;
      }

      // ---- 加入房间
      if (pathname === `${API_PREFIX}/rooms/join` && method === 'POST') {
        const body = await readJsonBody(req);
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        if (!code) return sendJson(res, 400, { code: 'BAD_PARAMS', message: '缺少邀请码' });
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 24) : `乐迷#${ip.slice(-4)}`;
        const result = manager.joinRoom(code, name);
        if (!result.ok) return sendJson(res, 404, { code: result.code, message: result.message });
        log.info('加入房间', { code, userId: result.membership.userId });
        sendJson(res, 200, {
          roomId: result.membership.roomId,
          code: result.membership.code,
          userId: result.membership.userId,
          token: result.membership.token,
          name: result.membership.name,
          isHost: false,
        });
        return true;
      }

      // ---- 房间预览（加入前看一眼）
      const previewMatch = pathname.match(/^\/api\/v1\/rooms\/([A-Z2-9]{6})$/);
      if (previewMatch && method === 'GET') {
        const room = manager.getByCode(previewMatch[1]);
        if (!room) return sendJson(res, 404, { code: 'NOT_FOUND', message: '房间不存在或邀请码有误' });
        return sendJson(res, 200, publicRoomView(room));
      }

      // ---- 轮询降级通道（WebSocket 不可用时的兜底）：状态轮询
      if (pathname === `${API_PREFIX}/rooms/state` && method === 'POST') {
        const body = await readJsonBody(req);
        const room = manager.getByCode(String(body.code ?? ''));
        const member = room && room.verifyToken({ userId: String(body.userId ?? ''), token: String(body.token ?? '') });
        if (!room || !member) return sendJson(res, 403, { code: 'AUTH_FAILED', message: '房间或令牌无效' });
        room.touchPollingMember(member.id);
        room.maybeMigrateHost();
        if (!pollStateLimiter.tryConsume(`${room.id}:${member.id}`)) {
          return sendJson(res, 429, { code: 'RATE_LIMIT', message: '轮询过于频繁，请稍后再试' });
        }
        room.touch();
        const snap = room.snapshot();
        if (snap.users && !snap.users.some((u) => u.id === member.id)) {
          snap.users.push({ id: member.id, name: member.name });
        }
        return sendJson(res, 200, snap);
      }

      // ---- 轮询降级通道：动作（ctl/enqueue/dequeue/play-queue/chat/mode/sync-req）
      if (pathname === `${API_PREFIX}/rooms/action` && method === 'POST') {
        const body = await readJsonBody(req);
        const room = manager.getByCode(String(body.code ?? ''));
        const member = room && room.verifyToken({ userId: String(body.userId ?? ''), token: String(body.token ?? '') });
        if (!room || !member) return sendJson(res, 403, { code: 'AUTH_FAILED', message: '房间或令牌无效' });
        const userId = member.id;
        const check = P.validateIncoming(body);
        if (!check.ok || check.value.type === 'hello') {
          return sendJson(res, 400, { code: 'BAD_PARAMS', message: check.error || '不支持 hello 动作' });
        }
        const msg = check.value;
        room.touchPollingMember(userId);
        room.maybeMigrateHost();
        let result = { ok: true };
        switch (msg.type) {
          case 'ctl': {
            const action = msg.action;
            switch (action) {
              case 'ready':
                result = room.clientReady(userId, msg.trackId);
                break;
              case 'end':
                result = room.clientEnd(userId, msg.trackId);
                break;
              case 'pause':
                result = room.clientPause(userId, msg.positionSec);
                break;
              case 'resume':
                result = room.clientResume(userId, msg.positionSec);
                break;
              case 'seek':
                result = room.clientSeek(userId, msg.positionSec);
                break;
              case 'skip':
                result = room.skipCurrent(userId, msg.trackId);
                break;
              case 'prev':
                result = room.playPrevious(userId);
                break;
              default:
                return sendJson(res, 400, { code: 'BAD_PARAMS', message: `不支持的控制动作: ${action}` });
            }
            break;
          }
          case 'enqueue': {
            if (!pollEnqueueLimiter.tryConsume(`${room.id}:${userId}`)) {
              return sendJson(res, 429, { code: 'RATE_LIMIT', message: '点歌太频繁啦，稍等片刻' });
            }
            result = room.enqueue(userId, msg.track);
            break;
          }
          case 'dequeue':
            result = room.dequeue(userId, msg.qid);
            break;
          case 'play-queue':
            result = room.playQueued(userId, msg.qid);
            break;
          case 'chat': {
            if (!pollChatLimiter.tryConsume(`${room.id}:${userId}`)) {
              return sendJson(res, 429, { code: 'RATE_LIMIT', message: '发言太快了，休息一下' });
            }
            result = room.addChat(userId, msg.text);
            break;
          }
          case 'mode':
            result = room.setMode(userId, msg.mode);
            break;
          case 'quality':
            result = room.setQuality(userId, msg.level);
            break;
          case 'sync-req':
            result = { ok: true };
            break;
          default:
            return sendJson(res, 400, { code: 'BAD_PARAMS', message: `不支持的动作类型: ${msg.type}` });
        }
        if (!result.ok) return sendJson(res, 400, { code: result.code, message: result.message });
        const snap = room.snapshot();
        if (snap.users && !snap.users.some((u) => u.id === userId)) {
          snap.users.push({ id: userId, name: member.name });
        }
        return sendJson(res, 200, { ok: true, snapshot: snap });
      }

      // ---- 音乐插件（MusicFree 兼容）：导入 / 查询 / 删除
      if (pathname === `${API_PREFIX}/music/plugin` && method === 'POST') {
        // 插件导入 = 服务端加载并执行第三方 JS：公网部署时可用管理令牌锁住
        if (!canMutatePlugin(req)) {
          return sendJson(res, 403, { code: 'FORBIDDEN', message: '插件导入需要管理令牌（请求头 x-plugin-token）' });
        }
        const body = await readJsonBody(req);
        const info = await pluginStore.importFromUrl(String(body.url ?? '').trim());
        return sendJson(res, 200, { plugin: info });
      }
      if (pathname === `${API_PREFIX}/music/plugin` && method === 'GET') {
        return sendJson(res, 200, { plugin: pluginStore.get() });
      }
      if (pathname === `${API_PREFIX}/music/plugin` && method === 'DELETE') {
        if (!canMutatePlugin(req)) {
          return sendJson(res, 403, { code: 'FORBIDDEN', message: '删除插件需要管理令牌（请求头 x-plugin-token）' });
        }
        pluginStore.clear();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 音乐搜索（GET=查询串；POST=JSON 体，云调用链路统一走 POST）
      if (pathname === `${API_PREFIX}/music/search` && (method === 'GET' || method === 'POST')) {
        const params = {};
        if (method === 'POST') Object.assign(params, await readJsonBody(req));
        for (const [k, v] of url.searchParams) if (!(k in params)) params[k] = v;
        const kw = String(params.kw ?? '').trim();
        const page = Number.parseInt(params.page ?? '1', 10) || 1;
        const size = Number.parseInt(params.size ?? '30', 10) || 30;
        const source = params.source ?? 'auto';
        if (!kw) return sendJson(res, 400, { code: 'BAD_PARAMS', message: '缺少搜索关键词 kw' });
        if (kw.length > 60) return sendJson(res, 400, { code: 'BAD_PARAMS', message: '关键词过长' });
        if (!['auto', 'netease', 'mock', 'plugin'].includes(source)) {
          return sendJson(res, 400, { code: 'BAD_PARAMS', message: 'source 必须是 auto|netease|mock|plugin' });
        }
        if (source === 'plugin' && !pluginStore.get()) {
          return sendJson(res, 400, { code: 'BAD_PARAMS', message: '尚未导入音乐插件，请先导入' });
        }
        if (!searchLimiter.tryConsume(`search:${ip}`)) {
          return sendJson(res, 429, { code: 'RATE_LIMIT', message: '搜索太频繁，请稍后再试' });
        }
        if (source === 'netease') {
          const result = await provider.searchNamed('netease', kw, { page, pageSize: size });
          return sendJson(res, 200, { provider: result.provider, tracks: result.tracks });
        }
        if (source === 'plugin') {
          const result = await provider.searchNamed('plugin', kw, { page });
          return sendJson(res, 200, { provider: result.provider, tracks: result.tracks });
        }
        const result = await provider.search(kw, { page, pageSize: size });
        return sendJson(res, 200, { provider: result.provider, tracks: result.tracks });
      }

      // ---- 歌词（统一入口：GET=查询串；POST=JSON 体，兼容插件 raw 回传）
      if (pathname === `${API_PREFIX}/music/lyric` && (method === 'GET' || method === 'POST')) {
        const params = {};
        let raw = null;
        if (method === 'POST') {
          const body = await readJsonBody(req);
          Object.assign(params, body);
          raw = body.raw ?? null;
        }
        for (const [k, v] of url.searchParams) if (!(k in params)) params[k] = v;
        const source = params.source ?? '';
        // 插件源可以只带 raw（musicItem 里有 id）
        const trackId = String(params.id ?? (raw && raw.id != null ? raw.id : ''));
        if (!/^(qqmusic|netease|mock|plugin)$/.test(source) || !/^[A-Za-z0-9_-]{1,64}$/.test(trackId)) {
          return sendJson(res, 400, { code: 'BAD_PARAMS', message: '参数非法' });
        }
        if (source === 'plugin') {
          if (!raw || typeof raw !== 'object') {
            return sendJson(res, 400, { code: 'BAD_PARAMS', message: '插件源歌词需要 raw（musicItem）' });
          }
          const text = await provider.fetchLyric({ source: 'plugin', trackId, raw });
          return sendJson(res, 200, { lyric: text });
        }
        const track = {
          source,
          trackId,
          title: String(params.title ?? '').slice(0, 100),
          artist: String(params.artist ?? '').slice(0, 100),
        };
        const text = await provider.fetchLyric(track);
        return sendJson(res, 200, { lyric: text });
      }

      // ---- 播放地址（调试/预加载用；正常流程由房间状态下发。GET=查询串；POST=JSON 体）
      if (pathname === `${API_PREFIX}/music/url` && (method === 'GET' || method === 'POST')) {
        const params = {};
        if (method === 'POST') Object.assign(params, await readJsonBody(req));
        for (const [k, v] of url.searchParams) if (!(k in params)) params[k] = v;
        const source = params.source ?? '';
        const trackId = String(params.id ?? '');
        const quality = params.quality ?? '';
        if (!/^(qqmusic|netease|mock)$/.test(source) || !/^[A-Za-z0-9_-]{1,64}$/.test(trackId)) {
          return sendJson(res, 400, { code: 'BAD_PARAMS', message: '参数非法' });
        }
        if (quality && !['standard', 'high', 'lossless'].includes(quality)) {
          return sendJson(res, 400, { code: 'BAD_PARAMS', message: 'quality 必须是 standard|high|lossless' });
        }
        const track = { source, trackId, title: '', artist: '', album: '', picUrl: '', durationSec: 0 };
        const result = await provider.resolveUrl(track, { quality: quality || undefined });
        if (!result) return sendJson(res, 404, { code: 'NO_URL', message: '该曲目暂无可播放源（版权或上游异常）' });
        return sendJson(res, 200, { url: result.url, trial: result.trial });
      }

      return sendJson(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });
    } catch (err) {
      const status = err.statusCode ?? 500;
      log.error('REST 处理异常', { pathname, method, error: err.message });
      if (!res.headersSent) {
        sendJson(res, status, { code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: err.message || '服务内部错误' });
      }
      return true;
    }
  }

  return handle;
}

module.exports = { createRestHandler, API_PREFIX };
