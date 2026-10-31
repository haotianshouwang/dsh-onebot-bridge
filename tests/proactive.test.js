import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProactiveMessaging, inQuietHours, parseQuietHours} from '../src/session/proactive.js';

const base = {
  proactiveEnabled: true,
  proactiveInactiveMinutes: 60,
  proactiveDailyLimit: 2,
  proactiveMinIntervalMinutes: 30,
  proactiveQuietHours: '23:00-08:00',
  proactiveAllowCasual: true,
  proactiveMaxChars: 240
};

async function setup(t, overrides = {}, {compose, send} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-proactive-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let now = new Date(2026, 9, 31, 12, 0).getTime();
  let ownerAt = now - 2 * 3600000;
  const sent = [], composed = [];
  const item = {config: {...base, ...overrides}};
  const p = await new ProactiveMessaging({
    dir,
    config: () => item.config,
    online: () => true,
    lastOwnerAt: () => ownerAt,
    recent: () => '主人: 今天有点累',
    compose: async options => { composed.push(options); return compose ? compose(options) : '今天先别熬太晚，记得休息。'; },
    send: async text => { sent.push(text); return send ? send(text) : {outcome: 'confirmed'}; },
    now: () => now,
    log: () => {}
  }).open();
  return {p, item, sent, composed, tick: seconds => { now += seconds * 1000; }, setOwner: value => { ownerAt = value; }, now: () => now};
}

test('安静时段解析支持跨午夜', () => {
  assert.deepEqual(parseQuietHours('23:00-08:00'), [1380, 480]);
  assert.equal(parseQuietHours('bad'), null);
  assert.equal(inQuietHours('23:00-08:00', new Date(2026, 9, 31, 23, 30).getTime()), true);
  assert.equal(inQuietHours('23:00-08:00', new Date(2026, 9, 31, 7, 30).getTime()), true);
  assert.equal(inQuietHours('23:00-08:00', new Date(2026, 9, 31, 12, 0).getTime()), false);
});

test('不活跃且无内容时只记录跳过，不发送', async t => {
  const x = await setup(t, {}, {compose: async () => 'SKIP'});
  const result = await x.p.tick();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'no-content');
  assert.equal(x.sent.length, 0);
  assert.equal(x.p.status().lastOutcome, 'skipped');
});

test('满足条件时发送并记录 confirmed，随后受最短间隔限制', async t => {
  const x = await setup(t);
  const result = await x.p.tick();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(x.sent.length, 1);
  assert.equal(x.p.status().today, 1);
  x.tick(60);
  const skipped = await x.p.tick();
  assert.equal(skipped.skipped, 'backoff');
  assert.equal(x.sent.length, 1);
});

test('发送 unknown 不冒充成功，并保留真实状态', async t => {
  const x = await setup(t, {}, {send: async () => ({outcome: 'unknown'})});
  const result = await x.p.tick();
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unknown');
  assert.equal(x.p.status().lastOutcome, 'unknown');
  assert.ok(x.p.status().recent.some(row => row.outcome === 'unknown'));
});

test('任务完成事件在允许时优先触发；关闭时只拒绝入队', async t => {
  const x = await setup(t, {proactiveAllowTask: true});
  assert.equal(await x.p.notify({reason: 'task', title: '查资料', summary: '两个来源一致'}), true);
  const result = await x.p.tick();
  assert.equal(result.ok, true);
  assert.equal(x.sent.length, 1);
  assert.equal(x.p.status().pending, 0);
  assert.equal(x.p.status().recent[0].reason, 'task');
  const off = await setup(t, {proactiveAllowTask: false});
  assert.equal(await off.p.notify({reason: 'task', title: 'x'}), false);
  assert.equal(off.sent.length, 0);
});

test('重复事件不会重复入队，重启后频率记录仍然保留', async t => {
  const x = await setup(t, {proactiveAllowTask: true});
  assert.equal(await x.p.notify({reason: 'task', title: '查资料', summary: '两个来源一致'}), true);
  assert.equal(await x.p.notify({reason: 'task', title: '查资料', summary: '两个来源一致'}), false);
  assert.equal(x.p.status().pending, 1);
  await x.p.tick();
  const reopened = await new ProactiveMessaging({
    dir: x.p.dir, config: () => x.item.config, online: () => true,
    lastOwnerAt: () => x.now() - 2 * 3600000, recent: () => '主人: 今天有点累',
    compose: async () => '第二次不同内容', send: async () => ({outcome: 'confirmed'}), now: x.now, log: () => {}
  }).open();
  assert.equal(reopened.status().today, 1);
  assert.equal(reopened.status().lastOutcome, 'confirmed');
});

test('安静时段、每日上限和关闭开关都不发送', async t => {
  const quiet = await setup(t, {proactiveQuietHours: '12:00-13:00'});
  assert.equal((await quiet.p.tick()).skipped, 'quiet');
  assert.equal(quiet.sent.length, 0);

  const capped = await setup(t, {proactiveDailyLimit: 0});
  assert.equal((await capped.p.tick()).skipped, 'daily-limit');

  const off = await setup(t, {proactiveEnabled: false});
  assert.equal((await off.p.tick()).skipped, 'disabled');
});

test('重复内容会被跳过，避免同一句话刷屏', async t => {
  const x = await setup(t);
  await x.p.tick();
  x.tick(31 * 60);
  const result = await x.p.tick();
  assert.equal(result.skipped, 'duplicate');
  assert.equal(x.sent.length, 1);
});
