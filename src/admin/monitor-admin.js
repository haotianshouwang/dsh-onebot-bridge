// 管理台只读投影；状态来自角色、任务、连接和遥测，不触发任何模型请求。
import {createMonitorUsage} from './monitor-usage.js';
const SLEEP_LABELS = {awake: '清醒', tired: '有些疲倦', 'winding-down': '准备休息', sleeping: '睡眠中', insomnia: '暂未入睡', 'nightmare-awake': '夜间醒来', waking: '正在醒来'};

export function createMonitorAdmin({activity, runtimeMonitor, resources, getStatus, getLife, getEmotion, getJobs, getPackages, getActivities = () => [], getDelivery = () => [], getWatchJobs = () => []}) {
  const usage = createMonitorUsage(activity);
  function character() {
    const status = getStatus() || {};
    const life = getLife?.() || null;
    const emotion = getEmotion?.() || null;
    const runtime = runtimeMonitor.snapshot();
    const active = runtime.active.filter(row => row.kind === 'model' || row.kind === 'operation');
    for (const job of getWatchJobs()) {
      if (!['accepted', 'running'].includes(job.state)) continue;
      active.push({id: job.id, kind: 'media', purpose: 'video-watch', platform: job.platform, status: job.state,
        startedAt: job.createdAt, requestedSeconds: job.requestedSeconds});
    }
    const phase = life?.sleep?.phase;
    const recent = getActivities().at(-1);
    const jobs = getJobs().filter(row => ['running', 'sending', 'deciding', 'observing', 'queued', 'collecting'].includes(row.status));
    const state = phase === 'sleeping' ? 'sleeping' : active.length ? 'working' : status.paused ? 'paused' : status.online ? 'idle' : 'offline';
    return {
      qq: status.bot || '', name: status.nickname || '', online: status.online === true, paused: status.paused === true,
      avatarUrl: status.bot ? '/api/bot-avatar?id=' + encodeURIComponent(status.bot) : '',
      mood: emotion?.observed ? emotion.state?.global || null : null, moodObserved: emotion?.observed === true, moodEnabled: emotion?.enabled === true,
      energy: life?.energy?.current ?? null, socialEnergy: life?.energy?.components?.social ?? null,
      sleepPhase: phase || '', sleepLabel: SLEEP_LABELS[phase] || phase || '未知', lifeUpdatedAt: life?.updatedAt || null,
      state, active, queueCount: jobs.length,
      lastActivity: recent ? {at: recent.at || recent.end || recent.start, type: recent.type || recent.category || '', status: recent.outcome || recent.status || ''} : null
    };
  }

  function delivery() {
    const rows = getDelivery();
    const counts = {confirmed: 0, failed: 0, unknown: 0, accepted: 0, cancelled: 0, other: 0};
    for (const row of rows) {
      const key = Object.hasOwn(counts, row.finalState) ? row.finalState : 'other';
      counts[key]++;
    }
    return {scope: 'retained-message-receipts', retained: rows.length, ...counts};
  }

  function overview(query = {}) {
    return {sampledAt: Date.now(), character: character(), resources: resources.snapshot(), usage: usage.summary(query),
      runtime: runtimeMonitor.snapshot(), packages: getPackages(), delivery: delivery()};
  }

  function invoke(op = 'overview', query = {}) {
    if (op === 'overview') return overview(query);
    if (op === 'records') return usage.list(query);
    if (op === 'summary') return usage.summary(query);
    throw new Error('不支持的监控操作');
  }

  return {overview, invoke};
}
