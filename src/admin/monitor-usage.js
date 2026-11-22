// 从统一活动账本聚合监控统计；不复制消息正文，不改写历史。
import {activityDay} from './activity-store.js';

const DAY_MS = 86400000;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const COMPONENTS = {
  'participation-decision': 'qq-participation', 'sticker-selection': 'qq-sticker',
  'sticker-classification': 'qq-sticker', 'memory-embedding': 'qq-memory',
  'private-thinking': 'qq-private', 'emotion-reflection': 'qq-emotion',
  'video-summary': 'qq-media-agent', 'bilibili-summary': 'qq-media-agent', 'douyin-summary': 'qq-media-agent',
  'context-compaction': 'qq-chat', compaction: 'qq-chat', 'session-title': 'qq-chat',
  autonomy: 'qq-autonomy', proactive: 'qq-proactive', observer: 'qq-participation',
  'write-diary': 'qq-autonomy', 'publish-qzone': 'qq-autonomy', 'learn-web': 'qq-autonomy',
  'learn-slang': 'qq-autonomy', 'browse-qzone': 'qq-autonomy', 'save-learning': 'qq-autonomy', 'task-step': 'qq-tasks'
};

export function componentOf(row) {
  if (row.purpose?.startsWith('plugin.')) return row.purpose.split('.')[1];
  if (row.kind === 'message') return 'qq-messages';
  if (row.kind === 'media') return 'qq-media-agent';
  if (COMPONENTS[row.purpose]) return COMPONENTS[row.purpose];
  if (row.purpose?.startsWith('qq.task.')) return 'qq-tasks';
  if (row.kind === 'action') return 'qq-core';
  if (row.platform === 'wechat') return 'qq-wechat';
  if (row.platform === 'qq-official') return 'qq-official-bot';
  return row.kind === 'model' ? 'qq-chat' : 'framework';
}

export function monitorStatus(value) {
  if (['completed', 'confirmed', 'success', 'succeeded', 'sent', 'received'].includes(value)) return 'success';
  if (['failed', 'error'].includes(value)) return 'failed';
  if (['aborted', 'cancelled'].includes(value)) return 'cancelled';
  if (['denied', 'denied_permission'].includes(value)) return 'denied';
  if (value === 'interrupted') return 'interrupted';
  if (['accepted', 'submitted'].includes(value)) return 'accepted';
  if (['running', 'started', 'authorized', 'pending', 'reserved'].includes(value)) return 'pending';
  return 'unknown';
}

function windowFor(query, now) {
  const range = ['today', '7d', '30d', 'all'].includes(query.range) ? query.range : 'today';
  const day = activityDay(now - (range === '7d' ? 6 : range === '30d' ? 29 : 0) * DAY_MS);
  return {range, start: range === 'all' ? 0 : Date.parse(day + 'T00:00:00+08:00')};
}

function blank() {
  return {calls: 0, success: 0, failed: 0, cancelled: 0, denied: 0, unknown: 0, accepted: 0, interrupted: 0, pending: 0,
    reportedCalls: 0, unreportedCalls: 0, incompleteCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: 0};
}

function add(target, row) {
  target.calls += row.calls;
  target[monitorStatus(row.status)] += row.calls;
  target.durationMs += row.durationMs;
  target.reportedCalls += row.reportedCalls;
  target.unreportedCalls += row.calls - row.reportedCalls;
  target.incompleteCalls += row.incompleteCalls;
  for (const key of [...TOKEN_FIELDS, 'totalTokens']) target[key] += row[key];
}

function selection(query = {}) {
  const allowed = ['kind', 'purpose', 'provider', 'model', 'platform', 'status'];
  const parts = [];
  const args = [];
  for (const key of allowed) {
    if (!query[key]) continue;
    if (typeof query[key] !== 'string' || query[key].length > 160) throw new Error('监控筛选条件无效');
    parts.push(key + ' = ?');
    args.push(query[key]);
  }
  return {parts, args};
}

export function createMonitorUsage(activity, {now = Date.now} = {}) {
  function where(query) {
    const window = windowFor(query, now());
    const filter = selection(query);
    return {...window, sql: ['at >= ?', ...filter.parts].join(' AND '), args: [window.start, ...filter.args]};
  }

  function summary(query = {}) {
    const filter = where(query);
    const numeric = TOKEN_FIELDS.map(key => 'SUM(COALESCE(json_extract(usage, \'$.' + key + '\'), 0)) AS ' + key);
    const sql = 'SELECT kind, purpose, provider, model, platform, status, COUNT(*) AS calls, SUM(duration_ms) AS durationMs,' +
      ' SUM(usage IS NOT NULL) AS reportedCalls, SUM(CASE WHEN usage IS NOT NULL AND COALESCE(json_extract(usage, \'$.complete\'), 0) = 0 THEN 1 ELSE 0 END) AS incompleteCalls,' +
      ' SUM(COALESCE(json_extract(usage, \'$.totalTokens\'), json_extract(usage, \'$.knownTokens\'), 0)) AS totalTokens, ' + numeric.join(', ') +
      ' FROM events WHERE ' + filter.sql + ' GROUP BY kind, purpose, provider, model, platform, status';
    const rows = activity.db.prepare(sql).all(...filter.args).map(row => ({...row, component: componentOf(row)})).filter(row => !query.component || row.component === query.component);
    const result = {model: blank(), tool: blank(), operation: blank(), messages: blank()};
    const groups = new Map();
    for (const row of rows) {
      const kind = row.kind === 'model' ? 'model' : row.kind === 'action' ? 'tool' : row.kind === 'message' ? 'messages' : 'operation';
      add(result[kind], row);
      const key = JSON.stringify([kind, row.component, row.purpose, row.provider, row.model, row.platform]);
      if (!groups.has(key)) groups.set(key, {kind, component: row.component, purpose: row.purpose, provider: row.provider, model: row.model, platform: row.platform, ...blank()});
      add(groups.get(key), row);
    }
    return {...result, breakdown: [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls),
      range: filter.range, sampledAt: now(), timezone: 'Asia/Shanghai', retention: {detailDays: 90},
      startedAt: Number(activity.db.prepare('SELECT value FROM meta WHERE key = ?').get('startedAt')?.value) || null};
  }

  function list(query = {}) {
    const filter = where(query);
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(query.offset) || 0)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 25)));
    let sql = filter.sql;
    const args = [...filter.args];
    if (query.component) {
      // 组件由既有用途派生，不写入/更改旧账本格式。
      const purposes = activity.db.prepare('SELECT DISTINCT kind, purpose, platform FROM events WHERE ' + sql).all(...args)
        .filter(row => componentOf(row) === query.component);
      if (!purposes.length) return {items: [], total: 0, offset, limit, hasMore: false};
      sql += ' AND (' + purposes.map(() => '(kind = ? AND purpose = ? AND platform = ?)').join(' OR ') + ')';
      for (const row of purposes) args.push(row.kind, row.purpose, row.platform);
    }
    const total = activity.db.prepare('SELECT COUNT(*) AS n FROM events WHERE ' + sql).get(...args).n;
    const items = activity.db.prepare('SELECT * FROM events WHERE ' + sql + ' ORDER BY at DESC, id DESC LIMIT ? OFFSET ?').all(...args, limit, offset)
      .map(row => activity.event(row)).map(row => ({...row, component: componentOf(row), status: monitorStatus(row.status), originalStatus: row.status}));
    return {items, total, offset, limit, hasMore: offset + items.length < total};
  }

  return {summary, list};
}
