'use strict';

const PLAYBACK_STATUSES = ['loading', 'playing', 'paused'];

/**
 * 将线上旧协议（isPlaying/anchorMs）与本地 v2（status/startAtSec）归一。
 * 返回新对象，避免在传输层缓存上写入 UI 字段。
 */
function normalizeRoomSnapshot(snapshot) {
  if (!snapshot || !snapshot.playback) return snapshot;
  const pb = snapshot.playback;
  const modern = PLAYBACK_STATUSES.includes(pb.status);
  const legacy = !modern && typeof pb.isPlaying === 'boolean';
  const status = modern ? pb.status : legacy ? (pb.isPlaying ? 'playing' : 'paused') : 'loading';
  const positionSec = Number.isFinite(Number(pb.positionSec)) ? Number(pb.positionSec) : 0;
  const startAtSec = modern && Number.isFinite(Number(pb.startAtSec)) ? Number(pb.startAtSec) : positionSec;

  return {
    ...snapshot,
    playback: {
      ...pb,
      status,
      startAtSec,
      positionSec,
      protocolVersion: legacy ? 1 : 2,
    },
  };
}

/** 房间页控件只展示已经生效的播放状态；loading 阶段不可提前显示为可播放。 */
function playbackViewState(playback) {
  const hasUrl = Boolean(playback && playback.url);
  const loading = Boolean(playback && (!hasUrl || playback.status === 'loading'));
  return {
    playing: Boolean(playback && playback.status === 'playing' && hasUrl),
    loading,
    disabled: !playback || loading,
  };
}

module.exports = { normalizeRoomSnapshot, playbackViewState };
