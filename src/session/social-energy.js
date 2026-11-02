import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export class SocialEnergy {
  constructor(dir, { now = () => Date.now(), log = () => {} } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'social-energy.json');
    this.now = now;
    this.log = log;
    this.state = { level: 0.72, updatedAt: 0, reason: '初始状态', lastEmotion: '' };
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value && typeof value === 'object') this.state = { ...this.state, ...value, level: clamp(value.level) };
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('warn', '社交精力读取失败，已使用默认状态');
    }
    this.state.updatedAt ||= this.now();
    return this;
  }

  async persist() {
    await writeFile(this.file, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }

  recover({ sleeping = false } = {}) {
    const elapsed = Math.max(0, this.now() - Number(this.state.updatedAt || this.now()));
    const rate = sleeping ? 0.000025 : 0.000006;
    if (elapsed > 0) this.state.level = clamp(this.state.level + elapsed * rate);
    this.state.updatedAt = this.now();
    return this.state.level;
  }

  consume(amount, reason) {
    this.recover();
    this.state.level = clamp(this.state.level - Math.max(0, Number(amount) || 0));
    this.state.updatedAt = this.now();
    this.state.reason = String(reason || '社交活动').slice(0, 120);
    return this.state.level;
  }

  recordMessage({ incoming = true, proactive = false } = {}) {
    if (proactive) return this.consume(0.08, '主动联系');
    return this.consume(incoming ? 0.015 : 0.03, incoming ? '收到消息' : '回复消息');
  }

  reflectEmotion({ mood = '平静', intensity = 0 } = {}) {
    const level = clamp(intensity);
    const key = `${String(mood)}:${Math.round(level * 20)}`;
    if (key === this.state.lastEmotion) return this.state.level;
    this.recover();
    const draining = new Set(['失落', '烦躁', '疲倦']);
    const restoring = new Set(['开心', '好奇', '期待']);
    if (draining.has(mood)) this.state.level = clamp(this.state.level - level * 0.06);
    if (restoring.has(mood)) this.state.level = clamp(this.state.level + level * 0.03);
    this.state.lastEmotion = key;
    this.state.reason = `情绪影响：${String(mood).slice(0, 12)}`;
    this.state.updatedAt = this.now();
    return this.state.level;
  }

  available(min = 0.2) {
    this.recover();
    return this.state.level >= min;
  }

  context() {
    this.recover();
    const level = this.state.level;
    const feeling = level < 0.2 ? '社交精力偏低，回复简短，少主动插话' : level < 0.45 ? '社交精力一般，保持自然节奏' : '社交精力充足，可以正常交流';
    return `[她此刻的社交精力，仅作为表达和节奏参考]\n${feeling}。不要播报数值，也不要把精力状态当成事实。`;
  }

  snapshot() {
    this.recover();
    return { ...this.state };
  }
}
