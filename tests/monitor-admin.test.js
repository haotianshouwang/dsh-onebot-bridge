import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ActivityStore} from '../src/admin/activity-store.js';
import {createMonitorUsage} from '../src/admin/monitor-usage.js';
import {createMonitorAdmin} from '../src/admin/monitor-admin.js';
import {createRuntimeMonitor} from '../src/host/runtime-monitor.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-monitor-'));
  const at = Date.parse('2026-11-14T12:00:00Z');
  const activity = await new ActivityStore(dir, {now: () => at}).open();
  t.after(async () => { activity.close(); await rm(dir, {recursive: true, force: true}); });
  return {activity, at, usage: createMonitorUsage(activity, {now: () => at})};
}

test('监控按真实用途/平台汇总，取消、受理、未知和零用量独立计数', async t => {
  const {activity, at, usage} = await fixture(t);
  activity.record({at, kind: 'model', purpose: 'chat', provider: 'test', model: 'm1', platform: 'qq', status: 'completed', usage: {inputTokens: 10, cacheReadTokens: 20, outputTokens: 5, totalTokens: 35}});
  activity.record({at: at + 1, kind: 'model', purpose: 'private-thinking', provider: 'test', model: 'm1', status: 'failed'});
  activity.record({at: at + 2, kind: 'model', purpose: 'memory-embedding', provider: 'test', model: 'm2', status: 'completed', usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0}});
  activity.record({at: at + 3, kind: 'model', purpose: 'chat', provider: 'test', model: 'm1', status: 'aborted', usage: {inputTokens: 2, outputTokens: 1}});
  for (const status of ['confirmed', 'failed', 'accepted', 'unknown', 'denied']) activity.record({at, kind: 'action', purpose: 'plugin.qq-qzone.list', status});
  const summary = usage.summary();
  assert.equal(summary.model.calls, 4);
  assert.equal(summary.model.totalTokens, 38);
  assert.equal(summary.model.cacheReadTokens, 20);
  assert.equal(summary.model.unreportedCalls, 1);
  assert.equal(summary.model.incompleteCalls, 1);
  assert.equal(summary.model.success, 2);
  assert.equal(summary.model.cancelled, 1);
  assert.equal(summary.tool.calls, 5);
  for (const status of ['success', 'failed', 'accepted', 'unknown', 'denied']) assert.equal(summary.tool[status], 1);
  assert.equal(usage.summary({component: 'qq-memory'}).model.totalTokens, 0);
  assert.equal(usage.list({component: 'qq-qzone', limit: 2}).total, 5);
  assert.equal(usage.list({component: 'qq-qzone', limit: 2}).hasMore, true);
  assert.equal(usage.list({component: 'qq-private'}).items[0].usage, null);
  assert.equal(usage.list({model: 'm2'}).items[0].usage.totalTokens, 0);
  assert.equal(usage.list({status: 'denied'}).items[0].status, 'denied');
});

test('北京时间范围、参数化筛选和分页不会跨范围读取', async t => {
  const {activity, at, usage} = await fixture(t);
  activity.record({at: at - 86400000, kind: 'model', purpose: 'write-diary', status: 'completed', usage: {inputTokens: 40, outputTokens: 10, totalTokens: 50}});
  activity.record({at, kind: 'model', purpose: 'chat', model: "m' OR 1=1", status: 'failed'});
  assert.equal(usage.summary().model.calls, 1);
  assert.equal(usage.summary({range: '7d'}).model.calls, 2);
  assert.equal(usage.summary({component: 'qq-autonomy', range: 'all'}).model.totalTokens, 50);
  assert.equal(usage.list({model: "m' OR 1=1"}).total, 1);
  assert.equal(usage.list({component: 'nonexistent'}).total, 0);
  assert.equal(usage.list({offset: -1, limit: 1000}).limit, 100);
});

test('角色没有心情观察时保持未知，模型成功不增加消息送达次数', async t => {
  const {activity, at} = await fixture(t);
  activity.record({at, kind: 'model', purpose: 'chat', status: 'completed'});
  const monitor = createMonitorAdmin({activity, runtimeMonitor: {snapshot: () => ({active: [], activeCount: 0})},
    resources: {snapshot: () => ({network: {available: false}})}, getStatus: () => ({bot: '12345678', nickname: '<script>bot</script>', online: true}),
    getEmotion: () => ({enabled: true, observed: false, state: {global: {mood: '平静'}}}),
    getLife: () => ({energy: {current: 0.5, components: {social: 0.4}}, sleep: {phase: 'awake'}}), getJobs: () => [], getPackages: () => [],
    getDelivery: () => [{finalState: 'confirmed'}, {finalState: 'accepted'}, {finalState: 'unknown'}, {finalState: 'failed'}]
  });
  const result = monitor.overview({range: 'all'});
  assert.equal(result.character.mood, null);
  assert.equal(result.character.state, 'idle');
  assert.match(result.character.avatarUrl, /^\/api\/bot-avatar/);
  assert.equal(result.delivery.confirmed, 1);
  assert.equal(result.delivery.retained, 4);
  assert.throws(() => monitor.invoke('send'), /不支持/);
});

test('运行监控跟踪并发用途、最大输出失败和中断，保持流内容原样', async t => {
  const {activity} = await fixture(t);
  const monitor = createRuntimeMonitor({ctx: {}, activity, resolveSession: id => id === 'owned' ? {purpose: 'write-diary', platform: 'qq'} : null});
  let release;
  const stream = async function* () {
    yield {type: 'usage', usage: {inputTokens: 3, outputTokens: 1, totalTokens: 4}};
    await new Promise(resolve => { release = resolve; });
    yield {type: 'finish', reason: {kind: 'max-tokens'}};
  };
  const iterator = monitor.listener({sessionId: 'owned', provider: 'test', model: 'm'}, stream);
  const value = await iterator.next();
  assert.equal(value.value.type, 'usage');
  assert.equal(monitor.snapshot().activeCount, 1);
  const ending = iterator.next();
  await Promise.resolve();
  release();
  await ending;
  await iterator.next();
  assert.equal(monitor.snapshot().activeCount, 0);
  const row = activity.list().items[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.errorCode, 'MAX_TOKENS');
  assert.equal(row.purpose, 'write-diary');
  const untouched = stream();
  assert.equal(monitor.listener({}, () => untouched), untouched);
  monitor.stop();
});

test('宿主停止时保留已经收到的模型用量，不把中断调用改成未知用量', async t => {
  const {activity} = await fixture(t);
  const monitor = createRuntimeMonitor({ctx: {}, activity, resolveSession: () => ({purpose: 'chat', platform: 'qq'})});
  const iterator = monitor.listener({sessionId: 'owned'}, async function* () {
    yield {type: 'usage', usage: {inputTokens: 11, outputTokens: 7, totalTokens: 18}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  });
  await iterator.next();
  monitor.stop();
  const row = activity.list().items[0];
  assert.equal(row.status, 'interrupted');
  assert.equal(row.usage.totalTokens, 18);
  await iterator.return();
  assert.equal(activity.list().items[0].status, 'interrupted');
});

test('监控显示真实待完成观看任务，历史完成记录不冒充当前活动', async t => {
  const {activity} = await fixture(t);
  let jobs = [{id: 'live', platform: 'bilibili', state: 'accepted', requestedSeconds: 30}, {id: 'done', platform: 'douyin', state: 'confirmed'}];
  const monitor = createMonitorAdmin({activity, runtimeMonitor: {snapshot: () => ({active: [], activeCount: 0})},
    resources: {snapshot: () => ({})}, getStatus: () => ({online: true}),
    getWatchJobs: () => jobs, getJobs: () => [], getPackages: () => []
  });
  let value = monitor.overview().character;
  assert.equal(value.state, 'working');
  assert.equal(value.active.length, 1);
  assert.equal(value.active[0].platform, 'bilibili');
  assert.equal(value.active[0].status, 'accepted');
  jobs = jobs.map(job => ({...job, state: 'unknown'}));
  value = monitor.overview().character;
  assert.equal(value.state, 'idle');
  assert.equal(value.active.length, 0);
});
