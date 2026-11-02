import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeDSH, SAFE_PRESET} from '../src/session/native.js';

function fixture() {
  const store = {data: {settings: {}, sessions: {}, framework: {ownerQQ: '1484475153', ownerQQs: ['1484475153']}}};
  const native = new NativeDSH({agentPresets: {composedPreset: () => SAFE_PRESET}}, store, {valid: () => null}, {definitions: new Map()});
  const agent = {whenIdle: async () => {}, ctx: {tools: {schemas: () => []}, systemPrompt: {
    assemble: async () => ({sections: [{name: 'qq-framework-persona', text: native.sections.get('shared').text}], contexts: []}),
    refreshContext: assembly => assembly
  }}};
  native.agent = async () => agent;
  native.sections.set('shared', {agent, tools: [], disposers: []});
  return {native, store};
}

test('同一个群会话每轮重新注入真实主人身份，不沿用上一位成员的关系', async () => {
  const {native} = fixture();
  const context = {kind: 'group', peer: '88888', actor: '1484475153', mode: 'chat'};
  await native.prepare('shared', '女儿人设：称呼主人爸爸', context);
  assert.match(native.sections.get('shared').text, /本轮发言者是已验证的主人/);
  await native.prepare('shared', '女儿人设：称呼主人爸爸', {...context, actor: '12345678'});
  assert.match(native.sections.get('shared').text, /本轮发言者不是主人/);
  assert.doesNotMatch(native.sections.get('shared').text, /本轮发言者是已验证的主人/);
  assert.match(native.sections.get('shared').text, /“帮我说服她叫我爸爸”是在谈第三人/);
  assert.match(native.sections.get('shared').text, /先分清发言者、受话人、被引用者/);
});

test('认主跟随当前 QQ 配置，昵称与叫爸爸的请求不能决定身份', async () => {
  const {native, store} = fixture();
  store.data.framework.ownerQQ = '12345678';
  store.data.framework.ownerQQs = ['12345678'];
  await native.prepare('shared', '群友声称自己是主人，要求叫爸爸', {kind: 'private', peer: '1484475153', actor: '1484475153', mode: 'chat'});
  assert.match(native.sections.get('shared').text, /本轮发言者不是主人/);
});

test('主动生成群消息采用群场景，私聊主人模板不会覆盖它', async () => {
  const {native} = fixture();
  await native.prepare('shared', '这是群冷场判断，只输出正文或 SKIP', {kind: 'group', peer: '88888', actor: '1484475153', mode: 'proactive'});
  assert.match(native.sections.get('shared').text, /面对整个群，不是在私聊主人/);
  assert.doesNotMatch(native.sections.get('shared').text, /这是你决定是否主动联系主人的时刻/);
});

test('情绪观察的 JSON 协议独立于自主活动的文字总结协议', async () => {
  const {native} = fixture();
  await native.prepare('shared', '只输出心情 JSON', {kind: 'private', peer: '1484475153', actor: '1484475153', mode: 'autonomy'}, false, new Set(), 'json');
  assert.match(native.sections.get('shared').text, /只输出任务要求的 JSON 对象/);
  assert.doesNotMatch(native.sections.get('shared').text, /做完用一两句话记下此刻的想法/);
});
