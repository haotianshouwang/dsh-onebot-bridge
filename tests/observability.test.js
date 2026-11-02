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
import {ERROR_CLASSES, classifyFailure, failureOf} from '../src/core/errors.js';
import {TaskStore, taskDetail} from '../src/session/tasks.js';

process.env.QQBOT_OWNER = '10000001';
const message = () => ({
  type: 'message', bot: '10000002', user: '10000001', kind: 'private', peer: '10000001',
  key: '10000002:private:10000001', id: '1', time: Date.now() / 1000, text: '你好',
  mentions: [], sender: '测试用户', parts: []
});

async function setup(t, request) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-obs-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  store.data.framework.enabledActions.push('qq.message.send');
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  actions.attach({status: {bot: '10000002', online: true}, request, call: async () => ({})});
  t.after(() => media.stop());
  return {dir, store, permissions, actions};
}

test('错误分类覆盖参数、权限、认证、网络、下游、超时、未知、持久化、插件与内部异常', () => {
  const cases = [
    [{message: '缺少参数：segments'}, 'input'],
    [{message: '此能力仅主人可用'}, 'permission'],
    [{code: 'QUOTA', message: '额度用尽'}, 'permission'],
    [{message: '登录凭据不可用，需要在QQ端重新登录'}, 'auth'],
    [{message: 'OneBot 尚未连接'}, 'network'],
    [{message: 'OneBot API 失败，retcode=1200'}, 'downstream'],
    [{message: '本地语音合成超时'}, 'timeout'],
    [{code: 'UNKNOWN_OUTCOME', message: '请求超时，结果未知'}, 'unknown'],
    [{message: 'state.json 写入失败：ENOSPC'}, 'persistence'],
    [{code: 'PLUGIN_CANCELLED', message: '插件已停用'}, 'cancelled'],
    [{code: 'PLUGIN_INPUT', message: '参数无效'}, 'input'],
    [{message: '未知的内部错误'}, 'internal']
  ];
  for (const [error, expected] of cases) assert.equal(classifyFailure(error), expected, JSON.stringify(error));
  assert.equal(classifyFailure(null), 'internal');
  assert.equal(failureOf({message: 'OneBot API 失败，retcode=1200'}).label, ERROR_CLASSES.downstream);
});

test('错误信息脱敏：Token、Cookie、access_token 不进入审计', () => {
  const failure = failureOf({message: 'connect failed Bearer abc.def.ghi access_token=secret123 cookie=session=xyz'});
  assert.ok(!failure.message.includes('abc.def.ghi'));
  assert.ok(!failure.message.includes('secret123'));
  assert.ok(!failure.message.includes('session=xyz'));
  assert.ok(failure.message.includes('[已隐藏]'));
});

test('执行失败审计带 errorClass、state 与耗时', async t => {
  const x = await setup(t, async () => { throw Object.assign(new Error('OneBot API 超时，结果未知'), {code: 'UNKNOWN_OUTCOME'}); });
  await assert.rejects(x.actions.invoke('qq.message.send', {segments: [{type: 'text', data: {text: 'x'}}]}, x.permissions.issue(message())), /超时/);
  const row = x.store.data.framework.audit.at(-1);
  assert.equal(row.outcome, 'unknown');
  assert.equal(row.state, 'unknown');
  assert.equal(row.errorClass, 'unknown');
  assert.ok(Number.isFinite(row.durationMs));
  assert.ok(row.traceId.endsWith(':1'));
});

test('任务详情暴露步骤、工具、状态、错误分类、重试与追踪标识', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-obs-task-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const tasks = await new TaskStore(path.join(dir, 'tasks')).open();
  const task = await tasks.create({goal: '检查可观测性', plan: ['搜索', '读取'], verificationMethod: 'steps'});
  await tasks.transition(task.id, 'analyzing');
  await tasks.transition(task.id, 'planning');
  await tasks.transition(task.id, 'executing');
  const first = await tasks.beginStep(task.id, {title: '搜索', planIndex: 1, operationKey: 'exec:1:1'});
  await tasks.completeStep(task.id, first.index, {status: 'done', state: 'confirmed', verified: true, tool: 'plugin.qq-web.search', outcome: 'confirmed', traceId: 'trace-1'});
  const second = await tasks.beginStep(task.id, {title: '读取', planIndex: 2, operationKey: 'exec:2:1'});
  await tasks.completeStep(task.id, second.index, {status: 'failed', state: 'unknown', tool: 'plugin.qq-web.read', note: '请求超时，结果未知', idempotent: true, traceId: 'trace-2'});

  const detail = taskDetail(tasks.get(task.id));
  assert.equal(detail.id, task.id);
  assert.equal(detail.steps.length, 2);
  assert.equal(detail.steps[0].tool, 'plugin.qq-web.search');
  assert.equal(detail.steps[0].verified, true);
  assert.equal(detail.steps[0].traceId, 'trace-1');
  assert.equal(detail.steps[1].errorClass, 'unknown');
  assert.equal(detail.steps[1].idempotent, true);
  assert.equal(detail.steps[1].finishedAt > 0, true);
  assert.equal(detail.verificationMethod, 'steps');
  assert.equal(detail.plan.length, 2);
});
