import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DEFAULT_INTENTS, QQOfficialClient} from '../src/builtins/qq-official/client.js';
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

test('官方机器人 AI 回调可以使用受限外部上下文而不放宽普通 QQ 身份校验', () => {
  const store = {data: {framework: {generation: 1, ownerQQ: '12345678', listenGroups: []}, settings: {enabled: true, listenPrivate: false}}};
  const permissions = new Permissions(store);
  const context = permissions.issue({external: true, bot: 'qq-official', user: '12345678', kind: 'private', peer: '12345678', key: 'qq-official:private:12345678', id: 'external-1'}, 'autonomy');
  assert.equal(permissions.valid(context), null);
  permissions.close(context);
});
