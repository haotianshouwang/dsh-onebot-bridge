// 私密秘密空间：真正的 AES-256-GCM 加密 + scrypt 密钥派生。
//
// 设计边界：
// - v2 的密码由角色通过现有受限 Agent 决策后由程序安全生成；用户界面不设置密码。
//   密码用 DSH 凭据库中的设备密钥封装，服务重启后仍可解封；普通 API 不返回密码。
// - v1 旧版“用户设置密码”的空间仍可原密码解锁，避免已有数据失联；
// - 文件里只有 salt、KDF 参数、校验块、设备密钥封装和每条秘密的密文/nonce/tag；
// - 解锁密钥只保存在宿主进程内存，并绑定当前管理会话，15 分钟无操作自动锁定；
// - 设备凭据丢失时无法恢复正文；只能经过明确确认后清空并重新初始化。
import {createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

const VERSION = 2;
const KDF = Object.freeze({name: 'scrypt', N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
const UNLOCK_TTL_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const CHECK_TEXT = 'qq-secret-vault-check-v1';
const MAX_TITLE = 80;
const MAX_BODY = 10000;

function derive(password, salt, params = KDF) {
  return new Promise((resolve, reject) => {
    scrypt(String(password), salt, 32, {N: params.N, r: params.r, p: params.p, maxmem: params.maxmem}, (error, key) => error ? reject(error) : resolve(Buffer.from(key)));
  });
}

function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < 10) return '密码至少 10 位';
  if (value.length > 200) return '密码最多 200 位';
  if (new Set(value).size < 4) return '密码太简单，请换一个';
  if (['password123', '1234567890', 'qwertyuiop', 'admin123456'].includes(value.toLowerCase())) return '密码太常见，请换一个';
  return null;
}

function encrypt(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return {iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')};
}

function decrypt(key, payload, aad) {
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('密文格式无效');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function safeEqualBuffers(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 由程序生成角色密码候选。密码不经过语言模型，也不写入提示词或日志。
 * 32 字节随机值的 base64url 约 256 bit 熵，超过普通口令强度。
 */
export function generateCharacterPassphrase() {
  return 'nw-' + randomBytes(32).toString('base64url');
}

export class SecretVault {
  constructor({dir, now = () => Date.now(), deviceKey = null}) {
    this.dir = dir;
    this.file = path.join(dir, 'secret-vault.json');
    this.now = now;
    this.record = null;
    this.unlocks = new Map();
    this.failures = new Map();
    this.corrupt = false;
    this.deviceKey = deviceKey ? Buffer.from(deviceKey) : null;
    if (this.deviceKey && this.deviceKey.length !== 32) throw new Error('设备密钥必须是 32 字节');
  }

  async open() {
    await mkdir(this.dir, {recursive: true});
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (![1, VERSION].includes(raw?.version) || raw?.kdf?.name !== 'scrypt' || !raw.check || !Array.isArray(raw.entries)) {
        this.corrupt = true;
        return this;
      }
      // v1 是旧版“用户设置密码”的空间；保留可解锁能力，不自动迁移内容。
      raw.mode = raw.mode === 'character' ? 'character' : 'user';
      this.record = raw;
    } catch (error) {
      if (error.code !== 'ENOENT') this.corrupt = true;
    }
    return this;
  }

  get configured() {
    return Boolean(this.record);
  }

  sessionKey(session) {
    const token = String(session || '');
    if (!token) throw Object.assign(new Error('秘密空间需要管理会话'), {code: 'LOCKED'});
    const row = this.unlocks.get(token);
    if (!row) throw Object.assign(new Error('秘密空间已锁定'), {code: 'LOCKED'});
    if (this.now() - row.last > UNLOCK_TTL_MS) {
      this.lock(token);
      throw Object.assign(new Error('秘密空间已自动锁定'), {code: 'LOCKED'});
    }
    row.last = this.now();
    return row.key;
  }

  touch(session) {
    const row = this.unlocks.get(String(session || ''));
    if (row) row.last = this.now();
  }

  lock(session) {
    const token = String(session || '');
    const row = this.unlocks.get(token);
    if (row?.key) row.key.fill(0);
    this.unlocks.delete(token);
  }

  lockPrefix(prefix) {
    for (const token of [...this.unlocks.keys()]) if (token.startsWith(String(prefix || ''))) this.lock(token);
  }

  lockAll() {
    for (const token of [...this.unlocks.keys()]) this.lock(token);
    this.failures.clear();
  }

  status(session) {
    const token = String(session || '');
    const row = this.unlocks.get(token);
    if (row && this.now() - row.last > UNLOCK_TTL_MS) this.lock(token);
    const unlocked = this.unlocks.has(token);
    const mode = this.record?.mode || (this.configured ? 'user' : null);
    const character = this.record?.character || null;
    return {
      configured: this.configured,
      unlocked,
      corrupt: this.corrupt,
      entries: this.record?.entries?.length || 0,
      mode,
      legacy: mode === 'user',
      character: character ? {
        create: character.create === true,
        shareWithOwner: character.shareWithOwner === true,
        reason: String(character.reason || '').slice(0, 300),
        decidedAt: character.decidedAt || null,
        source: character.source || ''
      } : null,
      deviceKeyAvailable: Boolean(this.deviceKey),
      autoLockSeconds: UNLOCK_TTL_MS / 1000,
      recovery: mode === 'character'
        ? '密码由角色自主设置并经设备凭据封装；普通界面不显示。设备凭据丢失时无法恢复正文。'
        : '密码无法找回；只能在确认后清空秘密空间重新设置。'
    };
  }

  failuresFor(session) {
    const token = String(session || '');
    const row = this.failures.get(token);
    if (!row) return 0;
    row.times = row.times.filter(time => this.now() - time < FAILURE_WINDOW_MS);
    if (!row.times.length) {
      this.failures.delete(token);
      return 0;
    }
    return row.times.length;
  }

  recordFailure(session) {
    const token = String(session || '');
    const row = this.failures.get(token) || {times: []};
    row.times.push(this.now());
    row.times = row.times.filter(time => this.now() - time < FAILURE_WINDOW_MS).slice(-MAX_FAILURES);
    this.failures.set(token, row);
  }

  unlockBlocked(session) {
    return this.failuresFor(session) >= MAX_FAILURES;
  }

  unlock(session, key) {
    const token = String(session || '');
    if (this.unlockBlocked(token)) throw Object.assign(new Error('尝试次数过多，请稍后再试'), {code: 'RATE_LIMIT'});
    this.lock(token);
    this.unlocks.set(token, {key, last: this.now()});
  }

  async setup(session, password) {
    if (this.corrupt) throw new Error('秘密空间文件损坏，请先从备份恢复或明确清空后重新初始化');
    if (this.configured) throw new Error('秘密空间已经初始化');
    const invalid = validatePassword(password);
    if (invalid) throw new Error(invalid);
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    const check = encrypt(key, CHECK_TEXT, 'v1|check');
    this.record = {version: VERSION, mode: 'user', kdf: {name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64')}, check, entries: [], createdAt: new Date(this.now()).toISOString()};
    await this.persist();
    this.unlock(session, key);
    return this.status(session);
  }

  /**
   * 角色自主创建秘密空间：decision 来自现有受限 Agent 的决策回调，
   * 密码由 generateCharacterPassphrase() 生成后立即用设备凭据封装。
   * 用户界面不会拿到密码。
   */
  async provisionCharacter({password, decision} = {}) {
    if (this.corrupt) throw new Error('秘密空间文件损坏，请先从备份恢复或明确清空后重新初始化');
    if (this.configured) throw new Error('秘密空间已经初始化，不能覆盖已有秘密');
    if (!this.deviceKey) throw new Error('设备凭据不可用，无法安全保存角色密码；已保持未初始化');
    const invalid = validatePassword(password);
    if (invalid) throw new Error(invalid);
    if (!decision || typeof decision !== 'object') throw new Error('缺少角色决策记录');
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    const check = encrypt(key, CHECK_TEXT, 'v1|check');
    const keyWrap = encrypt(this.deviceKey, JSON.stringify({password}), 'v1|character-key');
    this.record = {
      version: VERSION,
      mode: 'character',
      kdf: {name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64')},
      check,
      keyWrap,
      character: {
        create: true,
        shareWithOwner: decision.shareWithOwner === true,
        reason: String(decision.reason || '').slice(0, 300),
        decidedAt: new Date(this.now()).toISOString(),
        source: String(decision.source || 'agent').slice(0, 40),
        choice: Number(decision.choice) || 0
      },
      entries: [],
      createdAt: new Date(this.now()).toISOString()
    };
    await this.persist();
    key.fill(0);
    return this.status(null);
  }

  characterPassword() {
    if (!this.configured || this.record.mode !== 'character' || !this.record.keyWrap) throw new Error('不是角色密码空间');
    if (!this.deviceKey) throw new Error('设备凭据不可用');
    const payload = JSON.parse(decrypt(this.deviceKey, this.record.keyWrap, 'v1|character-key'));
    const password = String(payload.password || '');
    if (!password) throw new Error('角色密码封装无效');
    return password;
  }

  async unlockCharacter(session) {
    if (!this.configured || this.record.mode !== 'character') throw new Error('不是角色密码空间');
    const password = this.characterPassword();
    const salt = Buffer.from(this.record.kdf.salt, 'base64');
    const key = await derive(password, salt, this.record.kdf);
    try {
      const check = decrypt(key, this.record.check, 'v1|check');
      if (!safeEqualBuffers(Buffer.from(check), Buffer.from(CHECK_TEXT))) throw new Error('bad');
    } catch {
      key.fill(0);
      throw new Error('角色密码无法验证，设备凭据可能已更换');
    }
    this.unlock(session, key);
    return this.status(session);
  }

  /** 仅在角色决策明确 shareWithOwner 时调用；密码不进入普通日志。 */
  revealCharacterPassword() {
    if (this.record?.mode !== 'character' || this.record?.character?.shareWithOwner !== true) {
      throw new Error('她选择不分享密码');
    }
    return this.characterPassword();
  }

  async rotateCharacterPassword(password, session) {
    if (!this.configured || this.record.mode !== 'character') throw new Error('不是角色密码空间');
    const invalid = validatePassword(password);
    if (invalid) throw new Error(invalid);
    const currentKey = this.sessionKey(session);
    const entries = this.decryptedEntries(currentKey);
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    const next = entries.map(({entry, title, body}) => {
      const row = {id: entry.id, createdAt: entry.createdAt, updatedAt: this.now()};
      Object.assign(row, encrypt(key, JSON.stringify({title, body}), 'v1|secret|' + entry.id));
      return row;
    });
    this.record.kdf = {name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64')};
    this.record.check = encrypt(key, CHECK_TEXT, 'v1|check');
    this.record.keyWrap = encrypt(this.deviceKey, JSON.stringify({password}), 'v1|character-key');
    this.record.entries = next;
    this.record.character = {...this.record.character, decidedAt: new Date(this.now()).toISOString()};
    await this.persist();
    this.lock(session);
    await this.unlockCharacter(session);
    key.fill(0);
    return this.status(session);
  }

  async unlockWithPassword(session, password) {
    if (!this.configured) throw new Error('尚未设置秘密空间密码');
    if (this.record.mode === 'character') throw new Error('角色密码空间由角色决策解锁，不接受用户输入密码');
    const token = String(session || '');
    if (this.unlockBlocked(token)) throw Object.assign(new Error('尝试次数过多，请稍后再试'), {code: 'RATE_LIMIT'});
    const salt = Buffer.from(this.record.kdf.salt, 'base64');
    const key = await derive(password, salt, this.record.kdf);
    let text = '';
    try {
      text = decrypt(key, this.record.check, 'v1|check');
    } catch {
      key.fill(0);
      this.recordFailure(token);
      throw new Error('密码不正确');
    }
    if (!safeEqualBuffers(Buffer.from(text), Buffer.from(CHECK_TEXT))) {
      key.fill(0);
      this.recordFailure(token);
      throw new Error('密码不正确');
    }
    this.failures.delete(token);
    this.unlock(token, key);
    return this.status(session);
  }

  decryptedEntries(key) {
    return this.record.entries.map(entry => {
      const payload = JSON.parse(decrypt(key, entry, 'v1|secret|' + entry.id));
      return {entry, title: String(payload.title || ''), body: String(payload.body || '')};
    });
  }

  async persist() {
    const text = JSON.stringify(this.record, null, 2);
    await writeFile(this.file + '.tmp', text, {encoding: 'utf8', mode: 0o600});
    await rename(this.file + '.tmp', this.file);
  }

  list(session) {
    const key = this.sessionKey(session);
    const entries = [...this.record.entries].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    return entries.map(entry => {
      const payload = JSON.parse(decrypt(key, entry, 'v1|secret|' + entry.id));
      return {
        id: entry.id,
        title: String(payload.title || ''),
        createdAt: new Date(entry.createdAt).toISOString(),
        updatedAt: new Date(entry.updatedAt).toISOString()
      };
    });
  }

  read(session, id) {
    const key = this.sessionKey(session);
    const entry = this.record.entries.find(row => row.id === String(id));
    if (!entry) throw new Error('秘密不存在');
    const payload = JSON.parse(decrypt(key, entry, 'v1|secret|' + entry.id));
    return {
      id: entry.id,
      title: String(payload.title || ''),
      body: String(payload.body || ''),
      createdAt: new Date(entry.createdAt).toISOString(),
      updatedAt: new Date(entry.updatedAt).toISOString()
    };
  }

  create(session, {title, body} = {}) {
    const key = this.sessionKey(session);
    this.assertEntry(title, body);
    const at = this.now();
    const entry = {id: randomUUID(), createdAt: at, updatedAt: at};
    Object.assign(entry, encrypt(key, JSON.stringify({title: String(title), body: String(body)}), 'v1|secret|' + entry.id));
    this.record.entries.push(entry);
    return this.persist().then(() => ({id: entry.id, title: String(title), createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString()}));
  }

  async update(session, id, {title, body} = {}) {
    const key = this.sessionKey(session);
    const entry = this.record.entries.find(row => row.id === String(id));
    if (!entry) throw new Error('秘密不存在');
    const current = JSON.parse(decrypt(key, entry, 'v1|secret|' + entry.id));
    const nextTitle = title === undefined ? current.title : title;
    const nextBody = body === undefined ? current.body : body;
    this.assertEntry(nextTitle, nextBody);
    const encrypted = encrypt(key, JSON.stringify({title: String(nextTitle), body: String(nextBody)}), 'v1|secret|' + entry.id);
    entry.iv = encrypted.iv;
    entry.tag = encrypted.tag;
    entry.data = encrypted.data;
    entry.updatedAt = this.now();
    await this.persist();
    return {id: entry.id, title: String(nextTitle), updatedAt: new Date(entry.updatedAt).toISOString()};
  }

  async remove(session, id) {
    this.sessionKey(session);
    const index = this.record.entries.findIndex(row => row.id === String(id));
    if (index < 0) throw new Error('秘密不存在');
    const [removed] = this.record.entries.splice(index, 1);
    await this.persist();
    return {id: removed.id};
  }

  async changePassword(session, current, next) {
    if (this.record?.mode === 'character') throw new Error('角色密码只能由角色重设');
    const key = this.sessionKey(session);
    const invalid = validatePassword(next);
    if (invalid) throw new Error(invalid);
    // 用旧密码重新验证一次，防止管理会话被临时占用后改密码。
    const salt = Buffer.from(this.record.kdf.salt, 'base64');
    const oldKey = await derive(current, salt, this.record.kdf);
    try {
      const check = decrypt(oldKey, this.record.check, 'v1|check');
      if (!safeEqualBuffers(Buffer.from(check), Buffer.from(CHECK_TEXT))) throw new Error('bad');
    } catch {
      oldKey.fill(0);
      throw new Error('当前密码不正确');
    }
    oldKey.fill(0);
    const entries = this.decryptedEntries(key);
    const newSalt = randomBytes(16);
    const newKey = await derive(next, newSalt);
    const nextEntries = [];
    for (const {entry, title, body} of entries) {
      const nextEntry = {id: entry.id, createdAt: entry.createdAt, updatedAt: this.now()};
      Object.assign(nextEntry, encrypt(newKey, JSON.stringify({title, body}), 'v1|secret|' + entry.id));
      nextEntries.push(nextEntry);
    }
    this.record = {
      version: VERSION,
      mode: 'user',
      kdf: {name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: newSalt.toString('base64')},
      check: encrypt(newKey, CHECK_TEXT, 'v1|check'),
      entries: nextEntries,
      createdAt: this.record.createdAt,
      passwordChangedAt: new Date(this.now()).toISOString()
    };
    await this.persist();
    this.lock(session);
    this.unlock(session, newKey);
    key.fill(0);
    return this.status(session);
  }

  async reset(session, confirmation) {
    if (confirmation !== 'RESET') throw new Error('请输入 RESET 确认清空');
    this.lockAll();
    await rm(this.file, {force: true});
    this.record = null;
    return this.status(session);
  }

  assertEntry(title, body) {
    const titleText = String(title ?? '').trim();
    const bodyText = String(body ?? '');
    if (!titleText) throw new Error('秘密标题不能为空');
    if (titleText.length > MAX_TITLE) throw new Error(`秘密标题最多 ${MAX_TITLE} 字`);
    if (!bodyText.trim()) throw new Error('秘密正文不能为空');
    if (bodyText.length > MAX_BODY) throw new Error(`秘密正文最多 ${MAX_BODY} 字`);
  }
}
