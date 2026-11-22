// Durable activity and provider usage. Prompts, arguments and private bodies never enter this store.
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const ZONE = 'Asia/Shanghai';
const clean = (value, max = 160) => String(value || '').replace(/[\u0000-\u001f]/g, '').slice(0, max);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const activityDay = (at = Date.now()) => new Intl.DateTimeFormat('en-CA', {timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit'}).format(at);

export function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].map(key => [key, count(value[key])]));
  if (Object.values(usage).every(item => item === null)) return null;
  // DSH's input and cache buckets are disjoint. Reasoning is part of output.
  const known = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (usage[key] || 0), 0);
  usage.knownTokens = known;
  usage.complete = usage.totalTokens !== null && usage.totalTokens >= known;
  if (usage.totalTokens !== null && usage.totalTokens < known) usage.totalTokens = null;
  return usage;
}

function windowFor(date) {
  const day = date || activityDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式应为 YYYY-MM-DD');
  const start = Date.parse(day + 'T00:00:00+08:00');
  if (!Number.isFinite(start) || activityDay(start) !== day) throw new Error('日期无效');
  return {date: day, start, end: start + 86400000};
}

function page(query = {}) {
  return {offset: Math.max(0, Math.min(1000000, Math.trunc(Number(query.offset) || 0))), limit: Math.max(1, Math.min(100, Math.trunc(Number(query.limit) || 50)))};
}

export class ActivityStore {
  constructor(dir, {now = Date.now} = {}) { this.dir = dir; this.now = now; }

  async open() {
    await mkdir(this.dir, {recursive: true});
    this.db = new DatabaseSync(path.join(this.dir, 'activity.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;'
      + 'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT, purpose TEXT, platform TEXT, chat_key TEXT, session_id TEXT, request_id TEXT, provider TEXT, model TEXT, status TEXT, duration_ms INTEGER, usage TEXT, detail TEXT);'
      + 'CREATE INDEX IF NOT EXISTS events_day ON events(at,kind);'
      + 'CREATE TABLE IF NOT EXISTS messages (platform TEXT, chat_key TEXT, id TEXT, at INTEGER, direction TEXT, sender TEXT, text TEXT, source TEXT, kind TEXT, truncated INTEGER, PRIMARY KEY(platform,chat_key,id));'
      + 'CREATE INDEX IF NOT EXISTS messages_room ON messages(chat_key,at);'
      + 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT);');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('startedAt', String(this.now()));
    this.db.prepare("UPDATE events SET status='interrupted' WHERE status='running'").run();
    this.prune();
    return this;
  }

  record(value = {}) {
    if (!this.db) return null;
    const at = Number.isFinite(value.at) ? value.at : this.now();
    if (at < this.now() - 90 * 86400000) return null;
    const id = clean(value.id || randomUUID(), 700);
    const usage = normalizeUsage(value.usage);
    const detail = {};
    for (const key of ['capability', 'source', 'evidence', 'videoId', 'errorCode', 'title']) {
      if (value[key]) detail[key] = clean(value[key], key === 'title' ? 240 : 160);
    }
    this.db.prepare('INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, at, clean(value.kind || 'activity'), clean(value.purpose), clean(value.platform), clean(value.chatKey, 300), clean(value.sessionId), clean(value.requestId), clean(value.provider), clean(value.model), clean(value.status || 'completed'), Math.max(0, Math.round(Number(value.durationMs) || 0)), usage ? JSON.stringify(usage) : null, JSON.stringify(detail));
    return id;
  }

  message(msg) {
    if (!this.db || !msg?.key || !msg?.id) return;
    const at = Number(msg.time) * 1000;
    if (!Number.isFinite(at) || at < this.now() - 90 * 86400000) return;
    const platform = msg.platform || 'qq';
    const direction = msg.direction || (String(msg.user) === String(msg.bot) ? 'outbound' : 'inbound');
    const text = String(msg.text || '').slice(0, 12000);
    this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(clean(platform), clean(msg.key, 300), clean(msg.id), at, direction, clean(msg.sender || msg.user, 100), text, 'platform-api', clean(msg.kind), Number(String(msg.text || '').length > text.length));
    this.record({id: 'message:' + platform + ':' + msg.key + ':' + msg.id, at, kind: 'message', purpose: direction === 'outbound' ? 'message-send' : 'message-receive', platform, chatKey: msg.key, status: direction === 'outbound' ? 'sent' : 'received', source: 'platform-api'});
  }

  filter(query = {}) {
    const day = windowFor(query.date);
    const clauses = ['at>=?', 'at<?'], args = [day.start, day.end];
    for (const [key, column] of [['kind', 'kind'], ['platform', 'platform'], ['purpose', 'purpose'], ['model', 'model'], ['status', 'status'], ['chatKey', 'chat_key']]) {
      if (query[key]) { clauses.push(column + '=?'); args.push(clean(query[key], 300)); }
    }
    return {day, where: clauses.join(' AND '), args};
  }

  list(query = {}) {
    const {where, args} = this.filter(query), {offset, limit} = page(query);
    const total = this.db.prepare('SELECT count(*) AS n FROM events WHERE ' + where).get(...args).n;
    const items = this.db.prepare('SELECT * FROM events WHERE ' + where + ' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(...args, limit, offset).map(row => this.event(row));
    return {items, total, offset, hasMore: offset + items.length < total};
  }

  event(row) {
    return {id: row.id, at: row.at, kind: row.kind, purpose: row.purpose, platform: row.platform, chatKey: row.chat_key, sessionId: row.session_id, requestId: row.request_id, provider: row.provider, model: row.model, status: row.status, durationMs: row.duration_ms, usage: row.usage ? JSON.parse(row.usage) : null, ...JSON.parse(row.detail)};
  }

  summary(query = {}) {
    const {day, where, args} = this.filter(query);
    const rows = this.db.prepare('SELECT * FROM events WHERE ' + where).all(...args).map(row => this.event(row));
    const calls = rows.filter(row => row.kind === 'model');
    const totals = {calls: calls.length, reportedCalls: 0, unknownCalls: 0, incompleteCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0};
    const byPurpose = new Map(), byModel = new Map();
    const hourly = Array.from({length: 24}, (_, hour) => ({hour, tokens: 0, calls: 0, unknownCalls: 0}));
    for (const call of calls) {
      const hour = hourly[Math.floor((call.at - day.start) / 3600000)];
      hour.calls++;
      if (call.usage) {
        totals.reportedCalls++;
        if (!call.usage.complete) totals.incompleteCalls++;
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) totals[key] += call.usage[key] || 0;
      } else { totals.unknownCalls++; hour.unknownCalls++; }
      const tokens = call.usage?.totalTokens ?? call.usage?.knownTokens ?? 0;
      totals.totalTokens += tokens; hour.tokens += tokens;
      for (const [map, key] of [[byPurpose, call.purpose || 'unclassified'], [byModel, call.provider + '/' + call.model]]) {
        const group = map.get(key) || {key, calls: 0, tokens: 0, unknownCalls: 0};
        group.calls++; group.tokens += tokens; group.unknownCalls += Number(!call.usage); map.set(key, group);
      }
    }
    return {date: day.date, timeZone: ZONE, startedAt: Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('startedAt').value), retentionDays: 90, totals, byPurpose: [...byPurpose.values()].sort((a, b) => b.tokens - a.tokens), byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens), hourly, activities: rows.length, kinds: Object.fromEntries(['model', 'action', 'message', 'media'].map(kind => [kind, rows.filter(row => row.kind === kind).length])), failedCalls: calls.filter(row => ['failed', 'aborted', 'interrupted', 'error'].includes(row.status)).length};
  }

  conversations(query = {}) {
    const {offset, limit} = page(query);
    const args = query.platform ? [clean(query.platform)] : [];
    const where = query.platform ? 'WHERE platform=?' : '';
    const rows = this.db.prepare('SELECT platform,chat_key AS key,kind,count(*) AS count,max(at) AS lastAt FROM messages ' + where + ' GROUP BY platform,chat_key ORDER BY lastAt DESC').all(...args);
    return {items: rows.slice(offset, offset + limit), total: rows.length, offset, hasMore: offset + limit < rows.length};
  }

  messages(query = {}) {
    if (!query.key) throw new Error('请选择会话');
    const key = clean(query.key, 300), {offset, limit} = page(query);
    const where = query.platform ? 'chat_key=? AND platform=?' : 'chat_key=?';
    const args = query.platform ? [key, clean(query.platform)] : [key];
    const total = this.db.prepare('SELECT count(*) AS n FROM messages WHERE ' + where).get(...args).n;
    const items = this.db.prepare('SELECT id,at,direction,sender,text,source,kind,truncated FROM messages WHERE ' + where + ' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(...args, limit, offset).reverse();
    return {items, total, offset, hasMore: offset + items.length < total};
  }

  prune() {
    const cutoff = this.now() - 90 * 86400000;
    this.db.prepare('DELETE FROM events WHERE at<?').run(cutoff);
    this.db.prepare('DELETE FROM messages WHERE at<?').run(cutoff);
  }

  close() { this.db?.close(); this.db = null; }
}
