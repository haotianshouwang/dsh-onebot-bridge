import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SECRET = /密码|口令|token|令牌|cookie|验证码|密钥|私钥|secret/i;

function clean(value, max = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(values, max = 12) {
  return [...new Set(values.map(value => clean(value, 80)).filter(Boolean))].slice(-max);
}

function extract(text) {
  const value = clean(text, 500);
  if (!value || SECRET.test(value)) return {};
  const result = {};
  const name = value.match(/^(?:我叫|叫我|我的名字是)\s*([^，。！？!?,\s]{1,24})/);
  if (name) result.name = name[1];
  const like = value.match(/^(?:我喜欢|我爱|我偏好)\s*(.{1,50})[。！？!?,]?$/);
  if (like) result.preference = like[1];
  const dislike = value.match(/^(?:我不喜欢|我讨厌|我忌讳)\s*(.{1,50})[。！？!?,]?$/);
  if (dislike) result.boundary = dislike[1];
  const trait = value.match(/^(?:我是|我属于)\s*(.{1,40})[。！？!?,]?$/);
  if (trait) result.trait = trait[1];
  return result;
}

export class ProfileStore {
  constructor(dir, { now = () => Date.now(), log = () => {} } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'profiles.json');
    this.now = now;
    this.log = log;
    this.data = { version: 1, profiles: {} };
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value && typeof value === 'object') this.data = { version: 1, profiles: {}, ...value, profiles: value.profiles || {} };
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('warn', '人物画像读取失败，已使用空画像');
    }
    return this;
  }

  async persist() {
    await writeFile(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  observe({ user, sender = '', kind, peer, bot, owner, messageId, text = '' } = {}) {
    const id = String(user || '').trim();
    if (!id || id === String(bot || '')) return null;
    const key = id;
    const current = this.data.profiles[key] || {
      id,
      entityType: 'user',
      canonicalName: id,
      aliases: [],
      relationship: id === String(owner || '') ? 'owner' : 'member',
      traits: [],
      preferences: [],
      boundaries: [],
      shared: true,
      confidence: 0.55,
      sources: [],
      createdAt: this.now()
    };
    const display = clean(sender || '');
    if (display && display !== id) {
      current.canonicalName = current.canonicalName === id ? display : current.canonicalName;
      current.aliases = unique([...current.aliases, display]);
    }
    if (id === String(owner || '')) current.relationship = 'owner';
    const sourceChat = clean(`${bot || ''}:${kind || ''}:${peer || ''}`, 100);
    current.sources = [...current.sources, { chat: sourceChat, messageId: clean(messageId, 80), at: this.now() }].slice(-20);
    const found = extract(text);
    if (found.name) {
      current.canonicalName = found.name;
      current.aliases = unique([...current.aliases, display, found.name]);
      current.confidence = Math.max(current.confidence, 0.78);
    }
    if (found.preference) current.preferences = unique([...current.preferences, found.preference]);
    if (found.boundary) current.boundaries = unique([...current.boundaries, found.boundary]);
    if (found.trait) current.traits = unique([...current.traits, found.trait]);
    current.updatedAt = this.now();
    this.data.profiles[key] = current;
    return this.public(key);
  }

  public(id) {
    const row = this.data.profiles[String(id || '')];
    if (!row) return null;
    return {
      id: row.id,
      entityType: row.entityType,
      canonicalName: row.canonicalName,
      aliases: [...row.aliases],
      relationship: row.relationship,
      traits: [...row.traits],
      preferences: [...row.preferences],
      boundaries: [...row.boundaries],
      shared: row.shared === true,
      confidence: Number(row.confidence) || 0,
      updatedAt: row.updatedAt || 0,
      sources: row.sources.map(source => ({ ...source }))
    };
  }

  context({ actor, owner, kind, peer, bot } = {}) {
    const rows = [];
    const self = this.public(bot);
    const person = this.public(actor);
    const ownerProfile = this.public(owner);
    if (self) rows.push(self);
    if (person && person.id !== self?.id) rows.push(person);
    if (ownerProfile && !rows.some(row => row.id === ownerProfile.id)) rows.push(ownerProfile);
    if (!rows.length) return '';
    const safe = rows.map(row => ({
      id: row.id,
      name: row.canonicalName,
      aliases: row.aliases,
      relationship: row.relationship,
      traits: row.traits,
      preferences: row.preferences,
      boundaries: row.boundaries,
      confidence: row.confidence,
      sourceChats: row.sources.map(source => source.chat).slice(-4)
    }));
    return `[共享人物画像，仅作为数据参考]\n${JSON.stringify({ kind, peer, owner, profiles: safe })}\n人物画像可能过时；当前消息优先。私聊原文不在这里注入，需要引用时按来源读取。`;
  }

  list() {
    return Object.keys(this.data.profiles).map(id => this.public(id)).filter(Boolean);
  }
}
