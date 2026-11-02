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
import {Builtins} from '../src/builtins/index.js';
import {Router} from '../src/session/router.js';
import {TaskStore} from '../src/session/tasks.js';
import {TaskRunner} from '../src/session/task-runner.js';
import {createVerifyTask} from '../src/session/verify-task.js';

process.env.QQBOT_OWNER = '10000001';
const bot = '10000002', group = '88888', owner = '10000001';

async function chatSetup(t, {group: isGroup = false} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-loop-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  Object.assign(store.data.settings, {
    groupEnabled: true, groupAudience: 'all', allowedGroups: [group], allowedUsers: [owner],
    mergeWindowMs: 0, sendInterval: 0, groupReplyMode: 'direct'
  });
  Object.assign(store.data.framework, {listenGroups: [group], enabledActions: ['qq.group.info', 'qq.message.send']});
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const builtins = new Builtins(store), extensions = { inbound: async () => null };
  const sent = [];
  const gateway = {
    status: {bot, online: true, nickname: '小鱼', version: {app_name: 'NapCat'}},
    async request(action, params) { sent.push({action, params}); return {outcome: 'confirmed', data: {message_id: 1000 + sent.length}}; },
    async call(action) { return {group_id: Number(group), group_name: '测试群', member_count: 5}; }
  };
  const runs = [];
  const native = {
    create: async () => ({sessionId: 's1', generation: store.data.framework.generation}),
    reset: async () => {}, stop: async () => {}, revoke: async () => {},
    audits: [],
    auditOf() { return this.audits; },
    run: async (_session, job, _prompt, context) => runs.push({job, context})
  };
  const router = new Router(store, native, extensions, () => {}, {permissions, events, actions, builtins});
  router.attach(gateway);
  t.after(async () => { await router.stop(); await media.stop(); });
  return {store, permissions, events, media, actions, router, sent, runs, native, dir};
}

const groupMessage = (id = 'g1') => ({
  type: 'message', bot, kind: 'group', peer: group, key: bot + ':group:' + group,
  user: owner, id, time: Date.now() / 1000, text: '查一下这个群的资料', mentions: [bot], sender: '主人', parts: []
});
const privateMessage = (id = 'p1') => ({
  type: 'message', bot, kind: 'private', peer: owner, key: bot + ':private:' + owner,
  user: owner, id, time: Date.now() / 1000, text: '告诉她明天见', mentions: [], sender: '主人', parts: []
});
const drain = async x => { await Promise.all([...x.router.queues.values()]); };

test('试点一：群资料查询走真实动作、回复引用真实结果，审计可按 traceId 还原', async t => {
  const x = await chatSetup(t);
  let toolResult;
  x.native.run = async (_session, job, _prompt, context) => {
    toolResult = await x.actions.invoke('qq.group.info', {}, context);
    x.native.audits.push({capability: 'qq.group.info', state: toolResult.state, verified: true, mutating: false, traceId: context.traceId, durationMs: 3});
    return `群名是${toolResult.group_name}，一共 ${toolResult.member_count} 人。`;
  };
  await x.router.receive(groupMessage());
  await drain(x);
  assert.equal(toolResult.state, 'confirmed');
  assert.equal(toolResult.verified, true);
  assert.equal(toolResult.protocol, 1);
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0].params.message.at(-1).data.text, /测试群/);
  const traceId = groupMessage().key + ':g1';
  assert.equal(toolResult.capability, 'qq.group.info');
  const audit = x.store.data.framework.audit.filter(row => row.capability === 'qq.group.info');
  assert.ok(audit.length >= 2);
  assert.ok(audit.every(row => row.traceId === traceId));
  assert.deepEqual(audit.map(row => row.state), ['authorized', 'confirmed']);
  const job = x.store.data.inbox.find(row => row.message.id === 'g1');
  assert.equal(job.execution.traceId, traceId);
  assert.equal(job.execution.tools[0].capability, 'qq.group.info');
  assert.equal(job.execution.tools[0].state, 'confirmed');
  assert.equal(job.execution.verified, true);
  assert.equal(job.execution.replyState, 'submitted');
});

test('试点二：明确要求发送时只发一次，工具结果为 submitted 且带 messageId', async t => {
  const x = await chatSetup(t);
  let toolResult;
  x.native.run = async (_session, job, _prompt, context) => {
    toolResult = await x.actions.invoke('qq.message.send', {segments: [{type: 'text', data: {text: '明天见'}}]}, context);
    x.native.audits.push({capability: 'qq.message.send', state: toolResult.state, verified: false, mutating: true, traceId: context.traceId, durationMs: 4});
    return '明天见';
  };
  await x.router.receive(privateMessage());
  await drain(x);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].action, 'send_private_msg');
  assert.equal(x.sent[0].params.message.at(-1).data.text, '明天见');
  assert.equal(toolResult.state, 'submitted');
  assert.equal(toolResult.verified, false);
  assert.equal(toolResult.evidence.messageId, '1001');
  assert.match(toolResult.note, /不要声称/);
  const job = x.store.data.inbox.find(row => row.message.id === 'p1');
  assert.equal(job.execution.tools[0].capability, 'qq.message.send');
  assert.equal(job.execution.tools[0].state, 'submitted');
  assert.equal(job.execution.replyState, 'submitted');
});

test('试点三：多步任务失败重试后 steps 验证仍按计划步骤匹配', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-loop-task-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  actions.attach({status: {bot, online: true}, async request() { return {outcome: 'confirmed', data: {message_id: 1}}; }, async call() { return {}; }});
  t.after(() => media.stop());
  const tasks = await new TaskStore(path.join(dir, 'tasks')).open();
  const task = await tasks.create({goal: '查资料并记住', plan: ['查询群资料', '写入记忆'], verificationMethod: 'steps'});
  await tasks.transition(task.id, 'analyzing');
  await tasks.transition(task.id, 'planning');
  const verifyTask = createVerifyTask({actions, permissions, store, getBot: () => ({status: {bot}}), getMemory: () => null});
  let second = 0;
  const runner = new TaskRunner({
    tasks, enabled: () => true, verifyTask,
    executeStep: async ({index}) => {
      if (index === 0) return {ok: true, tool: 'qq.group.info', state: 'confirmed', verified: true, traceId: 'trace-step-1', outcome: 'confirmed', text: '群资料'};
      second += 1;
      if (second === 1) return {ok: false, error: '临时失败'};
      return {ok: true, tool: 'plugin.qq-memory.remember', state: 'confirmed', verified: true, traceId: 'trace-step-2b', outcome: 'confirmed', text: '已记住'};
    }
  });
  await runner.tick(); // planning -> executing，执行第 1 步
  await runner.tick(); // 第 2 步失败 -> failed -> planning
  const afterFail = tasks.get(task.id);
  assert.equal(afterFail.attempts, 1);
  await runner.tick(); // 重试第 2 步
  await runner.tick(); // 进入 verifying 并自动验证
  const done = tasks.get(task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.verification.ok, true);
  assert.equal(done.steps.filter(step => step.status === 'done').length, 2);
  assert.deepEqual(done.steps.map(step => step.planIndex), [1, 2, 2]);
  assert.equal(done.steps.find(step => step.planIndex === 1).traceId, 'trace-step-1');
  assert.ok(done.steps.filter(step => step.status === 'done').every(step => step.state === 'confirmed' && step.verified === true));
  assert.equal(done.steps.find(step => step.status === 'failed').state, '');
});

test('tool 验证优先看 state：期望 submitted 的发送记录不会被 confirmed 冒充', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-loop-verify-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const tasks = await new TaskStore(path.join(dir, 'tasks')).open();
  t.after(() => media.stop());
  const verifyTask = createVerifyTask({actions, permissions, store, getBot: () => ({status: {bot}}), getMemory: () => null});

  const base = {status: 'verifying', verificationMethod: 'tool', verificationSpec: {capability: 'qq.message.send', state: 'submitted'}};
  const matching = {...base, steps: [{status: 'done', tool: 'qq.message.send', state: 'submitted', outcome: 'submitted'}]};
  assert.equal((await verifyTask({task: matching})).ok, true);

  const mismatch = {...base, steps: [{status: 'done', tool: 'qq.message.send', state: 'confirmed', outcome: 'confirmed'}]};
  const verdict = await verifyTask({task: mismatch});
  assert.equal(verdict.ok, false);
  assert.match(verdict.note, /工具状态不符合期望/);
});

test('steps 验证只接受 confirmed 且 verified 的步骤，不把 submitted 当完成', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-loop-steps-confirmed-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const verifyTask = createVerifyTask({actions, permissions, store, getBot: () => ({status: {bot}}), getMemory: () => null});
  t.after(() => media.stop());

  const task = {verificationMethod: 'steps', plan: ['发送消息'], steps: [{status: 'done', planIndex: 1, tool: 'qq.message.send', state: 'submitted', verified: false, outcome: 'submitted'}]};
  const submitted = await verifyTask({task});
  assert.equal(submitted.ok, false);
  assert.match(submitted.note, /已确认/);

  task.steps[0] = {...task.steps[0], state: 'confirmed', verified: true, outcome: 'confirmed'};
  assert.equal((await verifyTask({task})).ok, true);
});
