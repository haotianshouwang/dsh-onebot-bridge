// 表情包管理页的数据服务。
//
// 只读取 StickerStore 的真实索引与图片文件；不扫描 QQ 缓存，也不把图片字节塞进列表响应。
// 浏览器通过 /api/sticker-image 按会话鉴权取图，避免一次列表传输几十 MB 的 Base64。
import { EMOTIONS } from '../builtins/sticker/index.js';

const SOURCES = ['auto-incoming', 'auto-sent', 'stolen', 'saved', 'manual'];
const SORTS = new Set(['recent', 'oldest', 'name', 'used']);
const SOURCE_LABELS = {
  'auto-incoming': '群里收到',
  'auto-sent': '发送后收藏',
  stolen: '偷图',
  saved: '手动收藏',
  manual: '手动收藏',
  unknown: '未知来源'
};
const EMOTION_LABELS = Object.fromEntries(EMOTIONS.map(value => [value, value]));

function positiveInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function iso(value) {
  const number = Number(value) || 0;
  return number ? new Date(number).toISOString() : null;
}

function dateStart(value) {
  if (!value) return 0;
  const date = new Date(String(value) + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function dateEnd(value) {
  if (!value) return 0;
  const date = new Date(String(value) + 'T23:59:59.999');
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function createStickerAdmin({stickers, getItem, now = () => Date.now()}) {
  if (!stickers) throw new Error('表情包存储不可用');

  const configOf = () => {
    const item = getItem();
    if (!item) throw new Error('表情包插件当前未注册');
    return {item, config: item.config || {}};
  };

  function overview() {
    const {item, config} = configOf();
    const todayStart = new Date(now());
    todayStart.setHours(0, 0, 0, 0);
    const stats = stickers.stats(config.maxStickers);
    const categories = stickers.categories().map(row => ({
      emotion: row.emotion,
      label: EMOTION_LABELS[row.emotion] || (row.emotion ? row.emotion : '未分类'),
      count: row.count
    }));
    const sources = stickers.sources().map(row => ({
      source: row.source,
      label: SOURCE_LABELS[row.source] || row.source,
      count: row.count
    }));
    return {
      id: 'qq-sticker',
      name: item.manifest?.name || '表情包',
      version: item.manifest?.version || '',
      description: item.manifest?.description || '',
      enabled: item.enabled === true,
      registered: item.registered === true,
      uninstalled: item.uninstalled === true,
      health: item.health || {},
      error: item.error || null,
      migrationError: item.migrationError || null,
      config,
      scope: item.scope || null,
      stats: {
        ...stats,
        total: stats.count,
        today: stickers.addedSince(todayStart.getTime()),
        lastCollectedAt: iso(stickers.latestCreatedAt()),
        usageBytes: stats.bytes
      },
      categories,
      sources,
      rules: {
        autoSaveIncoming: config.autoSaveIncoming === true,
        autoSaveSent: config.autoSaveSent === true,
        collectProbability: config.collectProbability ?? 100,
        collectCooldownSec: config.collectCooldownSec ?? 0,
        maxPerMessage: config.maxPerMessage ?? 3,
        excludeKeywords: config.excludeKeywords || []
      },
      capabilities: {
        imageProxy: true,
        annotate: true,
        remove: true,
        probability: true
      }
    };
  }

  function list(query = {}) {
    const {config} = configOf();
    const filters = {
      query: String(query.query || '').trim().slice(0, 80),
      emotion: String(query.emotion || '').slice(0, 20),
      source: String(query.source || '').slice(0, 24),
      from: dateStart(query.from),
      to: dateEnd(query.to),
      sort: SORTS.has(query.sort) ? query.sort : 'recent',
      offset: positiveInt(query.offset, 0, 0, 100000),
      limit: positiveInt(query.limit, 24, 1, 48)
    };
    if (filters.source && !SOURCES.includes(filters.source)) filters.source = '';
    const rows = stickers.list(filters);
    const total = stickers.count(filters);
    return {
      items: rows.map(row => ({
        id: row.id,
        name: row.name,
        emotion: row.emotion || '',
        emotionLabel: EMOTION_LABELS[row.emotion] || (row.emotion || '未分类'),
        tags: [...(row.tags || [])],
        usage: row.usage || '',
        source: row.source || 'unknown',
        sourceLabel: SOURCE_LABELS[row.source] || row.source || '未知来源',
        mime: row.mime,
        size: row.size,
        width: row.width || null,
        height: row.height || null,
        origin: row.origin || null,
        createdAt: iso(row.createdAt),
        usedAt: iso(row.usedAt),
        annotatedAt: iso(row.annotatedAt),
        imageUrl: '/api/sticker-image?id=' + encodeURIComponent(row.id)
      })),
      total,
      offset: filters.offset,
      limit: filters.limit,
      hasMore: filters.offset + rows.length < total,
      categories: stickers.categories().map(row => ({
        emotion: row.emotion,
        label: EMOTION_LABELS[row.emotion] || (row.emotion ? row.emotion : '未分类'),
        count: row.count
      })),
      config: {
        listLimit: config.listLimit,
        maxStickers: config.maxStickers
      }
    };
  }

  async function image(id) {
    const row = stickers.get(String(id || ''));
    if (!row) throw Object.assign(new Error('表情不存在'), {status: 404});
    const result = await stickers.read(row.id);
    return {row: result.row, bytes: result.bytes, mime: result.row.mime};
  }

  async function remove(id) {
    const row = await stickers.remove(String(id || ''));
    return {
      removed: {id: row.id, name: row.name, source: row.source || 'unknown'},
      overview: overview()
    };
  }

  async function annotate(body) {
    const id = String(body.id || '');
    if (!id) throw new Error('请选择表情');
    const emotion = body.emotion == null ? undefined : String(body.emotion);
    if (emotion && !EMOTIONS.includes(emotion)) throw new Error('情绪只能是：' + EMOTIONS.join('、'));
    const tags = body.tags == null ? undefined : String(body.tags).split(/[\s,，]+/).map(value => value.trim()).filter(Boolean).slice(0, 20);
    const row = await stickers.annotate(id, {
      name: body.name == null ? undefined : String(body.name).slice(0, 40),
      emotion,
      tags,
      usage: body.usage == null ? undefined : String(body.usage).slice(0, 120)
    });
    return {sticker: row, overview: overview()};
  }

  return {overview, list, image, remove, annotate};
}
