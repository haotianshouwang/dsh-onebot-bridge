// 持久化任务状态：只保存目标、计划、步骤、验证和有限重试状态，不保存任意文件内容。
// 这是自主任务的最小事实来源；模型或管理员必须通过显式动作推进状态。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export const TASK_STATUSES = ['pending', 'analyzing', 'planning', 'waiting_approval', 'executing', 'verifying', 'done', 'failed', 'cancelled'];
export const VERIFICATION_METHODS = ['manual', 'steps', 'tool', 'readback'];
const TRANSITIONS = {
  pending: ['analyzing', 'cancelled'],
  analyzing: ['planning', 'failed', 'cancelled'],
  planning: ['waiting_approval', 'executing', 'failed', 'cancelled'],
  waiting_approval: ['executing', 'cancelled', 'failed'],
  executing: ['verifying', 'failed', 'cancelled'],
  verifying: ['done', 'failed', 'cancelled'],
  failed: ['planning', 'cancelled'],
  done: [],
  cancelled: []
};

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class TaskStore {
  constructor(dir, {now = Date.now, maxTasks = 100} = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'tasks.json');
    this.now = now;
    this.maxTasks = Math.max(10, Math.min(1000, Number(maxTasks) || 100));
    this.tasks = [];
  }

  async open() {
    await mkdir(this.dir, {recursive: true});
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw?.tasks)) this.tasks = raw.tasks.filter(row => row && TASK_STATUSES.includes(row.status)).slice(0, this.maxTasks);
      else if (Array.isArray(raw)) this.tasks = raw.filter(row => row && TASK_STATUSES.includes(row.status)).slice(0, this.maxTasks);
      for (const task of this.tasks) {
        if (!VERIFICATION_METHODS.includes(task.verificationMethod)) task.verificationMethod = 'manual';
        if (!task.verificationSpec || typeof task.verificationSpec !== 'object' || Array.isArray(task.verificationSpec)) task.verificationSpec = {};
        if (typeof task.idempotencyKey !== 'string') task.idempotencyKey = '';
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.corrupt = true;
    }
    return this;
  }

  async persist() {
    const text = JSON.stringify({version: 1, tasks: this.tasks.slice(0, this.maxTasks)}, null, 2);
    await writeFile(this.file + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(this.file + '.tmp', this.file);
  }

  list({status = '', limit = 20} = {}) {
    const rows = this.tasks.filter(row => !status || row.status === status).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  get(id) {
    return this.tasks.find(row => row.id === String(id)) || null;
  }

  async create({goal, reason = '', completion = '', plan = [], maxSteps = 20, budgetMs = 0, verificationMethod = 'manual', verificationSpec = {}, idempotencyKey = ''} = {}) {
    const title = clean(goal, 500);
    if (!title) throw new Error('任务目标不能为空');
    if (this.tasks.length >= this.maxTasks) throw new Error('任务数量已达到上限，请先清理旧任务');
    const method = VERIFICATION_METHODS.includes(verificationMethod) ? verificationMethod : 'manual';
    if (method === 'tool' && !clean(verificationSpec?.capability, 100)) throw new Error('tool 验证必须声明 capability');
    if (method === 'readback' && !clean(verificationSpec?.capability, 100)) throw new Error('readback 验证必须声明 capability');
    const key = clean(idempotencyKey, 200);
    if (key) {
      const existing = this.tasks.find(task => task.idempotencyKey === key);
      if (existing) return existing;
    }
    const at = this.now();
    const steps = (Array.isArray(plan) ? plan : []).map(item => clean(item, 300)).filter(Boolean).slice(0, 20);
    const task = {
      id: 'task-' + randomUUID(),
      goal: title,
      reason: clean(reason, 300),
      completion: clean(completion, 300),
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      plan: steps,
      steps: [],
      attempts: 0,
      maxRetries: 2,
      maxSteps: Math.max(1, Math.min(50, Number(maxSteps) || 20)),
      budgetMs: Math.max(0, Math.min(86400000, Number(budgetMs) || 0)),
      verificationMethod: method,
      verificationSpec: verificationSpec && typeof verificationSpec === 'object' ? structuredClone(verificationSpec) : {},
      idempotencyKey: key,
      verification: null,
      memoryIds: [],
      history: [{at, from: '', to: 'pending', note: 'created'}]
    };
    this.tasks.unshift(task);
    this.tasks = this.tasks.slice(0, this.maxTasks);
    await this.persist();
    return task;
  }

  async transition(id, to, note = '') {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (!TASK_STATUSES.includes(to)) throw new Error('任务状态无效');
    if (!TRANSITIONS[task.status]?.includes(to)) throw new Error(`任务不能从 ${task.status} 转为 ${to}`);
    if (to === 'done' && task.verification?.ok !== true) throw new Error('任务完成条件尚未验证，不能进入 done');
    const at = this.now(), from = task.status;
    task.status = to;
    task.updatedAt = at;
    task.history.push({at, from, to, note: clean(note, 160)});
    if (to === 'failed') task.attempts += 1;
    if (to === 'done' || to === 'cancelled') task.closedAt = at;
    await this.persist();
    return task;
  }

  async setPlan(id, steps) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (!['pending', 'analyzing', 'planning', 'failed'].includes(task.status)) throw new Error('当前状态不能修改计划');
    task.plan = (Array.isArray(steps) ? steps : []).map(item => clean(item, 300)).filter(Boolean).slice(0, task.maxSteps);
    task.updatedAt = this.now();
    await this.persist();
    return task;
  }

  async addStep(id, {title, tool = '', status = 'done', outcome = '', note = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'executing') throw new Error('只有执行中的任务可以追加步骤');
    if (task.steps.length >= task.maxSteps) throw new Error('任务步骤已达到上限');
    const step = {
      index: task.steps.length + 1,
      title: clean(title, 200),
      tool: clean(tool, 100),
      status: ['pending', 'running', 'done', 'failed', 'skipped'].includes(status) ? status : 'done',
      outcome: clean(outcome, 200),
      note: clean(note, 200),
      at: this.now()
    };
    task.steps.push(step);
    task.updatedAt = step.at;
    await this.persist();
    return step;
  }

  async verify(id, {ok, note = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'verifying') throw new Error('只有验证中的任务可以写入验证结果');
    const at = this.now();
    task.verification = {ok: ok === true, note: clean(note, 300), at};
    task.updatedAt = at;
    await this.persist();
    return task;
  }

  async attachMemory(id, memoryId) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    const value = clean(memoryId, 100);
    if (value && !task.memoryIds.includes(value)) task.memoryIds.push(value);
    task.updatedAt = this.now();
    await this.persist();
    return task;
  }

  status() {
    const active = this.tasks.filter(row => !['done', 'failed', 'cancelled'].includes(row.status));
    return {
      total: this.tasks.length,
      active: active.length,
      waitingApproval: this.tasks.filter(row => row.status === 'waiting_approval').length,
      failed: this.tasks.filter(row => row.status === 'failed').length,
      latest: this.tasks[0] ? {id: this.tasks[0].id, goal: this.tasks[0].goal, status: this.tasks[0].status} : null
    };
  }
}
