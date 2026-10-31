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
  assert.equal(x.calls.length, 2);
});

test('任务执行器没有工具结果时失败，而不是把模型文字当完成', async t => {
  const x = await setup(t, {ok: false});
  const task = await x.tasks.create({goal: '核实一个事实', plan: ['搜索']});
  await x.tasks.transition(task.id, 'analyzing');
  await x.tasks.transition(task.id, 'planning');
  const result = await x.runner.tick();
  assert.equal(result.ok, false);
  assert.equal(x.tasks.get(task.id).status, 'failed');
  assert.equal(x.tasks.get(task.id).steps[0].status, 'failed');
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
