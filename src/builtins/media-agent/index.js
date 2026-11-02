import {MEDIA_PLATFORMS, migrateMediaState} from './domain.js';
import {createMediaPlatformRegistry} from './platforms.js';
import {createHash, randomUUID} from 'node:crypto';

export const manifest = {
  id: 'qq-media-agent',
  name: '媒体平台助手',
  version: '0.3.0',
  apiVersion: 2,
  type: 'native-source',
  entry: 'src/builtins/media-agent/index.js',
  bundled: true,
  description: '统一接入 B 站和抖音的公开查询、观看、日报与受控外发能力。',
  dependencies: {framework: '>=0.13.0'},
  configVersion: 2,
  capabilities: ['actions', 'storage'],
  configSchema: {
    bilibiliEnabled: {type: 'boolean', title: '启用 B 站适配', default: false},
    douyinEnabled: {type: 'boolean', title: '启用抖音适配', default: false},
    browserEnabled: {type: 'boolean', title: '启用专用 Edge 浏览器', default: false},
    autoWatchEnabled: {type: 'boolean', title: '允许自动观看', default: false},
    outboundEnabled: {type: 'boolean', title: '允许评论、私信或分享', default: false},
    platformMessageEnabled: {type: 'boolean', title: '允许平台私信', default: false},
    messageContacts: {type: 'string[]', title: '平台私信联系人白名单', description: '每行填写 platform:contactId，例如 bilibili:123456 或 douyin:MS4x；只允许向白名单联系人发送', default: [], maxItems: 100},
    dailyWatchMinutes: {type: 'number', title: '每日观看上限（分钟）', default: 10, min: 0, max: 1440, integer: true},
    reportRetentionDays: {type: 'number', title: '运行记录保留天数', default: 30, min: 1, max: 3650, integer: true},
    runHistoryLimit: {type: 'number', title: '最多保留运行记录', default: 200, min: 1, max: 1000, integer: true}
  },
  storagePolicy: {
    collection: 'runs',
    timestamp: 'createdAt',
    daysField: 'reportRetentionDays',
    limitField: 'runHistoryLimit'
  },
  settings: {
    title: '媒体平台助手',
    description: 'B 站和抖音共用权限、额度和任务生命周期；公开查询与受控专用 Edge 观看均使用真实宿主能力。',
    sections: [
      {title: '平台', fields: ['bilibiliEnabled', 'douyinEnabled', 'browserEnabled']},
      {title: '观看策略', fields: ['autoWatchEnabled', 'dailyWatchMinutes']},
      {title: '外发权限', fields: ['outboundEnabled', 'platformMessageEnabled', 'messageContacts']},
      {title: '记录', fields: ['reportRetentionDays', 'runHistoryLimit']}
    ]
  },
  configMigrations: [{to: 2, defaults: {platformMessageEnabled: false, messageContacts: []}}]
};

export function activateMediaAgent(framework, {read, browser} = {}) {
  const api = framework.registerTrustedPackage(manifest);
  const platforms = createMediaPlatformRegistry({read, browser});

  api.action('status', {
    description: '仅主人：读取 B 站和抖音的真实适配器状态、策略和已确认运行记录。',
    ownerOnly: true,
    timeoutMs: 8000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  }, async () => {
    const state = migrateMediaState(api.storage.get());
    return {
      ok: true,
      config: api.getConfig(),
      platforms: await platforms.status(),
      platformRecords: state.platformRecords,
      runs: state.runs.slice(-20)
    };
  });

  api.action('start', {
    description: '仅主人：在已启用的专用 Edge 中观看一个官方视频，并按真实播放进度写入日报。',
    ownerOnly: true,
    mutating: true,
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}, id: {type: 'string', minLength: 3, maxLength: 128}, url: {type: 'string', maxLength: 2000}, seconds: {type: 'integer', minimum: 1, maximum: 1800}},
      required: ['platform'],
      additionalProperties: false
    }
  }, async ({platform, id, url, seconds = 30}, _context, signal) => {
    const config = api.getConfig();
    if (!config[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (config.browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (config.autoWatchEnabled !== true) api.reject('自动观看未启用');
    if (!browser) api.reject('宿主没有提供专用浏览器服务');
    if (!id && !url) api.reject('需要视频 ID 或官方页面地址');
    const today = new Date().toISOString().slice(0, 10);
    const used = migrateMediaState(api.storage.get()).runs.filter(row => row.platform === platform && String(row.createdAt || '').slice(0, 10) === today).reduce((sum, row) => sum + (Number(row.watchSeconds) || 0), 0);
    const limit = Math.max(0, Number(config.dailyWatchMinutes) || 0) * 60;
    if (limit && used >= limit) api.reject('今日观看额度已用完');
    const remaining = limit ? Math.max(1, limit - used) : seconds;
    const boundedSeconds = Math.min(seconds, remaining);
    if (signal.aborted) throw Object.assign(new Error('任务已取消'), {code: 'PLUGIN_CANCELLED'});
    const adapter = platforms.get(platform);
    if (!adapter) api.reject('平台参数无效');
    const result = await adapter.start({config, id, url, seconds: boundedSeconds, signal});
    const now = new Date().toISOString();
    await api.storage.update(previous => {
      const state = migrateMediaState(previous);
      state.runs.push({platform, state: 'confirmed', watchSeconds: Number(result?.elapsedSeconds) || boundedSeconds, createdAt: now, title: String(result?.snapshot?.title || '').slice(0, 240)});
      state.platformRecords[platform].lastSuccessAt = now;
      return state;
    });
    return result;
  });

  api.action('browser-status', {
    description: '仅主人：读取专用 Edge 服务状态，不返回 Cookie、LocalStorage 或凭据。', ownerOnly: true, timeoutMs: 8000,
    parameters: {type: 'object', properties: {}, additionalProperties: false}
  }, async () => ({ok: true, enabled: api.getConfig().browserEnabled === true, service: browser ? await browser.status() : {state: 'unavailable', connected: false}}));

  api.action('login-status', {
    description: '仅主人：观察当前官方页面是否显示登录或验证码要求；不读取 Cookie、Token 或账号资料。', ownerOnly: true, timeoutMs: 12000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}}, required: ['platform'], additionalProperties: false}
  }, async ({platform}) => {
    if (!api.getConfig()[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (api.getConfig().browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    const adapter = platforms.get(platform); if (!adapter?.current) api.reject(`${platformLabel(platform)}没有登录状态读取能力`);
    const page = await adapter.current();
    return {platform, authenticated: page.loginRequired !== true, confidence: 'page-observation', loginRequired: page.loginRequired === true, url: page.url, observedAt: page.observedAt};
  });

  api.action('login', {
    description: '仅主人：打开平台官方首页供人工登录或扫码；插件不读取、不保存、不回显登录资料。', ownerOnly: true, timeoutMs: 20000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}}, required: ['platform'], additionalProperties: false}
  }, async ({platform}) => {
    if (!api.getConfig()[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (api.getConfig().browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (!browser) api.reject('宿主没有提供专用浏览器服务');
    const adapter = platforms.get(platform); if (!adapter?.open) api.reject(`${platformLabel(platform)}没有登录页面能力`);
    const url = platform === 'bilibili' ? 'https://www.bilibili.com/' : 'https://www.douyin.com/';
    const page = await adapter.open({url});
    return {platform, manual: true, instruction: '请在专用 Edge 窗口中完成登录或扫码，然后再次调用 login-status；插件不会读取或保存登录资料。', page};
  });

  api.action('report', {
    description: '仅主人：生成基于真实运行记录的今日观看日报。', ownerOnly: true, timeoutMs: 8000,
    parameters: {type: 'object', properties: {date: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'}}, additionalProperties: false}
  }, async ({date} = {}) => {
    const day = date || new Date().toISOString().slice(0, 10);
    const rows = migrateMediaState(api.storage.get()).runs.filter(row => String(row.createdAt || '').slice(0, 10) === day);
    const byPlatform = Object.fromEntries(MEDIA_PLATFORMS.map(platform => {
      const selected = rows.filter(row => row.platform === platform);
      return [platform, {runs: selected.length, watchSeconds: selected.reduce((sum, row) => sum + (Number(row.watchSeconds) || 0), 0), titles: selected.map(row => row.title).filter(Boolean).slice(-10)}];
    }));
    return {ok: true, date: day, totalRuns: rows.length, totalWatchSeconds: rows.reduce((sum, row) => sum + (Number(row.watchSeconds) || 0), 0), byPlatform, generatedAt: new Date().toISOString()};
  });

  api.action('open', {
    description: '仅主人：在专用 Edge 中打开 B 站或抖音官方视频页。', ownerOnly: true, timeoutMs: 20000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}, id: {type: 'string', minLength: 3, maxLength: 128}, url: {type: 'string', maxLength: 2000}}, required: ['platform'], additionalProperties: false}
  }, async ({platform, id, url}) => {
    if (!api.getConfig()[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (api.getConfig().browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (!browser) api.reject('宿主没有提供专用浏览器服务');
    if (!id && !url) api.reject('需要视频 ID 或官方页面地址');
    const adapter = platforms.get(platform); if (!adapter?.open) api.reject(`${platformLabel(platform)}没有浏览器打开能力`);
    return adapter.open({id, url});
  });

  api.action('current', {
    description: '仅主人：读取当前官方页面标题、网址、视频进度和有限正文，不返回登录资料。', ownerOnly: true, timeoutMs: 12000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}}, required: ['platform'], additionalProperties: false}
  }, async ({platform}) => {
    if (!api.getConfig()[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (api.getConfig().browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (!browser) api.reject('宿主没有提供专用浏览器服务');
    const adapter = platforms.get(platform); if (!adapter?.current) api.reject(`${platformLabel(platform)}没有当前页面读取能力`);
    return adapter.current();
  });

  api.action('screenshot', {
    description: '仅主人：获取当前官方页面的有界截图，供人工确认页面状态。', ownerOnly: true, timeoutMs: 15000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}}, required: ['platform'], additionalProperties: false}
  }, async ({platform}) => {
    if (!api.getConfig()[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (api.getConfig().browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (!browser) api.reject('宿主没有提供专用浏览器服务');
    const adapter = platforms.get(platform); if (!adapter?.screenshot) api.reject(`${platformLabel(platform)}没有截图能力`);
    return adapter.screenshot();
  });

  api.action('subtitles', {
    description: '仅主人：读取当前官方页面已经加载的字幕轨道和有限字幕文本，不下载任意文件。', ownerOnly: true, timeoutMs: 15000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}}, required: ['platform'], additionalProperties: false}
  }, async ({platform}) => {
    if (!api.getConfig()[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (api.getConfig().browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (!browser) api.reject('宿主没有提供专用浏览器服务');
    const adapter = platforms.get(platform); if (!adapter?.subtitles) api.reject(`${platformLabel(platform)}当前没有字幕读取能力`);
    return adapter.subtitles();
  });

  api.action('comment', {
    description: '仅主人明确确认后，在当前官方视频页提交一条公开评论。内容只在页面输入框中使用，不写入插件存储；提交结果通常只能确认 submitted。',
    ownerOnly: true, mutating: true, timeoutMs: 25000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}, content: {type: 'string', minLength: 1, maxLength: 300}, confirm: {type: 'boolean'}}, required: ['platform', 'content', 'confirm'], additionalProperties: false}
  }, async ({platform, content, confirm}) => {
    const config = api.getConfig();
    if (!config[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (config.browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (config.outboundEnabled !== true) api.reject('公开外发能力未启用');
    if (confirm !== true) api.reject('提交评论前必须明确 confirm=true');
    const adapter = platforms.get(platform);
    if (!adapter?.comment) api.reject(`${platformLabel(platform)}当前没有评论能力`);
    const text = String(content || '').trim();
    if (!text) api.reject('评论内容不能为空');
    const hash = createHash('sha256').update(text).digest('hex');
    const reservedAt = new Date().toISOString();
    await api.storage.update(previous => {
      const state = migrateMediaState(previous);
      const duplicate = state.outbound.find(row => row.platform === platform && row.kind === 'comment' && row.hash === hash && ['reserved', 'submitted', 'unknown'].includes(row.state));
      if (duplicate) api.reject('相同评论已有提交记录，未知结果不会自动重发');
      state.outbound.push({platform, kind: 'comment', hash, state: 'reserved', createdAt: reservedAt});
      return state;
    });
    try {
      const result = await adapter.comment({content: text});
      await api.storage.update(previous => {
        const state = migrateMediaState(previous);
        const row = [...state.outbound].reverse().find(item => item.platform === platform && item.kind === 'comment' && item.hash === hash && item.state === 'reserved');
        if (row) Object.assign(row, {state: result?.state || 'submitted', outcome: result?.outcome || 'submitted', url: result?.url || '', title: String(result?.title || '').slice(0, 240), updatedAt: new Date().toISOString()});
        return state;
      });
      return {...result, instruction: '评论已提交到页面，平台是否最终发布仍需人工回读确认；不要自动重发。'};
    } catch (error) {
      await api.storage.update(previous => {
        const state = migrateMediaState(previous);
        const row = [...state.outbound].reverse().find(item => item.platform === platform && item.kind === 'comment' && item.hash === hash && item.state === 'reserved');
        if (row) Object.assign(row, {state: 'unknown', outcome: 'unknown', updatedAt: new Date().toISOString()});
        return state;
      }).catch(() => {});
      throw Object.assign(new Error(String(error?.message || '评论提交结果未知')), {code: 'UNKNOWN_OUTCOME'});
    }
  });

  api.action('share', {
    description: '仅主人私聊中明确确认后，把当前官方视频链接发送到当前主人私聊。不会猜测联系人，也不会向群或第三方联系人发送。',
    ownerOnly: true, mutating: true, timeoutMs: 20000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}, confirm: {type: 'boolean'}}, required: ['platform', 'confirm'], additionalProperties: false}
  }, async ({platform, confirm}, context) => {
    const config = api.getConfig();
    if (!config[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    if (config.browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
    if (config.outboundEnabled !== true) api.reject('公开外发能力未启用');
    if (confirm !== true) api.reject('分享前必须明确 confirm=true');
    if (context.kind !== 'private' || !api.isOwner(context) || context.peer !== context.actor) api.reject('分享只允许发送到当前主人私聊');
    const adapter = platforms.get(platform);
    if (!adapter?.current) api.reject(`${platformLabel(platform)}当前页面不可读取`);
    const page = await adapter.current();
    if (page.loginRequired) api.reject('当前页面要求登录或验证码，未分享');
    const url = String(page.url || '');
    const hash = createHash('sha256').update(platform + '\n' + url).digest('hex');
    await api.storage.update(previous => {
      const state = migrateMediaState(previous);
      const duplicate = state.outbound.find(row => row.platform === platform && row.kind === 'share' && row.hash === hash && ['reserved', 'submitted', 'accepted', 'confirmed', 'unknown'].includes(row.state));
      if (duplicate) api.reject('相同视频已有分享记录，未知结果不会自动重发');
      state.outbound.push({platform, kind: 'share', hash, state: 'reserved', createdAt: new Date().toISOString(), url});
      return state;
    });
    try {
      const result = await api.invoke('qq.message.send', {segments: [{type: 'text', data: {text: `${String(page.title || '媒体视频').slice(0, 240)}\n${url}`}}]}, context);
      const stateValue = String(result?.state || result?.outcome || 'unknown');
      await api.storage.update(previous => {
        const state = migrateMediaState(previous);
        const row = [...state.outbound].reverse().find(item => item.platform === platform && item.kind === 'share' && item.hash === hash && item.state === 'reserved');
        if (row) Object.assign(row, {state: stateValue, outcome: result?.outcome || stateValue, updatedAt: new Date().toISOString()});
        return state;
      });
      return {...result, platform, url, instruction: stateValue === 'confirmed' ? '链接已按当前 QQ 回执确认发送。' : '链接已提交但尚未确认送达，不要自动重发。'};
    } catch (error) {
      await api.storage.update(previous => {
        const state = migrateMediaState(previous);
        const row = [...state.outbound].reverse().find(item => item.platform === platform && item.kind === 'share' && item.hash === hash && item.state === 'reserved');
        if (row) Object.assign(row, {state: 'unknown', outcome: 'unknown', updatedAt: new Date().toISOString()});
        return state;
      }).catch(() => {});
      throw Object.assign(new Error(String(error?.message || '分享结果未知')), {code: 'UNKNOWN_OUTCOME'});
    }
  });

  api.action('message-open', {
    description: '仅主人：打开已配置白名单联系人的平台资料页，供人工确认后发送私信。', ownerOnly: true, timeoutMs: 20000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}, contactId: {type: 'string', minLength: 1, maxLength: 120}}, required: ['platform', 'contactId'], additionalProperties: false}
  }, async ({platform, contactId}) => {
    assertMessageReady(api, platform);
    const contact = normalizeMessageContact(platform, contactId);
    if (!isMessageContactAllowed(api.getConfig(), contact)) api.reject('联系人不在平台私信白名单中');
    const adapter = platforms.get(platform);
    if (!adapter?.openContact) api.reject(`${platformLabel(platform)}当前没有联系人页面能力`);
    return adapter.openContact({contactId: contact.contactId});
  });

  api.action('message', {
    description: '仅主人明确确认后，向已配置白名单的平台联系人发送一条私信。发送结果未知时不会自动重发，也不会保存私信正文。', ownerOnly: true, mutating: true, timeoutMs: 30000,
    parameters: {type: 'object', properties: {platform: {type: 'string', enum: MEDIA_PLATFORMS}, contactId: {type: 'string', minLength: 1, maxLength: 120}, content: {type: 'string', minLength: 1, maxLength: 500}, confirm: {type: 'boolean'}}, required: ['platform', 'contactId', 'content', 'confirm'], additionalProperties: false}
  }, async ({platform, contactId, content, confirm}, context) => {
    assertMessageReady(api, platform);
    if (confirm !== true) api.reject('发送平台私信前必须明确 confirm=true');
    if (context.kind !== 'private' || !api.isOwner(context) || context.peer !== context.actor) api.reject('平台私信只允许在当前主人私聊中发起');
    const contact = normalizeMessageContact(platform, contactId);
    if (!isMessageContactAllowed(api.getConfig(), contact)) api.reject('联系人不在平台私信白名单中');
    const text = String(content || '').trim();
    if (!text) api.reject('私信内容不能为空');
    const hash = createHash('sha256').update(platform + '\n' + contact.contactId + '\n' + text).digest('hex');
    const token = randomUUID();
    const now = new Date().toISOString();
    await api.storage.update(previous => {
      const state = migrateMediaState(previous);
      if (state.messageLock && state.messageLock.expiresAt > Date.now()) api.reject('已有平台私信正在发送，请等待其结果');
      const duplicate = state.outbound.find(row => row.platform === platform && row.kind === 'message' && row.hash === hash && ['reserved', 'submitted', 'accepted', 'confirmed', 'unknown'].includes(row.state));
      if (duplicate) api.reject('相同平台私信已有发送记录，未知结果不会自动重发');
      state.messageLock = {token, expiresAt: Date.now() + 60000};
      state.outbound.push({platform, kind: 'message', hash, contactId: contact.contactId, state: 'reserved', createdAt: now});
      return state;
    });
    try {
      const adapter = platforms.get(platform);
      if (!adapter?.message) api.reject(`${platformLabel(platform)}当前没有私信能力`);
      const result = await adapter.message({contactId: contact.contactId, content: text});
      await api.storage.update(previous => {
        const state = migrateMediaState(previous);
        const row = [...state.outbound].reverse().find(item => item.platform === platform && item.kind === 'message' && item.hash === hash && item.state === 'reserved');
        if (row) Object.assign(row, {state: result?.state || result?.outcome || 'unknown', outcome: result?.outcome || result?.state || 'unknown', updatedAt: new Date().toISOString()});
        if (state.messageLock?.token === token) state.messageLock = null;
        return state;
      });
      return {...result, platform, contactId: contact.contactId, instruction: result?.state === 'confirmed' ? '平台私信结果已确认；不要重复发送。' : '平台私信已提交但尚未确认最终送达；不要自动重发。'};
    } catch (error) {
      await api.storage.update(previous => {
        const state = migrateMediaState(previous);
        const row = [...state.outbound].reverse().find(item => item.platform === platform && item.kind === 'message' && item.hash === hash && item.state === 'reserved');
        if (row) Object.assign(row, {state: 'unknown', outcome: 'unknown', updatedAt: new Date().toISOString()});
        if (state.messageLock?.token === token) state.messageLock = null;
        return state;
      }).catch(() => {});
      if (error?.code === 'PLUGIN_INPUT') throw error;
      throw Object.assign(new Error(String(error?.message || '平台私信发送结果未知')), {code: 'UNKNOWN_OUTCOME'});
    }
  });

  api.action('search', {
    description: '仅主人：搜索指定平台的公开内容。返回结果会标明是否需要登录或浏览器能力。',
    ownerOnly: true,
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {
        platform: {type: 'string', enum: MEDIA_PLATFORMS},
        query: {type: 'string', minLength: 1, maxLength: 120},
        limit: {type: 'integer', minimum: 1, maximum: 10}
      },
      required: ['platform', 'query'],
      additionalProperties: false
    }
  }, async ({platform, query, limit = 5}, _context, signal) => {
    const config = api.getConfig();
    if (!config[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    const adapter = platforms.get(platform);
    if (!adapter?.search) api.reject(`${platformLabel(platform)}当前没有可用的公开搜索能力`);
    return adapter.search({query: query.trim(), limit, signal});
  });

  api.action('video-info', {
    description: '仅主人：读取指定平台视频的公开信息，不读取私信、联系人或本机登录资料。',
    ownerOnly: true,
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {
        platform: {type: 'string', enum: MEDIA_PLATFORMS},
        id: {type: 'string', minLength: 3, maxLength: 64}
      },
      required: ['platform', 'id'],
      additionalProperties: false
    }
  }, async ({platform, id}, _context, signal) => {
    const config = api.getConfig();
    if (!config[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
    const adapter = platforms.get(platform);
    if (!adapter?.info) api.reject(`${platformLabel(platform)}当前没有可用的视频信息能力`);
    return adapter.info({bvid: id.trim(), signal});
  });

  return api;
}

function platformLabel(platform) {
  return platform === 'bilibili' ? 'B 站' : '抖音';
}

function assertMessageReady(api, platform) {
  const config = api.getConfig();
  if (!config[`${platform}Enabled`]) api.reject(`${platformLabel(platform)}适配未启用`);
  if (config.browserEnabled !== true) api.reject('专用 Edge 浏览器未启用');
  if (config.outboundEnabled !== true) api.reject('公开外发能力未启用');
  if (config.platformMessageEnabled !== true) api.reject('平台私信能力未启用');
}

function normalizeMessageContact(platform, contactId) {
  const id = String(contactId || '').trim();
  if (!id || id.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw Object.assign(new Error('平台联系人标识无效'), {code: 'PLUGIN_INPUT'});
  return {platform, contactId: id, key: `${platform}:${id}`};
}

function isMessageContactAllowed(config, contact) {
  return Array.isArray(config.messageContacts) && config.messageContacts.map(value => String(value).trim()).includes(contact.key);
}
