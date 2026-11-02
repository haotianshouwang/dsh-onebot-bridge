import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LifeState, isUrgentMessage } from '../src/session/life-state.js';
import { SocialEnergy } from '../src/session/social-energy.js';

function message({ kind = 'private', user = 'owner', text = '你好' } = {}) {
  return { kind, user, text };
}

test('睡眠状态只允许主人紧急私聊唤醒，群消息不会调用回复路径', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-life-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = new Date(2026, 10, 2, 1, 0).getTime();
  const life = await new LifeState(dir, { now: () => now }).open();
  life.configure({ sleepAt: '00:30', wakeAt: '08:30' });
  life.tick({ enabled: true });
  assert.equal(life.snapshot().state, 'sleeping');
  assert.equal(life.shouldReply(message({ kind: 'group', text: '大家早' }), { owner: true }).allow, false);
  assert.equal(life.shouldReply(message({ text: '我有急事' }), { owner: true }).woke, true);
  assert.equal(life.snapshot().state, 'awake');
  assert.equal(isUrgentMessage(message({ text: '醒醒，出事了' })), true);
});

test('失眠和噩梦惊醒时主人消息可以唤醒，普通睡眠私聊会排队计数', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-life-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const life = await new LifeState(dir).open();
  life.sleep();
  assert.equal(life.shouldReply(message({ text: '晚安' }), { owner: true }).allow, false);
  assert.equal(life.snapshot().pendingMessages, 1);
  life.setInsomnia();
  assert.equal(life.shouldReply(message({ text: '还没睡吗' }), { owner: true }).allow, true);
  life.setNightmareAwake();
  assert.equal(life.shouldReply(message({ text: '你还好吗' }), { owner: true }).allow, true);
});

test('社交精力会消耗、恢复并持久化，不能低于零或高于一', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-energy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const energy = await new SocialEnergy(dir, { now: () => now }).open();
  const first = energy.snapshot().level;
  energy.consume(0.5, '测试');
  assert.equal(energy.snapshot().level, first - 0.5);
  now += 24 * 3600000;
  energy.recover({ sleeping: true });
  assert.ok(energy.snapshot().level > first - 0.5);
  energy.consume(9, '边界');
  assert.equal(energy.snapshot().level, 0);
  energy.reflectEmotion({ mood: '开心', intensity: 1 });
  assert.ok(energy.snapshot().level > 0);
  await energy.persist();
  const reopened = await new SocialEnergy(dir, { now: () => now }).open();
  assert.ok(reopened.snapshot().level > 0);
});
