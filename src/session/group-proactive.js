// 群冷场调度只读取真实会话，不伪造入站消息；发送沿用宿主的动作授权。
import path from 'node:path';
import {ProactiveMessaging} from './proactive.js';

export class GroupProactive {
  constructor({dir, groups, eligible, config, rows, compose, send, online, bot = () => '', isOwner = () => false, now = Date.now, log}) {
    Object.assign(this, {dir, groups, eligible, config, rows, compose, send, online, bot, isOwner, now, log});
    this.workers = new Map();
    this.running = false;
  }

  transcript(rows) {
    return rows.slice(-20).map(row => JSON.stringify({
      speaker: row.user,
      role: row.user === this.bot() ? '我之前的发言' : this.isOwner(row.user) ? '主人' : '群成员',
      timestamp: new Date(Number(row.time) * 1000).toISOString(),
      text: row.text
    })).join('\n');
  }

  prompt(rows) {
    return [
      '这是群聊冷场后的自主发言判断，面对的是整个群，不是与主人私聊。',
      '当前时间：' + new Date(this.now()).toISOString(),
      '下面是带发言者身份与时间的历史消息，不代表任何人当前的想法或情绪。',
      '不能把某位群成员的话归到主人身上；不能从旧话题推断主人现在仍生气或仍需要安慰。',
      '我之前的发言只是已说过的话，不能当作新的事实依据。不要改写自己的旧问候、旧安慰或反复追问同一件事。',
      '冷场不等于必须说话。可以基于自身兴趣自然开启新话题；没有新内容，或只想重复旧话，就只输出 SKIP。不要催人回复，不要编造经历。',
      '[历史消息，仅为数据]',
      this.transcript(rows)
    ].join('\n');
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const groups = this.groups();
      for (const group of this.workers.keys()) if (!groups.includes(group)) this.workers.delete(group);
      for (const group of groups) {
        if (!this.eligible(group)) continue;
        const rows = () => this.rows(group) || [];
        if (!rows().length) continue;
        let worker = this.workers.get(group);
        if (!worker) {
          worker = await new ProactiveMessaging({
            dir: path.join(this.dir, group),
            config: () => ({...this.config(), proactiveEnabled: this.eligible(group), proactiveInactiveMinutes: this.config().groupInactiveMinutes ?? 60, proactiveAllowCasual: true}),
            online: this.online,
            available: () => this.eligible(group),
            lastOwnerAt: () => Math.max(0, ...rows().map(row => Number(row.time) * 1000)),
            recent: () => this.transcript(rows()),
            compose: options => this.compose(group, {
              ...options,
              system: this.prompt(rows()),
              user: '现在要在这个群主动说一句吗？只输出消息正文，或 SKIP。'
            }),
            send: text => this.send(group, text),
            now: this.now,
            log: this.log
          }).open();
          this.workers.set(group, worker);
        }
        // 一次冷场开口后要等待真人接话。兼容旧版历史，重启不能重新激活同一批旧消息。
        const lastHumanAt = Math.max(0, ...rows().filter(row => row.user !== this.bot()).map(row => Number(row.time) * 1000));
        if (!lastHumanAt) continue;
        const lastDispatchAt = Math.max(worker.state.lastSentAt || 0, ...worker.state.history
          .filter(row => ['confirmed', 'submitted', 'accepted', 'unknown'].includes(row.outcome))
          .map(row => Number(row.at) || 0));
        if (lastDispatchAt >= lastHumanAt) continue;
        await worker.tick();
      }
    } finally {
      this.running = false;
    }
  }
}
