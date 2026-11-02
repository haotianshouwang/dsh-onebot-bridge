// 持久化定时提醒；只发送已创建的当前聊天目标，未知结果不自动重发。
const SENT_STATES = new Set(['submitted', 'accepted', 'confirmed']);
const ACTIVE_STATUSES = new Set(['analyzing', 'planning', 'executing', 'verifying']);

function number(text) {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === '半') return 0.5;
  const digits = {零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char in digits) current = digits[char];
    else if (char === '十' || char === '百') {
      total += (current || 1) * (char === '十' ? 10 : 100);
      current = 0;
    } else return NaN;
  }
  return total + current;
}

// 只兜底处理明确、直接、发给自己的相对时间请求；复杂日期交给结构化工具。
export function parseReminderRequest(value) {
  const text = String(value || '').trim();
  const match = /^(?:请|麻烦你|帮我)?\s*([零一二两三四五六七八九十百半\d.]+)\s*(秒钟?|分钟?|小时|天)后\s*(?:提醒我\s*(.{1,160})|(?:给我|找我)(?:发(?:一?[个条])?(?:信息|消息)|说(?:个|一句)?话|聊(?:个|一会儿|一下)?天))[。！!]?$/u.exec(text);
  if (!match) return null;
  const unit = /^秒/.test(match[2]) ? 1 : /^分/.test(match[2]) ? 60 : match[2] === '小时' ? 3600 : 86400;
  const seconds = number(match[1]) * unit;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 366 * 86400) return null;
  return {
    delaySeconds: seconds,
    text: match[3] ? '提醒你：' + match[3].replace(/[。！!]$/u, '') : '时间到了，我来找你啦。'
  };
}

export function recoverReminder(task, at) {
  if (!task.reminder || ['done', 'cancelled', 'failed'].includes(task.status)) return false;
  const previous = task.status;
  let note;
  if (task.reminder.state === 'sending') {
    task.reminder.state = 'unknown';
    task.status = 'failed';
    note = '提醒发送中断，结果未知，不自动重发';
  } else if (task.reminder.state === 'pending' && ACTIVE_STATUSES.has(task.status)) {
    task.status = 'pending';
    note = '提醒尚未进入发送，恢复等待调度';
  } else if (SENT_STATES.has(task.reminder.state) && ACTIVE_STATUSES.has(task.status)) {
    task.status = 'done';
    task.verification = {ok: true, at, note: '恢复已保存的提醒发送回执；不代表对方已读'};
    task.closedAt = at;
    note = '提醒已有回执，不重复发送';
  } else return false;
  task.history ||= [];
  task.history.push({at, from: previous, to: task.status, note});
  task.updatedAt = at;
  return true;
}

export class ReminderScheduler {
  constructor({tasks, send, available, guard, now = Date.now, log = () => {}}) {
    Object.assign(this, {tasks, send, available, guard, now, log});
    this.running = false;
  }

  async tick() {
    if (this.running || !this.available()) return;
    this.running = true;
    try {
      const due = this.tasks.tasks.filter(task => task.status === 'pending'
        && task.reminder?.state === 'pending' && task.reminder.dueAt <= this.now());
      due.sort((a, b) => a.reminder.dueAt - b.reminder.dueAt);
      for (const task of due) await this.dispatch(task);
    } finally {
      this.running = false;
    }
  }

  async dispatch(task) {
    if (!this.available() || task.status !== 'pending') return;
    const blocked = await this.guard(task.reminder);
    if (blocked) {
      task.reminder.state = 'cancelled';
      await this.tasks.transition(task.id, 'cancelled', String(blocked));
      return;
    }
    for (const status of ['analyzing', 'planning', 'executing']) {
      if (task.status === 'cancelled') return;
      await this.tasks.transition(task.id, status, '持久化提醒调度');
    }
    task.reminder.state = 'sending';
    // 先落盘发送意图；断电/超时后不把非幂等发送自动重放。
    await this.tasks.persist();
    let result;
    try {
      const changed = await this.guard(task.reminder);
      if (changed || task.status === 'cancelled') {
        task.reminder.state = 'cancelled';
        if (task.status !== 'cancelled') await this.tasks.transition(task.id, 'cancelled', changed || '发送条件已变化');
        else await this.tasks.persist();
        return;
      }
      if (!this.available()) {
        // 尚未调用发送，离线/暂停不应丢掉已确认创建的提醒。
        task.reminder.state = 'pending';
        task.history.push({at: this.now(), from: task.status, to: 'pending', note: '发送前离线或暂停，继续等待'});
        task.status = 'pending';
        task.updatedAt = this.now();
        await this.tasks.persist();
        return;
      }
      result = await this.send(task.reminder);
    } catch {
      task.reminder.state = 'unknown';
      if (task.status !== 'cancelled') await this.tasks.transition(task.id, 'failed', '提醒发送结果未知，停止自动重发');
      else await this.tasks.persist();
      this.log('warn', '提醒发送结果未知，停止自动重发');
      return;
    }
    await this.record(task, result);
  }

  async record(task, result) {
    const state = String(result?.state || 'unknown');
    task.reminder.state = state;
    task.reminder.sentAt = this.now();
    if (result?.data?.message_id != null) task.reminder.messageId = String(result.data.message_id);
    if (task.status === 'cancelled') {
      await this.tasks.persist();
      return;
    }
    if (!SENT_STATES.has(state)) {
      await this.tasks.transition(task.id, 'failed', '提醒未获有效发送回执，不自动重发');
      return;
    }
    await this.tasks.addStep(task.id, {title: '提交定时提醒', tool: 'qq.message.send', state, verified: state === 'confirmed', outcome: state});
    await this.tasks.transition(task.id, 'verifying', '核验提醒发送回执');
    const note = state === 'confirmed' ? '自己的消息记录已核验；不代表对方已读' : '提醒已提交/受理；未证明对方收到或已读';
    await this.tasks.verify(task.id, {ok: true, note});
    await this.tasks.transition(task.id, 'done', '提醒发送请求已处理，不重复发送');
    this.log('info', '定时提醒已处理', {taskId: task.id, state});
  }
}
