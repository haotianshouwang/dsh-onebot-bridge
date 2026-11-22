import {DEFAULT_API_BASE_URL, DEFAULT_INTENTS, DEFAULT_SANDBOX_API_BASE_URL, QQOfficialClient} from './client.js';
import {QQQrConnector, QR_STATES} from './qr-connector.js';
import QRCode from 'qrcode';
import {once} from 'node:events';
import {officialCredentials} from './credentials.js';
export {APP_ID_REF, CLIENT_SECRET_REF} from './credentials.js';

export const manifest = {
  id: 'qq-official-bot',
  name: 'QQ 官方机器人',
  version: '1.0.0',
  apiVersion: 2,
  type: 'native-source',
  entry: 'src/builtins/qq-official/index.js',
  bundled: true,
  description: '通过腾讯 QQ 官方开放平台二维码绑定或 AppID/AppSecret 接入官方机器人，支持群聊、单聊与频道 @ 消息。',
  dependencies: {framework: '>=0.13.0'},
  configVersion: 1,
  capabilities: ['actions', 'storage'],
  configSchema: {
    apiBaseUrl: {type: 'string', title: 'QQ 官方 API 地址', default: DEFAULT_API_BASE_URL, enum: [DEFAULT_API_BASE_URL, DEFAULT_SANDBOX_API_BASE_URL], maxLength: 200},
    sandbox: {type: 'boolean', title: '使用沙箱 API', default: false},
    autoConnect: {type: 'boolean', title: '启用后自动连接', default: true},
    autoReply: {type: 'boolean', title: '收到消息后交给 DSH AI 回复', default: true},
    replyMaxChars: {type: 'number', title: '单条回复字符上限', default: 4500, min: 100, max: 12000, integer: true},
    intents: {type: 'number', title: 'Gateway intents 位掩码', default: DEFAULT_INTENTS, min: 1, max: 2147483647, integer: true},
    allowedUsers: {type: 'string[]', title: '允许自动回复的用户 OpenID', default: [], maxItems: 100, maxLength: 200},
    allowedGroups: {type: 'string[]', title: '允许自动回复的群 OpenID 或频道键', default: [], maxItems: 100, maxLength: 200}
  },
  settings: {
    title: 'QQ 官方机器人',
    description: 'QQ 官方机器人支持腾讯官方二维码绑定和手动 AppID/AppSecret 配置；凭据加密保存，设备密钥由 DSH credentials 管理。',
    sections: [{title: '连接与回复', fields: ['apiBaseUrl', 'sandbox', 'autoConnect', 'autoReply', 'replyMaxChars', 'intents', 'allowedUsers', 'allowedGroups']}]
  }
};

function configuredStatus(appId, secret) {
  return Boolean(appId && secret);
}

export function selectQrCredentials(credentialsList) {
  if (!Array.isArray(credentialsList)) throw new Error('QQ 二维码 SDK 返回的凭据格式无效');
  for (const item of credentialsList) {
    const appId = String(item?.appId || '').trim();
    const clientSecret = String(item?.appSecret || '').trim();
    if (appId && clientSecret) return {appId, clientSecret};
  }
  throw new Error('QQ 二维码 SDK 未返回有效 AppID/AppSecret');
}

export function activateQQOfficial(framework, {credentials, log = () => {}, generateReply, onReplySent, repliesAllowed = () => true, generation = () => 0, fetchImpl = globalThis.fetch, WebSocketImpl, qrSdkLoader} = {}) {
  if (!credentials?.resolve || !credentials?.set || !credentials?.unset) throw new Error('QQ 官方机器人缺少 DSH credentials 服务');
  const api = framework.registerTrustedPackage(manifest);
  const client = new QQOfficialClient({fetchImpl, WebSocketImpl, log});
  let processing = 0, disposed = false, manualStop = false, previouslyActive = false;
  let lastReplyError = '', qrPresentation = null;
  let lifetime = new AbortController(), syncJob = null, credentialTail = Promise.resolve();
  const active = () => !disposed && api.active();
  const requireActive = () => { if (!active()) api.reject('请先在插件设置中启用 QQ 官方机器人'); };
  const stopTransport = () => {
    qrPresentation = null; lastReplyError = '';
    lifetime.abort(); lifetime = new AbortController();
    void client.stop(); // stop synchronously invalidates pending token, Gateway and send calls.
    client.configure({appId: '', clientSecret: ''});
  };
  const {read: credentialsForClient, write: savePair} = officialCredentials(api.storage, credentials);
  const qrConnector = new QQQrConnector({
    sdkLoader: qrSdkLoader,
    onChange: status => {
      void (async () => {
        let qrImage = '';
        if (status.qrUrl) {
          try { qrImage = await QRCode.toDataURL(status.qrUrl, {errorCorrectionLevel: 'M', margin: 2, width: 320}); } catch {}
        }
        const latest = qrConnector.snapshot();
        if (!active() || latest.state !== status.state || latest.qrUrl !== status.qrUrl || latest.updatedAt !== status.updatedAt) return;
        qrPresentation = {qrUrl: status.qrUrl, qrImage};
      })().catch(() => {});
    },
    onSuccess: credentialsList => completeQrLogin(credentialsList, lifetime.signal)
  });

  async function configureClient(signal) {
    const saved = await credentialsForClient();
    signal.throwIfAborted(); requireActive();
    const config = api.getConfig();
    client.configure({...saved, apiBase: config.sandbox ? DEFAULT_SANDBOX_API_BASE_URL : config.apiBaseUrl, intents: config.intents});
    return configuredStatus(saved.appId, saved.clientSecret);
  }

  // Pair writes from owner controls and QR callbacks cannot interleave.
  function writeCredentials(pair, signal) {
    const job = credentialTail.then(async () => {
      signal.throwIfAborted(); requireActive();
      try { await savePair(pair, signal); }
      catch { throw new Error('无法保存官方机器人凭据，请检查存储和设备密钥'); }
      signal.throwIfAborted();
    });
    credentialTail = job.catch(() => {});
    return job;
  }

  async function completeQrLogin(credentialsList, signal) {
    await writeCredentials(selectQrCredentials(credentialsList), signal);
    signal.throwIfAborted();
    stopTransport(); manualStop = false;
    const run = lifetime.signal;
    await connect();
    const wait = AbortSignal.any([run, AbortSignal.timeout(30000)]);
    while (!client.connected) {
      const [status] = await once(client, 'status', {signal: wait});
      if (status.lastError) throw new Error('QQ 官方 Gateway 未就绪');
    }
  }

  const mayReply = event => {
    if (!active() || !repliesAllowed() || !client.connected || !event?.text || !event.messageId || !event.peer || !event.actor || api.getConfig().autoReply !== true) return false;
    const config = api.getConfig();
    const allowedUsers = Array.isArray(config.allowedUsers) ? config.allowedUsers : [];
    const allowedGroups = Array.isArray(config.allowedGroups) ? config.allowedGroups : [];
    if (event.kind === 'private' && allowedUsers.length && !allowedUsers.includes(event.actor)) return false;
    if (event.kind === 'group' && allowedGroups.length && !allowedGroups.includes(event.peer)) return false;
    if (event.kind === 'channel' && (!event.guildId || !event.channelId || (allowedGroups.length && !allowedGroups.includes(event.peer)))) return false;
    return true;
  };
  const handleEvent = async event => {
    if (!mayReply(event) || typeof generateReply !== 'function' || processing >= 4) return;
    const signal = lifetime.signal, ticket = generation();
    processing++;
    try {
      const reply = await generateReply({text: event.text, signal});
      if (signal.aborted || ticket !== generation() || !mayReply(event) || !reply?.trim()) return;
      const text = [...reply.trim()].slice(0, api.getConfig().replyMaxChars).join('');
      const result = await client.sendText(event.target, text, event.reply, api.getConfig().replyMaxChars);
      lastReplyError = '';
      await onReplySent?.({messageId: result});
    } catch {
      if (!signal.aborted && active()) {
        lastReplyError = '处理消息失败，请检查模型与 Gateway 状态';
        log('warn', 'QQ 官方消息处理失败');
      }
    } finally { processing--; }
  };
  client.on('event', event => { void handleEvent(event).catch(() => {}); });

  async function connect() {
    requireActive();
    if (!await configureClient(lifetime.signal)) api.reject('请先在 DSH 插件设置保存 QQ 官方机器人凭据');
    manualStop = false; client.start();
    return {ok: true, status: client.connected ? 'connected' : 'connecting'};
  }
  async function disconnect() {
    manualStop = true; qrConnector.stop(); stopTransport();
    return {ok: true, status: 'stopped'};
  }

  // Credential entry and QR presentations belong to the authenticated DSH owner UI,
  // not chat history, a model tool result, or the independent web action whitelist.
  async function ownerControl({op, appId, clientSecret}) {
    requireActive();
    if (op === 'credentials') {
      if (typeof appId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(appId) || typeof clientSecret !== 'string' || !clientSecret.trim() || clientSecret.length > 256) api.reject('请填写有效的 AppID 和 AppSecret');
      await disconnect(); await writeCredentials({appId, clientSecret}, lifetime.signal);
      manualStop = false; await sync();
      return {configured: true};
    }
    if (op === 'clear') {
      await disconnect(); await writeCredentials(null, lifetime.signal);
      return {ok: true};
    }
    if (op === 'connect') return connect();
    if (op === 'disconnect') return disconnect();
    if (op === 'qr-start') {
      if (qrConnector.running) api.reject('已有二维码会话，请刷新状态或取消绑定');
      await disconnect(); try { await qrConnector.start(); } catch { api.reject(qrConnector.snapshot().error || '二维码绑定失败'); }
    }
    else if (op === 'qr-cancel') { qrConnector.cancel(); manualStop = true; stopTransport(); }
    else if (op !== 'qr-status') api.reject('不支持的官方机器人设置操作');
    const qr = qrConnector.snapshot();
    return {state: qr.state, running: qr.running, error: qr.error, qrImage: qr.qrUrl && qr.qrUrl === qrPresentation?.qrUrl ? qrPresentation.qrImage : ''};
  }

  const empty = {type: 'object', properties: {}, additionalProperties: false};
  for (const name of ['set-credentials','qr-login-start','qr-login-status','qr-login-cancel']) {
    api.action(name, {description: '请在 DSH 主人设置页管理凭据或二维码，不要在聊天中输入密钥。', ownerOnly: true, parameters: empty}, () => api.reject('请使用 DSH 设置 → QQ 框架 → 插件 → QQ 官方机器人'));
  }
  api.action('connect', {description: '仅主人：连接 QQ 官方 Gateway。', ownerOnly: true, mutating: true, parameters: empty}, connect);
  api.action('disconnect', {description: '仅主人：断开 QQ 官方 Gateway。', ownerOnly: true, mutating: true, parameters: empty}, disconnect);
  api.action('status', {description: '仅主人：查看 QQ 官方机器人连接状态，不返回凭据。', ownerOnly: true, timeoutMs: 5000, parameters: {type: 'object', properties: {}, additionalProperties: false}}, async () => {
    const saved = await credentialsForClient();
    return {ok: true, state: client.status.state, configured: configuredStatus(saved.appId, saved.clientSecret), connected: client.connected, processing};
  });
  api.action('send', {description: '仅主人：向官方机器人指定会话发送文字。官方平台可能限制主动消息；优先在收到消息后使用被动回复。', ownerOnly: true, mutating: true, timeoutMs: 20000, parameters: {type: 'object', properties: {kind: {type: 'string', enum: ['private', 'group', 'channel']}, openid: {type: 'string', maxLength: 200}, groupOpenid: {type: 'string', maxLength: 200}, channelId: {type: 'string', maxLength: 200}, text: {type: 'string', minLength: 1, maxLength: 12000}}, required: ['kind', 'text'], additionalProperties: false}}, async args => {
    if (!client.connected) api.reject('QQ 官方机器人尚未连接');
    const target = args.kind === 'private' ? {kind: 'private', openid: String(args.openid || '')} : args.kind === 'group' ? {kind: 'group', groupOpenid: String(args.groupOpenid || '')} : {kind: 'channel', channelId: String(args.channelId || '')};
    if (!target.openid && !target.groupOpenid && !target.channelId) api.reject('请填写目标会话 ID');
    const value = await client.sendText(target, args.text, null, api.getConfig().replyMaxChars);
    return {ok: true, messageId: value};
  });

  api.settings(manifest.settings, async () => {
    let saved, credentialError = '';
    try { saved = await credentialsForClient(); }
    catch { credentialError = '凭据不可读，请检查设备密钥或清除后重新绑定'; }
    const configured = configuredStatus(saved?.appId, saved?.clientSecret);
    const rows = [
      {key: '凭据', value: credentialError ? '不可读取' : configured ? '已配置' : '未配置'},
      {key: '连接状态', value: ({stopped:'未连接',connecting:'连接中',connected:'已连接',disconnected:'已断开'})[client.status.state] || '未连接'},
      {key: 'Bot 名称', value: client.connected && client.status.botName || '—'},
      {key: 'Gateway', value: !client.closed && client.status.gateway || '—'},
      {key: '二维码绑定', value: qrConnector.snapshot().state || QR_STATES.IDLE},
      {key: '处理中消息', value: String(processing)}
    ];
    const error = credentialError || client.status.lastError || lastReplyError;
    if (error) rows.push({key: '最近错误', value: error});
    return {stats: [{label: '凭据已配置', value: configured ? 1 : 0}, {label: '已连接', value: client.connected ? 1 : 0}, {label: '二维码会话', value: qrConnector.running ? 1 : 0}], columns: [{key: 'key', label: '项目'}, {key: 'value', label: '当前值'}], rows, total: rows.length, offset: 0, hasMore: false};
  });

  function sync() {
    if (!active()) {
      if (previouslyActive) { qrConnector.stop(); stopTransport(); }
      previouslyActive = false; manualStop = false;
      return Promise.resolve();
    }
    previouslyActive = true;
    if (manualStop || !api.getConfig().autoConnect || !client.closed) return Promise.resolve();
    const signal = lifetime.signal;
    if (syncJob?.signal === signal) return syncJob.work;
    const work = configureClient(signal).then(configured => {
      if (configured && !signal.aborted && active() && !manualStop && api.getConfig().autoConnect) client.start();
    }).catch(() => { if (!signal.aborted) log('warn','QQ 官方机器人无法读取连接配置'); })
      .finally(() => { if (syncJob?.signal === signal) syncJob = null; });
    syncJob = {signal, work}; return work;
  }
  const syncTimer = setInterval(sync, 5000); // Also observes SDK quarantine/uninstall while the host is running.
  syncTimer.unref?.();
  void sync();
  return {api, ownerControl, sync,
    reconfigure() { qrConnector.stop(); stopTransport(); manualStop = false; return sync(); },
    stop() { disposed = true; clearInterval(syncTimer); qrConnector.stop(); stopTransport(); client.removeAllListeners(); }
  };
}
