import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rm, readdir, rename, stat} from 'node:fs/promises';
import path from 'node:path';
import {mediaType} from './media.js';
import {imageDimensions} from './image-info.js';

const MAX_STICKERS = 300;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const INDEX_VERSION = 1;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * 表情包收藏库。
 *
 * 存在插件自己的数据目录下（`<dataDir>/stickers`），与一次性的媒体资源池分开：
 * 媒体资源 1 小时就过期，表情包要长期保存。索引写 `index.json`，图片按内容哈希落盘，
 * 同一个表情重复收藏不会占两份空间。
 */
export class StickerStore {
  constructor(dir) {
    this.dir = path.join(dir, 'stickers');
    this.file = path.join(this.dir, 'index.json');
    this.items = new Map();
    this.ready = false;
  }

  async open() {
    await mkdir(this.dir, {recursive: true});
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw?.version === INDEX_VERSION && Array.isArray(raw.items)) for (const row of raw.items) this.items.set(row.id, row);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 索引坏了不能让整个框架起不来：把坏文件改名留证，从空库继续，日志里说明。
        const backup = this.file + '.broken-' + Date.now();
        try { await rename(this.file, backup); } catch {}
        this.corrupt = true;
        this.corruptFile = backup;
      }
    }
    // 索引里有、磁盘上没的条目直接丢弃，避免后续发送时报"文件不存在"。
    for (const [id, row] of [...this.items]) {
      try {
        await stat(path.join(this.dir, row.hash + '.bin'));
      } catch {
        this.items.delete(id);
      }
    }
    this.ready = true;
    return this;
  }

  async persist() {
    const payload = {version: INDEX_VERSION, items: [...this.items.values()]};
    await writeFile(this.file + '.tmp', JSON.stringify(payload, null, 2), {mode: 0o600});
    await writeFile(this.file, JSON.stringify(payload, null, 2), {mode: 0o600});
  }

  stats(max = MAX_STICKERS) {
    const rows = [...this.items.values()];
    return {
      count: rows.length,
      bytes: rows.reduce((sum, row) => sum + (row.size || 0), 0),
      max: Math.max(1, Number(max) || MAX_STICKERS)
    };
  }

  /**
   * 按后台筛选条件读取表情索引。所有条件在内存索引上执行，不读取图片字节。
   * 旧调用只依赖 tag/emotion/limit，这里保持兼容，并补充 query/source/offset/sort。
   */
  filtered({tag, emotion, source, query, from = 0, to = 0, sort = 'recent', classification = 'all'} = {}) {
    const text = String(query || '').trim().toLowerCase();
    const rows = [...this.items.values()].filter(row => {
      if (classification === 'verified' && row.isSticker !== true) return false;
      if (classification === 'excluded' && row.isSticker !== false) return false;
      if (classification === 'pending' && typeof row.isSticker === 'boolean') return false;
      if (tag && !(row.tags || []).includes(String(tag))) return false;
      if (emotion && row.emotion !== String(emotion)) return false;
      if (source && row.source !== String(source)) return false;
      if (from && Number(row.createdAt) < from) return false;
      if (to && Number(row.createdAt) > to) return false;
      if (!text) return true;
      return String(row.name || '').toLowerCase().includes(text)
        || String(row.usage || '').toLowerCase().includes(text)
        || String(row.emotion || '').toLowerCase().includes(text)
        || (row.tags || []).some(item => String(item).toLowerCase().includes(text));
    });
    const byRecent = (a, b) => (b.usedAt || b.createdAt || 0) - (a.usedAt || a.createdAt || 0);
    if (sort === 'oldest') rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    else if (sort === 'name') rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
    else if (sort === 'used') rows.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    else rows.sort(byRecent);
    return rows.map(row => ({...row, tags: [...(row.tags || [])]}));
  }

  count(filters = {}) {
    return this.filtered(filters).length;
  }

  list({tag, emotion, source, query, from, to, limit = 50, offset = 0, sort = 'recent', classification} = {}) {
    const rows = this.filtered({tag, emotion, source, query, from, to, sort, classification});
    const start = Math.max(0, Number(offset) || 0);
    return rows.slice(start, start + Math.min(Math.max(Number(limit) || 50, 1), 100));
  }

  /** 分类与来源分布，全部由真实索引聚合。 */
  categories(filters = {}) {
    const counts = new Map();
    for (const row of this.filtered(filters)) {
      const key = String(row.emotion || '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([emotion, count]) => ({emotion, count}))
      .sort((a, b) => b.count - a.count || a.emotion.localeCompare(b.emotion, 'zh-CN'));
  }

  sources() {
    const counts = new Map();
    for (const row of this.items.values()) counts.set(String(row.source || 'unknown'), (counts.get(String(row.source || 'unknown')) || 0) + 1);
    return [...counts.entries()].map(([source, count]) => ({source, count})).sort((a, b) => b.count - a.count);
  }

  addedSince(time) {
    const since = Number(time) || 0;
    return [...this.items.values()].filter(row => Number(row.createdAt) >= since).length;
  }

  latestCreatedAt() {
    let latest = 0;
    for (const row of this.items.values()) latest = Math.max(latest, Number(row.createdAt) || 0);
    return latest;
  }

  get(id) {
    const row = this.items.get(String(id));
    return row ? {...row, tags: [...(row.tags || [])]} : null;
  }

  find(query) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return [];
    return [...this.items.values()].filter(row =>
      String(row.id) === text ||
      String(row.name || '').toLowerCase().includes(text) ||
      (row.tags || []).some(tag => String(tag).toLowerCase().includes(text)) ||
      String(row.emotion || '').toLowerCase().includes(text) ||
      String(row.usage || '').toLowerCase().includes(text)
    ).map(row => ({...row, tags: [...(row.tags || [])]}));
  }

  /**
   * 从受控媒体资源里取出图片并收藏。
   * @param resource 媒体资源行（`{id, mime, name}`）
   * @param bytes 图片字节
   * @param context 当前聊天的执行上下文（只用来记录来源，不用于鉴权）
   */
  async save({bytes, name, tags, usage, emotion = '', isSticker, source = 'manual', context, max = MAX_STICKERS}) {
    if (!this.ready) throw new Error('表情包库尚未就绪');
    const buffer = Buffer.from(bytes);
    if (!buffer.length) throw new Error('表情内容为空');
    if (buffer.length > MAX_BYTES) throw new Error('表情图超过 2 MB，无法收藏');
    const mime = mediaType(buffer);
    if (!IMAGE_TYPES.has(mime)) throw new Error('只能收藏 PNG、JPEG、GIF 或 WebP 图片');
    const hash = createHash('sha256').update(buffer).digest('hex');
    const existing = [...this.items.values()].find(row => row.hash === hash);
    if (existing) {
      // 重复收藏：只补充标签与用途，不重复占空间。
      const merged = new Set([...(existing.tags || []), ...(tags || [])]);
      existing.tags = [...merged].slice(0, 20);
      if (usage) existing.usage = String(usage).slice(0, 120);
      if (emotion) existing.emotion = String(emotion).slice(0, 12);
      if (typeof isSticker === 'boolean') {
        existing.isSticker = isSticker;
        existing.annotatedAt = Date.now();
      }
      existing.usedAt = Date.now();
      await this.persist();
      return {sticker: {...existing, tags: [...existing.tags]}, deduped: true};
    }
    const capacity = Math.max(1, Math.min(1000, Number(max) || MAX_STICKERS));
    if (this.items.size >= capacity) throw new Error(`表情包库已满（${capacity} 张），请先删除一些`);
    const total = this.stats().bytes + buffer.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('表情包库总容量已满，请先删除一些');
    const id = randomUUID();
    await writeFile(path.join(this.dir, hash + '.bin'), buffer, {mode: 0o600});
    const row = {
      id, hash, name: String(name || '未命名表情').slice(0, 40), mime, size: buffer.length,
      ...imageDimensions(buffer, mime),
      tags: [...new Set((tags || []).map(tag => String(tag).slice(0, 20)))].slice(0, 20),
      usage: usage ? String(usage).slice(0, 120) : '',
      emotion: emotion ? String(emotion).slice(0, 12) : '',
      ...typeof isSticker === 'boolean' ? {isSticker, annotatedAt: Date.now()} : {},
      source, createdAt: Date.now(), usedAt: Date.now(),
      origin: context ? {kind: context.kind, peer: String(context.peer)} : null
    };
    this.items.set(id, row);
    await this.persist();
    return {sticker: {...row, tags: [...row.tags]}, deduped: false};
  }

  // 看到图之后补情绪、用途和标签；只改给出的字段，不覆盖没传的内容。
  async annotate(id, {name, emotion, tags, usage, isSticker} = {}) {
    const row = this.items.get(String(id));
    if (!row) throw new Error('没有这个表情');
    if (name) row.name = String(name).slice(0, 40);
    if (emotion) row.emotion = String(emotion).slice(0, 12);
    if (usage) row.usage = String(usage).slice(0, 120);
    if (typeof isSticker === 'boolean') row.isSticker = isSticker;
    if (Array.isArray(tags)) row.tags = [...new Set([...(row.tags || []), ...tags.map(tag => String(tag).slice(0, 20))])].slice(0, 20);
    row.annotatedAt = Date.now();
    await this.persist();
    return {...row, tags: [...(row.tags || [])]};
  }

  async read(id) {
    const row = this.items.get(String(id));
    if (!row) throw new Error('没有这个表情');
    return {row, bytes: await readFile(path.join(this.dir, row.hash + '.bin'))};
  }

  async touch(id) {
    const row = this.items.get(String(id));
    if (!row) return;
    row.usedAt = Date.now();
    await this.persist();
  }

  async remove(id) {
    const row = this.items.get(String(id));
    if (!row) throw new Error('没有这个表情');
    this.items.delete(String(id));
    const shared = [...this.items.values()].some(other => other.hash === row.hash);
    if (!shared) await rm(path.join(this.dir, row.hash + '.bin'), {force: true});
    await this.persist();
    return row;
  }

  async clear() {
    for (const name of await readdir(this.dir)) if (name.endsWith('.bin')) await rm(path.join(this.dir, name), {force: true});
    this.items.clear();
    await this.persist();
  }
}
