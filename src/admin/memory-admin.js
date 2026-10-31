// 长期记忆管理页的数据服务。
//
// 读写都经过 MemoryStore（SQLite）；列表不返回向量，设置页不回显嵌入密钥。
// 星图边与复习曲线都带有“推断/理论”标记，不能当成系统已确认的事实。
import {
  KINDS, SCOPES, KIND_LABELS, SCOPE_LABELS, REVIEW_INTERVALS_HOURS, REVIEW_MODEL,
  reviewState, theoreticalRetention, memoryHash, RETRIEVAL_MODEL
} from '../builtins/memory/store.js';

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    scopeLabel: SCOPE_LABELS[row.scope] || row.scope,
    owner: row.owner,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind] || row.kind,
    text: row.text,
    tags: [...(row.tags || [])],
    importance: Number(row.importance) || 3,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
    useCount: Number(row.use_count) || 0,
    hasVector: Boolean(row.dim),
    model: row.model || '',
    source: row.source || '',
    sourceUrl: row.source_url || '', sourceTitle: row.source_title || '',
    capturedAt: row.captured_at || 0, publishedAt: row.published_at || 0,
    confidence: Number(row.confidence ?? 1), expiresAt: row.expires_at || 0
  };
}

function safeConfig(config) {
  const value = {...config};
  const keyConfigured = Boolean(value.embeddingKey);
  delete value.embeddingKey;
  return {config: value, secrets: {embeddingKeyConfigured: keyConfigured}};
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,，]+/);
  return [...new Set(list.map(tag => String(tag).trim().slice(0, 20)).filter(Boolean))].slice(0, 5);
}

export function createMemoryAdmin({store, getItem, now = () => Date.now()}) {
  const requireStore = () => {
    if (!store) throw new Error('长期记忆库不可用；请检查 Node SQLite 与数据目录');
    return store;
  };

  function item() {
    const value = getItem();
    if (!value) throw new Error('长期记忆插件当前未注册');
    return value;
  }

  function overview() {
    const value = item();
    const memory = requireStore();
    const stats = memory.stats();
    const review = memory.reviewSummary(now());
    return {
      id: 'qq-memory',
      name: value.manifest?.name || '长期记忆',
      version: value.manifest?.version || '',
      description: value.manifest?.description || '',
      enabled: value.enabled === true,
      registered: value.registered === true,
      uninstalled: value.uninstalled === true,
      health: value.health || {},
      error: value.error || null,
      migrationError: value.migrationError || null,
      scope: value.scope || null,
      ...safeConfig(value.config || {}),
      stats: {
        total: stats.total,
        byScope: stats.byScope,
        vectors: stats.vectors,
        models: stats.models,
        latest: stats.latest ? new Date(stats.latest).toISOString() : null,
        expired: stats.expired || 0,
        due: review.due.length,
        reviewedToday: review.reviewedToday,
        reviewedTotal: review.reviewedTotal
      },
      reviewModel: {
        intervalsHours: [...REVIEW_INTERVALS_HOURS],
        baseStabilityHours: REVIEW_MODEL.baseStabilityHours,
        formula: REVIEW_MODEL.formula,
        note: '理论曲线只用于安排复习；真实复习记录来自本机 memory_reviews 表。'
      },
      retrievalModel: RETRIEVAL_MODEL
    };
  }

  function list(query = {}) {
    const memory = requireStore();
    const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const scope = SCOPES.includes(query.scope) ? query.scope : '';
    const kind = KINDS.includes(query.kind) ? query.kind : '';
    const sort = ['updated', 'created', 'oldest', 'importance'].includes(query.sort) ? query.sort : 'updated';
    const {total, rows} = memory.list({
      offset, limit, sort, scope, kind,
      query: String(query.query || '').trim().slice(0, 80)
    });
    const counts = memory.reviewCounts();
    const at = now();
    return {
      items: rows.map(row => {
        const info = counts.get(row.id) || {count: 0, last: 0};
        const history = info.count ? Array.from({length: info.count}, () => ({reviewedAt: info.last})) : [];
        const state = reviewState(row, history, at);
        return {...publicRow(row), reviewCount: info.count, nextReviewAt: state.nextDue ? new Date(state.nextDue).toISOString() : null, due: state.due};
      }),
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total
    };
  }

  function get(id) {
    const memory = requireStore();
    const row = memory.get(String(id || ''));
    if (!row) throw new Error('记忆不存在');
    const reviews = memory.reviewRows(row.id);
    const graph = memory.graph({limit: 160});
    const related = [];
    for (const edge of graph.edges) {
      if (edge.source !== row.id && edge.target !== row.id) continue;
      const otherId = edge.source === row.id ? edge.target : edge.source;
      const node = graph.nodes.find(item => item.id === otherId);
      if (node) related.push({
        id: node.id,
        label: node.label,
        kind: edge.kind,
        weight: edge.weight,
        relation: edge.kind === 'similarity' ? '向量相似度（推断）' : '共享标签：' + (edge.label || ''),
        inferred: true
      });
    }
    return {
      memory: publicRow(row),
      related: related.slice(0, 20),
      conflicts: memory.conflictsFor(row.id),
      historyAvailable: false,
      historyNote: '当前只保存最近更新时间，不保存逐次编辑历史；冲突记录单独保存在 memory_conflicts，复习记录保存在 memory_reviews。',
      reviews: reviews.map(review => ({
        id: review.id,
        reviewedAt: new Date(review.reviewedAt).toISOString(),
        scheduledFor: review.scheduledFor ? new Date(review.scheduledFor).toISOString() : null,
        outcome: review.outcome,
        intervalIndex: review.intervalIndex,
        note: review.note
      })),
      review: reviewState(row, reviews, now())
    };
  }

  function create(body = {}) {
    const memory = requireStore();
    const text = String(body.text || '').trim();
    if (!text) throw new Error('记忆正文不能为空');
    if (text.length > 500) throw new Error('一条记忆最多 500 字');
    const scope = SCOPES.includes(body.scope) ? body.scope : 'user';
    const owner = String(body.owner || '').trim();
    if (scope !== 'global' && !/^[1-9]\d{3,15}$/.test(owner)) throw new Error(scope === 'group' ? '请填写群号' : '请填写 QQ 号');
    const resolvedOwner = scope === 'global' ? '' : owner;
    const duplicate = memory.findExact(scope, resolvedOwner, memoryHash(scope, resolvedOwner, text));
    if (duplicate) throw new Error('相同范围与正文的记忆已经存在');
    const row = memory.insert({
      scope, owner: resolvedOwner, kind: KINDS.includes(body.kind) ? body.kind : 'fact', text,
      tags: normalizeTags(body.tags), importance: Number(body.importance) || 3, source: 'admin'
    });
    return {created: publicRow(row)};
  }

  function update(body = {}) {
    const memory = requireStore();
    const id = String(body.id || '');
    if (!id) throw new Error('请选择记忆');
    const row = memory.updateAdmin(id, {
      text: body.text,
      kind: body.kind,
      tags: body.tags === undefined ? undefined : normalizeTags(body.tags),
      importance: body.importance
    });
    if (!row) throw new Error('记忆不存在');
    return {memory: publicRow(row)};
  }

  function remove(id) {
    const memory = requireStore();
    const row = memory.remove(String(id || ''));
    if (!row) throw new Error('记忆不存在');
    return {removed: publicRow(row)};
  }

  function graph(query = {}) {
    const memory = requireStore();
    const value = memory.graph({limit: Number(query.limit) || 120});
    const scope = SCOPES.includes(query.scope) ? query.scope : '';
    if (!scope) return value;
    const nodes = value.nodes.filter(node => node.scope === scope);
    const ids = new Set(nodes.map(node => node.id));
    return {...value, nodes, edges: value.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))};
  }

  function reviewOverview(query = {}) {
    const memory = requireStore();
    const summary = memory.reviewSummary(now());
    const includeId = query.id ? String(query.id) : (summary.due[0]?.row.id || '');
    const due = summary.due.slice(0, 50).map(entry => ({
      ...publicRow(entry.row),
      dueAt: new Date(entry.dueAt).toISOString(),
      reviewCount: entry.reviewCount,
      lastReviewedAt: entry.lastReviewedAt ? new Date(entry.lastReviewedAt).toISOString() : null
    }));
    let detail = null;
    if (includeId) {
      const row = memory.get(includeId);
      if (!row) throw new Error('记忆不存在');
      const reviews = memory.reviewRows(includeId);
      const state = reviewState(row, reviews, now());
      detail = {
        memory: publicRow(row),
        reviews: reviews.map(review => ({
          reviewedAt: new Date(review.reviewedAt).toISOString(),
          note: review.note
        })),
        state,
        series: Array.from({length: 31}, (_, day) => ({
          day,
          hours: day * 24,
          retention: theoreticalRetention(day * 24, state.stabilityHours)
        }))
      };
    }
    return {
      stats: {
        total: summary.total,
        due: summary.due.length,
        reviewedToday: summary.reviewedToday,
        reviewedTotal: summary.reviewedTotal
      },
      due,
      detail,
      model: {
        intervalsHours: [...REVIEW_INTERVALS_HOURS],
        baseStabilityHours: REVIEW_MODEL.baseStabilityHours,
        formula: REVIEW_MODEL.formula,
        note: '理论曲线不是实际记忆测量；真实记录只有“已完成复习”的条目。'
      }
    };
  }

  function resolveConflict(body = {}) {
    const memory = requireStore();
    const id = String(body.conflictId || '');
    if (!id) throw new Error('请选择冲突记录');
    const result = memory.resolveConflict(id, now());
    if (!result.ok) throw new Error('冲突记录不存在或已处理');
    return {ok: true, id, resolvedAt: new Date(result.resolvedAt).toISOString()};
  }

  function reviewComplete(body = {}) {
    const memory = requireStore();
    const id = String(body.id || '');
    if (!id) throw new Error('请选择记忆');
    const row = memory.get(id);
    if (!row) throw new Error('记忆不存在');
    const reviewedAt = now();
    memory.addReview({memoryId: id, reviewedAt, note: String(body.note || '').slice(0, 200)});
    const reviews = memory.reviewRows(id);
    return {
      ok: true,
      memory: publicRow(row),
      review: reviewState(row, reviews, reviewedAt),
      history: reviews.map(review => ({
        id: review.id,
        reviewedAt: new Date(review.reviewedAt).toISOString(),
        note: review.note
      }))
    };
  }

  return {overview, list, get, create, update, remove, graph, reviewOverview, reviewComplete, resolveConflict};
}
