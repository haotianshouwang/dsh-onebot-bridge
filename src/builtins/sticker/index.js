// 表情包插件：收藏、偷图、识别用途、联网查含义。
//
// 边界：
// - 图片字节存在插件数据目录（StickerStore），不进 state.json；索引只存元数据。
// - 收藏来源只能是"当前聊天已收到的消息"（由核心 qq.media.receive 校验归属）。
// - 识别用途靠把图片本身回传给模型（工具结果里带图片块），模型看图判断，不做臆测。
// - 联网查含义复用 qq-web 的搜索动作；没装或没授权时明确说明，不编造含义。
export const manifest = {
  id: 'qq-sticker', name: '表情包', version: '1.0.0', bundled: true,
  description: '收藏群里的表情包、按标签检索、发送，并识别表情的用途或联网查它的含义；只用公开搜索，不访问本机文件。',
  dependencies: {framework: '>=0.8.0'}, configVersion: 2,
  configMigrations: [{to: 2, remove: ['savePerDay'], defaults: {autoSaveSent: false, autoSaveIncoming: false}}],
  capabilities: ['actions', 'resources'],
  configSchema: {
    listLimit: {type: 'number', title: '检索返回数量', default: 8, min: 1, max: 20, integer: true},
    autoSaveSent: {type: 'boolean', title: '她发出去的图自动收进库', description: '联网搜到并发出的图片，发送成功后自动收藏。默认关闭。', default: false},
    autoSaveIncoming: {type: 'boolean', title: '群里收到的图自动收进库', description: '命中作用范围的聊天里，别人发的图片自动收藏（每个表情按内容去重）。默认关闭。', default: false},
    meaningEnabled: {type: 'boolean', title: '允许联网查表情含义', default: true},
    maxStickers: {type: 'number', title: '表情库上限（张）', default: 300, min: 10, max: 1000, integer: true}
  },
  settings: {
    title: '表情包',
    description: '收藏当前聊天里收到的图片表情；识别用途时会把图片交给模型看，联网查含义使用必应搜索。所有动作默认只有主人可用，可在主人与权限里逐项开放。自动收藏是系统行为，只受作用范围限制，不需要工具授权，也不设每日配额。',
    sections: [{title: '检索与容量', fields: ['listLimit', 'maxStickers']}, {title: '自动收藏', fields: ['autoSaveSent', 'autoSaveIncoming']}, {title: '联网查含义', fields: ['meaningEnabled']}]
  }
};

const schema = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false});
// 哪些参数是必填，逐动作声明；不写就让模型自由省略。
const REQUIRED = {
  save: [], steal: [], list: [], send: ['id'], explain: [], remove: ['id']
};

export function activateSticker(framework, {stickers, readResource} = {}) {
  const api = framework.registerTrustedPackage(manifest);

  const remember = async (a, c, signal, source) => {
    if (!a.messageId && !a.resourceId) api.reject('请指定要收藏哪条消息里的表情，或联网查资料刚发出去的那张图的资源编号');
    let bytes;
    if (a.resourceId) {
      // 兼容"先联网搜图发出去、再收进表情库"：资源由联网查资料包创建，仍在当前聊天内有效。
      bytes = await readResource(String(a.resourceId), c);
    } else {
      // 核心动作会校验这条消息确实属于当前聊天，插件拿不到任意 URL。
      const resource = await api.invoke('qq.media.receive', {messageId: String(a.messageId), index: a.index ?? 0}, c, signal);
      bytes = await readResource(resource.id, c);
    }
    const {sticker, deduped} = await stickers.save({
      bytes, name: a.name, tags: a.tags, usage: a.usage, source, context: c
    });
    return {
      ok: true, deduped, sticker: publicRow(sticker),
      instruction: deduped
        ? '这张表情已经在库里，只补充了标签与用途。不要声称刚保存了一份新文件。'
        : '已收藏。可以告诉对方记下了，并按需补一句标签。'
    };
  };

  api.action('save', {
    description: '仅主人或已授权用户：把当前聊天某条消息里的图片收藏为表情，可附名字、标签（最多 5 个）与用途。messageId 必须是本聊天里真实收到过的消息。',
    mutating: true, timeoutMs: 20000,
    parameters: schema({
      messageId: {type: 'string', maxLength: 60, description: '包含表情的那条消息 ID'},
      resourceId: {type: 'string', maxLength: 60, description: '联网查资料刚发出去的图片资源编号，与 messageId 二选一'},
      index: {type: 'integer', minimum: 0, maximum: 19},
      name: {type: 'string', maxLength: 40},
      tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 20}},
      usage: {type: 'string', maxLength: 120, description: '这张表情适合什么时候用，例如"被夸时得意"'}
    }, REQUIRED.save)
  }, async (a, c, signal) => remember(a, c, signal, 'saved'));

  api.action('steal', {
    description: '仅主人或已授权用户：把别人发的表情偷进自己库里。用法与 save 相同，额外记录来源说明。不能偷当前聊天之外的消息。',
    mutating: true, timeoutMs: 20000,
    parameters: schema({
      messageId: {type: 'string', maxLength: 60, description: '包含表情的那条消息 ID'},
      resourceId: {type: 'string', maxLength: 60, description: '联网查资料刚发出去的图片资源编号，与 messageId 二选一'},
      index: {type: 'integer', minimum: 0, maximum: 19},
      name: {type: 'string', maxLength: 40},
      tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 20}},
      usage: {type: 'string', maxLength: 120}
    }, REQUIRED.steal)
  }, async (a, c, signal) => remember(a, c, signal, 'stolen'));

  api.action('list', {
    description: '仅主人或已授权用户：按标签或关键词检索表情库，返回编号、名字、标签、用途与来源。不会返回图片本身。',
    timeoutMs: 8000,
    parameters: schema({query: {type: 'string', maxLength: 40}, tag: {type: 'string', maxLength: 20}, limit: {type: 'integer', minimum: 1, maximum: 20}}, REQUIRED.list)
  }, async a => {
    const limit = a.limit ?? api.getConfig().listLimit ?? 8;
    const rows = a.query ? stickers.find(a.query) : a.tag ? stickers.list({tag: a.tag}) : stickers.list({limit});
    const stats = stickers.stats();
    return {
      ok: true, total: stats.count, capacity: stats.max,
      items: rows.slice(0, limit).map(publicRow),
      instruction: rows.length ? '用编号引用表情；要看具体长什么样可用 explain。' : '库里没有匹配的表情。'
    };
  });

  api.action('send', {
    description: '仅主人或已授权用户：把表情库里某个编号的表情发到当前聊天。编号必须来自 list 或 explain 的结果。',
    mutating: true, timeoutMs: 25000,
    parameters: schema({id: {type: 'string', maxLength: 60}}, REQUIRED.send)
  }, async (a, c, signal) => {
    const {row, bytes} = await stickers.read(a.id);
    const resource = await api.putResource(bytes, c, {purpose: 'image', name: row.name});
    await api.invoke('qq.image.send', {resourceId: resource.id}, c, signal);
    await stickers.touch(row.id);
    return {ok: true, id: row.id, name: row.name, tags: row.tags, instruction: '已经发出去了，不要再重复发送同一个表情。'};
  });

  api.action('explain', {
    description: '仅主人或已授权用户：弄清一张表情是什么、适合什么时候用。传 id 看库里的表情，或传 messageId 现看聊天里的图片。会把图片本身交给模型看，并可联网搜索这个表情的含义。',
    timeoutMs: 25000,
    parameters: schema({
      id: {type: 'string', maxLength: 60},
      messageId: {type: 'string', maxLength: 60},
      index: {type: 'integer', minimum: 0, maximum: 19},
      query: {type: 'string', maxLength: 60},
      search: {type: 'boolean', description: '是否联网查含义，默认按插件开关'}
    }, REQUIRED.explain)
  }, async (a, c, signal) => {
    let bytes, row = null, meta = {};
    if (a.id) {
      const result = await stickers.read(a.id);
      bytes = result.bytes; row = result.row; meta = publicRow(row);
      await stickers.touch(row.id);
    } else if (a.messageId) {
      const resource = await api.invoke('qq.media.receive', {messageId: String(a.messageId), index: a.index ?? 0}, c, signal);
      bytes = await readResource(resource.id, c);
      meta = {id: null, name: '当前聊天里的图片', mime: resource.mime, size: bytes.length};
    } else if (a.query) {
      const rows = stickers.find(a.query).slice(0, 1);
      if (!rows.length) api.reject('库里没有匹配的表情，无法解释');
      const result = await stickers.read(rows[0].id);
      bytes = result.bytes; row = result.row; meta = publicRow(row);
    } else api.reject('请提供表情编号、消息 ID 或关键词');

    const config = api.getConfig();
    const wantSearch = a.search ?? config.meaningEnabled !== false;
    let meaning = null;
    if (wantSearch) {
      const term = row ? [row.name, ...(row.tags || [])].filter(Boolean).join(' ') : (a.query || '');
      if (term) {
        try {
          const search = await api.invoke('plugin.qq-web.search', {query: `表情包 "${term}" 是什么梗 什么场合用`}, c, signal);
          meaning = {provider: search.provider, results: (search.results || []).slice(0, 3), note: '搜索摘要仅供参考，需要时再用 qq-web.read 打开正文核实。'};
        } catch (error) {
          meaning = {error: '联网查含义不可用（' + String(error?.message || error).slice(0, 80) + '）', note: '不要编造这个表情的来历。'};
        }
      }
    }
    return {
      ok: true, sticker: meta, meaning, previews: [{mediaType: stickerMime(bytes), base64: Buffer.from(bytes).toString('base64'), name: 'sticker'}],
      instruction: '先描述你在这张图里实际看到的内容，再判断适合什么场合用；联网结果的摘要不等于核实过的事实。'
    };
  });

  api.action('remove', {
    description: '仅主人：从表情库里删除一个表情。需要明确编号。',
    mutating: true, ownerOnly: true, timeoutMs: 8000,
    parameters: schema({id: {type: 'string', maxLength: 60}}, REQUIRED.remove)
  }, async a => {
    const row = await stickers.remove(a.id);
    return {ok: true, removed: publicRow(row), instruction: '已删除，不要再说还能发这张。'};
  });

  return api;
}

function publicRow(row) {
  return {
    id: row.id, name: row.name, tags: [...(row.tags || [])], usage: row.usage || '',
    mime: row.mime, size: row.size, source: row.source,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    usedAt: row.usedAt ? new Date(row.usedAt).toISOString() : null
  };
}

function stickerMime(bytes) {
  const head = bytes.subarray(0, 12);
  if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (head.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (head.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/png';
}
