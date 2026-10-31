// 有限任务执行器：只推进已经持久化、明确进入 planning/executing 的任务。
// 每个 tick 只执行一步；模型会话由宿主注入，工具白名单由宿主决定。没有执行结果就不写成功。
export class TaskRunner {
  constructor({tasks, enabled, executeStep, verifyTask, onDone, now = Date.now, log} = {}) {
    this.tasks = tasks;
    this.enabled = enabled || (() => false);
    this.executeStep = executeStep;
    this.verifyTask = verifyTask;
    this.onDone = onDone;
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
    const task = candidates.sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!task) return {ok: false, skipped: 'no-task'};
    if (task.status === 'verifying' && task.verificationMethod !== 'manual' && task.verification?.ok === false) return await this.recheck(task);
    if (task.budgetMs > 0 && this.now() - task.createdAt > task.budgetMs) {
      await this.tasks.transition(task.id, 'failed', 'task budget exceeded');
      return {ok: false, taskId: task.id, status: 'failed', error: 'task budget exceeded'};
    }
    this.running = true;
    try {
      if (task.status === 'planning') await this.tasks.transition(task.id, 'executing', 'runner started');
      // 失败步骤不能算作计划完成；重试时仍从同一步继续。
      const index = task.steps.filter(step => step.status === 'done').length;
      const plan = task.plan || [];
      if (index >= Math.max(1, plan.length)) {
        return await this.finish(task);
      }
      const title = plan[index] || ('步骤 ' + (index + 1));
      let result;
      try {
        result = await this.executeStep({task, index, title, completion: task.completion});
      } catch (error) {
        result = {ok: false, error: String(error?.message || error).slice(0, 240)};
      }
      const ok = result?.ok === true;
      await this.tasks.addStep(task.id, {
        title,
        tool: result?.tool || '',
        status: ok ? 'done' : 'failed',
        outcome: String(result?.outcome || result?.text || result?.error || '').slice(0, 200),
        note: ok ? '' : String(result?.error || '步骤没有可验证结果').slice(0, 200)
      });
      if (!ok) {
        await this.tasks.transition(task.id, 'failed', String(result?.error || 'step failed').slice(0, 160));
        const failed = this.tasks.get(task.id);
        if (failed && failed.attempts <= failed.maxRetries) {
          await this.tasks.transition(task.id, 'planning', 'retry ' + failed.attempts + '/' + failed.maxRetries);
          return {ok: false, taskId: task.id, status: 'planning', retry: true, error: String(result?.error || 'step failed').slice(0, 200)};
        }
        return {ok: false, taskId: task.id, status: 'failed', error: String(result?.error || 'step failed').slice(0, 200)};
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
