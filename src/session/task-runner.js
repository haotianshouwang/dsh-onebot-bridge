// 有限任务执行器：只推进已经持久化、明确进入 planning/executing 的任务。
// 每个 tick 只执行一步；模型会话由宿主注入，工具白名单由宿主决定。没有执行结果就不写成功。
import {failureOf} from '../core/errors.js';
export class TaskRunner {
  constructor({tasks, enabled, executeStep, verifyTask, onDone, guard, now = Date.now, log} = {}) {
    this.tasks = tasks;
    this.enabled = enabled || (() => false);
    this.executeStep = executeStep;
    this.verifyTask = verifyTask;
    this.onDone = onDone;
    this.guard = guard;
    this.now = now;
    this.log = log;
    this.running = false;
  }

  async recheck(task) {
    let verdict;
    try {
      verdict = await this.verifyTask({task});
    } catch (error) {
      verdict = {ok: false, note: String(error?.message || error).slice(0, 200)};
    }
    const ok = verdict?.ok === true;
    await this.tasks.verify(task.id, {ok, note: String(verdict?.note || (ok ? '自动验证通过' : '自动验证未通过')).slice(0, 300)});
    if (!ok) return {ok: false, taskId: task.id, status: 'verifying', verification: false, error: String(verdict?.note || '自动验证未通过').slice(0, 200)};
    const done = await this.tasks.transition(task.id, 'done', 'auto verification retry: ' + String(verdict?.note || '').slice(0, 100));
    if (typeof this.onDone === 'function') {
      try { await this.onDone(done); } catch (error) { this.log?.('warn', '任务完成通知失败：' + String(error?.message || error).slice(0, 120)); }
    }
    return {ok: true, taskId: task.id, status: 'done', verification: true, retry: true};
  }

  async finish(task) {
    await this.tasks.transition(task.id, 'verifying', 'all planned steps recorded');
    if (task.verificationMethod === 'manual' || typeof this.verifyTask !== 'function') {
      return {ok: true, taskId: task.id, status: 'verifying'};
    }
    let verdict;
    try {
      verdict = await this.verifyTask({task: this.tasks.get(task.id)});
    } catch (error) {
      verdict = {ok: false, note: String(error?.message || error).slice(0, 200)};
    }
    const ok = verdict?.ok === true;
    await this.tasks.verify(task.id, {ok, note: String(verdict?.note || (ok ? '自动验证通过' : '自动验证未通过')).slice(0, 300)});
    if (!ok) {
      return {ok: false, taskId: task.id, status: 'verifying', verification: false, error: String(verdict?.note || '自动验证未通过').slice(0, 200)};
    }
    const done = await this.tasks.transition(task.id, 'done', 'auto verification: ' + String(verdict?.note || '').slice(0, 100));
    if (typeof this.onDone === 'function') {
      try { await this.onDone(done); } catch (error) { this.log?.('warn', '任务完成通知失败：' + String(error?.message || error).slice(0, 120)); }
    }
    return {ok: true, taskId: task.id, status: 'done', verification: true};
  }

  async tick() {
    if (this.running) return {ok: false, skipped: 'busy'};
    if (!this.enabled()) return {ok: false, skipped: 'disabled'};
    const candidates = [
      ...this.tasks.list({status: 'executing', limit: 10}),
      ...this.tasks.list({status: 'planning', limit: 10}),
      ...this.tasks.list({status: 'verifying', limit: 10}).filter(task => task.verificationMethod !== 'manual' && task.verification?.ok === false && Number(task.verificationAttempts || 0) < 2)
    ];
    const task = candidates.filter(task=>!task.reminder).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!task) return {ok: false, skipped: 'no-task'};
    if (task.status === 'verifying' && task.verificationMethod !== 'manual' && task.verification?.ok === false) return await this.recheck(task);
    if (task.budgetMs > 0 && this.now() - task.createdAt > task.budgetMs) {
      await this.tasks.transition(task.id, 'failed', 'task budget exceeded');
      return {ok: false, taskId: task.id, status: 'failed', error: 'task budget exceeded'};
    }
    this.running = true;
    try {
      if (task.status === 'planning') await this.tasks.transition(task.id, 'executing', 'runner started');
      const plan = Array.isArray(task.plan) ? task.plan : [];
      // 失败/未知步骤不计入计划完成；重试时仍从同一计划步继续。
      const index = task.steps.filter(step => step.status === 'done').length;
      if (index >= Math.max(1, plan.length)) return await this.finish(task);

      // 上一次已写出执行意图但没有结果：不得自动重放，必须人工确认后重新规划。
      const current = this.tasks.get(task.id);
      const stalled = current.steps.find(step => {
        const position = Number(step.planIndex) > 0 ? Number(step.planIndex) : Number(step.index);
        return step.status === 'unknown' && position === index + 1;
      });
      const acknowledged = Number(current.recovery?.acknowledgedAt || 0) >= Number(stalled?.at || 0);
      if (stalled && !acknowledged) {
        const note = '步骤结果未知，需人工确认后重新规划';
        await this.tasks.transition(task.id, 'failed', note);
        return {ok: false, taskId: task.id, status: 'failed', error: note};
      }

      // 恢复时重新检查执行条件（在线、主人、包启用由 enabled() 负责）。
      if (typeof this.guard === 'function') {
        let blocked;
        try {
          blocked = await this.guard(task);
        } catch (error) {
          blocked = String(error?.message || error);
        }
        if (blocked) {
          const reason = ('前置条件不满足：' + String(blocked)).slice(0, 160);
          await this.tasks.transition(task.id, 'failed', reason);
          return {ok: false, taskId: task.id, status: 'failed', error: reason};
        }
      }

      const title = plan[index] || ('步骤 ' + (index + 1));
      const attempt = current.steps.filter(step => Number(step.planIndex) === index + 1).length + 1;
      const intent = await this.tasks.beginStep(task.id, {
        title,
        planIndex: index + 1,
        operationKey: `exec:${task.id}:${index + 1}:${attempt}`.slice(0, 160)
      });
      let result;
      try {
        result = await this.executeStep({task, index, title, completion: task.completion});
      } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        result = {ok: false, error: message, unknown: /超时|未知|断开|UNKNOWN_OUTCOME/i.test(message)};
      }
      const ok = result?.ok === true;
      const failure = ok ? null : failureOf({message: String(result?.error || '步骤没有可验证结果')});
      const unknown = result?.unknown === true || String(result?.state || '') === 'unknown' || failure?.errorClass === 'unknown';
      await this.tasks.completeStep(task.id, intent.index, {
        status: ok ? 'done' : unknown ? 'unknown' : 'failed',
        state: String(result?.state || (unknown ? 'unknown' : '')),
        verified: result?.verified === true,
        tool: result?.tool || '',
        traceId: String(result?.traceId || ''),
        idempotent: typeof result?.idempotent === 'boolean' ? result.idempotent : null,
        errorClass: failure?.errorClass || '',
        outcome: String(result?.outcome || result?.text || result?.error || '').slice(0, 200),
        note: ok ? '' : String(result?.error || '步骤没有可验证结果').slice(0, 200)
      });
      if (!ok) {
        const error = String(result?.error || 'step failed');
        await this.tasks.transition(task.id, 'failed', error.slice(0, 160));
        if (unknown) return {ok: false, taskId: task.id, status: 'failed', error: '结果未知，已停止自动执行：' + error.slice(0, 160)};
        if (result?.idempotent === false) return {ok: false, taskId: task.id, status: 'failed', error: '非幂等操作失败，不自动重试：' + error.slice(0, 140)};
        const failed = this.tasks.get(task.id);
        if (failed && failed.attempts <= failed.maxRetries) {
          await this.tasks.transition(task.id, 'planning', 'retry ' + failed.attempts + '/' + failed.maxRetries);
          return {ok: false, taskId: task.id, status: 'planning', retry: true, error: error.slice(0, 200)};
        }
        return {ok: false, taskId: task.id, status: 'failed', error: error.slice(0, 200)};
      }
      const updated = this.tasks.get(task.id);
      if (updated && updated.steps.filter(step => step.status === 'done').length >= Math.max(1, updated.plan.length)) {
        const finished = await this.finish(updated);
        return {...finished, step: title};
      }
      return {ok: true, taskId: task.id, status: this.tasks.get(task.id)?.status, step: title};
    } finally {
      this.running = false;
    }
  }
}
