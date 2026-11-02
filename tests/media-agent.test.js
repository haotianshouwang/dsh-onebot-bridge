import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/host/store.js';
import {Permissions} from '../src/core/permissions.js';
import {Events} from '../src/core/events.js';
import {Media} from '../src/core/media.js';
import {Actions} from '../src/core/actions.js';
import {PluginSDK} from '../src/sdk.js';
import {activateMediaAgent, manifest} from '../src/builtins/media-agent/index.js';
import {createMediaPlatformRegistry} from '../src/builtins/media-agent/platforms.js';
import {assertPlatformUrl} from '../src/builtins/media-agent/browser-service.js';

const owner = '10000001';
const bot = '10000002';
const privateMessage = (id = 'm1') => ({type: 'message', bot, user: owner, kind: 'private', peer: owner, key: `${bot}:private:${owner}`, id, time: Date.now() / 1000, text: ''});

test('媒体平台助手注册并提供独立存储', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-media-agent-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store);
  const events = new Events(store, () => {});
  const media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const sdk = new PluginSDK({store, permissions, events, media, actions});
  const api = activateMediaAgent(sdk.facade());

  assert.equal(api.id, manifest.id);
  assert.equal(api.getConfig().bilibiliEnabled, false);
  assert.equal(api.getConfig().platformMessageEnabled, false);
  assert.deepEqual(api.getConfig().messageContacts, []);
  assert.deepEqual(api.storage.get(), {});
  assert.ok((await sdk.pageList()).some(row => row.id === manifest.id));
  await sdk.stop();
});

test('媒体平台状态明确标记为未接入，不伪造连接状态', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-media-agent-status-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store);
  const events = new Events(store, () => {});
  const media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  const sdk = new PluginSDK({store, permissions, events, media, actions});
  const api = activateMediaAgent(sdk.facade());
  const state = api.storage.get();
  assert.deepEqual(state, {});
  const listed = await sdk.pageList();
  assert.equal(listed.find(row => row.id === manifest.id).enabled, false);
  await sdk.stop();
});

test('平台注册表同时包含 B 站和抖音驱动', async () => {
  const registry = createMediaPlatformRegistry({read: async () => ({body: JSON.stringify({code: 0, data: {result: []}})})});
  const statuses = await registry.status();
  assert.deepEqual(statuses.map(row => row.id), ['bilibili', 'douyin']);
  assert.equal(statuses.find(row => row.id === 'bilibili').state, 'ready');
  assert.equal(statuses.find(row => row.id === 'douyin').state, 'requires-browser');
  await registry.close();
});

test('B 站公开搜索只返回清洗后的公开字段', async () => {
  const registry = createMediaPlatformRegistry({read: async () => ({body: JSON.stringify({
    code: 0,
    data: {result: [{bvid: 'BV1TEST', title: '<em>测试</em>', author: '作者', arcurl: 'https://www.bilibili.com/video/BV1TEST', play: '12', description: '<p>说明</p>'}]}
  })})});
  const result = await registry.get('bilibili').search({query: '测试', limit: 1});
  assert.deepEqual(result.results[0], {
    bvid: 'BV1TEST',
    title: '测试',
    author: '作者',
    url: 'https://www.bilibili.com/video/BV1TEST',
    duration: '',
    play: 12,
    description: '说明'
  });
  await registry.close();
});

test('专用浏览器适配器只允许官方域名，并透传真实播放结果', async () => {
  assert.equal(assertPlatformUrl('douyin', 'https://www.douyin.com/video/123').hostname, 'www.douyin.com');
  assert.equal(assertPlatformUrl('bilibili', 'https://space.bilibili.com/123').hostname, 'space.bilibili.com');
  assert.throws(() => assertPlatformUrl('douyin', 'https://example.com/video/123'), /官方域名/);
  assert.throws(() => assertPlatformUrl('bilibili', 'http://www.bilibili.com/video/BV1'), /HTTPS/);
  const calls = [];
  const browser = {
    async status() { return {state: 'ready', connected: true}; },
    async open(platform, url) { calls.push(['open', platform, url]); return {platform, url, title: '真实页面'}; },
    async watch(platform, options) { calls.push(['watch', platform, options.seconds]); return {platform, elapsedSeconds: options.seconds, snapshot: {title: '真实视频'}}; },
    async snapshot(platform) { calls.push(['snapshot', platform]); return {platform, title: '当前页面'}; },
    async subtitles(platform) { calls.push(['subtitles', platform]); return {platform, cues: [{start: 0, end: 1, text: '字幕'}]}; },
    async comment(platform, content) { calls.push(['comment', platform, content]); return {platform, state: 'submitted', outcome: 'submitted', title: '视频'}; },
    async screenshot(platform) { calls.push(['screenshot', platform]); return {platform, base64: 'x'}; },
    async close() {}
  };
  const registry = createMediaPlatformRegistry({browser});
  const result = await registry.get('douyin').start({id: '123', seconds: 4});
  assert.equal(result.elapsedSeconds, 4);
  assert.deepEqual(calls.slice(0, 2), [['open', 'douyin', 'https://www.douyin.com/video/123'], ['watch', 'douyin', 4]]);
  const info = await registry.get('douyin').info();
  assert.equal(info.platform, 'douyin');
  assert.equal((await registry.get('douyin').subtitles()).cues[0].text, '字幕');
  assert.equal((await registry.get('douyin').comment({content: '评论'})).state, 'submitted');
  assert.equal((await registry.get('bilibili').status()).connected, true);
  await registry.close();
});

test('公开评论必须明确确认、持久化结果且拒绝相同内容重发', async t => {
  process.env.QQBOT_OWNER = owner;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-media-agent-comment-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store);
  const events = new Events(store, () => {});
  const media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  store.data.framework.enabledActions = ['plugin.qq-media-agent.comment'];
  actions.attach({status: {bot}});
  const browser = {
    async status() { return {state: 'ready', connected: true}; },
    async comment(platform, content) { return {platform, content, state: 'submitted', outcome: 'submitted', title: '真实视频', url: 'https://www.douyin.com/video/123'}; },
    async close() {}
  };
  const sdk = new PluginSDK({store, permissions, events, media, actions});
  activateMediaAgent(sdk.facade(), {browser});
  const item = store.data.framework.nativePackages[manifest.id];
  item.enabled = true;
  item.scope = {private: true, users: [owner], groups: []};
  Object.assign(item.config, {douyinEnabled: true, browserEnabled: true, outboundEnabled: true});
  t.after(() => sdk.stop());
  const context = permissions.issue(privateMessage(), 'chat');
  const result = await actions.invoke('plugin.qq-media-agent.comment', {platform: 'douyin', content: '公开评论', confirm: true}, context);
  assert.equal(result.state, 'submitted');
  assert.equal(store.data.framework.pluginData[manifest.id].outbound[0].state, 'submitted');
  await assert.rejects(actions.invoke('plugin.qq-media-agent.comment', {platform: 'douyin', content: '公开评论', confirm: true}, permissions.issue(privateMessage('m2'), 'chat')), /相同评论/);
});

test('分享只发当前主人私聊，并按 QQ 回执确认且拒绝重复发送', async t => {
  process.env.QQBOT_OWNER = owner;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-media-agent-share-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store);
  const events = new Events(store, () => {});
  const media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  store.data.framework.enabledActions = ['plugin.qq-media-agent.share', 'qq.message.send'];
  const sent = [];
  actions.attach({status: {bot}, async request(action, params) { sent.push({action, params}); return {outcome: 'confirmed', state: 'confirmed', data: {message_id: 55}}; }, async call(action, params) { assert.equal(action, 'get_msg'); return {message_id: params.message_id, user_id: bot, target_id: owner}; }});
  const browser = {async status() { return {state: 'ready', connected: true}; }, async snapshot() { return {platform: 'douyin', url: 'https://www.douyin.com/video/123', title: '分享视频', loginRequired: false}; }, async current() { return {platform: 'douyin', url: 'https://www.douyin.com/video/123', title: '分享视频', loginRequired: false}; }, async close() {}};
  const sdk = new PluginSDK({store, permissions, events, media, actions});
  activateMediaAgent(sdk.facade(), {browser});
  const item = store.data.framework.nativePackages[manifest.id];
  item.enabled = true;
  item.scope = {private: true, users: [owner], groups: []};
  Object.assign(item.config, {douyinEnabled: true, browserEnabled: true, outboundEnabled: true});
  t.after(() => sdk.stop());
  const context = permissions.issue(privateMessage(), 'chat');
  const result = await actions.invoke('plugin.qq-media-agent.share', {platform: 'douyin', confirm: true}, context);
  assert.equal(result.state, 'confirmed');
  assert.equal(sent[0].action, 'send_private_msg');
  assert.equal(sent[0].params.user_id, Number(owner));
  assert.match(sent[0].params.message[0].data.text, /https:\/\/www\.douyin\.com\/video\/123/);
  assert.equal(store.data.framework.pluginData[manifest.id].outbound[0].state, 'confirmed');
  await assert.rejects(actions.invoke('plugin.qq-media-agent.share', {platform: 'douyin', confirm: true}, permissions.issue(privateMessage('m2'), 'chat')), /相同视频/);
  const groupContext = permissions.issue({type: 'message', bot, user: owner, kind: 'group', peer: '20000001', key: `${bot}:group:20000001`, id: 'm3', time: Date.now() / 1000, text: ''}, 'chat');
  store.data.framework.listenGroups = ['20000001'];
  item.scope = {private: true, users: [owner], groups: ['20000001']};
  await assert.rejects(actions.invoke('plugin.qq-media-agent.share', {platform: 'douyin', confirm: true}, groupContext), /当前主人私聊/);
});

test('平台私信要求白名单、确认和独占发送，未知结果不自动重发', async t => {
  process.env.QQBOT_OWNER = owner;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-media-agent-message-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).open();
  const permissions = new Permissions(store);
  const events = new Events(store, () => {});
  const media = new Media(store);
  const actions = new Actions(store, permissions, events, media);
  store.data.framework.enabledActions = ['plugin.qq-media-agent.message', 'plugin.qq-media-agent.message-open'];
  actions.attach({status: {bot}, async close() {}});
  let calls = 0;
  const browser = {
    async openContact(platform, contactId) { return {platform, contactId, url: `https://www.douyin.com/user/${contactId}`}; },
    async message(platform, args) { calls += 1; return {platform, contactId: args.contactId, state: 'submitted', outcome: 'submitted'}; },
    async close() {}
  };
  const sdk = new PluginSDK({store, permissions, events, media, actions});
  activateMediaAgent(sdk.facade(), {browser});
  const item = store.data.framework.nativePackages[manifest.id];
  item.enabled = true;
  item.scope = {private: true, users: [owner], groups: []};
  Object.assign(item.config, {douyinEnabled: true, browserEnabled: true, outboundEnabled: true, platformMessageEnabled: true, messageContacts: ['douyin:abc123']});
  t.after(() => sdk.stop());
  const context = permissions.issue(privateMessage(), 'chat');
  const opened = await actions.invoke('plugin.qq-media-agent.message-open', {platform: 'douyin', contactId: 'abc123'}, context);
  assert.equal(opened.contactId, 'abc123');
  const result = await actions.invoke('plugin.qq-media-agent.message', {platform: 'douyin', contactId: 'abc123', content: '你好', confirm: true}, context);
  assert.equal(result.state, 'submitted');
  assert.equal(calls, 1);
  const row = store.data.framework.pluginData[manifest.id].outbound[0];
  assert.equal(row.kind, 'message');
  assert.equal('content' in row, false);
  await assert.rejects(actions.invoke('plugin.qq-media-agent.message', {platform: 'douyin', contactId: 'abc123', content: '你好', confirm: true}, permissions.issue(privateMessage('m2'), 'chat')), /相同平台私信/);
  await assert.rejects(actions.invoke('plugin.qq-media-agent.message', {platform: 'douyin', contactId: 'other', content: '你好', confirm: true}, permissions.issue(privateMessage('m3'), 'chat')), /白名单/);
});
