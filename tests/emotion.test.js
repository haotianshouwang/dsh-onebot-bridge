import test from 'node:test';
import assert from 'node:assert/strict';
import {EmotionService, moodAt} from '../src/builtins/emotion/service.js';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/host/store.js';
import {PluginSDK} from '../src/sdk.js';
import {Permissions} from '../src/core/permissions.js';
import {Actions} from '../src/core/actions.js';
import {Events} from '../src/core/events.js';
import {Media} from '../src/core/media.js';
import {activateEmotion} from '../src/builtins/emotion/index.js';

const key = '10000002:group:88888';
function fixture(extra = {}) {
  let now = 1000000;
  let data = {};
  let active = true;
  const identity = {bot: '10000002', owner: '10000001', generation: 1};
  const rooms = {[key]: {rows: [{id: '101', user: '123456', time: now / 1000, text: '这个游戏有新玩法了'}]}};
  const config = {autoObserve: true, shareWithOwner: true, shareUnanswered: true, halfLifeMinutes: 60, observeIntervalSec: 30};
  const scope = {private: true, users: ['10000001'], groups: ['88888']};
  const queued = [];
  const service = new EmotionService({
    read: () => structuredClone(data),
    write: async update => {data = update(structuredClone(data));},
    active: () => active, config: () => config, scope: () => scope,
    identity: () => identity, rooms: () => rooms, now: () => now,
    decide: async () => ({mood: '好奇', intensity: 0.8, reason: '刚看到群友分享游戏新玩法', sourceIds: ['101'], share: {kind: 'interesting', topic: '游戏新玩法', summary: '群友聊到游戏的新玩法，我觉得有趣', sourceIds: ['101']}}),
    notify: async event => {queued.push(event); return true;}, ...extra
  });
  return {service, rooms, identity, config, scope, queued, data: () => data, advance: ms => {now += ms;}, disable: () => {active = false;}};
}

test('情绪随时间自然缓和，不把历史心情当作当前事实', () => {
  const mood = {mood: '失落', intensity: 0.8, at: 1000};
  assert.equal(moodAt(mood, 3601000, 60).intensity, 0.4);
  assert.equal(moodAt(mood, 24 * 3600000, 60).mood, '平静');
});

test('基于真实消息保存情绪和分享事件，重复观察不重复分享', async () => {
  const x = fixture();
  await x.service.tick();
  assert.equal(x.data().global.mood, '好奇');
  assert.equal(x.data().events.length, 1);
  assert.equal(x.queued.length, 1);
  assert.deepEqual(x.queued[0].evidence.sources, x.data().events[0].sources);
  await x.service.tick();
  x.advance(60000);
  await x.service.tick();
  assert.equal(x.queued.length, 1);
  assert.match(x.service.context({key, kind: 'group', peer: '88888', actor: '123456'}), /游戏新玩法/);
  assert.equal(x.service.canShare(x.queued[0]), true);
  await x.service.delivery(x.queued[0], 'unknown');
  assert.equal(x.data().events[0].state, 'unknown');
});

test('通过真实 SDK 持久化并重启恢复，停用和移出监听范围立即停止上下文', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-emotion-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const x = fixture();
  let calls = 0;
  async function open() {
    const store = await new Store(dir).open();
    store.data.framework.listenGroups = ['88888'];
    const permissions = new Permissions(store);
    const events = new Events(store, () => {});
    const media = new Media(store);
    const actions = new Actions(store, permissions, events, media);
    const sdk = new PluginSDK({store, permissions, events, media, actions});
    const emotion = activateEmotion(sdk.facade(), {
      identity: () => x.identity, rooms: () => x.rooms, now: () => 1000000,
      reflect: async options => {
        calls++;
        assert.equal(options.format, 'json');
        assert.deepEqual(options.allow, []);
        return JSON.stringify({mood: '好奇', intensity: 0.8, reason: '游戏新玩法', sourceIds: ['101'], share: null});
      }, notify: async () => false
    });
    return {store, sdk, emotion, item: store.data.framework.nativePackages['qq-emotion']};
  }
  const first = await open();
  assert.equal(first.emotion.api.active(), false);
  first.item.enabled = true;
  first.item.scope = x.scope;
  await first.emotion.service.tick();
  assert.match(await first.sdk.contextFor({key}), /游戏新玩法/);
  await first.sdk.stop();
  const second = await open();
  assert.equal(second.emotion.api.active(), true);
  assert.equal(second.emotion.service.publicState(key).global.mood, '好奇');
  await second.emotion.service.tick();
  assert.equal(calls, 1);
  second.store.data.framework.listenGroups = [];
  assert.equal(await second.sdk.contextFor({key}), '');
  second.store.data.framework.listenGroups = ['88888'];
  second.item.enabled = false;
  assert.equal(await second.sdk.contextFor({key}), '');
  await second.sdk.stop();
});

test('发送结果回写中断时，从主动联系持久记录恢复真实状态', async () => {
  let state = '';
  const x = fixture({deliveryStatus: () => state});
  await x.service.tick();
  assert.equal(x.data().events[0].state, 'queued');
  state = 'unknown';
  await x.service.tick();
  assert.equal(x.data().events[0].state, 'unknown');
  assert.equal(x.queued.length, 1);
});

test('拒绝模型捏造的消息来源，范围外和停用不观察', async () => {
  const x = fixture({decide: async () => ({mood: '失落', intensity: 1, reason: '被冷落', sourceIds: ['invented']})});
  await x.service.tick();
  assert.equal(x.data().global, undefined);
  assert.equal(x.queued.length, 0);
  const y = fixture(); y.scope.groups = [];
  await y.service.tick(); assert.equal(y.queued.length, 0);
  y.scope.groups = ['88888']; y.disable();
  await y.service.tick(); assert.equal(y.queued.length, 0);
});

test('晚到的观察结果在配置或主人变化后丢弃；其他群不泄露原来的原因', async () => {
  const x = fixture({decide: async () => {x.identity.generation++; return {mood: '开心', intensity: 1, reason: '旧结果', sourceIds: ['101']};}});
  await x.service.tick(); assert.equal(x.data().global, undefined);
  const y = fixture(); await y.service.tick();
  y.scope.groups.push('99999');
  assert.doesNotMatch(y.service.context({key: '10000002:group:99999', kind: 'group', peer: '99999', actor: '123456'}), /游戏新玩法/);
  y.identity.owner = '10000003';
  assert.equal(y.service.canShare(y.queued[0]), false);
});

test('没人接话只提供可观察事实，普通冷场不能判成被人故意冷落', async () => {
  let observed;
  const x = fixture({decide: async input => {observed = input; return {mood: null, share: {kind: 'unanswered', topic: '没接上话', summary: '我来找你聊聊', sourceIds: ['101']}};}});
  await x.service.tick();
  assert.equal(x.queued.length, 0);
  x.rooms[key].rows = [
    {id: '101', user: x.identity.bot, time: 1000, text: '你们喜欢哪个角色？'},
    ...[1, 2, 3].map(i => ({id: String(101 + i), user: '123456', time: 1000 + i, text: '接着聊别的话题'}))
  ];
  x.advance(180000);
  await x.service.tick();
  assert.equal(observed.facts.response, 'not_directly_answered');
  assert.equal(x.queued.length, 1);
  x.rooms[key].rows.push({id: '105', user: '123456', time: 1181, text: '刚才那个问题我来回答', reply: '101'});
  assert.equal(x.service.canShare(x.queued[0]), false);
});
