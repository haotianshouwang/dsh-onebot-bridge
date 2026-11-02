import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProactiveMessaging, inQuietHours, parseQuietHours} from '../src/session/proactive.js';
import {recordProactiveConversation} from '../src/session/proactive-provenance.js';

const base = {
  proactiveEnabled: true,
  proactiveInactiveMinutes: 60,
  proactiveDailyLimit: 2,
  proactiveMinIntervalMinutes: 30,
  proactiveQuietHours: '23:00-08:00',
  proactiveAllowCasual: true,
  proactiveMaxChars: 240
};

test('已确认的社交主动消息写入真实来源，失败结果不写入', () => {
  const calls = [];
  const event = {
    reason: 'social',
    evidence: {
      key: '10000002:group:88888',
      sources: [{id: '101', user: '12345678', text: '鱼要鲨人了'}]
    }
  };
  const args = {
    event,
    result: {outcome: 'confirmed', data: {message_id: 'story-1'}},
    actions: {sentMessages: () => [{text: '我来告诉你这件事'}]},
    execution: {},
    conversation: {sent: (...value) => calls.push(value)},
    message: {bot: '10000002', key: '10000002:private:10000001'},
    text: '备用文本'
  };

  assert.equal(recordProactiveConversation(args), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'story-1');
  assert.equal(calls[0][2], '我来告诉你这件事');
  assert.deepEqual(calls[0][3], event.evidence);

  args.result = {outcome: 'failed'};
  assert.equal(recordProactiveConversation(args), false);
  assert.equal(calls.length, 1);
});

test('social composition receives original messages with speaker identity rather than only a model summary', () => {
  const proactive = new ProactiveMessaging({dir: os.tmpdir(), lastOwnerAt: () => 0});
  const event = {reason: 'social', title: '群聊见闻', evidence: {
    key: '10000002:group:88888',
    sources: [{id: '101', user: '12345678', text: '鱼要鲨人了', time: 1000}]
  }};
  const prompt = proactive.prompt({}, '模型概括的群聊见闻', 2000000, event);
  assert.match(prompt, /12345678/);
  assert.match(prompt, /鱼要鲨人了/);
  assert.match(prompt, /原消息/);
});

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
  assert.equal(x.p.status().today, 0);
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
  const x = await setup(t, {proactiveMinIntervalMinutes: 180}, {send: async () => ({outcome: 'unknown'})});
  const result = await x.p.tick();
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unknown');
  assert.equal(x.p.status().lastOutcome, 'unknown');
  assert.ok(x.p.status().recent.some(row => row.outcome === 'unknown'));
  x.tick(31 * 60);
  assert.equal((await x.p.tick()).skipped, 'interval');
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

test('群聊分享必须有有效来源，发送后按事件去重并回写真实结果', async t => {
  const x = await setup(t, {proactiveAllowGroupStories: true});
  const deliveries = [];
  x.p.validateEvent = event => event.evidence?.key === 'bot:group:88888';
  x.p.onEventResult = async (event, result) => deliveries.push({id: event.eventKey, state: result.state});
  const event = {reason: 'social', eventKey: 'source-101', title: '群聊见闻', summary: '群友讨论了游戏新玩法', evidence: {key: 'bot:group:88888'}};
  assert.equal(await x.p.notify({...event, evidence: {}}), false);
  assert.equal(await x.p.notify(event), true);
  assert.equal(await x.p.notify(event), false);
  await x.p.tick();
  assert.equal(x.sent.length, 1);
  assert.deepEqual(deliveries, [{id: 'source-101', state: 'confirmed'}]);
  assert.equal(await x.p.notify(event), false);
  assert.match(x.composed[0].system, /群聊见闻/);
});

test('生成分享期间群范围或回复关系变化时丢弃草稿，不私聊旧事件', async t => {
  let valid = true;
  const x = await setup(t, {proactiveAllowGroupStories: true}, {compose: async () => {valid = false; return '旧的群聊见闻';}});
  const deliveries = [];
  x.p.validateEvent = () => valid;
  x.p.onEventResult = async (_event, result) => deliveries.push(result.state);
  await x.p.notify({reason: 'social', eventKey: 'source-102', title: '没接上话', summary: '暂时没人接话', evidence: {key: 'group'}});
  const result = await x.p.tick();
  assert.equal(result.skipped, 'changed');
  assert.equal(x.sent.length, 0);
  assert.deepEqual(deliveries, ['cancelled']);
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

test('排队期间失效的群聊事件会取消并回写，不留下永久等待状态', async t => {
  const x = await setup(t, {proactiveAllowGroupStories: true});
  let valid = true;
  x.p.validateEvent = () => valid;
  const states = [];
  x.p.onEventResult = async (_event, result) => states.push(result.state);
  const event = {reason: 'social', eventKey: 'expired', summary: '旧见闻'};
  await x.p.notify(event);
  valid = false;
  await x.p.tick();
  assert.deepEqual(states, ['cancelled']);
  assert.equal(x.p.eventState('expired'), 'cancelled');
  assert.equal(x.p.status().pending, 0);
});

test('发送中断后恢复结果未知，不重新投递；事件认领期间不并发生成', async t => {
  let release;
  const x = await setup(t, {proactiveAllowGroupStories: true}, {compose: () => new Promise(resolve => {release = resolve;})});
  x.p.validateEvent = () => true;
  const event = {reason: 'social', eventKey: 'interrupted', summary: '真实群聊见闻'};
  await x.p.notify(event);
  const sending = x.p.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await x.p.tick()).skipped, 'busy');
  const reopened = await new ProactiveMessaging({dir: x.p.dir, now: x.now, config: () => x.item.config, validateEvent: () => true}).open();
  assert.equal(reopened.eventState(event.eventKey), 'unknown');
  assert.equal(reopened.status().pending, 0);
  assert.equal(await reopened.notify(event), false);
  release('SKIP');
  await sending;
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

test('自由模式只放宽自主活动，不绕过主动联系的节奏限制', async t => {
  const x = await setup(t, {freeMode: true, proactiveDailyLimit: 2, proactiveMinIntervalMinutes: 30, proactiveQuietHours: '00:00-23:59'}, {compose: () => '第' + (x.sent.length + 1) + '次自然联系'});
  assert.equal((await x.p.tick()).skipped, 'quiet');
  x.item.config.proactiveQuietHours = '23:00-08:00';
  assert.equal((await x.p.tick()).ok, true);
  x.tick(61);
  assert.equal((await x.p.tick()).skipped, 'backoff');
  x.tick(30 * 60);
  assert.equal((await x.p.tick()).ok, true);
  x.tick(30 * 60);
  assert.equal((await x.p.tick()).skipped, 'daily-limit');
  x.item.config.proactiveEnabled = false;
  assert.equal((await x.p.tick()).skipped, 'disabled');
});

test('主动消息生成期间主人发来新消息时不再发送旧草稿', async t => {
  const x = await setup(t, {}, {compose: () => {x.setOwner(x.now());return '过时的草稿';}});
  assert.equal((await x.p.tick()).skipped, 'changed');
  assert.equal(x.sent.length, 0);
});
