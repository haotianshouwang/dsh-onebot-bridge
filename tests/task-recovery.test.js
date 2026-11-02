import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TaskStore} from '../src/session/tasks.js';
import {TaskRunner} from '../src/session/task-runner.js';

async function openTask(t, plan = ['第一步']) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-recovery-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const tasks = await new TaskStore(path.join(dir, 'tasks')).open();
  const task = await tasks.create({goal: '恢复测试', plan, verificationMethod: 'manual'});
  await tasks.transition(task.id, 'analyzing');
  await tasks.transition(task.id, 'planning');
  return {dir, tasks, task, id: task.id};
}

test('执行前写意图：running 步骤在重启后变成 unknown，并写入可审计历史', async t => {
  const x = await openTask(t);
  await x.tasks.transition(x.id, 'executing');
  const step = await x.tasks.beginStep(x.id, {title: '第一步', planIndex: 1, operationKey: 'exec:1:1'});
  assert.equal(step.status, 'running');
  assert.equal(step.startedAt, step.at);

  const reopened = await new TaskStore(path.join(x.dir, 'tasks')).open();
  const task = reopened.get(x.id);
  assert.equal(task.steps[0].status, 'unknown');
  assert.equal(task.steps[0].state, 'unknown');
  assert.match(task.steps[0].note, /结果未知/);
  assert.match(task.history.at(-1).note, /恢复/);
});

test('崩溃窗口不自动重放：恢复后任务失败，人工确认后才允许新一次尝试', async t => {
  const x = await openTask(t);
  await x.tasks.transition(x.id, 'executing');
  await x.tasks.beginStep(x.id, {title: '第一步', planIndex: 1, operationKey: 'exec:1:1'});

  const reopened = await new TaskStore(path.join(x.dir, 'tasks')).open();
  let executed = 0;
  const runner = new TaskRunner({
    tasks: reopened, enabled: () => true,
    executeStep: async () => { executed += 1; return {ok: true, tool: 'core.status', state: 'confirmed', verified: true}; }
  });
  const blocked = await runner.tick();
  assert.equal(blocked.status, 'failed');
  assert.equal(executed, 0);
  assert.match(reopened.get(x.id).history.at(-1).note, /结果未知/);

  await assert.rejects(reopened.transition(x.id, 'planning', '直接重试'), /显式确认恢复/);
  await assert.rejects(reopened.recover(x.id, {confirmed: false}), /明确确认/);
  await reopened.recover(x.id, {confirmed: true, note: '主人核对后确认可以重新规划'});
  const runner2 = new TaskRunner({
    tasks: reopened, enabled: () => true,
    executeStep: async () => { executed += 1; return {ok: true, tool: 'core.status', state: 'confirmed', verified: true}; }
  });
  await runner2.tick();
  assert.equal(executed, 1);
  const latest = reopened.get(x.id).steps.at(-1);
  assert.equal(latest.status, 'done');
  assert.equal(latest.planIndex, 1);
  assert.equal(latest.state, 'confirmed');
  assert.equal(reopened.get(x.id).steps.filter(step => step.status === 'unknown').length, 1);
});

test('结果未知的步骤只失败一次，不会按 maxRetries 自动重试', async t => {
  const x = await openTask(t);
  let executed = 0;
  const runner = new TaskRunner({
    tasks: x.tasks, enabled: () => true,
    executeStep: async () => { executed += 1; return {ok: false, unknown: true, error: '请求超时，结果未知'}; }
  });
  const first = await runner.tick();
  assert.equal(first.status, 'failed');
  assert.equal(x.tasks.get(x.id).attempts, 1);
  assert.equal(x.tasks.get(x.id).steps.at(-1).status, 'unknown');
  await runner.tick();
  assert.equal(executed, 1);
  assert.equal(x.tasks.get(x.id).status, 'failed');
});

test('调用过写操作的步骤失败后不自动重试', async t => {
  const x = await openTask(t);
  let executed = 0;
  const runner = new TaskRunner({
    tasks: x.tasks, enabled: () => true,
    executeStep: async () => { executed += 1; return {ok: false, idempotent: false, error: '发送失败'}; }
  });
  const result = await runner.tick();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /非幂等/);
  assert.equal(x.tasks.get(x.id).status, 'failed');
  assert.equal(x.tasks.get(x.id).steps.at(-1).idempotent, false);
  await runner.tick();
  assert.equal(executed, 1);
});

test('恢复前重新检查前置条件：离线时任务失败且不调用工具', async t => {
  const x = await openTask(t);
  let executed = 0;
  const runner = new TaskRunner({
    tasks: x.tasks, enabled: () => true, guard: () => 'QQ 未连接',
    executeStep: async () => { executed += 1; return {ok: true}; }
  });
  const result = await runner.tick();
  assert.equal(result.status, 'failed');
  assert.equal(executed, 0);
  const task = x.tasks.get(x.id);
  assert.equal(task.status, 'failed');
  assert.match(task.history.at(-1).note, /前置条件不满足/);
});

test('取消后执行器不再推进任务', async t => {
  const x = await openTask(t);
  await x.tasks.transition(x.id, 'cancelled', '用户取消');
  let executed = 0;
  const runner = new TaskRunner({
    tasks: x.tasks, enabled: () => true,
    executeStep: async () => { executed += 1; return {ok: true}; }
  });
  const result = await runner.tick();
  assert.equal(result.skipped, 'no-task');
  assert.equal(executed, 0);
  assert.equal(x.tasks.get(x.id).status, 'cancelled');
});

test('只读步骤失败仍可安全重试，并记录每次尝试的 planIndex', async t => {
  const x = await openTask(t);
  let executed = 0;
  const runner = new TaskRunner({
    tasks: x.tasks, enabled: () => true,
    executeStep: async () => {
      executed += 1;
      if (executed === 1) return {ok: false, idempotent: true, error: '临时读取失败'};
      return {ok: true, idempotent: true, tool: 'core.status', state: 'confirmed', verified: true};
    }
  });
  await runner.tick();
  const retry = await runner.tick();
  assert.equal(retry.status, 'verifying');
  const task = x.tasks.get(x.id);
  assert.equal(task.steps.filter(step => step.planIndex === 1).length, 2);
  assert.equal(task.steps.filter(step => step.status === 'done').length, 1);
  assert.ok(task.history.some(row => row.note.startsWith('retry')));
});
