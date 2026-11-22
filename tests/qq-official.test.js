import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DEFAULT_INTENTS, QQOfficialClient} from '../src/builtins/qq-official/client.js';
import {officialReply} from '../src/builtins/qq-official/reply.js';
import {activateQQOfficial} from '../src/builtins/qq-official/index.js';
import {validateConfig} from '../src/core/package-model.js';
import {Permissions} from '../src/core/permissions.js';

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.last = this;
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1000);
  }

  terminate() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1006);
  }
}

function response(value, status = 200) {
  return {ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value)};
}

test('QQ 官方客户端获取 token、identify、heartbeat 和事件', async () => {
  const calls = [];
  const events = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({url: String(url), options});
    if (String(url).includes('/app/getAppAccessToken')) return response({access_token: 'access-token', expires_in: 7200});
    if (String(url).endsWith('/gateway/bot')) return response({url: 'wss://gateway.example.test'});
    throw new Error('unexpected request');
  };
  const client = new QQOfficialClient({appId: 'app-1', clientSecret: 'secret-1', fetchImpl, WebSocketImpl: FakeWebSocket});
  client.on('event', event => events.push(event));
  client.start();
  for (let i = 0; i < 20 && !FakeWebSocket.last; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
  const socket = FakeWebSocket.last;
  assert.ok(socket);
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({op: 10, d: {heartbeat_interval: 10000}})));
  assert.deepEqual(socket.sent[0], {op: 2, d: {token: 'QQBot access-token', intents: DEFAULT_INTENTS, shard: [0, 1]}});
  socket.emit('message', Buffer.from(JSON.stringify({op: 0, t: 'READY', s: 1, d: {session_id: 'session-1', user: {username: '机器人'}}})));
  socket.emit('message', Buffer.from(JSON.stringify({op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: {id: 'm-1', content: '你好', author: {user_openid: 'openid-1'}}})));
  assert.equal(events[0].kind, 'private');
  assert.equal(events[0].text, '你好');
  assert.equal(client.connected, true);
  socket.emit('message', Buffer.from(JSON.stringify({op: 11, d: null})));
  await client.stop();
  assert.equal(client.connected, false);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('QQ 官方客户端按 UTF-8 字节分块并使用被动回复字段', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url: String(url), options});
    if (String(url).includes('/app/getAppAccessToken')) return response({access_token: 'token-2', expires_in: 7200});
    if (String(url).includes('/v2/groups/')) return response({id: 'reply-1'});
    throw new Error('unexpected request');
  };
  const client = new QQOfficialClient({appId: 'app-2', clientSecret: 'secret-2', fetchImpl});
  const ids = await client.sendText({kind: 'group', groupOpenid: 'group-1'}, '甲'.repeat(1800), {messageId: 'message-1', messageSeq: 2}, 4500);
  assert.equal(ids, 'reply-1');
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.msg_type, 0);
  assert.equal(payload.msg_id, 'message-1');
  assert.equal(payload.msg_seq, 3);
  assert.ok(Buffer.byteLength(payload.content, 'utf8') <= 3000);
});

test('QQ 官方客户端错误不会泄露凭据', async () => {
  const fetchImpl = async () => { throw new Error('request failed secret-3 token-3'); };
  const client = new QQOfficialClient({appId: 'app-3', clientSecret: 'secret-3', fetchImpl});
  await assert.rejects(() => client.getAccessToken(), error => !String(error.message).includes('secret-3'));
});

test('官方平台 OpenID 和同名数字不会成为 OneBot 主人', () => {
  const store = {data: {framework: {generation: 1, ownerQQ: '12345678', listenGroups: []}, settings: {enabled: true, listenPrivate: false}}};
  const permissions = new Permissions(store);
  assert.throws(() => permissions.issue({external: true, bot: 'qq-official', user: '12345678', kind: 'private', peer: '12345678', key: 'qq-official:private:12345678', id: 'external-1'}, 'autonomy'), /身份不完整/);
});

test('官方文本回复没有会话、历史或工具，拒绝不完整的模型响应', async () => {
  const frames = [], llm = {async *stream(request) {
    frames.push(request);
    yield {type: 'text-delta', text: '回答'};
    yield {type: 'finish', reason: {kind: frames.length === 1 ? 'stop' : 'tool-calls'}};
  }};
  const reply = officialReply({llm, modelInfo: async () => ({provider:'test', model:'text'})});
  assert.equal(await reply({text:'第一条'}), '回答');
  await assert.rejects(() => reply({text:'第二条'}), /回复未完成/);
  await assert.rejects(() => officialReply({llm, modelInfo: async () => ({provider:'test'})})({text:'配置不完整'}), /未配置/);
  assert.equal(frames.length, 2);
  for (const [i, text] of ['第一条','第二条'].entries()) {
    assert.equal(frames[i].sessionId, undefined);
    assert.deepEqual(frames[i].tools, []);
    assert.deepEqual(frames[i].messages, [{role:'user', content:[{type:'text', text}]}]);
  }
});

test('QQ 官方客户端不会把凭据发送到自定义 URL，也不跟随重定向', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://bots.qq.com/app/getAppAccessToken');
    assert.equal(options.redirect, 'error');
    return response({error:'test-private-marker'}, 302);
  };
  assert.throws(() => new QQOfficialClient({apiBase:'https://example.invalid', fetchImpl}), /仅支持 QQ 官方/);
  const client = new QQOfficialClient({appId:'app', clientSecret:'dummy', fetchImpl});
  await assert.rejects(() => client.request('GET', 'https://example.invalid/'), /仅支持 QQ 官方/);
  assert.equal(calls, 0);
  await assert.rejects(() => client.getAccessToken(), {message: 'QQ 官方 access_token 获取失败（HTTP 302）'});
  assert.equal(calls, 1);
});

function fixture({generateReply, qrSdkLoader} = {}) {
  let enabled = false, config, stored = {}, page, generation = 0;
  const refs = new Map(), requests = [], sockets = [];
  const credentials = {
    resolve: async key => refs.has(key) ? {value:refs.get(key), source:'file'} : undefined,
    set: async (key, value) => refs.set(key,value), unset: async key => refs.delete(key)
  };
  const api = {
    active: () => enabled, getConfig: () => config, reject: text => { throw new Error(text); }, action: () => {},
    storage: {get: () => structuredClone(stored), update: async fn => { stored = fn(structuredClone(stored)); }},
    settings: (_, fn) => { page = fn; }
  };
  const framework = {registerTrustedPackage: manifest => { config = validateConfig(manifest, {}); return api; }};
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    requests.push({pathname, options});
    if (pathname === '/app/getAppAccessToken') return response({access_token:'test-token',expires_in:7200});
    if (pathname === '/gateway/bot') return response({url:'wss://gateway.example.test/?test-private-marker'});
    return response({id:'test-ack'});
  };
  class Socket extends FakeWebSocket { constructor(...args) { super(...args); sockets.push(this); } }
  const module = activateQQOfficial(framework, {credentials, fetchImpl, WebSocketImpl:Socket, generateReply, qrSdkLoader, generation:()=>generation});
  return {...module, requests, sockets, refs, config, setEnabled(value) { enabled = value; }, invalidate() { generation++; }, page: () => page(), stored: () => stored};
}

const turn = () => new Promise(resolve => setImmediate(resolve));
const frame = (socket, t, d) => socket.emit('message', Buffer.from(JSON.stringify({op:0,t,d})));
const ready = socket => {
  assert.ok(socket);
  socket.readyState = FakeWebSocket.OPEN;
  frame(socket, 'READY', {session_id:'test-session', user:{username:'test-bot'}});
};

const setCredentials = module => module.ownerControl({op:'credentials', appId:'app-test-marker', clientSecret:'secret-test-marker'});

test('官方模块凭据密文、启停、再启用和手动断开均使用实际运行状态', async t => {
  const module = fixture(); t.after(module.stop);
  await module.sync();
  await assert.rejects(() => module.ownerControl({op:'connect'}), /启用/);
  assert.equal(module.requests.length, 0);
  module.setEnabled(true);
  await setCredentials(module);
  await turn();
  const first = module.sockets.at(-1);
  assert.equal((await module.page()).stats[1].value, 0);
  ready(first);
  const live = await module.page();
  assert.equal(live.stats[0].value, 1);
  assert.equal(live.stats[1].value, 1);
  assert.equal(live.rows.find(row => row.key==='Gateway').value, 'wss://gateway.example.test');
  assert.doesNotMatch(JSON.stringify([module.stored(), [...module.refs], live]), /secret-test-marker|app-test-marker|test-private-marker/);
  assert.ok(module.stored().credentialBox.tag);
  await module.ownerControl({op:'disconnect'});
  assert.equal(first.readyState, FakeWebSocket.CLOSED);
  await module.sync(); await turn();
  assert.equal(module.sockets.length, 1);
  module.setEnabled(false); await module.sync();
  assert.equal((await module.page()).stats[1].value, 0);
  module.setEnabled(true); await module.reconfigure(); await turn();
  assert.equal(module.sockets.length, 2);
  ready(module.sockets.at(-1));
  await module.ownerControl({op:'clear'}); await module.sync();
  assert.equal(module.sockets.at(-1).readyState, FakeWebSocket.CLOSED);
  assert.equal(Object.hasOwn(module.stored(),'credentialBox'), false);
  assert.equal(module.sockets.length, 2);
});

test('密文篡改不会用于连接，主人仍可清除重设', async t => {
  const module = fixture(); t.after(module.stop);
  module.config.autoConnect = false; module.setEnabled(true);
  await setCredentials(module);
  const box = module.stored().credentialBox;
  const body = Buffer.from(box.body, 'base64'); body[0] ^= 1; box.body = body.toString('base64');
  await assert.rejects(() => module.ownerControl({op:'connect'}), /无法解密/);
  assert.equal(module.requests.length, 0);
  assert.equal((await module.page()).rows[0].value, '不可读取');
  await module.ownerControl({op:'clear'});
  assert.equal(Object.hasOwn(module.stored(),'credentialBox'), false);
});

test('官方消息只回复在当前连接和授权世代发起的请求', async t => {
  let received = '';
  const stale = Promise.withResolvers(), results = [stale.promise, '当前回复'];
  const module = fixture({generateReply: ({text}) => {received = text; return results.shift();}});
  t.after(module.stop);
  module.setEnabled(true); await setCredentials(module); await turn();
  const first = module.sockets.at(-1);
  ready(first);
  const msg = {id:'incoming', content:'纯文本', author:{user_openid:'12345678'}};
  frame(first, 'C2C_MESSAGE_CREATE', msg);
  assert.equal(received, '纯文本');
  module.invalidate(); stale.resolve('不能发送的旧回复'); await turn();
  assert.equal(module.requests.some(request => request.pathname.endsWith('/messages')), false);
  frame(first, 'C2C_MESSAGE_CREATE', {...msg,id:'new'}); await turn();
  const replies = module.requests.filter(request => request.pathname.endsWith('/messages'));
  assert.equal(replies.length, 1);
  assert.equal(JSON.parse(replies[0].options.body).msg_id, 'new');
  module.setEnabled(false); await module.sync();
  assert.equal(first.readyState, FakeWebSocket.CLOSED);
});

test('多段回复未完成时停止，不会转到新连接发送剩余内容', async () => {
  const gate = Promise.withResolvers();
  let sends = 0;
  const fetchImpl = async url => {
    if (String(url).endsWith('/app/getAppAccessToken')) return response({access_token:'token', expires_in:7200});
    if (String(url).endsWith('/gateway/bot')) return response({url:'wss://gateway.example.test'});
    sends++;
    return gate.promise;
  };
  const client = new QQOfficialClient({appId:'test', clientSecret:'test', fetchImpl, WebSocketImpl:FakeWebSocket});
  const pending = client.sendText({kind:'group',groupOpenid:'test'}, '甲'.repeat(1800));
  const stopped = assert.rejects(pending, {name:'AbortError'});
  await turn();
  assert.equal(sends, 1);
  await client.stop();
  client.start();
  gate.resolve(response({id:'old'}));
  await stopped;
  assert.equal(sends, 1);
  await client.stop();
});
