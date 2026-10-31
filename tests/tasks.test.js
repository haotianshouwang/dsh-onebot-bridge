import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TaskStore} from '../src/session/tasks.js';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-tasks-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  let now = new Date(2026, 9, 31, 12, 0).getTime();
  const store = await new TaskStore(dir, {now: () => now}).open();
  return {store, dir, tick: seconds => { now += seconds * 1000; }};
}

test('任务状态机拒绝非法跳转，并持久化计划、步骤和验证结果', async t => {
  const x = await setup(t);
  const task = await x.store.create({goal: '查清一个事实', reason: '用户询问', completion: '有两个独立来源', plan: ['搜索', '读取', '验证', '写记忆']});
  assert.equal(task.status, 'pending');
  await assert.rejects(x.store.transition(task.id, 'done'), /不能从/);
  await x.store.transition(task.id, 'analyzing', '开始分析');
  await x.store.transition(task.id, 'planning');
  await x.store.transition(task.id, 'executing');
  await x.store.addStep(task.id, {title: '搜索', tool: 'plugin.qq-web.search', outcome: 'ok'});
  await x.store.addStep(task.id, {title: '读取', tool: 'plugin.qq-web.read', outcome: 'ok'});
  await x.store.transition(task.id, 'verifying');
  await x.store.verify(task.id, {ok: true, note: '两个来源一致'});
  await x.store.transition(task.id, 'done', '完成');
  await x.store.attachMemory(task.id, 'mem-1');
  const reopened = await new TaskStore(x.dir).open();
  const row = reopened.get(task.id);
  assert.equal(row.status, 'done');
  assert.equal(row.steps.length, 2);
  assert.equal(row.verification.ok, true);
  assert.deepEqual(row.memoryIds, ['mem-1']);
  assert.equal(row.history.length >= 6, true);
});

test('任务步骤和重试有明确上限，失败后只允许重新规划', async t => {
  const x = await setup(t);
  const task = await x.store.create({goal: '执行一个任务', maxSteps: 1});
  for (const status of ['analyzing', 'planning', 'executing']) await x.store.transition(task.id, status);
  await x.store.addStep(task.id, {title: '第一步'});
  await assert.rejects(x.store.addStep(task.id, {title: '第二步'}), /上限/);
  await x.store.transition(task.id, 'failed', '工具失败');
  assert.equal(x.store.get(task.id).attempts, 1);
  await x.store.transition(task.id, 'planning', '重试');
  assert.equal(x.store.get(task.id).status, 'planning');
});

test('任务列表区分活动/等待授权/失败，不把完成当成活动', async t => {
  const x = await setup(t);
  const a = await x.store.create({goal: 'A'}), b = await x.store.create({goal: 'B'}), c = await x.store.create({goal: 'C'});
  await x.store.transition(a.id, 'analyzing');
  await x.store.transition(a.id, 'planning');
  await x.store.transition(a.id, 'waiting_approval');
  await x.store.transition(b.id, 'analyzing');
  await x.store.transition(b.id, 'failed');
  await x.store.transition(c.id, 'cancelled');
  assert.equal(x.store.status().active, 1);
  assert.equal(x.store.status().waitingApproval, 1);
  assert.equal(x.store.status().failed, 1);
  assert.equal(x.store.list({status: 'done'}).length, 0);
});
