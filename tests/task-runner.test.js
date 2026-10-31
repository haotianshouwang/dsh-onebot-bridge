import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TaskStore} from '../src/session/tasks.js';
import {TaskRunner} from '../src/session/task-runner.js';

async function setup(t, {ok = true} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-task-runner-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let now = new Date(2026, 9, 31, 12, 0).getTime();
  const tasks = await new TaskStore(dir, {now: () => now}).open();
  const calls = [];
  const runner = new TaskRunner({
    tasks,
    enabled: () => true,
    now: () => now,
    log: () => {},
    executeStep: async info => {
      calls.push(info);
      return ok ? {ok: true, tool: 'plugin.qq-web.search', outcome: 'ok', text: 'step done'} : {ok: false, error: 'tool failed'};
    }
  });
  return {tasks, runner, calls, tick: seconds => { now += seconds * 1000; }};
}

test('任务执行器每次只推进一步，所有计划步骤完成后进入验证', async t => {
  const x = await setup(t);
  const task = await x.tasks.create({goal: '核实一个事实', completion: '两个来源一致', plan: ['搜索', '读取']});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  const first = await x.runner.tick();
  assert.equal(first.ok, true);
  assert.equal(x.tasks.get(task.id).status, 'executing');
  assert.equal(x.tasks.get(task.id).steps.length, 1);
  const second = await x.runner.tick();
  assert.equal(second.ok, true);
  const done = x.tasks.get(task.id);
  assert.equal(done.status, 'verifying');
  assert.equal(done.steps.length, 2);
  assert.match(done.steps[0].operationKey, /^plan:0:/);
  assert.equal(x.calls.length, 2);
});

test('任务执行器没有工具结果时失败，重试上限后停在 failed', async t => {
  const x = await setup(t, {ok: false});
  const task = await x.tasks.create({goal: '核实一个事实', plan: ['搜索']});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  const first = await x.runner.tick();
  assert.equal(first.ok, false);
  assert.equal(first.retry, true);
  assert.equal(x.tasks.get(task.id).status, 'planning');
  await x.runner.tick();
  const third = await x.runner.tick();
  assert.equal(third.ok, false);
  assert.equal(x.tasks.get(task.id).status, 'failed');
  assert.equal(x.tasks.get(task.id).steps[0].status, 'failed');
});

test('超过任务时间预算后停止执行', async t => {
  const x = await setup(t);
  const task = await x.tasks.create({goal: '预算任务', plan: ['搜索'], budgetMs: 1000});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  x.tick(2);
  const result = await x.runner.tick();
  assert.equal(result.status, 'failed');
  assert.equal(x.tasks.get(task.id).status, 'failed');
  assert.equal(x.calls.length, 0);
});

test('任务执行器重启后从持久化步骤继续', async t => {
  const x = await setup(t);
  const task = await x.tasks.create({goal: '跨重启任务', plan: ['第一步', '第二步']});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  await x.runner.tick();
  const reopened = await new TaskStore(x.tasks.dir).open();
  const resumed = new TaskRunner({tasks: reopened, enabled: () => true, executeStep: async () => ({ok: true, tool: 'plugin.qq-web.read', outcome: 'ok'})});
  const result = await resumed.tick();
  assert.equal(result.ok, true);
  assert.equal(reopened.get(task.id).steps.length, 2);
  assert.equal(reopened.get(task.id).status, 'verifying');
});

test('显式 steps 验证通过后才自动 done，并触发完成回调', async t => {
  const x = await setup(t);
  const seen = [];
  x.runner.verifyTask = async ({task}) => ({ok: task.steps.every(step => step.status === 'done' && step.tool), note: '步骤工具齐全'});
  x.runner.onDone = async task => seen.push(task.id);
  const task = await x.tasks.create({goal: '自动验证', plan: ['搜索'], verificationMethod: 'steps'});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  const result = await x.runner.tick();
  assert.equal(result.status, 'done');
  assert.equal(x.tasks.get(task.id).status, 'done');
  assert.equal(x.tasks.get(task.id).verification.ok, true);
  assert.deepEqual(seen, [task.id]);
});

test('自动验证失败后只重试验证，不重复执行步骤', async t => {
  const x = await setup(t);
  let verifyCalls = 0;
  x.runner.verifyTask = async () => ({ok: verifyCalls++ > 0, note: verifyCalls > 1 ? '第二次通过' : '暂时没证据'});
  const task = await x.tasks.create({goal: '验证重试', plan: ['搜索'], verificationMethod: 'steps'});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  const first = await x.runner.tick();
  assert.equal(first.status, 'verifying');
  assert.equal(x.tasks.get(task.id).verification.ok, false);
  const steps = x.tasks.get(task.id).steps.length;
  const second = await x.runner.tick();
  assert.equal(second.status, 'done');
  assert.equal(x.tasks.get(task.id).steps.length, steps);
  assert.equal(x.tasks.get(task.id).verification.attempts, 2);
});

test('manual 验证不会被自动 done，自动验证失败保持 verifying', async t => {
  const x = await setup(t);
  x.runner.verifyTask = async () => ({ok: false, note: '证据不足'});
  const manual = await x.tasks.create({goal: '人工验证', plan: ['搜索'], verificationMethod: 'manual'});
  await x.tasks.transition(manual.id, 'analyzing');
  await x.tasks.transition(manual.id, 'planning');
  await x.runner.tick();
  assert.equal(x.tasks.get(manual.id).status, 'verifying');
  const auto = await x.tasks.create({goal: '自动失败', plan: ['搜索'], verificationMethod: 'steps'});
  await x.tasks.transition(auto.id, 'analyzing');
  await x.tasks.transition(auto.id, 'planning');
  const result = await x.runner.tick();
  assert.equal(result.status, 'verifying');
  assert.equal(x.tasks.get(auto.id).status, 'verifying');
  assert.equal(x.tasks.get(auto.id).verification.ok, false);
});

test('任务执行器关闭时不做任何事', async t => {
  const x = await setup(t);
  x.runner.enabled = () => false;
  const task = await x.tasks.create({goal: '不执行', plan: ['步骤']});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  assert.equal((await x.runner.tick()).skipped, 'disabled');
  assert.equal(x.calls.length, 0);
});
