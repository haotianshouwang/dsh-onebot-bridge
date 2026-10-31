// 自主时间管理页的数据服务：日记、日常活动/时间线、时间汇总，以及私密空间的会话封装。
//
// 所有日记与活动都来自本机 autonomy 数据目录；活动会区分“她自动做的”和“用户手动补记的”。
import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SecretVault, generateCharacterPassphrase} from './secret-vault.js';

const CATEGORY_LABELS = {diary: '写日记', qzone: '发空间', learn: '学习', slang: '学黑话', browse: '翻空间', other: '其他', work: '工作', rest: '休息', life: '生活'};
const SOURCE_LABELS = {auto: '自动生成', manual: '手动创建', autonomy: '自主活动'};

function time(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dayStart(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return 0;
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayEnd(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return 0;
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function durationMinutes(start, end) {
  return Math.max(0, Math.round((Number(end) - Number(start)) / 60000));
}

export function createAutonomyAdmin({auto, dir, getItem, log = () => {}, now = () => Date.now(), deviceKey = null, decideSecret = null}) {
  if (!auto?.store) throw new Error('自主时间存储不可用');
  const vault = new SecretVault({dir, now, deviceKey});
  const store = auto.store;
  const decisionFile = path.join(dir, 'secret-decision.json');
  const auditFile = path.join(dir, 'secret-audit.jsonl');
  let decision = {version: 1, status: 'undecided', lastAttempt: 0, lastError: '', shareWithOwner: false, reason: ''};

  async function open() {
    await mkdir(dir, {recursive: true});
    await vault.open();
    try {
      const raw = JSON.parse(await readFile(decisionFile, 'utf8'));
      if (raw && raw.version === 1 && ['undecided', 'declined', 'created', 'error'].includes(raw.status)) {
        decision = {...decision, ...raw};
      }
    } catch (error) {
      if (error.code !== 'ENOENT') decision.lastError = '秘密空间决策文件无法读取';
    }
    if (decision.status === 'created' && !vault.configured) {
      decision = {version: 1, status: 'error', lastAttempt: now(), lastError: '决策记录显示已创建，但秘密空间文件缺失；请从备份恢复或明确重置', shareWithOwner: false, reason: ''};
      await persistDecision();
    }
    return api;
  }

  async function persistDecision() {
    const text = JSON.stringify(decision, null, 2);
    await writeFile(decisionFile + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(decisionFile + '.tmp', decisionFile);
  }

  async function audit(event, detail = {}) {
    try {
      await appendFile(auditFile, JSON.stringify({at: new Date(now()).toISOString(), event, ...detail}) + '\n', {encoding: 'utf8', mode: 0o600});
    } catch { /* 审计失败不阻断安全操作 */ }
  }

  function secretState(session) {
    const status = vault.status(session);
    return {
      ...status,
      decision: {
        status: decision.status,
        shareWithOwner: decision.shareWithOwner === true,
        reason: decision.reason || '',
        decidedAt: decision.decidedAt || null,
        lastError: decision.lastError || ''
      }
    };
  }

  async function ensureDecision({force = false} = {}) {
    if (vault.configured) return {created: true, status: secretState(null)};
    if (!force && decision.status === 'declined') return {created: false, reason: decision.reason || '她暂时不打算创建秘密空间', status: secretState(null)};
    if (!force && decision.status === 'created') return {created: true, status: secretState(null)};
    if (typeof decideSecret !== 'function') throw new Error('当前没有可用的角色决策通道');
    if (!vault.deviceKey) throw new Error('设备凭据不可用，不能安全保存角色密码');
    const passwords = [generateCharacterPassphrase(), generateCharacterPassphrase(), generateCharacterPassphrase()];
    const options = passwords.map((_, index) => ({index, label: ['安静', '克制', '任性'][index] || '选项 ' + (index + 1)}));
    decision.lastAttempt = now();
    decision.lastError = '';
    await persistDecision();
    try {
      const verdict = await decideSecret({options});
      if (!verdict || verdict.create !== true) {
        decision = {
          version: 1, status: 'declined', lastAttempt: now(), lastError: '',
          shareWithOwner: verdict?.shareWithOwner === true, reason: String(verdict?.reason || '她暂时不打算创建秘密空间').slice(0, 300),
          decidedAt: new Date(now()).toISOString(), choice: null
        };
        await persistDecision();
        await audit('secret-declined', {reason: decision.reason});
        return {created: false, reason: decision.reason, status: secretState(null)};
      }
      const choice = Math.max(0, Math.min(passwords.length - 1, Number(verdict.choice) || 0));
      await vault.provisionCharacter({
        password: passwords[choice],
        decision: {
          shareWithOwner: verdict.shareWithOwner === true,
          reason: verdict.reason,
          choice,
          source: 'agent'
        }
      });
      passwords.fill('');
      decision = {
        version: 1, status: 'created', lastAttempt: now(), lastError: '',
        shareWithOwner: verdict.shareWithOwner === true,
        reason: String(verdict.reason || '').slice(0, 300),
        decidedAt: new Date(now()).toISOString(), choice
      };
      await persistDecision();
      await audit('secret-created', {shareWithOwner: decision.shareWithOwner, choice});
      return {created: true, status: secretState(null)};
    } catch (error) {
      passwords.fill('');
      decision.lastError = String(error?.message || error).slice(0, 300);
      decision.status = 'error';
      await persistDecision();
      throw error;
    }
  }

  function item() {
    const value = getItem();
    if (!value) throw new Error('自主时间插件当前未注册');
    return value;
  }

  function overview() {
    const value = item();
    const config = value.config || {};
    const today = now();
    const activities = store.activities || [];
    const todayActivities = activities.filter(row => dayStart(row.start) === dayStart(today));
    return {
      id: 'qq-autonomy',
      name: value.manifest?.name || '自主时间',
      version: value.manifest?.version || '',
      description: value.manifest?.description || '',
      enabled: value.enabled === true,
      registered: value.registered === true,
      uninstalled: value.uninstalled === true,
      health: value.health || {},
      error: value.error || null,
      migrationError: value.migrationError || null,
      config,
      scope: value.scope || null,
      today: {
        runs: store.total(today),
        maxRuns: config.maxRunsPerDay ?? 8,
        activities: todayActivities.length
      },
      lastActivity: activities[0] ? {
        id: activities[0].id,
        title: activities[0].title,
        category: activities[0].category,
        categoryLabel: CATEGORY_LABELS[activities[0].category] || activities[0].category,
        start: time(activities[0].start),
        end: time(activities[0].end),
        source: activities[0].source,
        sourceLabel: SOURCE_LABELS[activities[0].source] || activities[0].source
      } : null,
      next: (() => {
        try {
          const type = auto.choose(today);
          return type ? {type, label: CATEGORY_LABELS[type] || type} : null;
        } catch {
          return null;
        }
      })(),
      secret: secretState(null)
    };
  }

  async function diaryList(query = {}) {
    const all = await store.readDiaryEntries();
    const search = String(query.query || '').trim().toLowerCase();
    const from = query.from ? dayStart(query.from) : 0;
    const to = query.to ? dayEnd(query.to) : 0;
    let rows = all.filter(entry => {
      const at = Number(entry.at) || 0;
      if (from && at < from) return false;
      if (to && at > to) return false;
      if (!search) return true;
      return String(entry.title || '').toLowerCase().includes(search)
        || String(entry.text || '').toLowerCase().includes(search)
        || String(entry.mood || '').toLowerCase().includes(search);
    }).sort((a, b) => Number(b.at) - Number(a.at));
    const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 20));
    return {
      items: rows.slice(offset, offset + limit).map(entry => ({
        id: entry.id,
        title: entry.title || firstLine(entry.text),
        mood: entry.mood || '',
        at: time(entry.at),
        createdAt: time(entry.createdAt || entry.at),
        updatedAt: time(entry.updatedAt || entry.at),
        source: entry.source === 'manual' ? 'manual' : 'auto',
        sourceLabel: SOURCE_LABELS[entry.source === 'manual' ? 'manual' : 'auto'],
        excerpt: String(entry.text || '').replace(/\s+/g, ' ').slice(0, 100),
        words: String(entry.text || '').length
      })),
      total: rows.length,
      offset,
      limit,
      hasMore: offset + limit < rows.length
    };
  }

  async function diaryGet(id) {
    const entry = (await store.readDiaryEntries()).find(row => row.id === String(id));
    if (!entry) throw new Error('日记不存在');
    return {
      id: entry.id,
      title: entry.title || '',
      mood: entry.mood || '',
      text: entry.text,
      at: time(entry.at),
      source: entry.source === 'manual' ? 'manual' : 'auto',
      sourceLabel: SOURCE_LABELS[entry.source === 'manual' ? 'manual' : 'auto'],
      createdAt: time(entry.createdAt || entry.at),
      updatedAt: time(entry.updatedAt || entry.at)
    };
  }

  async function applyRetention() {
    const cfg = item().config || {};
    const removedDiary = await store.pruneDiary({
      mode: cfg.diaryRetentionMode || 'none',
      count: Number(cfg.diaryRetentionCount) || 1000,
      days: Number(cfg.diaryRetentionDays) || 365,
      now: now()
    });
    const removedActivities = await store.pruneActivities({
      mode: cfg.activityRetentionMode || 'none',
      count: Number(cfg.activityRetentionCount) || 5000,
      days: Number(cfg.activityRetentionDays) || 365,
      now: now()
    });
    if (removedDiary || removedActivities) log('info', '自主时间历史清理', {removedDiary, removedActivities});
    return {removedDiary, removedActivities};
  }

  async function diaryCreate(body = {}) {
    const entry = await store.writeDiary({
      title: String(body.title || '').slice(0, 60),
      mood: String(body.mood || '').slice(0, 20),
      text: body.text,
      now: now(),
      source: 'manual'
    });
    await applyRetention();
    log('info', '手动创建日记', {id: entry.id});
    return {created: {id: entry.id, at: time(entry.at)}};
  }

  async function diaryUpdate(body = {}) {
    const entry = await store.updateDiary(String(body.id || ''), {
      title: body.title,
      mood: body.mood,
      text: body.text
    });
    return {updated: {id: entry.id, updatedAt: time(entry.updatedAt)}};
  }

  async function diaryDelete(id) {
    const entry = await store.deleteDiary(String(id || ''));
    return {removed: {id: entry.id, title: entry.title || firstLine(entry.text)}};
  }

  async function activityList(query = {}) {
    const all = await store.readActivities();
    const from = query.from ? dayStart(query.from) : 0;
    const to = query.to ? dayEnd(query.to) : 0;
    const category = String(query.category || '');
    const source = String(query.source || '');
    let rows = all.filter(row => {
      if (from && row.start < from) return false;
      if (to && row.start > to) return false;
      if (category && row.category !== category) return false;
      if (source && row.source !== source) return false;
      return true;
    });
    const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    return {
      items: rows.slice(offset, offset + limit).map(publicActivity),
      total: rows.length,
      offset,
      limit,
      hasMore: offset + limit < rows.length,
      categories: [...new Set(all.map(row => row.category))].map(key => ({key, label: CATEGORY_LABELS[key] || key})),
      sources: [...new Set(all.map(row => row.source))].map(key => ({key, label: SOURCE_LABELS[key] || key}))
    };
  }

  async function activityCreate(body = {}) {
    const row = await store.addActivity({
      title: body.title,
      description: body.description,
      start: parseDate(body.start),
      end: parseDate(body.end),
      category: body.category || 'other',
      source: 'manual',
      diaryId: body.diaryId || ''
    });
    await applyRetention();
    return {created: publicActivity(row)};
  }

  async function activityUpdate(body = {}) {
    const row = await store.updateActivity(String(body.id || ''), {
      title: body.title,
      description: body.description,
      start: body.start ? parseDate(body.start) : undefined,
      end: body.end ? parseDate(body.end) : undefined,
      category: body.category,
      diaryId: body.diaryId
    });
    return {updated: publicActivity(row)};
  }

  async function activityDelete(id) {
    const row = await store.deleteActivity(String(id || ''));
    return {removed: publicActivity(row)};
  }

  async function timeSummary(query = {}) {
    const all = await store.readActivities();
    const from = query.from ? dayStart(query.from) : dayStart(now()) - 6 * 86400000;
    const to = query.to ? dayEnd(query.to) : dayEnd(now());
    const rows = all.filter(row => row.start >= from && row.start <= to);
    const byCategory = new Map();
    const byDay = new Map();
    for (const row of rows) {
      const minutes = durationMinutes(row.start, row.end);
      const category = row.category || 'other';
      byCategory.set(category, (byCategory.get(category) || 0) + minutes);
      const key = new Date(row.start).toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) || 0) + minutes);
    }
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      totalMinutes: rows.reduce((sum, row) => sum + durationMinutes(row.start, row.end), 0),
      byCategory: [...byCategory.entries()].map(([key, minutes]) => ({key, label: CATEGORY_LABELS[key] || key, minutes})).sort((a, b) => b.minutes - a.minutes),
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, minutes]) => ({day, minutes})),
      items: rows.sort((a, b) => b.start - a.start).map(publicActivity)
    };
  }

  async function secret(op, body = {}, session) {
    if (!session) throw new Error('秘密空间只能从管理站点访问');
    switch (op) {
      case 'status': return {status: secretState(session)};
      case 'decide': {
        const result = await ensureDecision({force: body.force === true});
        return {...result, status: secretState(session)};
      }
      case 'setup': {
        // 仅供旧版迁移/测试；新界面不再要求用户替角色设置密码。
        if (body.legacy !== true) throw new Error('秘密空间密码由角色自主设置；请在页面请求她决定');
        const status = await vault.setup(session, body.password);
        await audit('secret-legacy-setup');
        return {status: secretState(session)};
      }
      case 'unlock': {
        const status = await vault.unlockWithPassword(session, body.password);
        await audit('secret-unlock', {mode: status.mode});
        return {status: secretState(session)};
      }
      case 'request-share': {
        const state = secretState(session);
        if (state.mode !== 'character') throw new Error('当前不是角色密码空间');
        if (state.character?.shareWithOwner !== true) throw new Error('她选择不分享这个空间');
        const status = await vault.unlockCharacter(session);
        await audit('secret-shared-with-owner');
        return {status: secretState(session)};
      }
      case 'lock': vault.lock(session); return {status: secretState(session)};
      case 'list': return {status: secretState(session), items: vault.list(session)};
      case 'get': return {secret: vault.read(session, String(body.id || ''))};
      case 'create': {
        const created = await vault.create(session, {title: body.title, body: body.text});
        return {created, status: secretState(session)};
      }
      case 'update': {
        const updated = await vault.update(session, String(body.id || ''), {title: body.title, body: body.text});
        return {updated, status: secretState(session)};
      }
      case 'remove': {
        const removed = await vault.remove(session, String(body.id || ''));
        return {removed, status: secretState(session)};
      }
      case 'change-password': {
        const status = await vault.changePassword(session, String(body.current || ''), String(body.password || ''));
        await audit('secret-password-changed', {mode: 'user'});
        return {status: secretState(session)};
      }
      case 'reset': {
        const status = await vault.reset(session, String(body.confirmation || ''));
        decision = {version: 1, status: 'undecided', lastAttempt: 0, lastError: '', shareWithOwner: false, reason: ''};
        await persistDecision();
        await audit('secret-reset');
        return {status: secretState(session)};
      }
      default: throw new Error('不支持的秘密空间操作');
    }
  }

  function lockSession(session) {
    vault.lock(session);
    vault.lockPrefix(String(session || '') + '|');
  }

  const api = {
    open, overview, diaryList, diaryGet, diaryCreate, diaryUpdate, diaryDelete,
    activityList, activityCreate, activityUpdate, activityDelete, timeSummary,
    secret, lockSession, vault, ensureDecision, secretState, applyRetention
  };
  return api;
}

function publicActivity(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    start: time(row.start),
    end: time(row.end),
    minutes: durationMinutes(row.start, row.end),
    category: row.category || 'other',
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    source: row.source === 'autonomy' ? 'autonomy' : 'manual',
    sourceLabel: SOURCE_LABELS[row.source === 'autonomy' ? 'autonomy' : 'manual'],
    diaryId: row.diaryId || '',
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt)
  };
}

function parseDate(value) {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error('时间格式无效');
  return ms;
}

function firstLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名日记';
}
