import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {appendFile, mkdir, readFile, rename, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {base32, matchCounter, recoveryHash, seal, unseal} from './admin-totp.js';

const SESSION_ABSOLUTE_MS=12*3600000, SESSION_IDLE_MS=30*60000, LOGIN_WINDOW_MS=15*60000, LOGIN_MAX_FAILURES=5;
const N = 131072, maxmem = 192 * 1024 * 1024;
// Offline checks on new passphrases only. Never normalize or truncate the secret used by scrypt.
const weak = new Set(['password123456789', '123456789012345', 'qwertyuiopasdfgh', 'correcthorsebatterystaple']);
const commonPattern = /^(?:(?:password|passw0rd|administrator|admin|qwerty|letmein|welcome|iloveyou)(?:\d+)?)+$/;
const locked = () => new Error('管理认证记录不可用，请在本机恢复备份，不要重新初始化');
const bytes = (str, size) => typeof str === 'string' && Buffer.from(str, 'base64').length === size && Buffer.from(str, 'base64').toString('base64') === str;
function valid(raw) {
  if (!raw || ![1,2].includes(raw.version) || raw.algorithm !== 'scrypt' || !(raw.version === 1 ? [16384] : [16384, N]).includes(raw.N) || raw.r !== 8 || raw.p !== 1 || !bytes(raw.salt,16) || !bytes(raw.hash,32)) return false;
  if (raw.version === 1) return !Object.hasOwn(raw, 'mfa');
  const m = raw.mfa;
  return m === null || Boolean(m && Number.isSafeInteger(m.last) && m.last >= 0 && bytes(m.box?.iv,12) && bytes(m.box?.body,20) && bytes(m.box?.tag,16) && Array.isArray(m.recovery) && m.recovery.length <= 8 && m.recovery.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)));
}
function derive(value, salt, cost) {
  return new Promise((res, rej) => scrypt(value, salt, 32, {N: cost, r:8, p:1, maxmem}, (err, key) => err ? rej(err) : res(key)));
}
export function validatePassword(value) {
  if (typeof value !== 'string' || [...value].length < 15) return '密码至少 15 位';
  if ([...value].length > 200) return '密码最多 200 位';
  if (new Set(value).size < 4) return '密码太简单，请换一个';
  const simple = value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  if (weak.has(simple) || commonPattern.test(simple) || (simple.length >= 8 && '1234567890'.repeat(21).includes(simple))) return '密码太常见，请换一个';
  return null;
}
// One writer per data directory. All credential changes and proof consumption are serialized.
export class AdminAuth {
  constructor(dir, {deviceKey, now = Date.now, onSessionEnd = () => {}} = {}) {
    this.dir = dir; this.file = path.join(dir, 'admin.json'); this.auditFile = path.join(dir, 'audit.jsonl');
    this.deviceKey = deviceKey; this.now = now; this.onSessionEnd = onSessionEnd;
    this.sessions = new Map(); this.attempts = new Map(); this.tail = Promise.resolve(); this.record = null; this.corrupt = false; this.pending = null;
  }
  serial(work) { const next = this.tail.then(work); this.tail = next.catch(() => {}); return next; }
  async open() {
    await mkdir(this.dir, {recursive:true, mode:0o700});
    let text;
    try { text = await readFile(this.file,'utf8'); } catch (e) { if (e.code !== 'ENOENT') this.corrupt = true; return this; }
    try {
      const raw = JSON.parse(text); if (!valid(raw)) throw locked();
      if (raw.mfa) unseal(raw.mfa.box, await this.deviceKey(false)).fill(0);
      this.record = raw;
    } catch { this.corrupt = true; }
    return this;
  }
  get configured() { return Boolean(this.record) && !this.corrupt; }
  status() { return {configured:this.configured, corrupt:this.corrupt, enrolled:Boolean(this.record?.mfa), recoveryRemaining:this.record?.mfa?.recovery.length ?? 0}; }
  async persist(next) {
    if (this.corrupt || !valid(next)) throw locked();
    const tmp = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify(next), {mode:0o600, flag:'wx'});
      await rename(tmp, this.file); this.record = next;
    } finally { await rm(tmp, {force:true}).catch(() => {}); }
  }
  async passwordRecord(password) {
    const invalid = validatePassword(password); if (invalid) throw new Error(invalid);
    const salt = randomBytes(16), hash = await derive(password,salt,N);
    return {version:2, algorithm:'scrypt', N, r:8, p:1, salt:salt.toString('base64'), hash:hash.toString('base64'), createdAt:this.record?.createdAt || new Date().toISOString(), mfa:this.record?.mfa || null};
  }
  // Trusted first provisioning only; never overwrites an existing password or a broken file.
  setPassword(password) { return this.serial(async () => {
    if (this.corrupt) throw locked(); if (this.configured) throw new Error('管理密码已设置');
    await this.persist(await this.passwordRecord(password)); await this.audit({outcome:'owner-setup'});
  }); }
  async verify(password) {
    if (!this.configured || typeof password !== 'string' || !password || password.length > 400) return false;
    const record = this.record, key = await derive(password, Buffer.from(record.salt,'base64'),record.N);
    return timingSafeEqual(key,Buffer.from(record.hash,'base64'));
  }
  changePassword(token, current, next) { return this.serial(async () => {
    const session = this.session(token); if (!session) throw new Error('会话已过期');
    if (this.loginBlocked(session.ip)) throw new Error('尝试次数过多，请稍后再试');
    if (!await this.verify(current)) { this.loginFailed(session.ip); throw new Error('当前密码不正确'); }
    await this.persist(await this.passwordRecord(next)); this.revokeAll(); this.loginSucceeded(session.ip);
    await this.audit({outcome:'password-changed'}); return this.createSession(session);
  }); }
  clearPending() { this.pending?.seed.fill(0); this.pending = null; clearTimeout(this.pendingTimer); }
  beginEnrollment() { return this.serial(async () => {
    if (!this.configured || !this.deviceKey) throw new Error('请先在 DSH 设置网页密码并检查凭据库');
    await this.deviceKey(!this.record.mfa); this.clearPending();
    const seed = randomBytes(20); this.pending = {seed, expires:this.now()+300000, failures:0};
    this.pendingTimer = setTimeout(() => this.clearPending(),300000); this.pendingTimer.unref?.();
    return base32(seed);
  }); }
  confirmEnrollment(code) { return this.serial(async () => {
    const p = this.pending;
    if (!p || this.now() >= p.expires || p.failures >= 5) { this.clearPending(); throw new Error('绑定已失效，请重新开始'); }
    const last = matchCounter(p.seed, String(code), -1, this.now());
    if (last === null) { p.failures++; throw new Error('验证码不正确，请检查认证器的时间'); }
    const codes = Array.from({length:8}, () => randomBytes(16).toString('hex').match(/.{8}/g).join('-'));
    const mfa = {box:seal(p.seed,await this.deviceKey(false)), last, recovery:codes.map(recoveryHash)};
    await this.persist({...this.record,version:2,mfa}); this.clearPending(); this.revokeAll(); await this.audit({outcome:'owner-mfa-bound'}); return codes;
  }); }
  login(password, factor, required, meta) { return this.serial(async () => {
    const ip = meta.ip, wait = this.loginBlocked(ip);
    if (wait) return {wait};
    if (!this.configured || required && !this.record.mfa) return {unavailable:true};
    let ok = await this.verify(password); const m = this.record.mfa;
    if (ok && m) {
      const code = typeof factor === 'string' ? factor.trim() : '';
      const seed = unseal(m.box,await this.deviceKey(false));
      let last; try { last = matchCounter(seed,code,m.last,this.now()); } finally { seed.fill(0); }
      const index = code.length === 35 ? m.recovery.indexOf(recoveryHash(code)) : -1;
      ok = last !== null || index >= 0;
      if (ok) await this.persist({...this.record,mfa:{...m,last:last ?? m.last,recovery:index < 0 ? m.recovery : m.recovery.filter((_,i) => i !== index)}});
    }
    if (!ok) { this.loginFailed(ip); await this.audit({outcome:'login-failed',ip}); return {}; }
    this.loginSucceeded(ip); await this.audit({outcome:'login',ip}); return this.createSession(meta);
  }); }
  revokeAll() { for (const key of this.sessions.keys()) this.destroy(key); }

  createSession({ ip = '', ua = '' } = {}) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, { csrf, created: now, last: now, ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 160) });
    for (const [key, session] of this.sessions) if (now - session.created > SESSION_ABSOLUTE_MS) this.destroy(key);
    return { token, csrf };
  }

  session(token) {
    const session = this.sessions.get(String(token || ''));
    if (!session) return null;
    const now = Date.now();
    if (now - session.created > SESSION_ABSOLUTE_MS || now - session.last > SESSION_IDLE_MS) {
      this.destroy(token);
      return null;
    }
    session.last = now;
    return session;
  }

  destroy(token) {
    if (this.sessions.delete(String(token || ''))) this.onSessionEnd(token);
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
      await appendFile(this.auditFile, JSON.stringify({ at: new Date().toISOString(), outcome:row.outcome, ip:row.ip }) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* 审计写不进去不影响登录本身 */ }
  }
}
