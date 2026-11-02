import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/host/store.js';
import {Permissions} from '../src/core/permissions.js';
import {Events} from '../src/core/events.js';
import {Actions} from '../src/core/actions.js';
import {Media} from '../src/core/media.js';
import {RESULT_STATES, RESULT_PROTOCOL, canTransition, classify, classifyError, normalizeResult, stateOf, stateLabel} from '../src/core/result.js';
import {CAPABILITY_CONTRACTS, DEFAULT_CONTRACT, contractFor, contractInfo} from '../src/core/contracts.js';

process.env.QQBOT_OWNER = '10000001';
const message = (extra = {}) => ({
  type: 'message', bot: '10000002', user: '10000001', kind: 'private', peer: '10000001',
  key: '10000002:private:10000001', id: '1', time: Date.now() / 1000, text: '你好',
  mentions: [], sender: '测试用户', parts: [], ...extra
});

async function setup(t, botOverride = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-result-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  Object.assign(store.data.framework, {enabledActions: ['qq.message.send', 'qq.profile.nickname']});
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const sent = [];
  const bot = {
    status: {bot: '10000002', online: true, version: {app_name: 'NapCat'}},
    async request(action, params) { sent.push({action, params}); return {outcome: 'confirmed', data: {message_id: 42}}; },
    async call(action) { return action === 'get_login_info' ? {user_id: 10000002, nickname: '小鱼'} : {}; },
    ...botOverride
  };
  actions.attach(bot);
  t.after(() => media.stop());
  return {store, permissions, events, media, actions, sent};
}

test('协议状态完整且转换表拒绝非法跳转', () => {
  assert.deepEqual([...RESULT_STATES], ['requested', 'authorized', 'submitted', 'accepted', 'confirmed', 'failed', 'unknown', 'cancelled']);
  assert.equal(canTransition('authorized', 'submitted'), true);
  assert.equal(canTransition('submitted', 'confirmed'), true);
  assert.equal(canTransition('accepted', 'confirmed'), true);
  assert.equal(canTransition('unknown', 'confirmed'), true);
  assert.equal(canTransition('confirmed', 'submitted'), false);
  assert.equal(canTransition('cancelled', 'confirmed'), false);
  assert.equal(canTransition('failed', 'confirmed'), false);
  assert.equal(stateLabel('submitted'), '已提交');
});

test('发送后回读自己的同一聊天消息记录，模型得到已发送而非已读', async t => {
  const x = await setup(t, {call: async () => ({message_id: 42, user_id: 10000002, target_id: 10000001})});
  const result = await x.actions.invoke('qq.message.send', {segments: [{type: 'text', data: {text: 'hi'}}]}, x.permissions.issue(message()));
  assert.equal(result.state, 'confirmed');
  assert.equal(result.evidence.messageStored, true);
  assert.match(result.note, /已发送/);
  assert.match(result.note, /不代表对方已读/);
  assert.equal(x.sent.length, 1);
});

test('消息回读不能用其他聊天或其他作者的记录冒充自己的发送成功', async t => {
  const x = await setup(t, {call: async () => ({message_id: 42, user_id: 10000001, target_id: 10000002})});
  const result = await x.actions.invoke('qq.message.send', {segments: [{type: 'text', data: {text: 'hi'}}]}, x.permissions.issue(message()));
  assert.equal(result.state, 'submitted');
  assert.equal(result.verified, false);
  assert.match(result.note, /不要重复发送/);
});

test('classify 把历史 outcome/ok/错误映射为协议状态，不把未知当成功', () => {
  assert.equal(classify({outcome: 'confirmed'}), 'confirmed');
  assert.equal(classify({outcome: 'accepted'}), 'accepted');
  assert.equal(classify({outcome: 'failed'}), 'failed');
  assert.equal(classify({outcome: 'unknown'}), 'unknown');
  assert.equal(classify({outcome: 'duplicate'}), 'accepted');
  assert.equal(classify({ok: false, error: 'x'}), 'failed');
  assert.equal(classify({ok: true}), 'confirmed');
  assert.equal(classify(null), 'unknown');
  assert.equal(classify({}), 'confirmed');
  assert.equal(classifyError(Object.assign(new Error('timeout'), {code: 'UNKNOWN_OUTCOME'})), 'unknown');
  assert.equal(classifyError(Object.assign(new Error('x'), {code: 'CANCELLED'})), 'cancelled');
  assert.equal(classifyError(new Error('x')), 'failed');
});

test('normalizeResult 保留 outcome 并新增 state/evidence/protocol', () => {
  const result = normalizeResult({outcome: 'confirmed', data: {message_id: 7}, retcode: 0}, {capability: 'qq.message.send', contract: contractFor('qq.message.send')});
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.state, 'submitted');
  assert.equal(result.verified, false);
  assert.equal(result.protocol, RESULT_PROTOCOL);
  assert.equal(result.evidence.messageId, '7');
  assert.equal(result.evidence.retcode, 0);
  assert.match(result.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.capability, 'qq.message.send');
  assert.equal(stateOf(result), 'submitted');
});

test('消息发送经 invoke 归类为 submitted，不再把网关 ACK 当已验证', async t => {
  const x = await setup(t), c = x.permissions.issue(message());
  const result = await x.actions.invoke('qq.message.send', {segments: [{type: 'text', data: {text: 'hi'}}]}, c);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.state, 'submitted');
  assert.equal(result.verified, false);
  assert.equal(result.evidence.messageId, '42');
  const row = x.store.data.framework.audit.at(-1);
  assert.equal(row.outcome, 'completed');
  assert.equal(row.state, 'submitted');
});

test('昵称修改只有在回读匹配时才是 confirmed', async t => {
  const x = await setup(t);
  const ok = await x.actions.invoke('qq.profile.nickname', {nickname: '小鱼'}, x.permissions.issue(message()));
  assert.equal(ok.state, 'confirmed');
  assert.equal(ok.verified, true);
  assert.equal(ok.evidence.visible, true);

  const y = await setup(t, {async call() { return {nickname: '别的名字'}; }});
  const mismatch = await y.actions.invoke('qq.profile.nickname', {nickname: '小鱼'}, y.permissions.issue(message()));
  assert.equal(mismatch.state, 'unknown');
  assert.equal(mismatch.verified, false);
});

test('QQ 空间评论契约只到 accepted，不把 HTTP 200 当确认', () => {
  const result = normalizeResult({outcome: 'confirmed', url: 'https://user.qzone.qq.com/1/mood/2'}, {capability: 'plugin.qq-qzone.comment', contract: contractFor('plugin.qq-qzone.comment')});
  assert.equal(result.state, 'accepted');
  assert.equal(result.verified, false);
});

test('未知结果与取消不会被归一化成成功', async t => {
  const x = await setup(t, {async request() { throw Object.assign(new Error('超时'), {code: 'UNKNOWN_OUTCOME'}); }});
  await assert.rejects(x.actions.invoke('qq.message.send', {segments: [{type: 'text', data: {text: 'hi'}}]}, x.permissions.issue(message())), /超时/);
  const row = x.store.data.framework.audit.at(-1);
  assert.equal(row.outcome, 'unknown');
  assert.equal(row.state, 'unknown');
});

test('所有 mutating 核心动作都声明了验证契约', async t => {
  const x = await setup(t);
  const tasks = {create() {}, setPlan() {}, transition() {}, recover() {}, addStep() {}, verify() {}, attachMemory() {}, list() { return []; }, status() { return {}; }, get() { return null; }};
  x.actions.installTaskActions(tasks);
  const missing = [...x.actions.definitions.values()]
    .filter(cap => cap.mutating && !cap.plugin)
    .map(cap => cap.id)
    .filter(id => contractFor(id) === DEFAULT_CONTRACT);
  assert.deepEqual(missing, []);
  assert.ok(CAPABILITY_CONTRACTS['qq.message.send']);
  assert.equal(contractInfo('qq.message.send').describes, '网关已提交');
  assert.equal(contractInfo('qq.profile.nickname').describes, '必须回读匹配');
});

test('纯数据返回按能力成功处理，显式失败对象仍为 failed', async t => {
  const x = await setup(t);
  const c = x.permissions.issue(message());
  const plain = normalizeResult({group_id: 1, group_name: '测试群'}, {capability: 'qq.group.info', contract: contractFor('qq.group.info')});
  assert.equal(plain.state, 'confirmed');
  const failed = normalizeResult({ok: false, outcome: 'failed', error: '拒绝'}, {capability: 'plugin.qq-qzone.list', contract: contractFor('plugin.qq-qzone.list')});
  assert.equal(failed.state, 'failed');
  const unknown = normalizeResult({outcome: 'unknown'}, {capability: 'qq.message.send', contract: contractFor('qq.message.send')});
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.note, /不要声称/);
  assert.equal(x.actions.definitions.has('qq.group.info'), true);
  assert.ok(c);
});

test('动作目录公开每个能力的确认契约，便于管理台和工具说明', async t => {
  const x = await setup(t);
  const send = x.actions.catalog().find(cap => cap.id === 'qq.message.send');
  assert.equal(send.contract.ack, 'submitted');
  assert.equal(send.contract.verify, 'ack');
  const nickname = x.actions.catalog().find(cap => cap.id === 'qq.profile.nickname');
  assert.equal(nickname.contract.verify, 'readback');
});
