// 表情包插件：收藏、偷图、识别用途、联网查含义。
//
// 边界：
// - 图片字节存在插件数据目录（StickerStore），不进 state.json；索引只存元数据。
// - 收藏来源只能是"当前聊天已收到的消息"（由核心 qq.media.receive 校验归属）。
// - 识别用途靠把图片本身回传给模型（工具结果里带图片块），模型看图判断，不做臆测。
// - 联网查含义复用 qq-web 的搜索动作；没装或没授权时明确说明，不编造含义。
export const manifest = {
  id: 'qq-sticker', name: '表情包', version: '1.1.0', bundled: true,
  apiVersion: 2, type: 'native-source', entry: 'src/builtins/sticker/index.js',
  description: '收藏群里的表情包、按标签和情绪检索、发送，并在偷图后看图补名字、情绪和用途；只用公开搜索，不访问本机文件。',
  dependencies: {framework: '>=0.8.0'}, configVersion: 2,
  configMigrations: [{to: 2, remove: ['savePerDay'], defaults: {autoSaveSent: false, autoSaveIncoming: false}}],
  capabilities: ['actions', 'resources'],
  configSchema: {
    listLimit: {type: 'number', title: '检索返回数量', default: 8, min: 1, max: 20, integer: true},
    autoSaveSent: {type: 'boolean', title: '她发出去的图自动收进库', description: '联网搜到并发出的图片，发送成功后自动收藏。默认关闭。', default: false},
    autoSaveIncoming: {type: 'boolean', title: '群里收到的图自动收进库', description: '命中作用范围的聊天里，别人发的图片自动收藏（每个表情按内容去重）。默认关闭。', default: false},
    collectProbability: {type: 'number', title: '自动收藏概率（%）', description: '每条收到图片的消息 / 每次发出联网图片时只判定一次。100 表示都收，0 表示关闭自动收藏。', default: 100, min: 0, max: 100, integer: true},
    collectCooldownSec: {type: 'number', title: '收集冷却（秒）', description: '同一聊天两次自动收集之间的最小间隔；0 表示不设冷却。', default: 0, min: 0, max: 3600, integer: true},
    maxPerMessage: {type: 'number', title: '单条消息最多收几张', description: '一条消息里有多张图片时，最多处理前几张。', default: 3, min: 1, max: 10, integer: true},
    excludeKeywords: {type: 'string[]', title: '排除关键词', description: '消息正文包含这些词时不自动收藏，每行一个。', default: [], maxItems: 20},
    meaningEnabled: {type: 'boolean', title: '允许联网查表情含义', default: true},
    maxStickers: {type: 'number', title: '表情库上限（张）', default: 300, min: 10, max: 1000, integer: true}
  },
  settings: {
    title: '表情包',
    description: '收藏当前聊天里收到的图片表情，偷到后会先把图片给你看，再补名字、情绪（开心、无语、生气等）、标签和用途；检索可以按标签或情绪找。所有动作默认只有主人可用，可在主人与权限里逐项开放。自动收藏是系统行为，只受作用范围限制，不需要工具授权，也不设每日配额。',
    sections: [
      {title: '检索与容量', fields: ['listLimit', 'maxStickers']},
      {title: '自动收藏', fields: ['autoSaveSent', 'autoSaveIncoming', 'collectProbability', 'collectCooldownSec', 'maxPerMessage', 'excludeKeywords']},
      {title: '联网查含义', fields: ['meaningEnabled']}
    ]
  }
};

export const EMOTIONS = ['开心', '无语', '生气', '难过', '惊讶', '撒娇', '得意', '尴尬', '疑惑', '其他'];

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
      bytes, name: a.name, tags: a.tags, usage: a.usage, emotion: a.emotion, source, context: c,
      max: api.getConfig().maxStickers
    });
    const {bytes: previewBytes} = await stickers.read(sticker.id);
    return {
      ok: true, deduped, sticker: publicRow(sticker),
      previews: [{mediaType: sticker.mime, base64: Buffer.from(previewBytes).toString('base64'), name: sticker.name}],
      instruction: '先看这张图，再调用 annotate 补上 emotion（' + EMOTIONS.join('、') + ' 之一）、标签和用途；判断依据只能是图里实际看到的内容。'
        + (deduped ? '这张表情已经在库里，这次只补充了标签与用途。' : '已收藏。')
    };
  };

  api.action('save', {
    description: '仅主人或已授权用户：把当前聊天某条消息里的图片收藏为表情。收藏后会返回图片预览，先用 annotate 补情绪、标签和用途。messageId 必须是本聊天里真实收到过的消息。',
    mutating: true, timeoutMs: 20000,
    parameters: schema({
      messageId: {type: 'string', maxLength: 60, description: '包含表情的那条消息 ID'},
      resourceId: {type: 'string', maxLength: 60, description: '联网查资料刚发出去的图片资源编号，与 messageId 二选一'},
      index: {type: 'integer', minimum: 0, maximum: 19},
      name: {type: 'string', maxLength: 40},
      tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 20}},
      emotion: {type: 'string', maxLength: 12, description: '可选：' + EMOTIONS.join('/')},
      usage: {type: 'string', maxLength: 120, description: '这张表情适合什么时候用，例如"被夸时得意"'}
    }, REQUIRED.save)
  }, async (a, c, signal) => remember(a, c, signal, 'saved'));

  api.action('steal', {
    description: '仅主人或已授权用户：把别人发的表情偷进自己库里，并返回图片预览让你当场分类。用法与 save 相同；看过后调用 annotate 标情绪、标签和用途。不能偷当前聊天之外的消息。',
    mutating: true, timeoutMs: 20000,
    parameters: schema({
      messageId: {type: 'string', maxLength: 60, description: '包含表情的那条消息 ID'},
      resourceId: {type: 'string', maxLength: 60, description: '联网查资料刚发出去的图片资源编号，与 messageId 二选一'},
      index: {type: 'integer', minimum: 0, maximum: 19},
      name: {type: 'string', maxLength: 40},
      tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 20}},
      emotion: {type: 'string', maxLength: 12, description: '可选：' + EMOTIONS.join('/')},
      usage: {type: 'string', maxLength: 120}
    }, REQUIRED.steal)
  }, async (a, c, signal) => remember(a, c, signal, 'stolen'));

  api.action('annotate', {
    description: '仅主人或已授权用户：看完表情图片后补分类。emotion 从固定词表选一个，tags 写检索用的短词，usage 写它适合什么场合。只改传入的字段，不会动别的表情。',
    mutating: true, timeoutMs: 8000,
    parameters: schema({
      id: {type: 'string', maxLength: 60, description: '表情编号'},
      name: {type: 'string', maxLength: 40},
      emotion: {type: 'string', maxLength: 12, description: EMOTIONS.join('/')},
      tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 20}},
      usage: {type: 'string', maxLength: 120}
    }, ['id'])
  }, async a => {
    if (a.emotion && !EMOTIONS.includes(a.emotion)) api.reject('情绪只能是：' + EMOTIONS.join('、'));
    const row = await stickers.annotate(a.id, {name: a.name, emotion: a.emotion, tags: a.tags, usage: a.usage});
    return {ok: true, sticker: publicRow(row), instruction: '已补好分类。以后按情绪或标签就能找到它。'};
  });

  api.action('list', {
    description: '仅主人或已授权用户：按关键词、标签或情绪检索表情库，返回编号、名字、情绪、标签、用途与来源。不会返回图片本身。',
    timeoutMs: 8000,
    parameters: schema({query: {type: 'string', maxLength: 40}, tag: {type: 'string', maxLength: 20}, emotion: {type: 'string', maxLength: 12}, limit: {type: 'integer', minimum: 1, maximum: 20}}, REQUIRED.list)
  }, async a => {
    const limit = a.limit ?? api.getConfig().listLimit ?? 8;
    const rows = a.query ? stickers.find(a.query) : stickers.list({tag: a.tag, emotion: a.emotion, limit});
    const stats = stickers.stats(api.getConfig().maxStickers);
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
    const sent = await api.invoke('qq.image.send', {resourceId: resource.id}, c, signal);
    const outcome = sent?.outcome || 'unknown', confirmed = outcome === 'confirmed', accepted = outcome === 'accepted';
    if (confirmed) await stickers.touch(row.id);
    return {
      ok: confirmed, outcome, accepted, id: row.id, name: row.name, emotion: row.emotion || '', tags: row.tags,
      instruction: confirmed ? '已经发出去了，不要再重复发送同一个表情。' : accepted ? '网关已受理图片，但尚未确认送达；不要声称已经确认收到。' : '图片发送结果未确认，不要声称已经发出。'
    };
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
      const term = row ? [row.name, row.emotion, ...(row.tags || [])].filter(Boolean).join(' ') : (a.query || '');
      if (term) {
        try {
          const search = await api.invoke('plugin.qq-web.search', {query: `表情包 "${term}" 是什么梗 什么场合用`}, c, signal);
          // 表情含义只需要摘要；不把网址带给模型，避免她在群里刷来源链接。
          meaning = {provider: search.provider, results: (search.results || []).slice(0, 3).map(({title, snippet}) => ({title, snippet})), note: '摘要仅供参考；不要输出来源链接或站点名。'};
        } catch (error) {
          meaning = {error: '联网查含义不可用（' + String(error?.message || error).slice(0, 80) + '）', note: '不要编造这个表情的来历。'};
        }
      }
    }
    return {
      ok: true, sticker: meta, meaning, previews: [{mediaType: stickerMime(bytes), base64: Buffer.from(bytes).toString('base64'), name: 'sticker'}],
      instruction: '先描述你在这张图里实际看到的内容，再判断适合什么场合用；联网摘要不等于核实过的事实，不要输出来源链接或站点名。'
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
    id: row.id, name: row.name, tags: [...(row.tags || [])], emotion: row.emotion || '', usage: row.usage || '',
    mime: row.mime, size: row.size, source: row.source,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    usedAt: row.usedAt ? new Date(row.usedAt).toISOString() : null,
    annotatedAt: row.annotatedAt ? new Date(row.annotatedAt).toISOString() : null
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
