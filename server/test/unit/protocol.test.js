'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../../src/ws/protocol');

test('协议：合法消息通过校验', () => {
  const ok = P.validateIncoming({ type: 'hello', token: 'a'.repeat(10), userId: 'u1', name: '小明' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, '小明');

  assert.equal(P.validateIncoming({ type: 'ctl', action: 'seek', positionSec: 12.5 }).ok, true);
  assert.equal(P.validateIncoming({ type: 'ctl', action: 'end', trackId: 'm001' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'ctl', action: 'ready', trackId: 'm001' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'ctl', action: 'resume', positionSec: 30 }).ok, true);
  assert.equal(P.validateIncoming({ type: 'ping' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'sync-req' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'mode', mode: 'host' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'quality', level: 'lossless' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'quality', level: 'standard' }).ok, true);
  assert.equal(P.validateIncoming({ type: 'play-queue', qid: 'q1_100_5' }).ok, true);
  assert.equal(
    P.validateIncoming({ type: 'enqueue', track: { source: 'qqmusic', trackId: '0039MnYb0qxYhV', title: '晴天', artist: '周杰伦', picUrl: 'https://a/b.jpg', durationSec: 269 } }).ok,
    true,
  );
});

test('协议：非法消息被拒绝', () => {
  const bad = [
    null,
    'text',
    [],
    {},
    { type: 'hack' },
    { type: 'hello', token: '', userId: 'u1', name: 'x' },
    { type: 'hello', token: 't', userId: 'u1' },
    { type: 'ctl', action: 'volume' },
    { type: 'ctl', action: 'seek', positionSec: 'x' },
    { type: 'ctl', action: 'seek', positionSec: -1 },
    { type: 'ctl', action: 'end', trackId: '../etc' },
    { type: 'enqueue' },
    { type: 'enqueue', track: { source: 'evil', trackId: 'x', title: 't' } },
    { type: 'enqueue', track: { source: 'mock', trackId: '', title: 't' } },
    { type: 'enqueue', track: { source: 'mock', trackId: 'x', title: '' } },
    { type: 'dequeue', qid: 'a b c!' },
    { type: 'chat', text: '   ' },
    { type: 'mode', mode: 'king' },
    { type: 'quality', level: 'hifi' },
    { type: 'quality' },
    { type: 'play-queue', qid: 'a b!' },
    { type: 'play-queue' },
  ];
  for (const msg of bad) {
    const res = P.validateIncoming(msg);
    assert.equal(res.ok, false, `应拒绝: ${JSON.stringify(msg)}`);
  }
});

test('协议：长文本截断到上限，超限字段丢弃', () => {
  const res = P.validateIncoming({ type: 'chat', text: 'a'.repeat(300) });
  assert.equal(res.ok, true);
  assert.equal(res.value.text.length, 300);

  const overflow = P.validateIncoming({ type: 'chat', text: 'x'.repeat(301) });
  assert.equal(overflow.ok, true, '超长文本应截断而非拒绝');
  assert.equal(overflow.value.text.length, 300);

  const track = P.validateIncoming({
    type: 'enqueue',
    track: { source: 'mock', trackId: 'x', title: 't'.repeat(150), artist: 'a'.repeat(150) },
  });
  assert.equal(track.ok, true);
  assert.equal(track.value.track.title.length, 100);
  assert.equal(track.value.track.artist.length, 100);
  assert.equal(track.value.track.picUrl, '', '非 https 封面应置空');

  const insecureCover = P.validateIncoming({
    type: 'enqueue',
    track: { source: 'mock', trackId: 'x', title: 't', picUrl: 'http://insecure' },
  });
  assert.equal(insecureCover.ok, true, 'http 封面应规范化为空而不是拒绝');
  assert.equal(insecureCover.value.track.picUrl, '');
});

test('协议：下行构造器与 sendSafe', () => {
  const fakeWs = {
    readyState: 1,
    sent: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    },
  };
  assert.equal(P.sendSafe(fakeWs, P.outPong()), true);
  assert.equal(fakeWs.sent[0].type, 'pong');

  const deadWs = { readyState: 3, send() { throw new Error('closed'); } };
  assert.equal(P.sendSafe(deadWs, P.outError('X', 'y')), false);

  const state = P.outState({ seq: 1 });
  assert.equal(state.type, 'state');
  assert.equal(state.state.seq, 1);
});
