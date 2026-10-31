// 有限任务执行器：只推进已经持久化、明确进入 planning/executing 的任务。
// 每个 tick 只执行一步；模型会话由宿主注入，工具白名单由宿主决定。没有执行结果就不写成功。
export class TaskRunner {
  constructor({tasks, enabled, executeStep, now = Date.now, log} = {}) {
    this.tasks = tasks;
    this.enabled = enabled || (() => false);
    this.executeStep = executeStep;
    this.now = now;
    this.log = log;
    this.running = false;
  }

  async tick() {
    if (this.running) return {ok: false, skipped: 'busy'};
    if (!this.enabled()) return {ok: false, skipped: 'disabled'};
    const candidates = [
      ...this.tasks.list({status: 'executing', limit: 10}),
      ...this.tasks.list({status: 'planning', limit: 10})
    ];
    const task = candidates.sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!task) return {ok: false, skipped: 'no-task'};
    this.running = true;
    try {
      if (task.status === 'planning') await this.tasks.transition(task.id, 'executing', 'runner started');
      // 失败步骤不能算作计划完成；重试时仍从同一步继续。
      const index = task.steps.filter(step => step.status === 'done').length;
      const plan = task.plan || [];
      if (index >= Math.max(1, plan.length)) {
        await this.tasks.transition(task.id, 'verifying', 'all planned steps recorded');
        return {ok: true, taskId: task.id, status: 'verifying'};
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
      if (updated && updated.steps.length >= Math.max(1, updated.plan.length)) {
        await this.tasks.transition(task.id, 'verifying', 'planned steps complete');
      }
      return {ok: true, taskId: task.id, status: this.tasks.get(task.id)?.status, step: title};
    } finally {
      this.running = false;
    }
  }
}
