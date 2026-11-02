import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {GroupProactive} from '../src/session/group-proactive.js';
import {freeMode} from '../src/core/freedom.js';
import {Participation} from '../src/session/participation.js';
import {ReplyGate} from '../src/session/reply-gate.js';

test('自由模式放开业务预算，不改变停用和明确的群参与范围', () => {
  const store = {data: {framework: {nativePackages: {'qq-autonomy': {enabled: true, config: {enabled: true, freeMode: true}}}}}};
  assert.equal(freeMode(store), true);
  store.data.framework.nativePackages['qq-autonomy'].enabled = false;
  assert.equal(freeMode(store), false);
  const p = new Participation();
  for (let i = 0; i < 100; i++) assert.equal(p.permit('group', {freeMode: true}), true);
  const gate = new ReplyGate();
  assert.equal(gate.admitIntent({}, {}, {freeMode: true, groupReplyMode: 'smart'}, {reason: 'related'}), true);
  assert.equal(gate.admitIntent({}, {}, {freeMode: true, groupReplyMode: 'direct'}, {reason: 'related'}), false);
});

test('真实群背景触发冷场判断，发送后持久化去重；生成中有新消息则取消', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'group-social-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let now = Date.now();
  const rows = [{time: (now - 2 * 3600000) / 1000, user: '12345', text: '刚才聊的天文话题'}];
  const sent = [];
  let allowed = true, changed = false;
  const options = {
    dir, groups: () => ['123456'], eligible: () => allowed,
    config: () => ({freeMode: true, groupInactiveMinutes: 60}), rows: () => rows,
    compose: async (_, options) => {
      assert.match(options.system, /天文话题/);
      if (changed) rows.push({time: now / 1000, user: '12345', text: '新消息'});
      return changed ? '新草稿' : '刚才的天文话题让我想到一个问题';
    },
    send: async (group, text) => {sent.push({group, text});return {outcome: 'confirmed'};},
    online: () => true, now: () => now
  };
  await new GroupProactive(options).tick();
  assert.equal(sent.length, 1);
  now += 61000;
  await new GroupProactive(options).tick();
  assert.equal(sent.length, 1);
  rows.push({user: '12345', text: '天文话题有新的补充', time: now / 1000});
  changed = true;
  now += 61 * 60000;
  await new GroupProactive(options).tick();
  assert.equal(sent.length, 1);
  allowed = false;
  await new GroupProactive(options).tick();
  assert.equal(sent.length, 1);
});

test('群冷场开口后无人接话，不因换种措辞或重启再翻同一件旧事', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'group-no-monologue-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let now = Date.now(), calls = 0;
  const rows = [{id: 'human1', user: 'other', text: '头盔扛不住', time: (now - 2 * 3600000) / 1000}];
  const sent = [];
  const options = {
    dir, groups: () => ['123456'], eligible: () => true,
    bot: () => 'bot', isOwner: id => id === 'owner',
    config: () => ({freeMode: true, groupInactiveMinutes: 60}), rows: () => rows,
    compose: async () => '第' + (++calls) + '种安慰旧头盔的说法',
    send: async (_, text) => {sent.push(text);rows.push({user: 'bot', text, time: now / 1000});return {outcome: 'confirmed'};},
    online: () => true, now: () => now
  };
  await new GroupProactive(options).tick();
  now += 61 * 60000;
  await new GroupProactive(options).tick();
  assert.equal(sent.length, 1);
  assert.equal(calls, 1);
  rows.push({id: 'human2', user: 'other', text: '新的话题', time: now / 1000});
  now += 181 * 60000;
  await new GroupProactive(options).tick();
  assert.equal(sent.length, 2);
});

test('群主动提示保留真实发言者、身份和时间，不冒充私聊主人', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'group-audience-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const now = Date.now();
  let captured = '';
  const p = new GroupProactive({
    dir, groups: () => ['123456'], eligible: () => true, bot: () => 'bot', isOwner: id => id === 'owner',
    config: () => ({freeMode: true, groupInactiveMinutes: 60}),
    rows: () => [{user: 'other', text: '我的头盔', time: (now - 7200000) / 1000}],
    compose: async (_, options) => {
      captured = options.system;
      return 'SKIP';
    },
    send: async () => {throw Error('不应发送');}, online: () => true, now: () => now
  });
  await p.tick();
  assert.match(captured, /群成员/);
  assert.match(captured, /历史消息/);
  assert.match(captured, /timestamp/);
  assert.doesNotMatch(captured, /主人已经约/);
});
