// 持久化任务状态：只保存目标、计划、步骤、验证和有限重试状态，不保存任意文件内容。
// 这是自主任务的最小事实来源；模型或管理员必须通过显式动作推进状态。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {RESULT_STATES} from '../core/result.js';
import {ERROR_CLASSES,classifyFailure} from '../core/errors.js';
import {recoverReminder} from './reminders.js';

export const TASK_STATUSES = ['pending', 'analyzing', 'planning', 'waiting_approval', 'executing', 'verifying', 'done', 'failed', 'cancelled'];
export const VERIFICATION_METHODS = ['manual', 'steps', 'tool', 'readback', 'memory'];
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
    this.tail = Promise.resolve();
  }

  async open() {
    await mkdir(this.dir, {recursive: true});
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw?.tasks)) this.tasks = raw.tasks.filter(row => row && TASK_STATUSES.includes(row.status)).slice(0, this.maxTasks);
      else if (Array.isArray(raw)) this.tasks = raw.filter(row => row && TASK_STATUSES.includes(row.status)).slice(0, this.maxTasks);
      const at = this.now();
      let recovered = false;
      for (const task of this.tasks) {
        if (recoverReminder(task, at)) recovered = true;
        if (!VERIFICATION_METHODS.includes(task.verificationMethod)) task.verificationMethod = 'manual';
        if (!task.verificationSpec || typeof task.verificationSpec !== 'object' || Array.isArray(task.verificationSpec)) task.verificationSpec = {};
        if (typeof task.idempotencyKey !== 'string') task.idempotencyKey = '';
        if (!Number.isFinite(Number(task.verificationAttempts))) task.verificationAttempts = 0;
        if (!Array.isArray(task.history)) task.history = [];
        // 旧任务补字段：新步骤记录 planIndex/state/verified，旧记录按索引兼容。
        for (const step of Array.isArray(task.steps) ? task.steps : []) {
          if (!Number.isFinite(Number(step.planIndex))) step.planIndex = 0;
          if (typeof step.state !== 'string') step.state = '';
          if (typeof step.verified !== 'boolean') step.verified = false;
          if (typeof step.traceId !== 'string') step.traceId = '';
          if (typeof step.idempotent !== 'boolean') step.idempotent = null;
          if (typeof step.errorClass !== 'string') step.errorClass = '';
          // 执行中崩溃：步骤已写出但没写回结果，只能标 unknown，不能当作成功或重试。
          if (step.status === 'running') {
            step.status = 'unknown';
            step.state = 'unknown';
            step.note = '进程中断，步骤结果未知';
            step.recoveredAt = at;
            recovered = true;
            task.history.push({at, from: task.status, to: task.status, note: '恢复：步骤 ' + (step.planIndex || step.index) + ' 结果未知'});
            task.updatedAt = at;
          }
        }
      }
      try {
        if (recovered) await this.persist();
      } catch {
        this.corrupt = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.corrupt = true;
    }
    return this;
  }

  async persist() {
    const text = JSON.stringify({version: 1, tasks: this.tasks.slice(0, this.maxTasks)}, null, 2);
    const task = this.tail.catch(() => {}).then(async () => {
      await writeFile(this.file + '.tmp', text, {encoding: 'utf8', mode: 0o600});
      await rename(this.file + '.tmp', this.file);
    });
    this.tail = task;
    await task;
  }

  list({status = '', limit = 20} = {}) {
    const rows = this.tasks.filter(row => !status || row.status === status).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  get(id) {
    return this.tasks.find(row => row.id === String(id)) || null;
  }

  async create({goal, reason = '', completion = '', plan = [], maxSteps = 20, budgetMs = 0, verificationMethod = 'manual', verificationSpec = {}, idempotencyKey = '', reminder = null} = {}) {
    const title = clean(goal, 500);
    if (!title) throw new Error('任务目标不能为空');
    const method = VERIFICATION_METHODS.includes(verificationMethod) ? verificationMethod : 'manual';
    if (method === 'tool' && !clean(verificationSpec?.capability, 100)) throw new Error('tool 验证必须声明 capability');
    if (method === 'readback' && !clean(verificationSpec?.capability, 100)) throw new Error('readback 验证必须声明 capability');
    if (method === 'memory' && !clean(verificationSpec?.memoryId, 100)) throw new Error('memory 验证必须声明 memoryId');
    const key = clean(idempotencyKey, 200);
    if (key) {
      const existing = this.tasks.find(task => task.idempotencyKey === key);
      if (existing) return existing;
    }
    if (this.tasks.length >= this.maxTasks) throw new Error('任务数量已达到上限，请先清理旧任务');
    const at = this.now();
    if (reminder && (!Number.isFinite(reminder.dueAt) || reminder.dueAt <= at || reminder.dueAt > at + 366*86400000 || !clean(reminder.text,500))) throw new Error('提醒时间必须在未来一年内，且提醒内容不能为空');
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
      verificationAttempts: 0,
      verification: null,
      memoryIds: [],
      history: [{at, from: '', to: 'pending', note: 'created'}]
    };
    if (reminder) task.reminder = {...structuredClone(reminder), text:clean(reminder.text,500), state:'pending'};
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
    if (task.status === 'failed' && to === 'planning') {
      const latestUnknown = (task.steps || []).filter(step => step.status === 'unknown').at(-1);
      const acknowledgedAt = Number(task.recovery?.acknowledgedAt || 0);
      if (latestUnknown && acknowledgedAt < Number(latestUnknown.at || 0)) {
        throw new Error('存在结果未知的步骤，必须先显式确认恢复');
      }
    }
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

  async recover(id, {confirmed = false, note = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'failed') throw new Error('只有失败任务可以确认恢复');
    if (confirmed !== true) throw new Error('必须明确确认结果未知风险');
    const unknown = (task.steps || []).filter(step => step.status === 'unknown').at(-1);
    if (!unknown) throw new Error('任务没有需要人工确认的未知步骤');
    const at = this.now();
    task.recovery = {
      acknowledgedAt: at,
      stepIndex: Number(unknown.index) || 0,
      note: clean(note, 160) || '主人明确确认后重新规划'
    };
    task.updatedAt = at;
    task.history.push({at, from: 'failed', to: 'failed', note: '人工确认未知步骤风险：' + task.recovery.note});
    await this.persist();
    return this.transition(id, 'planning', task.recovery.note);
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

  async addStep(id, {title, tool = '', status = 'done', outcome = '', note = '', operationKey = '', state = '', verified = false, planIndex = 0, traceId = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'executing') throw new Error('只有执行中的任务可以追加步骤');
    const key = clean(operationKey, 160);
    if (key) {
      const existing = task.steps.find(step => step.operationKey === key);
      if (existing) return existing;
    }
    if (task.steps.length >= task.maxSteps) throw new Error('任务步骤已达到上限');
    const step = {
      index: task.steps.length + 1,
      planIndex: Math.max(0, Math.min(50, Number(planIndex) || 0)),
      title: clean(title, 200),
      tool: clean(tool, 100),
      status: ['pending', 'running', 'done', 'failed', 'skipped'].includes(status) ? status : 'done',
      state: RESULT_STATES.includes(state) ? state : '',
      verified: verified === true,
      outcome: clean(outcome, 200),
      note: clean(note, 200),
      traceId: clean(traceId, 200),
      operationKey: key,
      at: this.now()
    };
    task.steps.push(step);
    task.updatedAt = step.at;
    await this.persist();
    return step;
  }

  // 执行前写意图：先把步骤记为 running 并落盘，再调用外部能力。
  // 进程在调用前/调用中崩溃时，重启后该步骤一定是 unknown，而不是「没发生过」。
  async beginStep(id, {title, planIndex = 0, operationKey = '', traceId = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'executing') throw new Error('只有执行中的任务可以开始步骤');
    const key = clean(operationKey, 160);
    if (key) {
      const existing = task.steps.find(step => step.operationKey === key);
      if (existing) return existing;
    }
    if (task.steps.length >= task.maxSteps) throw new Error('任务步骤已达到上限');
    const at = this.now();
    const step = {
      index: task.steps.length + 1,
      planIndex: Math.max(0, Math.min(50, Number(planIndex) || 0)),
      title: clean(title, 200),
      tool: '',
      status: 'running',
      state: '',
      verified: false,
      outcome: '',
      note: '',
      traceId: clean(traceId, 200),
      errorClass: '',
      idempotent: null,
      operationKey: key,
      at,
      startedAt: at
    };
    task.steps.push(step);
    task.updatedAt = at;
    await this.persist();
    return step;
  }

  // 写回步骤结果；只允许结束 running/pending 的步骤，避免覆盖已记录的结果。
  async completeStep(id, index, {status = 'failed', state = '', verified = false, tool = '', outcome = '', note = '', traceId = '', idempotent = null, errorClass = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    const step = task.steps.find(row => row.index === Number(index));
    if (!step) throw new Error('任务步骤不存在');
    if (!['running', 'pending'].includes(step.status)) throw new Error('步骤已有结果，不能重复写入');
    const at = this.now();
    step.status = ['done', 'failed', 'unknown', 'skipped'].includes(status) ? status : 'failed';
    step.state = RESULT_STATES.includes(state) ? state : '';
    step.verified = verified === true;
    step.tool = clean(tool, 100);
    step.outcome = clean(outcome, 200);
    step.note = clean(note, 200);
    step.traceId = clean(traceId, 200) || step.traceId;
    // true=只读可安全重试；false=调用过写操作，禁止自动重放；null=旧记录/未判定。
    step.idempotent = typeof idempotent === 'boolean' ? idempotent : null;
    step.errorClass = ERROR_CLASSES[errorClass] ? errorClass : (status === 'done' ? '' : classifyFailure({message: note || outcome}));
    step.finishedAt = at;
    task.updatedAt = at;
    await this.persist();
    return step;
  }

  async verify(id, {ok, note = ''} = {}) {
    const task = this.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'verifying') throw new Error('只有验证中的任务可以写入验证结果');
    const at = this.now();
    task.verificationAttempts = Number(task.verificationAttempts || 0) + 1;
    task.verification = {ok: ok === true, note: clean(note, 300), at, attempts: task.verificationAttempts};
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

// 管理台用的紧凑任务快照：步骤、工具、状态、错误分类、重试与验证都可查询；
// 只保留执行元数据，不复制聊天正文或凭据。
export function taskDetail(task) {
  if (!task) return null;
  return {
    id: task.id,
    goal: String(task.goal || '').slice(0, 300),
    status: task.status,
    attempts: Number(task.attempts) || 0,
    maxRetries: Number(task.maxRetries) || 0,
    verificationMethod: task.verificationMethod,
    createdAt: Number(task.createdAt) || 0,
    updatedAt: Number(task.updatedAt) || 0,
    closedAt: Number(task.closedAt) || 0,
    verification: task.verification ? {...task.verification} : null,
    reminder: task.reminder ? {...task.reminder} : null,
    recovery: task.recovery ? {...task.recovery} : null,
    plan: (task.plan || []).slice(0, 20).map(item => String(item).slice(0, 150)),
    steps: (task.steps || []).slice(-15).map(step => ({
      index: step.index,
      planIndex: step.planIndex,
      title: step.title,
      tool: step.tool,
      status: step.status,
      state: step.state,
      verified: step.verified === true,
      idempotent: typeof step.idempotent === 'boolean' ? step.idempotent : null,
      errorClass: step.errorClass || '',
      outcome: step.outcome,
      note: step.note,
      traceId: step.traceId || '',
      at: Number(step.at) || 0,
      finishedAt: Number(step.finishedAt) || 0
    })),
    history: (task.history || []).slice(-8).map(row => ({at: row.at, from: row.from, to: row.to, note: row.note}))
  };
}
