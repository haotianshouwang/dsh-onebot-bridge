import {DEFAULT_API_BASE_URL, DEFAULT_INTENTS, QQOfficialClient} from './client.js';
import {QQQrConnector, QR_STATES} from './qr-connector.js';
import QRCode from 'qrcode';

const APP_ID_REF = 'DSH_QQ_OFFICIAL_APP_ID';
const CLIENT_SECRET_REF = 'DSH_QQ_OFFICIAL_CLIENT_SECRET';

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
    apiBaseUrl: {type: 'string', title: 'QQ 官方 API 地址', default: DEFAULT_API_BASE_URL, maxLength: 200},
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
    description: 'QQ 官方机器人支持腾讯官方二维码绑定和手动 AppID/AppSecret 配置；凭据只保存在 DSH credentials。',
    sections: [{title: '连接与回复', fields: ['apiBaseUrl', 'sandbox', 'autoConnect', 'autoReply', 'replyMaxChars', 'intents', 'allowedUsers', 'allowedGroups']}]
  }
};

function credentialValue(credentials, key) {
  const fallback = key === APP_ID_REF ? (process.env.DSH_QQ_OFFICIAL_APP_ID || process.env.QQBOT_APP_ID || '') : (process.env.DSH_QQ_OFFICIAL_CLIENT_SECRET || process.env.QQBOT_APP_SECRET || '');
  return credentials.resolve(key).then(result => String(result?.value || fallback));
}

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

export function activateQQOfficial(framework, {credentials, log = () => {}, generateReply, onReplySent, fetchImpl = globalThis.fetch, WebSocketImpl, qrSdkLoader} = {}) {
  if (!credentials?.resolve || !credentials?.set || !credentials?.unset) throw new Error('QQ 官方机器人缺少 DSH credentials 服务');
  const api = framework.registerTrustedPackage(manifest);
  const client = new QQOfficialClient({fetchImpl, WebSocketImpl, log});
  let processing = 0;
  let qrPresentation = {state: QR_STATES.IDLE, qrUrl: '', qrImage: '', error: '', startedAt: 0, updatedAt: 0, running: false};

  const state = () => {
    const value = api.storage.get();
    return value && typeof value === 'object' ? value : {};
  };
  const updateState = updater => api.storage.update(data => ({...data, ...updater(data)}));
  const credentialsForClient = async () => ({appId: await credentialValue(credentials, APP_ID_REF), clientSecret: await credentialValue(credentials, CLIENT_SECRET_REF)});
  const persistedQrStatus = status => ({state: status.state, error: status.error || '', startedAt: status.startedAt || 0, updatedAt: status.updatedAt || 0, running: status.running === true});
  const qrConnector = new QQQrConnector({
    sdkLoader: qrSdkLoader,
    onChange: status => {
      void (async () => {
        let qrImage = '';
        if (status.qrUrl) {
          try { qrImage = await QRCode.toDataURL(status.qrUrl, {errorCorrectionLevel: 'M', margin: 2, width: 320}); } catch {}
        }
        if (qrConnector.snapshot().updatedAt !== status.updatedAt) return;
        qrPresentation = {...status, qrImage};
        await updateState(() => ({qrLogin: persistedQrStatus(status)}));
      })().catch(() => {});
    },
    onSuccess: credentialsList => completeQrLogin(credentialsList)
  });

  const configureClient = async () => {
    const saved = await credentialsForClient();
    const config = api.getConfig();
    const apiBaseUrl = config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : config.apiBaseUrl;
    client.configure({appId: saved.appId, clientSecret: saved.clientSecret, apiBase: apiBaseUrl, intents: config.intents});
    return saved;
  };

  const waitForReady = (timeoutMs = 30000) => {
    if (client.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        client.off('status', onStatusReady);
      };
      const onStatusReady = status => {
        if (status.connected === true) {
          cleanup();
          resolve();
          return;
        }
        if (status.lastError && status.state === 'disconnected') {
          cleanup();
          reject(new Error(status.lastError));
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('QQ 官方 Gateway 等待 READY 超时'));
      }, timeoutMs);
      client.on('status', onStatusReady);
    });
  };

  async function completeQrLogin(credentialsList) {
    await updateState(() => ({qrLogin: {...qrConnector.snapshot(), state: QR_STATES.AUTHENTICATED}, lastStatus: 'authorizing', lastError: ''}));
    const selected = selectQrCredentials(credentialsList);
    await credentials.set(APP_ID_REF, selected.appId);
    await credentials.set(CLIENT_SECRET_REF, selected.clientSecret);
    await configureClient();
    client.start();
    await updateState(() => ({lastStatus: 'connecting', lastError: ''}));
    await waitForReady();
    await updateState(() => ({lastStatus: 'online', lastError: ''}));
  }

  const onStatus = status => {
    void updateState(() => ({
      lastStatus: status.connected ? 'online' : status.state || 'offline',
      botName: status.botName || state().botName || '',
      gateway: status.gateway || state().gateway || '',
      lastError: status.lastError || ''
    })).catch(() => {});
  };
  client.on('status', onStatus);

  const handleEvent = async event => {
    if (!api.active() || api.getConfig().autoReply !== true || !event?.text || typeof generateReply !== 'function') return;
    const config = api.getConfig();
    const allowedUsers = Array.isArray(config.allowedUsers) ? config.allowedUsers : [];
    const allowedGroups = Array.isArray(config.allowedGroups) ? config.allowedGroups : [];
    if (event.kind === 'private' && allowedUsers.length && !allowedUsers.includes(event.actor)) return;
    if (event.kind === 'group' && allowedGroups.length && !allowedGroups.includes(event.peer)) return;
    if (event.kind === 'channel' && allowedGroups.length && !allowedGroups.includes(`${event.guildId}-${event.channelId}`)) return;
    processing += 1;
    try {
      const reply = await generateReply({text: event.text, event});
      if (reply) {
        const result = await client.sendText(event.target, String(reply).trim(), event.reply, config.replyMaxChars);
        await onReplySent?.({event, reply: String(reply).trim(), result});
      }
      await updateState(() => ({lastStatus: 'online', lastError: ''}));
    } catch (error) {
      const saved = await credentialsForClient();
      const detail = String(error?.message || error).replaceAll(saved.clientSecret || '\u0000', '[凭据已隐藏]').replace(/\s+/g, ' ').slice(0, 240);
      await updateState(() => ({lastStatus: 'reply_error', lastError: detail}));
      log('warn', 'QQ 官方消息处理失败');
    } finally {
      processing = Math.max(0, processing - 1);
    }
  };
  client.on('event', event => { void handleEvent(event); });

  const connect = async () => {
    const saved = await configureClient();
    if (!configuredStatus(saved.appId, saved.clientSecret)) throw new Error('请先配置 QQ 官方机器人 AppID 和 AppSecret');
    client.start();
    await updateState(() => ({lastStatus: 'connecting', lastError: ''}));
    return {ok: true, status: 'connecting'};
  };

  const disconnect = async () => {
    await client.stop();
    await updateState(() => ({lastStatus: 'stopped', lastError: ''}));
    return {ok: true, status: 'stopped'};
  };

  api.action('set-credentials', {description: '仅主人：保存或清除 QQ 官方机器人 AppID/AppSecret。密钥不会写入插件配置或日志。', ownerOnly: true, mutating: true, timeoutMs: 10000, parameters: {type: 'object', properties: {appId: {type: 'string', minLength: 1, maxLength: 128}, clientSecret: {type: 'string', minLength: 1, maxLength: 256}, clear: {type: 'boolean'}}, additionalProperties: false}}, async args => {
    qrConnector.cancel();
    if (args.clear === true) {
      await credentials.unset(APP_ID_REF);
      await credentials.unset(CLIENT_SECRET_REF);
      await disconnect();
      return {ok: true, configured: false};
    }
    if (!args.appId || !args.clientSecret) api.reject('保存凭据时必须同时填写 AppID 和 AppSecret');
    await credentials.set(APP_ID_REF, String(args.appId));
    await credentials.set(CLIENT_SECRET_REF, String(args.clientSecret));
    await updateState(() => ({lastStatus: 'configured', lastError: ''}));
    return {ok: true, configured: true};
  });

  api.action('connect', {description: '仅主人：连接 QQ 官方机器人 Gateway。', ownerOnly: true, mutating: true, timeoutMs: 20000, parameters: {type: 'object', properties: {}, additionalProperties: false}}, async () => connect());
  api.action('disconnect', {description: '仅主人：断开 QQ 官方机器人 Gateway。', ownerOnly: true, mutating: true, timeoutMs: 10000, parameters: {type: 'object', properties: {}, additionalProperties: false}}, async () => disconnect());
  api.action('qr-login-start', {description: '仅主人：创建 QQ 官方机器人官方二维码绑定会话。', ownerOnly: true, mutating: true, timeoutMs: 20000, parameters: {type: 'object', properties: {source: {type: 'string', maxLength: 64}}, additionalProperties: false}}, async args => {
    const result = await qrConnector.start({source: String(args.source || 'dsh-onebot-bridge')});
    await updateState(() => ({qrLogin: persistedQrStatus(result)}));
    return {ok: true, ...result};
  });
  api.action('qr-login-status', {description: '仅主人：查看 QQ 官方机器人二维码绑定会话状态。', ownerOnly: true, timeoutMs: 5000, parameters: {type: 'object', properties: {}, additionalProperties: false}}, async () => ({ok: true, ...qrPresentation}));
  api.action('qr-login-cancel', {description: '仅主人：取消 QQ 官方机器人二维码绑定会话。', ownerOnly: true, mutating: true, timeoutMs: 5000, parameters: {type: 'object', properties: {}, additionalProperties: false}}, async () => {
    const result = qrConnector.cancel();
    qrPresentation = {...result, qrImage: ''};
    await updateState(() => ({qrLogin: persistedQrStatus(result)}));
    return {ok: true, ...result};
  });
  api.action('status', {description: '仅主人：查看 QQ 官方机器人连接状态，不返回凭据。', ownerOnly: true, timeoutMs: 5000, parameters: {type: 'object', properties: {}, additionalProperties: false}}, async () => {
    const saved = await credentialsForClient();
    return {ok: true, ...state(), configured: configuredStatus(saved.appId, saved.clientSecret), connected: client.connected, processing};
  });
  api.action('send', {description: '仅主人：向官方机器人指定会话发送文字。官方平台可能限制主动消息；优先在收到消息后使用被动回复。', ownerOnly: true, mutating: true, timeoutMs: 20000, parameters: {type: 'object', properties: {kind: {type: 'string', enum: ['private', 'group', 'channel']}, openid: {type: 'string', maxLength: 200}, groupOpenid: {type: 'string', maxLength: 200}, channelId: {type: 'string', maxLength: 200}, text: {type: 'string', minLength: 1, maxLength: 12000}}, required: ['kind', 'text'], additionalProperties: false}}, async args => {
    if (!client.connected) api.reject('QQ 官方机器人尚未连接');
    const target = args.kind === 'private' ? {kind: 'private', openid: String(args.openid || '')} : args.kind === 'group' ? {kind: 'group', groupOpenid: String(args.groupOpenid || '')} : {kind: 'channel', channelId: String(args.channelId || '')};
    if (!target.openid && !target.groupOpenid && !target.channelId) api.reject('请填写目标会话 ID');
    const value = await client.sendText(target, args.text, null, api.getConfig().replyMaxChars);
    return {ok: true, messageId: value};
  });

  api.settings(manifest.settings, async () => {
    const saved = await credentialsForClient();
    const current = state();
    const rows = [
      {key: '凭据', value: configuredStatus(saved.appId, saved.clientSecret) ? '已配置（DSH credentials）' : '未配置'},
      {key: '连接状态', value: current.lastStatus || '未连接'},
      {key: 'Bot 名称', value: current.botName || '—'},
      {key: 'Gateway', value: current.gateway || '—'},
      {key: '二维码绑定', value: qrConnector.snapshot().state || QR_STATES.IDLE},
      {key: '处理中消息', value: String(processing)}
    ];
    if (current.lastError) rows.push({key: '最近错误', value: String(current.lastError).slice(0, 240)});
    return {stats: [{label: '凭据已配置', value: configuredStatus(saved.appId, saved.clientSecret) ? 1 : 0}, {label: '已连接', value: client.connected ? 1 : 0}, {label: '二维码会话', value: qrConnector.running ? 1 : 0}], columns: [{key: 'key', label: '项目'}, {key: 'value', label: '当前值'}], rows, total: rows.length, offset: 0, hasMore: false};
  });

  const syncTimer = setInterval(() => {
    if (!api.active()) {
      clearInterval(syncTimer);
      qrConnector.stop();
      void client.stop();
      return;
    }
    const config = api.getConfig();
    if (config.autoConnect !== true || !configuredStatus(client.appId, client.clientSecret)) {
      void configureClient().then(saved => {
        if (!configuredStatus(saved.appId, saved.clientSecret) && client.connected) return client.stop();
        return undefined;
      }).catch(error => log('warn', 'QQ 官方机器人配置读取失败：' + String(error?.message || error).slice(0, 160)));
      return;
    }
    if (!client.connected && !client.connecting && !client.ws) void connect().catch(error => log('warn', 'QQ 官方机器人连接失败：' + String(error?.message || error).slice(0, 160)));
  }, 1500);
  syncTimer.unref?.();
  return api;
}

export {APP_ID_REF, CLIENT_SECRET_REF};
