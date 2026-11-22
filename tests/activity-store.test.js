import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ActivityStore, activityDay, normalizeUsage} from '../src/admin/activity-store.js';
import {createRuntimeMonitor} from '../src/host/runtime-monitor.js';

async function open(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'activity-ledger-'));
  const at = Date.parse('2026-11-13T16:05:00Z');
  const activity = await new ActivityStore(dir, {now: () => at}).open();
  t.after(async () => { activity.close(); await rm(dir, {recursive: true, force: true}); });
  return {activity, dir, at};
}

test('按北京时间分天，缓存只计一次，推理包含在输出中，未知用量不补零', async t => {
  const {activity, at} = await open(t);
  assert.equal(activityDay(at), '2026-11-14');
  activity.record({kind: 'model', at, purpose: 'chat', usage: {inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 2, outputTokens: 20, reasoningTokens: 8, totalTokens: 62}});
  activity.record({kind: 'model', at: at + 1, purpose: 'video-summary', status: 'failed'});
  activity.record({kind: 'model', at: at - 600000, usage: {inputTokens: 500, outputTokens: 100, totalTokens: 600}});
  const summary = activity.summary({date: '2026-11-14'});
  assert.equal(summary.totals.calls, 2);
  assert.equal(summary.totals.totalTokens, 62);
  assert.equal(summary.totals.unknownCalls, 1);
  assert.equal(summary.totals.reasoningTokens, 8);
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.hourly[0].tokens, 62);
  assert.equal(activity.list({date: '2026-11-14', purpose: 'video-summary'}).items[0].usage, null);
  assert.throws(() => activity.summary({date: '2026-02-30'}), /日期无效/);
  assert.equal(normalizeUsage({inputTokens: -1, outputTokens: NaN}), null);
  assert.equal(normalizeUsage({inputTokens: 50, outputTokens: 20, totalTokens: 5}).totalTokens, null);
});

test('模型流最后一份 usage 替换增量，重试单列，失败无 usage 仍保存且秘密不落盘', async t => {
  const {activity, dir} = await open(t);
  const monitor = createRuntimeMonitor({ctx: {}, activity});
  const options = {provider: 'test', model: 'test-model', system: 'PRIVATE-PROMPT-NEVER-LOG', messages: [{text: 'SECRET-BODY-NEVER-LOG'}]};
  const attempt = async function* () {
    yield {type: 'text-delta', text: 'SECRET-OUTPUT-NEVER-LOG'};
    yield {type: 'usage', usage: {inputTokens: 10, outputTokens: 2, totalTokens: 12}};
    yield {type: 'usage', usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  };
  await monitor.scope({purpose: 'private-thinking', platform: 'system'}, async () => {
    for await (const _chunk of monitor.listener(options, attempt)) { /* consume actual test stream */ }
    await assert.rejects(async () => { for await (const _chunk of monitor.listener(options, async function* () { throw new Error('provider unavailable'); })) {} });
  });
  const result = activity.summary();
  assert.equal(result.totals.calls, 2);
  assert.equal(result.totals.totalTokens, 15);
  assert.equal(result.totals.unknownCalls, 1);
  assert.equal(result.failedCalls, 1);
  monitor.stop(); activity.close();
  assert.doesNotMatch((await readFile(path.join(dir, 'activity.db'))).toString(), /PRIVATE-PROMPT|SECRET-BODY|SECRET-OUTPUT/);
});

test('消息去重、按会话隔离、分页和重启保留真实来源', async t => {
  const {activity, dir, at} = await open(t);
  const msg = {platform: 'wechat', key: 'wechat:private:u1', id: 'm1', time: at / 1000, sender: '接口测试联系人', text: '<script>untrusted</script>'};
  activity.message(msg); activity.message(msg);
  activity.message({...msg, key: 'wechat:private:u2', id: 'm2', direction: 'outbound', text: '第二个会话'});
  assert.equal(activity.conversations({platform: 'wechat'}).total, 2);
  assert.equal(activity.messages({key: msg.key}).total, 1);
  assert.equal(activity.messages({key: msg.key}).items[0].source, 'platform-api');
  const id = activity.record({kind: 'model', at, status: 'running'});
  activity.close();
  const reopened = await new ActivityStore(dir, {now: () => at}).open();
  assert.equal(reopened.list({date: '2026-11-14', kind: 'model'}).items.find(row => row.id === id).status, 'interrupted');
  assert.equal(reopened.messages({key: msg.key}).items[0].text, msg.text);
  reopened.close();
});

test('相同会话键在不同平台保存时，消息查询按所选平台隔离', async t => {
  const {activity, at} = await open(t);
  const base = {key: 'shared:private:123', id: 'same-id', time: at / 1000, direction: 'inbound'};
  activity.message({...base, platform: 'qq', text: 'QQ 的消息'});
  activity.message({...base, platform: 'wechat', text: '微信的消息'});
  const result = activity.messages({key: base.key, platform: 'wechat'});
  assert.equal(result.total, 1);
  assert.equal(result.items[0].text, '微信的消息');
});
