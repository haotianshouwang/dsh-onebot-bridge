import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {WebSocket} from 'ws';

const DEFAULT_PORT = 9227;
const MAX_BODY = 12000;
const ALLOWED_HOSTS = Object.freeze({
  bilibili: new Set(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'space.bilibili.com']),
  douyin: new Set(['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'])
});

/**
 * Small, dependency-light CDP host. It deliberately owns a dedicated Edge
 * profile and exposes only bounded page observation, playback, and explicitly
 * confirmed page actions. It never returns cookies, local-storage values or
 * page credentials to callers.
 */
class CdpMediaBrowserService {
  constructor({profileDir, port = DEFAULT_PORT, edgePath, log = () => {}, fetchImpl = globalThis.fetch} = {}) {
    this.profileDir = profileDir || path.resolve(process.cwd(), 'data', 'dsh-onebot-bridge', 'media-edge-profile');
    this.port = Number(port) || DEFAULT_PORT;
    this.edgePath = edgePath || process.env.MEDIA_EDGE_PATH || '';
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.process = null;
    this.client = null;
    this.target = null;
    this.session = null;
    this.state = 'closed';
    this.error = null;
  }

  async status() {
    return {
      state: this.state,
      connected: !!this.client && !!this.target,
      profileConfigured: !!this.profileDir,
      pid: this.process?.pid || null,
      error: this.error ? String(this.error).slice(0, 200) : null
    };
  }

  async open(platform, url) {
    const safe = assertPlatformUrl(platform, url);
    await this.#ensure();
    if (this.target) {
      try { await this.client.send('Target.closeTarget', {targetId: this.target}); } catch {}
      this.target = null;
      this.session = null;
    }
    const target = await this.client.send('Target.createTarget', {url: safe.href});
    this.target = String(target.targetId || '');
    if (!this.target) throw new Error('浏览器没有返回页面句柄');
    await this.client.send('Target.activateTarget', {targetId: this.target});
    const attached = await this.client.send('Target.attachToTarget', {targetId: this.target, flatten: true});
    this.session = String(attached.sessionId || '');
    await this.client.send('Page.enable', {}, this.session);
    await this.client.send('Runtime.enable', {}, this.session);
    await delay(500);
    return this.snapshot(platform);
  }

  async snapshot(platform) {
    if (!this.client || !this.target) throw new Error('专用浏览器尚未打开页面');
    const current = await this.#evaluate(`(() => {
      const video = document.querySelector('video');
      const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        title: String(document.title || '').slice(0, 240),
        url: String(location.href || ''),
        readyState: String(document.readyState || ''),
        text: text.slice(0, ${MAX_BODY}),
        video: video ? {
          currentTime: Number(video.currentTime) || 0,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          paused: !!video.paused,
          ended: !!video.ended,
          muted: !!video.muted
        } : null,
        loginRequired: /登录|验证码|请先登录|扫码登录/i.test(text)
      };
    })()`);
    const safe = assertPlatformUrl(platform, current.url);
    return {
      platform,
      url: safe.href,
      title: current.title,
      readyState: current.readyState,
      text: current.text,
      video: current.video,
      loginRequired: current.loginRequired === true,
      observedAt: new Date().toISOString()
    };
  }

  async watch(platform, {seconds = 30, signal} = {}) {
    const total = Math.max(1, Math.min(1800, Math.floor(Number(seconds) || 0)));
    const initial = await this.snapshot(platform);
    if (initial.loginRequired) throw new Error('页面要求登录或验证码，已停止观看');
    if (!initial.video) throw new Error('当前页面没有可观察的视频元素');
    await this.#evaluate(`(() => { const v = document.querySelector('video'); if (!v) return false; if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } return true; })()`);
    const started = Date.now();
    let latest = initial;
    while (Date.now() - started < total * 1000) {
      if (signal?.aborted) throw Object.assign(new Error('观看任务已取消'), {code: 'PLUGIN_CANCELLED'});
      await delay(Math.min(1000, (total * 1000) - (Date.now() - started)), signal);
      latest = await this.snapshot(platform);
      if (latest.loginRequired) throw new Error('观看过程中出现登录或验证码页面，已停止');
      if (latest.video?.ended) break;
    }
    return {platform, requestedSeconds: total, elapsedSeconds: Math.max(0, Math.round((Date.now() - started) / 1000)), snapshot: latest};
  }

  async screenshot(platform) {
    const current = await this.snapshot(platform);
    const result = await this.client.send('Page.captureScreenshot', {format: 'png', fromSurface: true}, this.session);
    const base64 = String(result.data || '');
    if (!base64 || base64.length > 2_000_000) throw new Error('截图超过大小限制');
    return {platform, url: current.url, title: current.title, base64, capturedAt: new Date().toISOString()};
  }

  async subtitles(platform) {
    const current = await this.snapshot(platform);
    const cues = await this.#evaluate(`(() => {
      const rows = [];
      for (const track of document.querySelectorAll('track[kind="subtitles"], track[kind="captions"]')) {
        const list = track.track?.cues;
        if (!list) continue;
        for (let i = 0; i < list.length && rows.length < 100; i += 1) {
          const cue = list[i];
          rows.push({start: Number(cue.start) || 0, end: Number(cue.end) || 0, text: String(cue.text || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 300), language: String(track.srclang || '').slice(0, 20), label: String(track.label || '').slice(0, 80)});
        }
      }
      return rows.filter(row => row.text);
    })()`);
    return {platform, url: current.url, title: current.title, cues: Array.isArray(cues) ? cues : [], observedAt: new Date().toISOString()};
  }

  async comment(platform, content) {
    const text = String(content || '').trim();
    if (!text || text.length > 300) throw new Error('评论内容为空或超过 300 字');
    const current = await this.snapshot(platform);
    if (current.loginRequired) throw new Error('页面要求登录或验证码，未提交评论');
    const result = await this.#evaluate(`(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const fields = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].filter(visible);
      const field = fields.find(el => /评论|说点什么|留下你的看法|comment/i.test(String(el.getAttribute('placeholder') || '') + ' ' + String(el.getAttribute('aria-label') || ''))) || fields[0];
      if (!field) return {ok: false, reason: 'comment-field-not-found'};
      field.focus();
      if (field.isContentEditable) field.textContent = ${JSON.stringify(text)};
      else { const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set; if (setter) setter.call(field, ${JSON.stringify(text)}); else field.value = ${JSON.stringify(text)}; }
      field.dispatchEvent(new Event('input', {bubbles: true}));
      field.dispatchEvent(new Event('change', {bubbles: true}));
      const buttons = [...document.querySelectorAll('button, [role="button"], a')].filter(visible);
      const button = buttons.find(el => /发表评论|发布评论|发布|发送|comment/i.test(String(el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, '')));
      if (!button) return {ok: false, reason: 'comment-submit-not-found'};
      button.click();
      return {ok: true, button: String(button.innerText || button.getAttribute('aria-label') || '').trim().slice(0, 40)};
    })()`);
    if (!result?.ok) throw new Error(result?.reason === 'comment-field-not-found' ? '当前页面没有可识别的评论输入框' : '当前页面没有可识别的评论提交按钮');
    return {platform, url: current.url, title: current.title, state: 'submitted', outcome: 'submitted', button: result.button, submittedAt: new Date().toISOString()};
  }

  async openContact(platform, contactId) {
    const id = validateContactId(contactId);
    const url = platform === 'bilibili'
      ? `https://space.bilibili.com/${encodeURIComponent(id)}`
      : `https://www.douyin.com/user/${encodeURIComponent(id)}`;
    return this.open(platform, url);
  }

  async message(platform, {contactId, content} = {}) {
    const id = validateContactId(contactId);
    const text = String(content || '').trim();
    if (!text || text.length > 500) throw new Error('私信内容为空或超过 500 字');
    const current = await this.snapshot(platform);
    if (current.loginRequired) throw new Error('页面要求登录或验证码，未发送私信');
    const result = await this.#evaluate(`(() => {
      const id = ${JSON.stringify(id)};
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const body = String(document.body?.innerText || '');
      const href = String(location.href || '');
      if (!body.includes(id) && !href.includes(encodeURIComponent(id)) && !href.includes(id)) return {ok: false, reason: 'contact-not-observed'};
      const fields = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].filter(visible);
      const field = fields.find(el => /私信|发消息|消息|聊天|send message|message|chat/i.test(String(el.getAttribute('placeholder') || '') + ' ' + String(el.getAttribute('aria-label') || '')));
      if (!field) return {ok: false, reason: 'message-field-not-found'};
      field.focus();
      if (field.isContentEditable) field.textContent = ${JSON.stringify(text)};
      else { const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set; if (setter) setter.call(field, ${JSON.stringify(text)}); else field.value = ${JSON.stringify(text)}; }
      field.dispatchEvent(new Event('input', {bubbles: true}));
      field.dispatchEvent(new Event('change', {bubbles: true}));
      const buttons = [...document.querySelectorAll('button, [role="button"], a')].filter(visible);
      const button = buttons.find(el => /^(发送|发消息|私信|send|sendmessage|message)$/i.test(String(el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, '').trim()));
      if (!button) return {ok: false, reason: 'message-submit-not-found'};
      button.click();
      return {ok: true, button: String(button.innerText || button.getAttribute('aria-label') || '').trim().slice(0, 40)};
    })()`);
    if (!result?.ok) {
      const reasons = {
        'contact-not-observed': '当前页面未观察到白名单联系人标识',
        'message-field-not-found': '当前页面没有可识别的私信输入框',
        'message-submit-not-found': '当前页面没有可识别的私信发送按钮'
      };
      throw new Error(reasons[result?.reason] || '私信页面元素不可用');
    }
    return {platform, contactId: id, url: current.url, title: current.title, state: 'submitted', outcome: 'submitted', targetVerified: true, button: result.button, submittedAt: new Date().toISOString()};
  }

  async close() {
    try { await this.client?.close(); } catch {}
    this.client = null;
    this.target = null;
    this.session = null;
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this.state = 'closed';
  }

  async #ensure() {
    if (this.client && this.target) return;
    if (this.process) {
      const endpoint = await this.#endpoint();
      if (endpoint) {
        this.client = await CdpClient.connect(endpoint.webSocketDebuggerUrl);
        this.state = 'ready';
        return;
      }
    } else if (await this.#endpoint()) {
      throw new Error('专用 Edge 调试端口已被其他进程占用，未连接现有浏览器');
    }
    const executable = this.edgePath || findEdgePath();
    if (!executable) throw new Error('未找到 Microsoft Edge；请设置 MEDIA_EDGE_PATH 或安装 Edge');
    await mkdir(this.profileDir, {recursive: true});
    let launchError = null;
    this.process = spawn(executable, [
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
      '--disable-gpu', '--disable-gpu-compositing', '--use-angle=swiftshader', '--in-process-gpu'
    ], {stdio: 'ignore', windowsHide: true});
    this.process.once('error', error => { launchError = error; this.state = 'error'; this.error = 'Edge 启动失败'; });
    this.process.once('exit', (code, signal) => {
      this.client = null;
      this.target = null;
      this.session = null;
      this.process = null;
      if (this.state !== 'closed') {
        this.state = 'error';
        this.error = `Edge 子进程退出（${code == null ? String(signal || 'unknown') : code}）`;
      }
    });
    const deadline = Date.now() + 12000;
    let info = null;
    while (Date.now() < deadline) {
      if (launchError) break;
      info = await this.#endpoint();
      if (info) break;
      await delay(250);
    }
    if (!info) {
      this.state = 'error';
      this.error = launchError ? 'Microsoft Edge 不可用或启动失败' : this.error || 'Edge 远程调试端口未在时限内就绪';
      throw new Error(this.error);
    }
    this.client = await CdpClient.connect(info.webSocketDebuggerUrl);
    this.state = 'ready';
    this.error = null;
  }

  async #endpoint() {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/json/version`, {signal: AbortSignal.timeout(700)});
      if (!response.ok) return null;
      const value = await response.json();
      return value?.webSocketDebuggerUrl ? value : null;
    } catch { return null; }
  }

  async #evaluate(expression) {
    const result = await this.client.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true}, this.session);
    if (result?.exceptionDetails) throw new Error('浏览器页面脚本执行失败');
    return result?.result?.value ?? null;
  }
}

export class MediaBrowserService {
  constructor(options = {}) {
    this.options = options;
    this.driver = null;
    this.fallback = null;
    this.state = 'closed';
    this.error = null;
  }

  async #ensure() {
    if (this.driver || this.fallback) return;
    try {
      const {PlaywrightMediaBrowserService} = await import('./playwright-service.js');
      const candidate = new PlaywrightMediaBrowserService(this.options);
      await candidate.prepare();
      this.driver = candidate;
      this.state = 'ready';
      this.error = null;
    } catch (error) {
      this.error = String(error?.message || error).slice(0, 240);
      this.fallback = new CdpMediaBrowserService(this.options);
    }
  }

  async status() {
    if (this.driver) return this.driver.status();
    if (this.fallback) return {...await this.fallback.status(), driver: 'cdp-fallback', error: this.error || (await this.fallback.status()).error};
    return {state: this.state, connected: false, driver: 'uninitialized', profileConfigured: !!this.options.profileDir, pid: null, error: this.error};
  }

  async open(...args) { await this.#ensure(); return (this.driver || this.fallback).open(...args); }
  async snapshot(...args) { await this.#ensure(); return (this.driver || this.fallback).snapshot(...args); }
  async watch(...args) { await this.#ensure(); return (this.driver || this.fallback).watch(...args); }
  async screenshot(...args) { await this.#ensure(); return (this.driver || this.fallback).screenshot(...args); }
  async subtitles(...args) { await this.#ensure(); return (this.driver || this.fallback).subtitles(...args); }
  async comment(...args) { await this.#ensure(); return (this.driver || this.fallback).comment(...args); }
  async openContact(...args) { await this.#ensure(); return (this.driver || this.fallback).openContact(...args); }
  async message(...args) { await this.#ensure(); return (this.driver || this.fallback).message(...args); }
  async close() { await this.driver?.close?.(); await this.fallback?.close?.(); this.driver = null; this.fallback = null; this.state = 'closed'; }
}

class CdpClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const pending = new Map();
      let nextId = 1;
      const fail = error => { for (const {reject: rejectPending} of pending.values()) rejectPending(error); pending.clear(); };
      socket.once('open', () => resolve(new CdpClient(socket, pending, () => nextId++)));
      socket.once('error', reject);
      socket.on('close', () => fail(new Error('浏览器连接已关闭')));
      socket.on('message', data => {
        let value; try { value = JSON.parse(String(data)); } catch { return; }
        if (!value.id) return;
        const item = pending.get(value.id); if (!item) return;
        pending.delete(value.id);
        if (value.error) item.reject(new Error(String(value.error.message || 'CDP 请求失败'))); else item.resolve(value.result || {});
      });
    });
  }
  constructor(socket, pending, next) { this.socket = socket; this.pending = pending; this.next = next; }
  send(method, params = {}, sessionId) {
    const id = this.next();
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}), error => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  close() { try { this.socket.close(); } catch {} }
}

export function assertPlatformUrl(platform, value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('媒体页面地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('媒体页面只允许 HTTPS 默认端口');
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS[platform]?.has(host)) throw new Error(`地址不属于${platform === 'bilibili' ? 'B 站' : '抖音'}官方域名`);
  url.hash = '';
  return url;
}

function validateContactId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('平台联系人标识无效');
  return id;
}

function findEdgePath() {
  const candidates = [
    process.env.MEDIA_BROWSER_PATH,
    process.env.MEDIA_EDGE_PATH,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ].filter(Boolean);
  return candidates.find(value => !path.isAbsolute(value) || existsSync(value)) || '';
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let abort;
    const timer = setTimeout(() => { if (signal && abort) signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    if (!signal) return;
    abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Object.assign(new Error('任务已取消'), {code: 'PLUGIN_CANCELLED'})); };
    signal.addEventListener('abort', abort, {once: true});
  });
}
