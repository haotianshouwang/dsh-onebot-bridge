// 独立管理站点的登录与安全状态。
//
// 只用 Node 内置能力实现：scrypt 口令哈希、内存会话、登录限速、CSRF 令牌和审计。
// 站点默认只监听 127.0.0.1；会话在进程重启后全部失效，需要重新登录。
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_ABSOLUTE_MS = 12 * 3600000;
const SESSION_IDLE_MS = 30 * 60000;
const LOGIN_WINDOW_MS = 15 * 60000;
const LOGIN_MAX_FAILURES = 5;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const WEAK = new Set(['password123', '1234567890', 'qwertyuiop', 'admin123456']);

function derive(password, salt, options = SCRYPT) {
  return new Promise((resolve, reject) => {
    scrypt(String(password), salt, 32, options, (error, key) => error ? reject(error) : resolve(key));
  });
}

export function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (value.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  if (new Set(value).size < 4) return '密码太简单，请换一个';
  if (WEAK.has(value.toLowerCase())) return '密码太常见，请换一个';
  return null;
}

export class AdminAuth {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'admin.json');
    this.auditFile = path.join(dir, 'audit.jsonl');
    this.record = null;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw && typeof raw.hash === 'string' && typeof raw.salt === 'string' && raw.algorithm === 'scrypt') this.record = raw;
    } catch (error) {
      if (error.code !== 'ENOENT') this.corrupt = true;
    }
    return this;
  }

  get configured() {
    return Boolean(this.record?.hash);
  }

  async setPassword(password) {
    const invalid = validatePassword(password);
    if (invalid) throw Object.assign(new Error(invalid), { code: 'WEAK_PASSWORD' });
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    this.record = {
      version: 1, algorithm: 'scrypt', ...SCRYPT, salt: salt.toString('base64'),
      hash: key.toString('base64'), createdAt: new Date().toISOString()
    };
    const text = JSON.stringify(this.record, null, 2);
    await writeFile(this.file + '.tmp', text, { encoding: 'utf8', mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }

  async verify(password) {
    if (!this.configured) return false;
    const salt = Buffer.from(this.record.salt, 'base64');
    const expected = Buffer.from(this.record.hash, 'base64');
    const key = await derive(String(password ?? ''), salt, {
      N: this.record.N, r: this.record.r, p: this.record.p, maxmem: SCRYPT.maxmem
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  }

  createSession({ ip = '', ua = '' } = {}) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, { csrf, created: now, last: now, ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 160) });
    for (const [key, session] of this.sessions) if (now - session.created > SESSION_ABSOLUTE_MS) this.sessions.delete(key);
    return { token, csrf };
  }

  session(token) {
    const session = this.sessions.get(String(token || ''));
    if (!session) return null;
    const now = Date.now();
    if (now - session.created > SESSION_ABSOLUTE_MS || now - session.last > SESSION_IDLE_MS) {
      this.sessions.delete(String(token));
      return null;
    }
    session.last = now;
    return session;
  }

  destroy(token) {
    this.sessions.delete(String(token || ''));
  }

  loginBlocked(ip) {
    const row = this.attempts.get(String(ip));
    if (!row) return 0;
    row.fails = row.fails.filter(time => Date.now() - time < LOGIN_WINDOW_MS);
    if (!row.fails.length) { this.attempts.delete(String(ip)); return 0; }
    if (row.fails.length < LOGIN_MAX_FAILURES) return 0;
    return Math.ceil((row.fails[0] + LOGIN_WINDOW_MS - Date.now()) / 1000);
  }

  loginFailed(ip) {
    const key = String(ip);
    const row = this.attempts.get(key) || { fails: [] };
    row.fails.push(Date.now());
    row.fails = row.fails.filter(time => Date.now() - time < LOGIN_WINDOW_MS).slice(-LOGIN_MAX_FAILURES);
    this.attempts.set(key, row);
  }

  loginSucceeded(ip) {
    this.attempts.delete(String(ip));
  }

  async audit(row) {
    try {
      await appendFile(this.auditFile, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* 审计写不进去不影响登录本身 */ }
  }
}
