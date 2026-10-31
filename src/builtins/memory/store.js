// 长期记忆的本地存储：SQLite（Node 内置 node:sqlite）+ 精确余弦检索。
//
// 设计：
// - SQLite 是唯一事实来源：文本、范围、标签、重要度和向量都存在 memories 表。
// - 向量以 Float32 小端 BLOB 保存，检索时在作用范围内的候选集中算余弦，规模在几千条以内足够快。
// - 没有向量（未配置嵌入模型或调用失败）时退化为关键词 + 重要度 + 新近度打分，记忆不会因此丢失。
// - 作用范围：global 全部聊天可见；user 仅该用户；group 仅该群。群和私聊都只能看到 global + 自己相关的记录。
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SCOPES = ['global', 'user', 'group'];
export const KINDS = ['fact', 'preference', 'event', 'note'];
export const RETRIEVAL_MODEL = Object.freeze({
  embeddingFloor: 0.42,
  keywordFloor: 0.32,
  weights: Object.freeze({embedding: 0.68, keyword: 0.2, importance: 0.08, recency: 0.04}),
  keywordWeights: Object.freeze({keyword: 0.7, importance: 0.18, recency: 0.12}),
  description: '语义命中时：0.68 × 余弦 + 0.20 × 关键词 + 0.08 × 重要度 + 0.04 × 新近度；关键词命中时：0.70 × 关键词 + 0.18 × 重要度 + 0.12 × 新近度。'
});
const EMBEDDING_FLOOR = RETRIEVAL_MODEL.embeddingFloor;
const KEYWORD_FLOOR = RETRIEVAL_MODEL.keywordFloor;

// 复习模型集中管理：理论遗忘曲线只用于解释和安排，不代表真实测量。
// 间隔单位为小时，按首次记住后的复习次数依次使用；最后一档之后重复最后一档。
export const REVIEW_INTERVALS_HOURS = Object.freeze([0.083, 0.5, 12, 24, 48, 96, 168, 360]);
export const REVIEW_MODEL = Object.freeze({
  baseStabilityHours: 24,
  importanceFactor: 0.35,
  reviewFactor: 0.9,
  maxStabilityHours: 24 * 365,
  formula: 'R(t) = exp(-t / S)，S = 24h × (1 + 0.35 × (重要度 - 1)) × (1 + 0.9 × 已完成复习次数)'
});
export const KIND_LABELS = Object.freeze({fact: '事实', preference: '偏好', event: '经历', note: '笔记'});
export const SCOPE_LABELS = Object.freeze({global: '通用', user: '用户', group: '群'});

export function stabilityHours(row, reviewCount = 0) {
  const importance = Math.max(1, Math.min(5, Number(row?.importance) || 3));
  const reviews = Math.max(0, Number(reviewCount) || 0);
  return Math.min(
    REVIEW_MODEL.maxStabilityHours,
    REVIEW_MODEL.baseStabilityHours * (1 + REVIEW_MODEL.importanceFactor * (importance - 1)) * (1 + REVIEW_MODEL.reviewFactor * reviews)
  );
}

export function theoreticalRetention(hours, stability = REVIEW_MODEL.baseStabilityHours) {
  const elapsed = Math.max(0, Number(hours) || 0);
  const scale = Math.max(1, Number(stability) || REVIEW_MODEL.baseStabilityHours);
  return Math.max(0, Math.min(1, Math.exp(-elapsed / scale)));
}

export function normalizeMemoryText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

export function memoryHash(scope, owner, text) {
  return createHash('sha256').update([scope, owner, normalizeMemoryText(text).toLowerCase()].join('\u0000')).digest('hex');
}

function gramsOf(text) {
  const normalized = normalizeMemoryText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const grams = new Set();
  for (const word of normalized.split(/\s+/).filter(Boolean)) {
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      if (word.length === 1) grams.add(word);
      for (let i = 0; i < word.length - 1; i++) grams.add(word.slice(i, i + 2));
    } else if (word.length >= 2) grams.add(word);
  }
  return grams;
}

export function keywordScore(query, text) {
  const q = gramsOf(query);
  if (!q.size) return 0;
  const t = gramsOf(text);
  let hit = 0;
  for (const gram of q) if (t.has(gram)) hit++;
  let score = hit / q.size;
  const qn = normalizeMemoryText(query).toLowerCase(), tn = normalizeMemoryText(text).toLowerCase();
  if (qn.length >= 2 && tn.includes(qn)) score = Math.max(score, 0.92);
  return Math.min(1, score);
}

export function toVector(bytes) {
  if (!bytes || !bytes.length || bytes.length % 4) return null;
  const copy = Buffer.from(bytes);
  const view = new Float32Array(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
  return view.length ? view : null;
}

export function toBuffer(vector) {
  const copy = Float32Array.from(vector);
  return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
}

export function normalizeVector(vector) {
  const out = Float32Array.from(vector);
  let sum = 0;
  for (const value of out) sum += value * value;
  const length = Math.sqrt(sum);
  if (!Number.isFinite(length) || length <= 0) return out;
  for (let i = 0; i < out.length; i++) out[i] /= length;
  return out;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function scoreMemory(row, { vector = null, model = '', query = '', now = Date.now() } = {}) {
  const kw = keywordScore(query, row.text);
  const imp = (Math.max(1, Math.min(5, Number(row.importance) || 3)) - 1) / 4;
  const recency = Math.max(0, Math.min(1, 1 - (now - Number(row.updated_at || 0)) / (365 * 86400000)));
  let cos = null;
  if (vector && row.embedding && row.dim === vector.length && row.model === model) cos = cosine(vector, row.embedding);
  if (cos !== null && cos >= EMBEDDING_FLOOR) {
    return {score: RETRIEVAL_MODEL.weights.embedding * Math.max(0, cos) + RETRIEVAL_MODEL.weights.keyword * kw + RETRIEVAL_MODEL.weights.importance * imp + RETRIEVAL_MODEL.weights.recency * recency, cos, kw};
  }
  if (kw >= KEYWORD_FLOOR) return {score: RETRIEVAL_MODEL.keywordWeights.keyword * kw + RETRIEVAL_MODEL.keywordWeights.importance * imp + RETRIEVAL_MODEL.keywordWeights.recency * recency, cos, kw};
  return null;
}

export function startOfToday(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 下一次复习时间：已完成次数决定间隔；从未复习时从创建时间起算第一个间隔。 */
export function reviewDueAt(row, {count = 0, last = 0} = {}, now = Date.now()) {
  const index = Math.min(Math.max(0, Number(count) || 0), REVIEW_INTERVALS_HOURS.length - 1);
  const base = Number(last) || Number(row?.created_at) || now;
  return base + REVIEW_INTERVALS_HOURS[index] * 3600000;
}

export function reviewState(row, reviews = [], now = Date.now()) {
  const sorted = [...reviews].sort((a, b) => a.reviewedAt - b.reviewedAt);
  const count = sorted.length;
  const last = sorted.at(-1)?.reviewedAt || Number(row?.created_at) || now;
  const intervalIndex = Math.min(count, REVIEW_INTERVALS_HOURS.length - 1);
  const nextDue = last + REVIEW_INTERVALS_HOURS[intervalIndex] * 3600000;
  const stability = stabilityHours(row, count);
  return {
    count,
    lastReviewedAt: sorted.at(-1)?.reviewedAt || 0,
    nextDue,
    intervalHours: REVIEW_INTERVALS_HOURS[intervalIndex],
    stabilityHours: stability,
    retention: theoreticalRetention((now - last) / 3600000, stability),
    due: nextDue <= now,
    reviews: sorted
  };
}

export class MemoryStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'memory.db');
    this.db = null;
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = DELETE;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'fact',
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        dim INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        source_title TEXT NOT NULL DEFAULT '',
        captured_at INTEGER NOT NULL DEFAULT 0,
        published_at INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memories_hash ON memories(scope, owner, hash);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, owner);
      CREATE INDEX IF NOT EXISTS memories_updated ON memories(updated_at);
      CREATE TABLE IF NOT EXISTS memory_reviews (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        reviewed_at INTEGER NOT NULL,
        scheduled_for INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT 'reviewed',
        interval_index INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS memory_reviews_memory ON memory_reviews(memory_id, reviewed_at);
      CREATE TABLE IF NOT EXISTS memory_conflicts (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        old_text TEXT NOT NULL,
        new_text TEXT NOT NULL,
        old_source_url TEXT NOT NULL DEFAULT '',
        new_source_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memory_conflicts_memory ON memory_conflicts(memory_id, created_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map(row => row.name));
    for (const [name, ddl] of [
      ['source_url', "TEXT NOT NULL DEFAULT ''"], ['source_title', "TEXT NOT NULL DEFAULT ''"],
      ['captured_at', 'INTEGER NOT NULL DEFAULT 0'], ['published_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['confidence', 'REAL NOT NULL DEFAULT 1'], ['expires_at', 'INTEGER NOT NULL DEFAULT 0']
    ]) if (!columns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl};`);
    const version = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema')?.value;
    if (!version) this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
    return this;
  }

  close() {
    try { this.db?.close(); } catch { /* 已关闭 */ }
    this.db = null;
  }

  assertOpen() {
    if (!this.db) throw new Error('记忆库尚未打开');
  }

  row(value) {
    if (!value) return null;
    let tags = [];
    try { tags = JSON.parse(value.tags || '[]'); } catch { tags = []; }
    return { ...value, tags: Array.isArray(tags) ? tags : [], embedding: null };
  }

  get(id) {
    this.assertOpen();
    return this.row(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id)));
  }

  count() {
    this.assertOpen();
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n || 0);
  }

  findExact(scope, owner, hash) {
    this.assertOpen();
    return this.row(this.db.prepare('SELECT * FROM memories WHERE scope = ? AND owner = ? AND hash = ?').get(scope, owner, hash));
  }

  // 同范围、同模型下最相似的一条，用于合并“换个说法又问一遍”。
  findSimilar({ scope, owner, vector, model, threshold = 0.93 }) {
    this.assertOpen();
    if (!vector?.length) return null;
    const rows = this.db.prepare('SELECT * FROM memories WHERE scope = ? AND owner = ? AND dim = ? AND model = ?').all(scope, owner, vector.length, model);
    let best = null;
    for (const value of rows) {
      const cand = this.row(value);
      cand.embedding = toVector(value.embedding);
      const similarity = cosine(vector, cand.embedding);
      if (similarity >= threshold && (!best || similarity > best.similarity)) best = { row: cand, similarity };
    }
    return best;
  }

  insert({ scope, owner = '', kind = 'fact', text, tags = [], source = '', importance = 3, embedding = null, model = '', sourceUrl = '', sourceTitle = '', capturedAt = 0, publishedAt = 0, confidence = 1, expiresAt = 0 }) {
    this.assertOpen();
    const normalized = normalizeMemoryText(text);
    const now = Date.now();
    const id = randomUUID();
    const confidenceValue = Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 1;
    this.db.prepare(`INSERT INTO memories (id, scope, owner, kind, text, hash, tags, source, importance, created_at, updated_at, used_at, use_count, embedding, dim, model, source_url, source_title, captured_at, published_at, confidence, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, scope, owner, kind, normalized, memoryHash(scope, owner, normalized), JSON.stringify(tags), String(source || '').slice(0, 40),
      Math.max(1, Math.min(5, Number(importance) || 3)), now, now,
      embedding ? toBuffer(embedding) : null, embedding ? embedding.length : 0, embedding ? String(model || '') : '',
      String(sourceUrl || '').slice(0, 1000), String(sourceTitle || '').slice(0, 300),
      Number(capturedAt) || (sourceUrl ? now : 0), Number(publishedAt) || 0, confidenceValue, Number(expiresAt) || 0
    );
    return this.get(id);
  }

  update(id, { text, kind, tags, importance, embedding = null, model = '', sourceUrl, sourceTitle, capturedAt, publishedAt, confidence, expiresAt }) {
    this.assertOpen();
    const current = this.get(id);
    if (!current) return null;
    const normalized = normalizeMemoryText(text ?? current.text);
    const nextTags = Array.isArray(tags) ? [...new Set([...(current.tags || []), ...tags])].slice(0, 5) : current.tags;
    const nextImportance = Math.max(1, Math.min(5, Number(importance ?? current.importance) || 3));
    const nextHash = memoryHash(current.scope, current.owner, normalized);
    const nextSourceUrl = sourceUrl === undefined ? current.source_url : String(sourceUrl || '').slice(0, 1000);
    const nextSourceTitle = sourceTitle === undefined ? current.source_title : String(sourceTitle || '').slice(0, 300);
    const nextCaptured = capturedAt === undefined ? current.captured_at : (Number(capturedAt) || 0);
    const nextPublished = publishedAt === undefined ? current.published_at : (Number(publishedAt) || 0);
    const nextConfidence = confidence === undefined ? current.confidence : (Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : current.confidence);
    const nextExpires = expiresAt === undefined ? current.expires_at : (Number(expiresAt) || 0);
    if (embedding?.length) {
      this.db.prepare(`UPDATE memories SET text = ?, hash = ?, kind = ?, tags = ?, importance = ?, updated_at = ?, embedding = ?, dim = ?, model = ?, source_url = ?, source_title = ?, captured_at = ?, published_at = ?, confidence = ?, expires_at = ? WHERE id = ?`).run(
        normalized, nextHash, kind || current.kind, JSON.stringify(nextTags), nextImportance, Date.now(),
        toBuffer(embedding), embedding.length, String(model || ''), nextSourceUrl, nextSourceTitle, nextCaptured, nextPublished, nextConfidence, nextExpires, id
      );
    } else {
      // 没有新向量时保留旧向量，避免“重复记住同一句话”把已有嵌入抹掉。
      this.db.prepare(`UPDATE memories SET text = ?, hash = ?, kind = ?, tags = ?, importance = ?, updated_at = ?, source_url = ?, source_title = ?, captured_at = ?, published_at = ?, confidence = ?, expires_at = ? WHERE id = ?`).run(
        normalized, nextHash, kind || current.kind, JSON.stringify(nextTags), nextImportance, Date.now(), nextSourceUrl, nextSourceTitle, nextCaptured, nextPublished, nextConfidence, nextExpires, id
      );
    }
    return this.get(id);
  }

  recordConflict({memoryId, oldText, newText, oldSourceUrl = '', newSourceUrl = '', at = Date.now()}) {
    this.assertOpen();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO memory_conflicts (id, memory_id, old_text, new_text, old_source_url, new_source_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, String(memoryId), String(oldText).slice(0, 2000), String(newText).slice(0, 2000), String(oldSourceUrl).slice(0, 1000), String(newSourceUrl).slice(0, 1000), at);
    return {id, memoryId, oldText: String(oldText).slice(0, 2000), newText: String(newText).slice(0, 2000), createdAt: at};
  }

  resolveConflict(id, at = Date.now()) {
    this.assertOpen();
    const result = this.db.prepare('UPDATE memory_conflicts SET resolved_at = ? WHERE id = ? AND resolved_at = 0').run(at, String(id));
    return {ok: result.changes > 0, id: String(id), resolvedAt: result.changes > 0 ? at : 0};
  }

  conflictsFor(memoryId) {
    this.assertOpen();
    return this.db.prepare('SELECT * FROM memory_conflicts WHERE memory_id = ? ORDER BY created_at DESC LIMIT 20').all(String(memoryId)).map(row => ({
      id: row.id, memoryId: row.memory_id, oldText: row.old_text, newText: row.new_text,
      oldSourceUrl: row.old_source_url, newSourceUrl: row.new_source_url,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null
    }));
  }

  remove(id) {
    this.assertOpen();
    const row = this.get(id);
    if (!row) return null;
    this.db.prepare('DELETE FROM memory_reviews WHERE memory_id = ?').run(String(id));
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(String(id));
    return row;
  }

  /** 后台编辑：标签按提交值替换；正文变化时清除旧向量，避免用旧语义继续检索新文本。 */
  updateAdmin(id, {text, kind, tags, importance} = {}) {
    this.assertOpen();
    const current = this.get(id);
    if (!current) return null;
    const normalized = normalizeMemoryText(text ?? current.text);
    if (!normalized) throw new Error('记忆正文不能为空');
    if (normalized.length > 500) throw new Error('一条记忆最多 500 字');
    const nextKind = KINDS.includes(kind) ? kind : current.kind;
    const nextTags = Array.isArray(tags) ? [...new Set(tags.map(tag => normalizeMemoryText(tag).slice(0, 20)).filter(Boolean))].slice(0, 5) : current.tags;
    const nextImportance = Math.max(1, Math.min(5, Number(importance ?? current.importance) || 3));
    const changed = normalized !== current.text;
    const nextHash = memoryHash(current.scope, current.owner, normalized);
    this.db.prepare(`UPDATE memories SET text = ?, hash = ?, kind = ?, tags = ?, importance = ?, updated_at = ?,
      embedding = CASE WHEN ? THEN NULL ELSE embedding END,
      dim = CASE WHEN ? THEN 0 ELSE dim END,
      model = CASE WHEN ? THEN '' ELSE model END
      WHERE id = ?`).run(
      normalized, nextHash, nextKind, JSON.stringify(nextTags), nextImportance, Date.now(),
      changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, String(id)
    );
    return this.get(id);
  }

  markUsed(ids) {
    this.assertOpen();
    if (!ids?.length) return;
    const statement = this.db.prepare('UPDATE memories SET used_at = ?, use_count = use_count + 1 WHERE id = ?');
    const now = Date.now();
    for (const id of ids) statement.run(now, String(id));
  }

  // 当前聊天可见的记录：global + 该用户 + 当前群。
  visible({ actor = '', group = '' } = {}) {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT * FROM memories WHERE scope = 'global' OR (scope = 'user' AND owner = ?) OR (scope = 'group' AND owner = ? AND ? <> '') ORDER BY updated_at DESC LIMIT 5000`).all(String(actor || ''), String(group || ''), String(group || ''));
    return rows.map(value => { const row = this.row(value); row.embedding = toVector(value.embedding); return row; });
  }

  recall({ actor = '', group = '', query = '', vector = null, model = '', limit = 6, now = Date.now() } = {}) {
    this.assertOpen();
    const scored = [];
    for (const row of this.visible({ actor, group })) {
      const hit = scoreMemory(row, { vector, model, query, now });
      if (hit) scored.push({ ...row, score: Math.round(hit.score * 1000) / 1000, cos: hit.cos === null ? null : Math.round(hit.cos * 1000) / 1000 });
    }
    scored.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
    return scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 6)));
  }

  list({offset = 0, limit = 30, query = '', scope = '', kind = '', sort = 'updated'} = {}) {
    this.assertOpen();
    const conditions = [];
    const args = [];
    const text = String(query || '').trim();
    if (text) {
      const like = `%${text.replace(/[%_\\]/g, value => '\\' + value)}%`;
      conditions.push("(text LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      args.push(like, like);
    }
    if (scope) { conditions.push('scope = ?'); args.push(String(scope)); }
    if (kind) { conditions.push('kind = ?'); args.push(String(kind)); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const order = sort === 'created' ? 'created_at DESC'
      : sort === 'oldest' ? 'updated_at ASC'
        : sort === 'importance' ? 'importance DESC, updated_at DESC'
          : 'updated_at DESC';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM memories ${where}`).get(...args)?.n || 0);
    const rows = this.db.prepare(`SELECT * FROM memories ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, Math.max(1, Math.min(100, limit)), Math.max(0, offset));
    return {total, rows: rows.map(value => this.row(value))};
  }

  expired({limit = 20, now = Date.now()} = {}) {
    this.assertOpen();
    const rows = this.db.prepare('SELECT * FROM memories WHERE expires_at > 0 AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?')
      .all(Number(now), Math.max(1, Math.min(100, Number(limit) || 20)));
    return rows.map(value => this.row(value));
  }

  reviewRows(memoryId) {
    this.assertOpen();
    return this.db.prepare('SELECT * FROM memory_reviews WHERE memory_id = ? ORDER BY reviewed_at ASC').all(String(memoryId))
      .map(row => ({
        id: row.id,
        memoryId: row.memory_id,
        reviewedAt: Number(row.reviewed_at),
        scheduledFor: Number(row.scheduled_for),
        outcome: row.outcome,
        intervalIndex: Number(row.interval_index),
        note: row.note
      }));
  }

  reviewCounts() {
    this.assertOpen();
    const rows = this.db.prepare('SELECT memory_id, COUNT(*) AS n, MAX(reviewed_at) AS last FROM memory_reviews GROUP BY memory_id').all();
    return new Map(rows.map(row => [row.memory_id, {count: Number(row.n), last: Number(row.last) || 0}]));
  }

  reviewSummary(now = Date.now()) {
    this.assertOpen();
    const total = this.count();
    const reviewedToday = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_reviews WHERE reviewed_at >= ?').get(startOfToday(now))?.n || 0);
    const reviewedTotal = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_reviews').get()?.n || 0);
    const memories = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT 5000').all().map(value => this.row(value));
    const counts = this.reviewCounts();
    const due = [];
    for (const row of memories) {
      const info = counts.get(row.id) || {count: 0, last: 0};
      const dueAt = reviewDueAt(row, info, now);
      if (dueAt <= now) due.push({row, dueAt, reviewCount: info.count, lastReviewedAt: info.last});
    }
    due.sort((a, b) => a.dueAt - b.dueAt || b.row.importance - a.row.importance);
    return {total, due, reviewedToday, reviewedTotal, counts};
  }

  addReview({memoryId, reviewedAt = Date.now(), scheduledFor = 0, note = '', outcome = 'reviewed'} = {}) {
    this.assertOpen();
    const memory = this.get(memoryId);
    if (!memory) return null;
    const previous = this.reviewRows(memoryId).length;
    const intervalIndex = Math.min(previous, REVIEW_INTERVALS_HOURS.length - 1);
    const id = randomUUID();
    this.db.prepare('INSERT INTO memory_reviews (id, memory_id, reviewed_at, scheduled_for, outcome, interval_index, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, String(memoryId), Number(reviewedAt), Number(scheduledFor) || 0, String(outcome || 'reviewed').slice(0, 20), intervalIndex, String(note || '').slice(0, 200));
    return {
      id, memoryId: String(memoryId), reviewedAt: Number(reviewedAt), scheduledFor: Number(scheduledFor) || 0,
      outcome: String(outcome || 'reviewed'), intervalIndex, note: String(note || '').slice(0, 200)
    };
  }

  graph({limit = 120, similarity = 0.82} = {}) {
    this.assertOpen();
    const maxNodes = Math.max(2, Math.min(200, Number(limit) || 120));
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY importance DESC, updated_at DESC LIMIT ?').all(maxNodes)
      .map(value => {
        const row = this.row(value);
        row.embedding = toVector(value.embedding);
        return row;
      });
    const nodes = rows.map(row => ({
      id: row.id,
      label: String(row.text).slice(0, 60),
      scope: row.scope,
      owner: row.owner,
      kind: row.kind,
      importance: row.importance,
      tags: row.tags,
      hasVector: Boolean(row.dim && row.embedding?.length),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    }));
    const edges = [];
    const seen = new Set();
    const addEdge = (a, b, kind, weight, meta = {}) => {
      if (!a || !b || a === b) return;
      const [x, y] = a < b ? [a, b] : [b, a];
      const key = kind + ':' + x + ':' + y;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({source: x, target: y, kind, weight: Math.round(weight * 1000) / 1000, inferred: true, ...meta});
    };
    const byTag = new Map();
    for (const row of rows) for (const tag of row.tags || []) {
      const key = String(tag).trim().toLowerCase();
      if (!key) continue;
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key).push(row);
    }
    for (const [tag, group] of byTag) {
      const ordered = group.slice().sort((a, b) => b.updated_at - a.updated_at);
      const max = Math.min(ordered.length - 1, 8);
      for (let index = 0; index < max; index += 1) addEdge(ordered[index].id, ordered[index + 1].id, 'shared-tag', 0.6, {label: tag});
    }
    const threshold = Math.max(0.5, Math.min(0.99, Number(similarity) || 0.82));
    for (let i = 0; i < rows.length; i += 1) {
      const a = rows[i];
      if (!a.embedding?.length || !a.dim) continue;
      for (let j = i + 1; j < rows.length; j += 1) {
        const b = rows[j];
        if (!b.embedding?.length || b.dim !== a.dim || b.model !== a.model) continue;
        const score = cosine(a.embedding, b.embedding);
        if (score >= threshold) addEdge(a.id, b.id, 'similarity', score, {label: '相似度 ' + Math.round(score * 100) + '%'});
      }
    }
    const degree = new Map(nodes.map(node => [node.id, 0]));
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    for (const node of nodes) node.degree = degree.get(node.id) || 0;
    return {
      nodes,
      edges: edges.slice(0, 500),
      inferred: true,
      note: '连线由共享标签或已保存向量的余弦相似度计算，属于推断关系，不是人工确认的事实。'
    };
  }

  stats() {
    this.assertOpen();
    const total = this.count();
    const byScope = Object.fromEntries(this.db.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all().map(row => [row.scope, Number(row.n)]));
    const vectors = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE dim > 0').get()?.n || 0);
    const models = this.db.prepare("SELECT model, COUNT(*) AS n FROM memories WHERE model <> '' GROUP BY model").all().map(row => ({ model: row.model, count: Number(row.n) }));
    const latest = Number(this.db.prepare('SELECT MAX(updated_at) AS t FROM memories').get()?.t || 0);
    const expired = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE expires_at > 0 AND expires_at <= ?').get(Date.now())?.n || 0);
    return { total, byScope, vectors, models, latest, expired };
  }

  prune({ days = 730, max = 2000, now = Date.now() } = {}) {
    this.assertOpen();
    const removed = [];
    const cutoff = now - Math.max(1, days) * 86400000;
    const deleteOne = this.db.prepare('DELETE FROM memories WHERE id = ?');
    for (const row of this.db.prepare('SELECT id FROM memories WHERE updated_at < ?').all(cutoff)) { removed.push(row.id); deleteOne.run(row.id); }
    const overflow = this.count() - Math.max(1, max);
    if (overflow > 0) {
      for (const row of this.db.prepare('SELECT id FROM memories ORDER BY importance ASC, use_count ASC, updated_at ASC LIMIT ?').all(overflow)) { removed.push(row.id); deleteOne.run(row.id); }
    }
    return removed;
  }
}
