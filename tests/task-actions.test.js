import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/host/store.js';
import {Permissions} from '../src/core/permissions.js';
import {Actions} from '../src/core/actions.js';
import {Events} from '../src/core/events.js';
import {Media} from '../src/core/media.js';
import {TaskStore} from '../src/session/tasks.js';

const bot = '10000002', owner = '10000001';

test('任务动作通过权限检查后可创建、推进、验证和查询', async t => {
  process.env.QQBOT_OWNER = owner;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-task-actions-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(path.join(dir, 'state')).open();
  Object.assign(store.data.framework, {
    listenPrivate: true,
    enabledActions: ['qq.task.create', 'qq.task.list', 'qq.task.get', 'qq.task.plan', 'qq.task.transition', 'qq.task.step', 'qq.task.verify', 'qq.task.attach-memory']
  });
  const permissions = new Permissions(store), events = new Events(store, () => {}), media = new Media(store), actions = new Actions(store, permissions, events, media);
  actions.attach({status: {bot}});
  const tasks = await new TaskStore(path.join(dir, 'tasks')).open();
  actions.installTaskActions(tasks);
  const msg = {bot, user: owner, kind: 'private', peer: owner, key: bot + ':private:' + owner, id: 'm1'};
  const context = permissions.issue(msg, 'chat');
  const taskEvents = [];
  actions.onTaskEvent = async event => taskEvents.push(event);
  const created = await actions.invoke('qq.task.create', {goal: '阅读并验证一篇文章', completion: '两个独立来源一致', plan: ['搜索', '读取', '验证']}, context);
  assert.equal(created.status, 'pending');
  await actions.invoke('qq.task.transition', {id: created.id, status: 'analyzing', note: '开始'}, context);
  await actions.invoke('qq.task.transition', {id: created.id, status: 'planning'}, context);
  await actions.invoke('qq.task.transition', {id: created.id, status: 'executing'}, context);
  await actions.invoke('qq.task.step', {id: created.id, title: '搜索', tool: 'plugin.qq-web.search', outcome: '4 results'}, context);
  await actions.invoke('qq.task.transition', {id: created.id, status: 'verifying'}, context);
  await actions.invoke('qq.task.verify', {id: created.id, ok: true, note: '来源一致'}, context);
  await actions.invoke('qq.task.transition', {id: created.id, status: 'done'}, context);
  const list = await actions.invoke('qq.task.list', {limit: 5}, context);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, 'done');
  assert.equal(list.items[0].steps.length, 1);
  assert.equal((await actions.invoke('qq.task.get', {id: created.id}, context)).task.verification.ok, true);
  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0].reason, 'task');
});
