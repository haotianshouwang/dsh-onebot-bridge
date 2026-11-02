import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LIFE_STATES = Object.freeze([
  'awake',
  'tired',
  'winding-down',
  'sleeping',
  'insomnia',
  'nightmare-awake',
  'waking'
]);

const URGENT_WORDS = /紧急|急事|很急|出事|救命|快醒|醒醒|重要的事|马上回复|立刻回复/i;

function clean(value, max = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseTime(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return hour * 60 + minute;
}

function minuteOf(now) {
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
}

function inWindow(nowMinute, start, end) {
  return start < end ? nowMinute >= start && nowMinute < end : nowMinute >= start || nowMinute < end;
}

export function isUrgentMessage(message) {
  return URGENT_WORDS.test(String(message?.text || ''));
}

export class LifeState {
  constructor(dir, { now = () => Date.now(), log = () => {} } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'life-state.json');
    this.now = now;
    this.log = log;
    this.state = {
      state: 'awake',
      updatedAt: 0,
      reason: '',
      sleepAt: '00:30',
      wakeAt: '08:30',
      lastTransition: null,
      pendingMessages: 0
    };
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value && typeof value === 'object') {
        this.state = {
          ...this.state,
          ...value,
          state: LIFE_STATES.includes(value.state) ? value.state : 'awake'
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('warn', '睡眠状态读取失败，已使用默认状态');
    }
    return this;
  }

  async persist() {
    await writeFile(this.file, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }

  configure({ sleepAt, wakeAt } = {}) {
    this.state.sleepAt = String(sleepAt || this.state.sleepAt);
    this.state.wakeAt = String(wakeAt || this.state.wakeAt);
    return this.snapshot();
  }

  snapshot() {
    return { ...this.state, nextTransition: this.nextTransition() };
  }

  transition(state, reason = '') {
    if (!LIFE_STATES.includes(state)) throw new Error('睡眠状态无效');
    const at = this.now();
    this.state.state = state;
    this.state.updatedAt = at;
    this.state.reason = clean(reason);
    this.state.lastTransition = { at, state, reason: this.state.reason };
    return this.snapshot();
  }

  sleep(reason = '按作息入睡') {
    return this.transition('sleeping', reason);
  }

  wake(reason = '自然醒来') {
    return this.transition('awake', reason);
  }

  setInsomnia(reason = '失眠') {
    return this.transition('insomnia', reason);
  }

  setNightmareAwake(reason = '噩梦惊醒') {
    return this.transition('nightmare-awake', reason);
  }

  nextTransition() {
    const now = this.now();
    const current = minuteOf(now);
    const sleep = parseTime(this.state.sleepAt, 30);
    const wake = parseTime(this.state.wakeAt, 510);
    const target = this.state.state === 'sleeping' || this.state.state === 'insomnia' || this.state.state === 'nightmare-awake' ? wake : sleep;
    let delta = target - current;
    if (delta <= 0) delta += 24 * 60;
    return new Date(now + delta * 60000).toISOString();
  }

  tick({ enabled = false } = {}) {
    if (!enabled) return this.snapshot();
    const current = minuteOf(this.now());
    const sleep = parseTime(this.state.sleepAt, 30);
    const wake = parseTime(this.state.wakeAt, 510);
    if (this.state.state === 'awake' || this.state.state === 'tired') {
      if (inWindow(current, sleep, wake)) return this.sleep();
    } else if (this.state.state === 'sleeping' && !inWindow(current, sleep, wake)) {
      return this.transition('waking', '到达自然起床时间');
    } else if (this.state.state === 'waking') {
      return this.wake('完成起床');
    }
    return this.snapshot();
  }

  shouldReply(message, { owner = false } = {}) {
    const state = this.state.state;
    if (!['sleeping', 'insomnia', 'nightmare-awake'].includes(state)) return { allow: true, reason: '' };
    const ownerPrivate = message?.kind === 'private' && owner === true;
    const urgent = isUrgentMessage(message);
    if (state === 'sleeping' && ownerPrivate && urgent) {
      this.wake('主人发送紧急消息');
      return { allow: true, reason: 'urgent-wake', woke: true };
    }
    if (['insomnia', 'nightmare-awake'].includes(state) && ownerPrivate) {
      this.wake(state === 'insomnia' ? '失眠时收到主人消息' : '噩梦惊醒后收到主人消息');
      return { allow: true, reason: 'awake-message', woke: true };
    }
    if (ownerPrivate) this.state.pendingMessages = Number(this.state.pendingMessages || 0) + 1;
    return { allow: false, reason: state === 'sleeping' ? 'sleeping' : 'sleeping-group' };
  }

  context({ enabled = false } = {}) {
    if (!enabled) return '';
    const labels = {
      awake: '清醒', tired: '有些疲惫', 'winding-down': '准备休息', sleeping: '正在睡觉',
      insomnia: '失眠中', 'nightmare-awake': '刚从噩梦中惊醒', waking: '刚起床'
    };
    return `[她当前的作息状态，仅作为回复时机参考]\n${labels[this.state.state] || '清醒'}。不要把状态值直接告诉对方，也不要在睡眠时主动联系。`;
  }

  isSleeping() {
    return ['sleeping', 'insomnia', 'nightmare-awake'].includes(this.state.state);
  }
}
