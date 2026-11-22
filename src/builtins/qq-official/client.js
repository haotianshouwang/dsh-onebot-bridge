import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';

export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
export const DEFAULT_API_BASE_URL = 'https://api.sgroup.qq.com';
export const DEFAULT_SANDBOX_API_BASE_URL = 'https://sandbox.api.sgroup.qq.com';
export const DEFAULT_INTENTS = (1 << 25) | (1 << 30);

const MAX_TEXT_BYTES = 3000;
const MAX_PASSIVE_CHUNKS = 5;
const REFRESH_MARGIN_MS = 60000;
const MAX_RECONNECT_MS = 60000;

// Never forward a QQ bearer token or the token request body to a custom endpoint.
export function safeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || DEFAULT_API_BASE_URL)); } catch { throw new Error('QQ 官方 API 地址无效'); }
  if (![DEFAULT_API_BASE_URL, DEFAULT_SANDBOX_API_BASE_URL].includes(url.origin) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('仅支持 QQ 官方生产或沙箱 API 根地址');
  }
  return url.origin;
}

function splitText(value, maxBytes = MAX_TEXT_BYTES) {
  const result = [];
  let current = '';
  for (const char of String(value || '')) {
    const next = current + char;
    if (Buffer.byteLength(next, 'utf8') > maxBytes && current) {
      result.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current || !result.length) result.push(current);
  return result;
}

function stripMentions(value) {
  return String(value || '').replace(/<@!?[^>]+>/g, '').trim();
}

function attachmentsText(value) {
  if (!Array.isArray(value)) return '';
  return value.map(item => item?.content_type?.startsWith('image/') ? '[图片]' : item?.filename ? `[附件: ${String(item.filename).slice(0, 80)}]` : '[附件]').join(' ');
}

function normalizeEvent(type, data, appId) {
  if (!data || typeof data !== 'object') return null;
  const author = data.author || {};
  const text = [stripMentions(data.content), attachmentsText(data.attachments)].filter(Boolean).join(' ').slice(0, 12000);
  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    return {kind: 'group', peer: String(data.group_openid || ''), actor: String(author.member_openid || author.id || ''), text, target: {kind: 'group', groupOpenid: String(data.group_openid || '')}, reply: {messageId: String(data.id || ''), messageSeq: Number(data.msg_seq) || 0}, messageId: String(data.id || ''), appId};
  }
  if (type === 'C2C_MESSAGE_CREATE') {
    return {kind: 'private', peer: String(author.user_openid || author.id || ''), actor: String(author.user_openid || author.id || ''), text, target: {kind: 'private', openid: String(author.user_openid || author.id || '')}, reply: {messageId: String(data.id || ''), messageSeq: Number(data.msg_seq) || 0}, messageId: String(data.id || ''), appId};
  }
  if (type === 'AT_MESSAGE_CREATE') {
    return {kind: 'channel', peer: `${String(data.guild_id || '')}-${String(data.channel_id || '')}`, actor: String(author.id || ''), text, target: {kind: 'channel', channelId: String(data.channel_id || '')}, guildId: String(data.guild_id || ''), channelId: String(data.channel_id || ''), reply: {messageId: String(data.id || ''), messageSeq: Number(data.msg_seq) || 0}, messageId: String(data.id || ''), appId};
  }
  return null;
}

export class QQOfficialClient extends EventEmitter {
  constructor({appId, clientSecret, apiBase = DEFAULT_API_BASE_URL, intents = DEFAULT_INTENTS, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, log = () => {}} = {}) {
    super();
    this.appId = String(appId || '');
    this.clientSecret = String(clientSecret || '');
    this.apiBase = safeBaseUrl(apiBase);
    this.intents = Number.isSafeInteger(intents) ? intents : DEFAULT_INTENTS;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.ws = null;
    this.closed = true;
    this.lifetime = new AbortController();
    this.connecting = false;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = 30000;
    this.lastHeartbeatAck = 0;
    this.lastSeq = 0;
    this.sessionId = '';
    this.canResume = false;
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.connectionToken = '';
    this.attempt = 0;
    this.status = {state: 'stopped', connected: false, botName: '', gateway: '', lastError: ''};
    this.replySequences = new Map();
  }

  configure({appId, clientSecret, apiBase, intents} = {}) {
    if (appId !== undefined) this.appId = String(appId || '');
    if (clientSecret !== undefined) this.clientSecret = String(clientSecret || '');
    if (apiBase !== undefined) this.apiBase = safeBaseUrl(apiBase);
    if (intents !== undefined && Number.isSafeInteger(intents)) this.intents = intents;
  }

  get connected() {
    return this.ws?.readyState === this.WebSocketImpl.OPEN && this.status.connected === true;
  }

  start() {
    if (!this.appId || !this.clientSecret) throw new Error('QQ 官方机器人缺少 AppID 或 AppSecret');
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    this.closed = false;
    if (!this.connecting && !this.ws) void this.connect();
  }

  async stop() {
    this.closed = true;
    this.lifetime.abort();
    this.accessToken = this.connectionToken = this.sessionId = '';
    this.tokenExpiresAt = this.lastSeq = this.attempt = 0;
    this.tokenPromise = null;
    this.canResume = false;
    this.replySequences.clear();
    this.connecting = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.status = {state: 'stopped', connected: false, gateway: '', botName: '', lastError: ''};
    if (ws) {
      try { ws.removeAllListeners(); } catch {}
      // ws emits an error when a handshake is interrupted.
      ws.on('error', () => {});
      try { ws.close(); } catch {}
      try { ws.terminate(); } catch {}
    }
  }

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiresAt - Date.now() > REFRESH_MARGIN_MS) return this.accessToken;
    if (this.tokenPromise) return this.tokenPromise;
    const {signal} = this.lifetime;
    signal.throwIfAborted();
    const pending = this.tokenPromise = (async () => {
      const response = await this.fetch(TOKEN_URL, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({appId: this.appId, clientSecret: this.clientSecret}), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])}).catch(() => {throw new Error('无法访问 QQ 官方认证服务');});
      const raw = await response.text();
      let value;
      try { value = JSON.parse(raw); } catch { value = null; }
      if (!response.ok || !value || typeof value.access_token !== 'string' || !value.access_token) throw new Error(`QQ 官方 access_token 获取失败（HTTP ${response.status}）`);
      signal.throwIfAborted();
      this.accessToken = value.access_token;
      this.tokenExpiresAt = Date.now() + (Number(value.expires_in) || 7200) * 1000;
      return this.accessToken;
    })();
    try { return await pending; } finally { if (this.tokenPromise === pending) this.tokenPromise = null; }
  }

  async request(method, path, body) {
    const {signal} = this.lifetime;
    const url = new URL(path, this.apiBase + '/');
    if (url.origin !== this.apiBase) throw new Error('仅支持 QQ 官方 API 地址');
    const token = await this.getAccessToken();
    signal.throwIfAborted();
    const response = await this.fetch(url, {method, headers: {authorization: `QQBot ${token}`, 'x-union-appid': this.appId, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])}).catch(() => {throw new Error('无法访问 QQ 官方 API');});
    const raw = await response.text();
    signal.throwIfAborted();
    let value;
    try { value = JSON.parse(raw); } catch { value = null; }
    if (!response.ok) throw new Error(`QQ 官方 API 请求失败（HTTP ${response.status}）`);
    return value;
  }

  async resolveGateway() {
    const value = await this.request('GET', '/gateway/bot');
    if (!value?.url || typeof value.url !== 'string') throw new Error('QQ 官方 Gateway 返回地址无效');
    return value.url;
  }

  async connect() {
    if (this.closed || this.connecting || this.ws) return;
    const {signal} = this.lifetime;
    this.connecting = true;
    this.status = {...this.status, state: 'connecting', connected: false};
    try {
      const [token, url] = await Promise.all([this.getAccessToken(), this.resolveGateway()]);
      if (signal.aborted) return;
      const endpoint = new URL(url);
      if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password) throw new Error('QQ 官方 Gateway 地址无效');
      this.connectionToken = token;
      this.status = {...this.status, state: 'connecting', gateway: endpoint.origin, lastError: ''};
      const ws = new this.WebSocketImpl(url, {handshakeTimeout: 15000, maxPayload: 1024 * 1024});
      this.ws = ws;
      ws.on('open', () => this.emit('open'));
      ws.on('message', data => this.handleFrame(data));
      ws.on('error', () => this.fail(new Error('QQ 官方 Gateway 连接异常')));
      ws.on('close', code => this.handleClose(code));
    } catch (error) {
      if (!signal.aborted) { this.fail(new Error('QQ 官方 Gateway 连接失败')); this.scheduleReconnect(); }
    } finally {
      if (!signal.aborted) this.connecting = false;
    }
  }

  sendOp(op, data) {
    if (this.ws?.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify({op, d: data}));
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.lastHeartbeatAck = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== this.WebSocketImpl.OPEN) return;
      if (Date.now() - this.lastHeartbeatAck > this.heartbeatIntervalMs * 3) {
        this.fail(new Error('QQ 官方 Gateway 心跳超时'));
        this.ws.terminate();
        return;
      }
      this.sendOp(1, this.lastSeq);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  handleFrame(data) {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.op === 10) {
      this.heartbeatIntervalMs = Math.max(2000, Number(frame.d?.heartbeat_interval) || 30000);
      this.startHeartbeat();
      if (this.sessionId && this.canResume) this.sendOp(6, {token: `QQBot ${this.connectionToken}`, session_id: this.sessionId, seq: this.lastSeq});
      else this.sendOp(2, {token: `QQBot ${this.connectionToken}`, intents: this.intents, shard: [0, 1]});
      return;
    }
    if (frame.op === 11) { this.lastHeartbeatAck = Date.now(); return; }
    if (frame.op === 7) { this.ws?.terminate(); return; }
    if (frame.op === 9) { this.canResume = false; this.sessionId = ''; this.ws?.terminate(); return; }
    if (frame.op !== 0) return;
    if (Number.isInteger(frame.s) && frame.s > 0) this.lastSeq = frame.s;
    if (frame.t === 'READY') {
      this.sessionId = String(frame.d?.session_id || '');
      this.canResume = true;
      this.attempt = 0;
      this.status = {...this.status, state: 'connected', connected: true, botName: String(frame.d?.user?.username || this.appId), lastError: ''};
      this.emit('status', structuredClone(this.status));
      return;
    }
    if (frame.t === 'RESUMED') {
      this.status = {...this.status, state: 'connected', connected: true, lastError: ''};
      this.emit('status', structuredClone(this.status));
      return;
    }
    const event = normalizeEvent(frame.t, frame.d, this.appId);
    if (event) this.emit('event', event);
  }

  handleClose(code) {
    this.stopHeartbeat();
    this.ws = null;
    this.status = {...this.status, state: this.closed ? 'stopped' : 'disconnected', connected: false};
    if (code === 4004) { this.accessToken = ''; this.tokenExpiresAt = 0; this.canResume = false; }
    if ([9001, 9005].includes(Number(code))) { this.sessionId = ''; this.canResume = false; }
    this.emit('status', structuredClone(this.status));
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(MAX_RECONNECT_MS, 3000 * 2 ** Math.min(this.attempt++, 6));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
    this.retryTimer.unref?.();
  }

  fail(error) {
    const message = error.message; // Only locally defined diagnostics reach fail().
    this.status = {...this.status, state: 'disconnected', lastError: message, connected: false};
    this.log('warn', 'QQ 官方机器人：' + message);
    this.emit('status', structuredClone(this.status));
  }

  async sendText(target, text, reply = null, maxChars = 4500) {
    const chunks = splitText(text, Math.min(MAX_TEXT_BYTES, Math.max(1, Number(maxChars) || 4500)));
    if (reply?.messageId && chunks.length > MAX_PASSIVE_CHUNKS) throw new Error('QQ 官方单条入站消息最多被动回复 5 个分块，请缩短回复');
    const path = target.kind === 'group' ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages` : target.kind === 'channel' ? `/channels/${encodeURIComponent(target.channelId)}/messages` : `/v2/users/${encodeURIComponent(target.openid)}/messages`;
    let sequence = Math.max(1, Number(reply?.messageSeq) || 0);
    const key = String(reply?.messageId || target.kind + ':' + (target.openid || target.groupOpenid || target.channelId));
    sequence = Math.max(sequence + 1, (this.replySequences.get(key) || 0) + 1);
    let lastId = null;
    const {signal} = this.lifetime;
    for (const chunk of chunks) {
      signal.throwIfAborted();
      const body = {msg_type: 0, content: chunk};
      if (reply?.messageId) { body.msg_id = reply.messageId; if (target.kind === 'group') body.msg_seq = sequence++; }
      const value = await this.request('POST', path, body);
      if (value?.id != null) lastId = String(value.id);
    }
    this.replySequences.set(key, sequence);
    if (this.replySequences.size > 1000) this.replySequences.delete(this.replySequences.keys().next().value);
    return lastId;
  }
}

export {normalizeEvent, splitText};
