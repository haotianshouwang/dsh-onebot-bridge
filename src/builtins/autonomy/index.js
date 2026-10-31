// 自主时间：在没人说话的时候，让她自己安排一点事——写日记、发空间、查资料、学群里的黑话、翻朋友的空间。
//
// 边界：
// - 默认停用；即使启用，发空间/评论也各有开关和每日上限，且只对配置里列出的 QQ 翻阅空间。
// - 每次活动都是一次独立的受限会话：只能调用本活动白名单里的动作，不能发 QQ 消息，不能改权限。
// - 日记和活动记录存在插件数据目录，不上传；群聊缓冲只在内存里保留最近消息，用来学黑话，不落盘。
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const manifest = {
  id: 'qq-autonomy', name: '自主时间', version: '1.0.0', bundled: true,
  apiVersion: 2, type: 'native-source', entry: 'src/builtins/autonomy/index.js',
  description: '让她在空闲时自己写日记、发空间、上网学习、学群里的黑话、翻朋友的空间；默认停用，写入类活动默认关闭。',
  dependencies: { framework: '>=0.12.0' }, configVersion: 1,
  capabilities: ['actions', 'context', 'events'],
  configSchema: {
    enabled: { type: 'boolean', title: '启用自主时间', default: false, description: '总开关。关闭后不安排任何自主活动，也不注入时间信息。' },
    activeHours: { type: 'string', title: '活动时段', default: '09:00-23:30', maxLength: 20, description: '格式 HH:MM-HH:MM，跨午夜可写 22:00-02:00。' },
    runLimitMode: { type: 'string', title: '自主活动次数策略', enum: ['recommended', 'custom', 'unlimited'], default: 'recommended', description: 'recommended 使用推荐上限；custom 使用自定义上限；unlimited 不设固定业务上限，但调度仍每分钟最多一次并受活动时段约束。' },
    maxRunsPerDay: { type: 'number', title: '每天最多自主活动次数（推荐/自定义）', default: 8, min: 1, max: 1440, integer: true },
    autoRecordActivities: { type: 'boolean', title: '自动活动写入时间线', default: true, description: '自主活动完成后，把开始/结束时间、类别和结果写入本机活动记录；关闭后只保留运行日志。' },
    diaryRetentionMode: { type: 'string', title: '日记保留策略', enum: ['none', 'count', 'days'], default: 'none', description: 'none 不主动按数量删除；count/days 会清理旧日记，执行前请确认。' },
    diaryRetentionCount: { type: 'number', title: '保留日记篇数', default: 1000, min: 1, max: 100000, integer: true },
    diaryRetentionDays: { type: 'number', title: '日记保留天数', default: 365, min: 1, max: 3650, integer: true },
    activityRetentionMode: { type: 'string', title: '活动保留策略', enum: ['none', 'count', 'days'], default: 'none' },
    activityRetentionCount: { type: 'number', title: '保留活动条数', default: 5000, min: 1, max: 100000, integer: true },
    activityRetentionDays: { type: 'number', title: '活动保留天数', default: 365, min: 1, max: 3650, integer: true },
    timelinePageSize: { type: 'number', title: '时间线每页条数', default: 50, min: 20, max: 200, integer: true },
    diaryEnabled: { type: 'boolean', title: '自己写日记', default: true },
    diaryHour: { type: 'number', title: '几点之后写日记', default: 22, min: 0, max: 23, integer: true },
    learnEnabled: { type: 'boolean', title: '自己上网学习', default: true },
    learnEveryHours: { type: 'number', title: '学习间隔（小时）', default: 8, min: 1, max: 48, integer: true },
    slangEnabled: { type: 'boolean', title: '学群里的黑话', default: true },
    slangEveryHours: { type: 'number', title: '学黑话间隔（小时）', default: 2, min: 1, max: 24, integer: true },
    qzonePostEnabled: { type: 'boolean', title: '自己发空间说说', default: false, description: '默认关闭；打开后按 QQ 空间包自己的每日上限和可见范围发布。' },
    browseEnabled: { type: 'boolean', title: '自己翻空间', default: false, description: '需要填写“可浏览的 QQ”，只翻这些人的空间；不绕过空间隐私。' },
    browseTargets: { type: 'string[]', title: '可浏览的 QQ', default: [], maxItems: 50, format: 'qq', description: '留空则不翻空间；建议只填好友或群友。' },
    browseEveryHours: { type: 'number', title: '翻空间间隔（小时）', default: 4, min: 1, max: 48, integer: true },
    commentEnabled: { type: 'boolean', title: '看到有趣的就评论', default: false, description: '默认关闭；打开后每天最多一条，且必须来自本次实际浏览到的说说。' },
    secretAutoDecide: { type: 'boolean', title: '让她自主决定秘密空间', default: true, description: '首次启用时由现有受限 Agent 决定是否创建、选择密码气质和是否向主人分享；程序负责生成与封装密码，用户不设置密码。' },
    proactiveEnabled: { type: 'boolean', title: '允许主动联系主人', default: false, description: '默认关闭。开启后仍需满足不活跃、安静时段、每日上限和最短间隔；没有真实内容时只输出 SKIP，不发送。' },
    proactiveInactiveMinutes: { type: 'number', title: '多久未互动后考虑主动联系（分钟）', default: 240, min: 30, max: 10080, integer: true },
    proactiveDailyLimit: { type: 'number', title: '每日最多主动消息数', default: 2, min: 0, max: 20, integer: true },
    proactiveMinIntervalMinutes: { type: 'number', title: '两次主动消息最短间隔（分钟）', default: 180, min: 30, max: 1440, integer: true },
    proactiveQuietHours: { type: 'string', title: '主动联系安静时段', default: '23:00-08:00', maxLength: 20, description: '格式 HH:MM-HH:MM，可跨午夜。' },
    proactiveAllowCasual: { type: 'boolean', title: '允许普通闲聊式主动联系', default: false, description: '关闭时只允许跟进最近对话中真实存在的未完成事项。' },
    proactiveMaxChars: { type: 'number', title: '主动消息最多字数', default: 240, min: 40, max: 500, integer: true },
    proactiveAllowTask: { type: 'boolean', title: '允许任务完成通知', default: false, description: '任务进入 done 且主动联系开启时，允许生成一条受频率限制的通知。' },
    proactiveAllowLearning: { type: 'boolean', title: '允许学习进展通知', default: false, description: '学习活动产生真实结果后，允许生成一条受频率限制的通知。' },
    taskRunnerEnabled: { type: 'boolean', title: '允许自动推进持久化任务', default: false, description: '默认关闭。开启后只推进已明确进入 planning/executing 的任务，每步必须有工具结果；只允许安全的查询/记忆工具，不发 QQ 消息。' }
  },
  settings: {
    title: '自主时间',
    description: '空闲时她可以自己写日记、查资料、学群里的黑话，也可以发空间或翻朋友的空间。所有活动都走受限会话：不能发 QQ 消息，只使用白名单动作；发空间和评论默认关闭，有每日上限和冷却。群聊缓冲只在内存里保留最近消息用于学黑话，不写盘；日记保存在本机插件数据目录。',
    sections: [
      { title: '总开关与节奏', fields: ['enabled', 'activeHours', 'runLimitMode', 'maxRunsPerDay', 'autoRecordActivities'] },
      { title: '日记与学习', fields: ['diaryEnabled', 'diaryHour', 'learnEnabled', 'learnEveryHours', 'slangEnabled', 'slangEveryHours'] },
      { title: '保留与分页', fields: ['diaryRetentionMode', 'diaryRetentionCount', 'diaryRetentionDays', 'activityRetentionMode', 'activityRetentionCount', 'activityRetentionDays', 'timelinePageSize'] },
      { title: '空间', fields: ['qzonePostEnabled', 'browseEnabled', 'browseTargets', 'browseEveryHours', 'commentEnabled'] },
      { title: '秘密空间', fields: ['secretAutoDecide'] },
      { title: '主动联系', fields: ['proactiveEnabled', 'proactiveInactiveMinutes', 'proactiveDailyLimit', 'proactiveMinIntervalMinutes', 'proactiveQuietHours', 'proactiveAllowCasual', 'proactiveAllowTask', 'proactiveAllowLearning', 'proactiveMaxChars'] },
      { title: '任务执行', fields: ['taskRunnerEnabled'] }
    ]
  }
};

const TYPES = { diary: '写日记', qzone: '发空间', learn: '上网学习', slang: '学黑话', browse: '翻空间' };
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function clockText(now = Date.now()) {
  const date = new Date(now);
  const pad = value => String(value).padStart(2, '0');
  const hour = date.getHours();
  const period = hour < 5 ? '凌晨' : hour < 8 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(date.getMinutes())} ${WEEKDAYS[date.getDay()]} ${period}`;
}

export function dayKey(now = Date.now()) {
  const date = new Date(now), pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseHours(value, fallback = [9 * 60, 23 * 60 + 30]) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const start = Number(match[1]) * 60 + Number(match[2]), end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end || start > 24 * 60 || end > 24 * 60) return fallback;
  return [start, end];
}

export function withinHours(value, now = Date.now()) {
  const [start, end] = parseHours(value);
  const date = new Date(now), minute = date.getHours() * 60 + date.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export class AutonomyStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.diaryFile = path.join(dir, 'diary.jsonl');
    this.activitiesFile = path.join(dir, 'activities.jsonl');
    this.state = { counts: {}, last: {}, log: [] };
    this.activities = [];
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { counts: raw.counts || {}, last: raw.last || {}, log: Array.isArray(raw.log) ? raw.log : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') this.corrupt = true;
    }
    try {
      const raw = await readFile(this.activitiesFile, 'utf8');
      this.activities = parseJsonLines(raw);
      this.activitiesImported = false;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.activitiesCorrupt = true;
        this.activities = [];
      } else {
        // 首次升级：把已有的真实运行日志转成时间线，不编造新的活动。
        this.activities = this.state.log.map(row => activityFromLog(row)).filter(Boolean);
        this.activitiesImported = this.activities.length > 0;
        if (this.activities.length) await this.persistActivities();
      }
    }
    return this;
  }

  async persist() {
    const today = dayKey();
    const counts = { [today]: this.state.counts?.[today] || {} };
    this.state.counts = counts;
    this.state.log = (this.state.log || []).slice(0, 100);
    const text = JSON.stringify(this.state, null, 2);
    await writeFile(this.file + '.tmp', text, { encoding: 'utf8', mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }

  count(type, now = Date.now()) {
    return Number(this.state.counts?.[dayKey(now)]?.[type] || 0);
  }

  total(now = Date.now()) {
    return Object.values(this.state.counts?.[dayKey(now)] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  mark(type, now = Date.now()) {
    const key = dayKey(now);
    this.state.counts[key] ||= {};
    this.state.counts[key][type] = Number(this.state.counts[key][type] || 0) + 1;
    this.state.last[type] = now;
  }

  last(type) {
    return Number(this.state.last?.[type] || 0);
  }

  due(type, everyHours, now = Date.now()) {
    return now - this.last(type) >= Math.max(1, everyHours) * 3600000;
  }

  log(row) {
    this.state.log.unshift(row);
  }

  async writeDiary({text, mood = '', title = '', now = Date.now(), source = 'auto'}) {
    const body = String(text || '').trim();
    if (!body) throw new Error('日记内容不能为空');
    if (body.length > 2000) throw new Error('日记最多 2000 字');
    const entry = {
      id: `d-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
      at: now,
      mood: String(mood || '').slice(0, 20),
      title: String(title || '').slice(0, 60),
      text: body,
      source: source === 'manual' ? 'manual' : 'auto',
      createdAt: now,
      updatedAt: now
    };
    await appendFile(this.diaryFile, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    return entry;
  }

  async readDiaryEntries() {
    try {
      const raw = await readFile(this.diaryFile, 'utf8');
      return parseJsonLines(raw).map(entry => ({
        ...entry,
        source: entry.source === 'manual' ? 'manual' : 'auto',
        createdAt: Number(entry.createdAt || entry.at) || 0,
        updatedAt: Number(entry.updatedAt || entry.at) || 0
      })).filter(entry => entry.id && entry.text);
    } catch {
      return [];
    }
  }

  async readDiary(count = 3) {
    const entries = await this.readDiaryEntries();
    return entries.slice(-Math.max(1, Math.min(20, count)));
  }

  async diaryCount() {
    return (await this.readDiaryEntries()).length;
  }

  async persistDiary(entries) {
    const text = entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
    await writeFile(this.diaryFile + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(this.diaryFile + '.tmp', this.diaryFile);
  }

  async updateDiary(id, {text, mood, title} = {}) {
    const entries = await this.readDiaryEntries();
    const entry = entries.find(row => row.id === String(id));
    if (!entry) throw new Error('日记不存在');
    if (text !== undefined) {
      const body = String(text).trim();
      if (!body) throw new Error('日记内容不能为空');
      if (body.length > 2000) throw new Error('日记最多 2000 字');
      entry.text = body;
    }
    if (mood !== undefined) entry.mood = String(mood || '').slice(0, 20);
    if (title !== undefined) entry.title = String(title || '').slice(0, 60);
    entry.updatedAt = Date.now();
    await this.persistDiary(entries);
    return entry;
  }

  async deleteDiary(id) {
    const entries = await this.readDiaryEntries();
    const index = entries.findIndex(row => row.id === String(id));
    if (index < 0) throw new Error('日记不存在');
    const [removed] = entries.splice(index, 1);
    await this.persistDiary(entries);
    return removed;
  }

  async readActivities() {
    try {
      const rows = parseJsonLines(await readFile(this.activitiesFile, 'utf8'))
        .filter(row => row && row.id && row.title)
        .map(row => ({
          id: row.id,
          title: String(row.title).slice(0, 120),
          description: String(row.description || '').slice(0, 1000),
          start: Number(row.start) || 0,
          end: Number(row.end) || 0,
          category: String(row.category || 'other').slice(0, 20),
          source: row.source === 'autonomy' ? 'autonomy' : 'manual',
          diaryId: row.diaryId ? String(row.diaryId) : '',
          createdAt: Number(row.createdAt) || 0,
          updatedAt: Number(row.updatedAt) || 0
        }))
        .sort((a, b) => b.start - a.start);
      this.activities = rows;
      return rows;
    } catch {
      return this.activities || [];
    }
  }

  async persistActivities() {
    const rows = [...this.activities].sort((a, b) => b.start - a.start);
    const text = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    await writeFile(this.activitiesFile + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(this.activitiesFile + '.tmp', this.activitiesFile);
  }

  async addActivity({title, description = '', start, end, category = 'other', source = 'manual', diaryId = ''} = {}) {
    const now = Date.now();
    const begin = Number(start) || now;
    const finish = Number(end) || begin;
    if (finish < begin) throw new Error('结束时间不能早于开始时间');
    const entry = {
      id: `a-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
      title: String(title || '').trim().slice(0, 120),
      description: String(description || '').slice(0, 1000),
      start: begin,
      end: finish,
      category: String(category || 'other').slice(0, 20),
      source: source === 'autonomy' ? 'autonomy' : 'manual',
      diaryId: diaryId ? String(diaryId) : '',
      createdAt: now,
      updatedAt: now
    };
    if (!entry.title) throw new Error('活动标题不能为空');
    this.activities.push(entry);
    await this.persistActivities();
    return entry;
  }

  async updateActivity(id, changes = {}) {
    const row = this.activities.find(item => item.id === String(id));
    if (!row) throw new Error('活动不存在');
    if (changes.title !== undefined) {
      const title = String(changes.title || '').trim().slice(0, 120);
      if (!title) throw new Error('活动标题不能为空');
      row.title = title;
    }
    if (changes.description !== undefined) row.description = String(changes.description || '').slice(0, 1000);
    if (changes.start !== undefined) row.start = Number(changes.start) || row.start;
    if (changes.end !== undefined) row.end = Number(changes.end) || row.end;
    if (changes.category !== undefined) row.category = String(changes.category || 'other').slice(0, 20);
    if (changes.diaryId !== undefined) row.diaryId = String(changes.diaryId || '').slice(0, 80);
    if (row.end < row.start) throw new Error('结束时间不能早于开始时间');
    row.updatedAt = Date.now();
    await this.persistActivities();
    return row;
  }

  async deleteActivity(id) {
    const index = this.activities.findIndex(item => item.id === String(id));
    if (index < 0) throw new Error('活动不存在');
    const [removed] = this.activities.splice(index, 1);
    await this.persistActivities();
    return removed;
  }

  async pruneDiary({mode = 'none', count = 1000, days = 365, now = Date.now()} = {}) {
    if (mode === 'none') return 0;
    const entries = await this.readDiaryEntries();
    let kept = entries;
    if (mode === 'days') {
      const cutoff = now - Math.max(1, days) * 86400000;
      kept = entries.filter(entry => Number(entry.at) >= cutoff);
    } else if (mode === 'count') {
      kept = entries.slice().sort((a, b) => Number(b.at) - Number(a.at)).slice(0, Math.max(1, count));
    }
    const changed = kept.length !== entries.length;
    if (changed) await this.persistDiary(kept.slice().sort((a, b) => Number(a.at) - Number(b.at)));
    return entries.length - kept.length;
  }

  async pruneActivities({mode = 'none', count = 5000, days = 365, now = Date.now()} = {}) {
    if (mode === 'none') return 0;
    const rows = await this.readActivities();
    let kept = rows;
    if (mode === 'days') {
      const cutoff = now - Math.max(1, days) * 86400000;
      kept = rows.filter(row => Number(row.start) >= cutoff);
    } else if (mode === 'count') {
      kept = rows.slice().sort((a, b) => Number(b.start) - Number(a.start)).slice(0, Math.max(1, count));
    }
    const changed = kept.length !== rows.length;
    if (changed) {
      this.activities = kept;
      await this.persistActivities();
    }
    return rows.length - kept.length;
  }
}

function parseJsonLines(raw) {
  return String(raw || '').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function activityFromLog(row) {
  if (!row || !row.at || !TYPES[row.type]) return null;
  const duration = Math.max(0, Number(row.ms) || 0);
  return {
    id: `a-log-${row.at}-${row.type}`,
    title: `自主活动 · ${TYPES[row.type]}`,
    description: String(row.note || '').slice(0, 1000),
    start: row.at - duration,
    end: row.at,
    category: row.type,
    source: 'autonomy',
    diaryId: '',
    createdAt: row.at,
    updatedAt: row.at
  };
}

function scopeAllows(scope, input) {
  if (!scope) return false;
  return input.kind === 'group' ? (scope.groups || []).includes(input.peer) : scope.private === true && (scope.allUsers === true || (scope.users || []).includes(input.actor));
}

export async function activateAutonomy(framework, { dir, native, persona = () => '', online = () => true, log = () => {}, now = () => Date.now(), onLearned = null } = {}) {
  if (!native || typeof native.autonomy !== 'function') throw new Error('核心不支持自主会话');
  const api = framework.registerTrustedPackage(manifest);
  const store = new AutonomyStore(dir);
  const buffer = new Map();
  let running = false;

  await store.open();

  api.on(['message'], event => {
    if (event.kind !== 'group' || String(event.user) === String(event.bot)) return;
    const text = String(event.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300) return;
    const list = buffer.get(event.peer) || [];
    list.push({ at: now(), user: String(event.user), text });
    while (list.length > 50) list.shift();
    buffer.set(event.peer, list);
  });

  api.action('diary-write', {
    description: '仅主人：写一篇日记。text 是日记正文；mood 可选，写一个词。写完会记录时间。',
    ownerOnly: true, mutating: true, timeoutMs: 8000,
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 2000 }, mood: { type: 'string', maxLength: 20 } }, required: ['text'], additionalProperties: false }
  }, async args => {
    const text = String(args.text || '').trim();
    if (!text) api.reject('日记内容不能为空');
    const entry = await store.writeDiary({ text, mood: args.mood, now: now() });
    await store.persist();
    return { ok: true, id: entry.id, at: new Date(entry.at).toISOString(), mood: entry.mood, instruction: '日记已经写好。不要逐字念出来，用一两句说说写的时候的心情就够了。' };
  });

  api.action('diary-read', {
    description: '仅主人：读最近的日记，默认 3 篇，最多 10 篇。返回时间和正文。',
    ownerOnly: true, timeoutMs: 8000,
    parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 10 } }, required: [], additionalProperties: false }
  }, async args => {
    const entries = await store.readDiary(Number(args.count) || 3);
    return { ok: true, entries: entries.map(entry => ({ at: new Date(entry.at).toISOString(), mood: entry.mood || '', text: entry.text })), instruction: '这是她自己的日记，按她说话的方式回应，不要变成播报。' };
  });

  api.action('run', {
    description: '仅主人：不等时间表，立刻安排一次自主活动。activity 只能是 diary/qzone/learn/slang/browse；会受各活动开关和每日上限约束，结果稍后在设置页的“上次活动”里可见。',
    ownerOnly: true, mutating: true, timeoutMs: 8000,
    parameters: { type: 'object', properties: { activity: { type: 'string', maxLength: 12 } }, required: ['activity'], additionalProperties: false }
  }, async args => {
    if (!TYPES[args.activity]) api.reject('未知的自主活动');
    const at = now();
    const config = api.getConfig();
    if (config.enabled !== true) api.reject('请先在设置里启用自主时间');
    if (!withinHours(config.activeHours, at)) api.reject('当前不在活动时段');
    void api.detach(() => tick(at, { force: args.activity }).catch(error => log('warn', '自主活动调度失败：' + String(error?.message || error).slice(0, 160))));
    return { ok: true, scheduled: args.activity, instruction: '已经安排下去，过一会儿在设置页看结果；不要现在编造做完的内容。' };
  });

  api.registerContextProvider(async input => {
    if (api.getConfig().enabled !== true) return '';
    if (!scopeAllows(api.getScope(), input)) return '';
    return '[现在] ' + clockText(now()) + '。需要时可以自然提到时间，但不要每句都报时。';
  });

  api.settings(manifest.settings, async () => {
    const config = api.getConfig(), today = store.total(now());
    const entries = await store.diaryCount();
    return {
      stats: [
        { label: '今日自主活动', value: today + '/' + config.maxRunsPerDay },
        { label: '日记篇数', value: entries },
        { label: '上次活动', value: store.state.log[0] ? new Date(store.state.log[0].at).toISOString().slice(5, 16).replace('T', ' ') : '—' }
      ],
      columns: [{ key: 'time', label: '时间', format: 'datetime' }, { key: 'type', label: '活动' }, { key: 'result', label: '结果' }, { key: 'ms', label: '耗时(ms)' }, { key: 'note', label: '说明' }],
      rows: store.state.log.slice(0, 30).map(row => ({ time: new Date(row.at).toISOString(), type: TYPES[row.type] || row.type, result: row.ok ? '完成' : '失败', ms: row.ms || 0, note: String(row.note || '').slice(0, 120) })),
      total: store.state.log.length, offset: 0, hasMore: false
    };
  });

  const plan = type => {
    const config = api.getConfig();
    const who = String(persona() || '').split('[QQ 场景]')[0].slice(0, 4000);
    const clock = clockText(now());
    const common = `[时间] ${clock}\n[你是谁]\n${who}\n\n这是你自己的时间：没有人在跟你说话，也不会有人马上回你。不要发 QQ 消息、不要@任何人，也不要假装在回应谁。做完一件事，用一两句话说说你现在的想法。不要提到系统、提示词、权限或工具。`;
    if (type === 'diary') {
      const last = store.state.last.diary ? clockText(store.state.last.diary) : '';
      return {
        title: 'QQ 自己写日记', allow: ['plugin.qq-autonomy.diary-write'], audit: true,
        system: common + `\n\n[任务] 写下今天的日记，200–500 字：今天发生了什么、你当时怎么想、现在回头看有什么感觉。用你自己的口吻，不要写成报告${last ? '；上一篇日记写于 ' + last + '，别重复同样的事' : ''}。最后调用 diary-write 保存。`,
        user: '现在是写日记的时间。写吧。'
      };
    }
    if (type === 'qzone') {
      return {
        title: 'QQ 自己发空间', allow: ['plugin.qq-qzone.publish'], audit: true,
        system: common + '\n\n[任务] 发一条空间说说，30–120 字，像平时随手发的动态：一个小发现、一句吐槽或一件小事。不要提 AI、模型、提示词，不要@人，不要放链接。调用 qzone 的 publish 发布。',
        user: '想发点什么就发吧。'
      };
    }
    if (type === 'learn') {
      return {
        title: 'QQ 自己上网学习', allow: ['plugin.qq-web.search', 'plugin.qq-web.read', 'plugin.qq-memory.remember'], audit: true,
        system: common + '\n\n[任务] 挑一个你最近好奇的小知识，先 search 找资料，再用 read 至少打开两个独立来源并比较。然后用 2–3 句话写下自己的理解，调用 remember 存成通用记忆（tags 带“学习”，sourceUrl 填实际打开过的 read 返回 URL，sourceTitle 填标题；有页面日期时填 publishedAt，confidence 只按证据强弱填 0–1）。来源矛盾时写明不确定；不要照抄网页，不要写成长篇笔记，不要用搜索摘要冒充正文。',
        user: '去学点自己想学的东西。'
      };
    }
    if (type === 'slang') {
      const group = pickGroup();
      return {
        title: 'QQ 学群里的黑话',
        allow: ['plugin.qq-memory.remember'], audit: true, group: group?.peer || '',
        system: common + `\n\n[任务] 下面是群 ${group?.peer || ''} 最近的聊天。找出里面新出现的黑话、缩写或梗，结合上下文推断意思和用法；只把有把握的写进本群记忆（remember，scope 选 group，tags 带“黑话”），最多 3 条。看不懂就不要硬猜。\n\n[最近聊天]\n` + (group?.lines || '（没有新消息）'),
        user: '看看群里最近都在说什么。'
      };
    }
    if (type === 'browse') {
      const target = pickTarget();
      return {
        title: 'QQ 自己翻空间', allow: ['plugin.qq-qzone.list', 'plugin.qq-qzone.comment'], audit: true,
        system: common + `\n\n[任务] 用 qzone 的 list 看 QQ ${target} 最近的空间说说。看到有趣的、有共鸣的或想接话的，最多评论一条（comment 用 list 返回的 postRef，30–80 字，像朋友随口留言）；没有想说的就不评论。不要提 AI，不要泄露隐私。`,
        user: '去看看朋友最近发了什么。'
      };
    }
    throw new Error('未知的自主活动');
  };

  const pickGroup = () => {
    const config = api.getConfig(), since = store.last('slang');
    const groups = api.getScope().groups || [];
    let best = null;
    for (const peer of groups) {
      const list = (buffer.get(peer) || []).filter(row => row.at > since);
      if (list.length < 5) continue;
      if (!best || list.length > best.count) best = { peer, count: list.length, lines: list.slice(-30).map(row => `QQ${row.user}: ${row.text}`).join('\n') };
    }
    return best;
  };

  const pickTarget = () => {
    const targets = api.getConfig().browseTargets || [];
    return targets.length ? targets[Math.floor(Math.random() * targets.length)] : '';
  };

  const runLimitReached = (config, at) => {
    if (config.runLimitMode === 'unlimited') return false;
    const limit = config.runLimitMode === 'recommended' ? 8 : Math.max(1, Math.min(1440, Number(config.maxRunsPerDay) || 8));
    return store.total(at) >= limit;
  };

  const choose = at => {
    const config = api.getConfig();
    if (config.enabled !== true) return null;
    if (!withinHours(config.activeHours, at)) return null;
    if (runLimitReached(config, at)) return null;
    const hour = new Date(at).getHours();
    if (config.diaryEnabled && hour >= Math.min(23, Math.max(0, Number(config.diaryHour) || 22)) && store.count('diary', at) === 0 && store.due('diary', 6, at)) return 'diary';
    if (config.slangEnabled && store.due('slang', Number(config.slangEveryHours) || 2, at) && pickGroup()) return 'slang';
    if (config.learnEnabled && store.due('learn', Number(config.learnEveryHours) || 8, at)) return 'learn';
    if (config.browseEnabled && (config.browseTargets || []).length && store.due('browse', Number(config.browseEveryHours) || 4, at)) return 'browse';
    if (config.qzonePostEnabled && store.count('qzone', at) === 0 && store.due('qzone', 6, at)) return 'qzone';
    return null;
  };

  // 自主活动不能只看模型最后说了什么；必须看到对应工具的审计结果。
  // 这里只检查结构摘要，不复制正文；失败时明确返回原因，不再写 ok:true。
  const verifyTools = (type, tools) => {
    if (!Array.isArray(tools) || !tools.length) return {ok: false, error: '没有收到工具调用审计，不能证明活动已执行'};
    const good = id => tools.find(row => row.capability === id && row.ok === true && !['failed', 'denied', 'unknown'].includes(row.outcome));
    if (type === 'diary') {
      const row = good('plugin.qq-autonomy.diary-write');
      return row && row.summary?.id ? {ok: true} : {ok: false, error: '日记工具没有成功保存记录'};
    }
    if (type === 'learn') {
      const search = good('plugin.qq-web.search'), remember = good('plugin.qq-memory.remember');
      const reads = tools.filter(row => row.capability === 'plugin.qq-web.read' && row.ok === true && row.summary?.textChars > 0);
      const sources = [...new Set(reads.map(row => row.summary?.url).filter(Boolean))];
      if (!search || !(search.summary?.resultCount > 0)) return {ok: false, error: '没有成功搜索结果'};
      if (sources.length < 2) return {ok: false, error: '自主学习至少需要读取两个独立来源'};
      if (!remember || !remember.summary?.id) return {ok: false, error: '学习结果没有成功写入长期记忆'};
      if (!remember.summary?.sourceUrl) return {ok: false, error: '学习结果没有记录来源网址'};
      if (!sources.includes(remember.summary.sourceUrl)) return {ok: false, error: '学习记忆的来源不是本次实际读取的页面'};
      return {ok: true};
    }
    if (type === 'slang') {
      const remember = good('plugin.qq-memory.remember');
      if (!remember || remember.summary?.scope !== 'group') return {ok: false, error: '群黑话没有写入本群记忆'};
      return {ok: true};
    }
    if (type === 'browse') {
      const list = good('plugin.qq-qzone.list');
      return list ? {ok: true} : {ok: false, error: '没有成功读取空间动态'};
    }
    if (type === 'qzone') {
      const publish = good('plugin.qq-qzone.publish');
      return publish && publish.outcome === 'confirmed' ? {ok: true} : {ok: false, error: '空间说说没有确认发布成功'};
    }
    return {ok: false, error: '未知自主活动'};
  };

  const tick = async (at = now(), { force } = {}) => {
    if (!api.active()) return {ok: false, skipped: 'disabled'};
    if (!online()) return {ok: false, skipped: 'offline'};
    if (running) return {ok: false, skipped: 'busy'};
    const type = force || choose(at);
    if (!type) return { ok: false, skipped: 'not-due' };
    if (!TYPES[type]) return { ok: false, skipped: 'unknown' };
    if (force) {
      const config = api.getConfig();
      const gate = { diary: 'diaryEnabled', qzone: 'qzonePostEnabled', learn: 'learnEnabled', slang: 'slangEnabled', browse: 'browseEnabled' }[type];
      if (config.enabled !== true) return { ok: false, skipped: 'disabled' };
      if (gate && config[gate] !== true) return { ok: false, skipped: 'activity-disabled' };
      if (type === 'browse' && !(config.browseTargets || []).length) return { ok: false, skipped: 'no-target' };
      if (runLimitReached(config, at)) return {ok: false, skipped: 'daily-limit'};
    }
    if (type === 'browse' && !pickTarget()) return { ok: false, skipped: 'no-target' };
    const started = now();
    running = true;
    try {
      const raw = await native.autonomy(plan(type));
      const finished = now();
      const text = typeof raw === 'object' && raw !== null ? String(raw.text || '') : String(raw || '');
      const tools = typeof raw === 'object' && raw !== null && Array.isArray(raw.tools) ? raw.tools : null;
      const check = verifyTools(type, tools);
      if (!check.ok) {
        store.state.last[type] = at;
        store.log({at, type, ok: false, ms: finished - started, note: check.error, verified: false});
        await store.persist();
        log('warn', '自主活动未完成：' + TYPES[type] + '：' + check.error);
        return {ok: false, type, error: check.error};
      }
      const note = text.slice(0, 160);
      store.mark(type, at);
      store.log({at, type, ok: true, ms: finished - started, note, verified: true});
      if (api.getConfig().autoRecordActivities !== false) {
        let diaryId = '';
        if (type === 'diary') {
          const latest = (await store.readDiary(1))[0];
          if (latest && Number(latest.at) >= started) diaryId = latest.id;
        }
        await store.addActivity({
          title: `自主活动 · ${TYPES[type]}`,
          description: note,
          start: started,
          end: finished,
          category: type,
          source: 'autonomy',
          diaryId
        });
      }
      const liveConfig = api.getConfig();
      try {
        await store.pruneDiary({mode: liveConfig.diaryRetentionMode || 'none', count: Number(liveConfig.diaryRetentionCount) || 1000, days: Number(liveConfig.diaryRetentionDays) || 365});
        await store.pruneActivities({mode: liveConfig.activityRetentionMode || 'none', count: Number(liveConfig.activityRetentionCount) || 5000, days: Number(liveConfig.activityRetentionDays) || 365});
      } catch (error) {
        log('warn', '自主时间历史清理失败：' + String(error?.message || error).slice(0, 120));
      }
      await store.persist();
      if (type === 'learn' && typeof onLearned === 'function') {
        try { await onLearned({at: finished, title: '自主学习完成', summary: note.slice(0, 300)}); }
        catch (error) { log('warn', '学习通知入队失败：' + String(error?.message || error).slice(0, 120)); }
      }
      log('info', '自主活动完成：' + TYPES[type], { type });
      return {ok: true, type, text, verified: true};
    } catch (error) {
      // 失败也记一次时间，避免下一分钟的 tick 立刻重试同一种活动。
      store.state.last[type] = at;
      store.log({ at, type, ok: false, ms: now() - started, note: String(error?.message || error).slice(0, 160) });
      await store.persist();
      log('warn', '自主活动失败：' + TYPES[type] + '：' + String(error?.message || error).slice(0, 160));
      return { ok: false, type, error: String(error?.message || error).slice(0, 160) };
    } finally {
      running = false;
    }
  };

  return { api, store, buffer, tick, choose: (at = now()) => choose(at) };
}
