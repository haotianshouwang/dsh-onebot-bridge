import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {assertPlatformUrl} from './browser-service.js';

const MAX_BODY = 12000;

export class PlaywrightMediaBrowserService {
  constructor({profileDir, browserPath, edgePath, headless = false} = {}) {
    this.profileDir = profileDir || path.resolve(process.cwd(), 'data', 'dsh-onebot-bridge', 'media-edge-profile');
    this.browserPath = browserPath || process.env.MEDIA_BROWSER_PATH || edgePath || process.env.MEDIA_EDGE_PATH || findBrowserPath();
    this.headless = headless === true || process.env.MEDIA_BROWSER_HEADLESS === '1';
    this.context = null;
    this.page = null;
    this.state = 'closed';
    this.error = null;
    this.driver = 'playwright';
  }

  async prepare() {
    let playwright;
    try { playwright = await import('playwright-core'); } catch { playwright = await import('playwright'); }
    await mkdir(this.profileDir, {recursive: true});
    const executablePath = this.browserPath && (path.isAbsolute(this.browserPath) ? (existsSync(this.browserPath) ? this.browserPath : '') : this.browserPath);
    if (!executablePath) throw new Error('Playwright 未找到浏览器可执行文件；请设置 MEDIA_BROWSER_PATH');
    this.context = await playwright.chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless: this.headless,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--disable-gpu', '--disable-gpu-compositing', '--use-angle=swiftshader', '--in-process-gpu']
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.state = 'ready';
  }

  async status() {
    return {state: this.state, connected: !!this.context && !!this.page, driver: this.driver, profileConfigured: !!this.profileDir, pid: null, error: this.error};
  }

  async open(platform, url) {
    const safe = assertPlatformUrl(platform, url);
    await this.#ensurePage();
    for (const page of this.context.pages()) if (page !== this.page) await page.close().catch(() => {});
    await this.page.goto(safe.href, {waitUntil: 'domcontentloaded', timeout: 30000});
    await this.page.waitForTimeout(500);
    return this.snapshot(platform);
  }

  async snapshot(platform) {
    await this.#ensurePage();
    const current = await this.page.evaluate(maxBody => {
      const video = document.querySelector('video');
      const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return {title: String(document.title || '').slice(0, 240), url: String(location.href || ''), readyState: String(document.readyState || ''), text: text.slice(0, maxBody), video: video ? {currentTime: Number(video.currentTime) || 0, duration: Number.isFinite(video.duration) ? video.duration : 0, paused: !!video.paused, ended: !!video.ended, muted: !!video.muted} : null, loginRequired: /登录|验证码|请先登录|扫码登录/i.test(text)};
    }, MAX_BODY);
    const safe = assertPlatformUrl(platform, current.url);
    return {platform, url: safe.href, title: current.title, readyState: current.readyState, text: current.text, video: current.video, loginRequired: current.loginRequired === true, observedAt: new Date().toISOString()};
  }

  async watch(platform, {seconds = 30, signal} = {}) {
    const total = Math.max(1, Math.min(1800, Math.floor(Number(seconds) || 0)));
    const initial = await this.snapshot(platform);
    if (initial.loginRequired) throw new Error('页面要求登录或验证码，已停止观看');
    if (!initial.video) throw new Error('当前页面没有可观察的视频元素');
    await this.page.evaluate(() => { const v = document.querySelector('video'); if (!v) return false; if (v.paused) { const p = v.play(); if (p?.catch) p.catch(() => {}); } return true; });
    const started = Date.now(); let latest = initial;
    while (Date.now() - started < total * 1000) {
      if (signal?.aborted) throw Object.assign(new Error('任务已取消'), {code: 'PLUGIN_CANCELLED'});
      await delay(Math.min(1000, total * 1000 - (Date.now() - started)), signal);
      latest = await this.snapshot(platform);
      if (latest.loginRequired) throw new Error('观看过程中出现登录或验证码页面，已停止');
      if (latest.video?.ended) break;
    }
    return {platform, requestedSeconds: total, elapsedSeconds: Math.max(0, Math.round((Date.now() - started) / 1000)), snapshot: latest};
  }

  async screenshot(platform) {
    const current = await this.snapshot(platform);
    const base64 = (await this.page.screenshot({type: 'png'})).toString('base64');
    if (!base64 || base64.length > 2_000_000) throw new Error('截图超过大小限制');
    return {platform, url: current.url, title: current.title, base64, capturedAt: new Date().toISOString()};
  }

  async subtitles(platform) {
    const current = await this.snapshot(platform);
    const cues = await this.page.evaluate(() => {
      const rows = [];
      for (const track of document.querySelectorAll('track[kind="subtitles"], track[kind="captions"]')) {
        const list = track.track?.cues;
        if (!list) continue;
        for (let i = 0; i < list.length && rows.length < 100; i += 1) { const cue = list[i]; rows.push({start: Number(cue.start) || 0, end: Number(cue.end) || 0, text: String(cue.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300), language: String(track.srclang || '').slice(0, 20), label: String(track.label || '').slice(0, 80)}); }
      }
      return rows.filter(row => row.text);
    });
    return {platform, url: current.url, title: current.title, cues: Array.isArray(cues) ? cues : [], observedAt: new Date().toISOString()};
  }

  async comment(platform, content) {
    const text = String(content || '').trim();
    if (!text || text.length > 300) throw new Error('评论内容为空或超过 300 字');
    const current = await this.snapshot(platform);
    if (current.loginRequired) throw new Error('页面要求登录或验证码，未提交评论');
    const result = await this.page.evaluate(({text}) => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const fields = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].filter(visible);
      const field = fields.find(el => /评论|说点什么|留下你的看法|comment/i.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`));
      if (!field) return {ok: false, reason: 'comment-field-not-found'};
      field.focus(); if (field.isContentEditable) field.textContent = text; else { const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set; if (setter) setter.call(field, text); else field.value = text; } field.dispatchEvent(new Event('input', {bubbles: true})); field.dispatchEvent(new Event('change', {bubbles: true}));
      const button = [...document.querySelectorAll('button, [role="button"], a')].filter(visible).find(el => /发表评论|发布评论|发布|发送|comment/i.test(String(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, '')));
      if (!button) return {ok: false, reason: 'comment-submit-not-found'}; button.click(); return {ok: true, button: String(button.innerText || button.getAttribute('aria-label') || '').trim().slice(0, 40)};
    }, {text});
    if (!result?.ok) throw new Error(result?.reason === 'comment-field-not-found' ? '当前页面没有可识别的评论输入框' : '当前页面没有可识别的评论提交按钮');
    return {platform, url: current.url, title: current.title, state: 'submitted', outcome: 'submitted', button: result.button, submittedAt: new Date().toISOString()};
  }

  async openContact(platform, contactId) {
    const id = validateContactId(contactId);
    return this.open(platform, platform === 'bilibili' ? `https://space.bilibili.com/${encodeURIComponent(id)}` : `https://www.douyin.com/user/${encodeURIComponent(id)}`);
  }

  async message(platform, {contactId, content} = {}) {
    const id = validateContactId(contactId); const text = String(content || '').trim();
    if (!text || text.length > 500) throw new Error('私信内容为空或超过 500 字');
    const current = await this.snapshot(platform); if (current.loginRequired) throw new Error('页面要求登录或验证码，未发送私信');
    const result = await this.page.evaluate(({id, text}) => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const body = String(document.body?.innerText || ''); const href = String(location.href || '');
      if (!body.includes(id) && !href.includes(encodeURIComponent(id)) && !href.includes(id)) return {ok: false, reason: 'contact-not-observed'};
      const field = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].filter(visible).find(el => /私信|发消息|消息|聊天|send message|message|chat/i.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`));
      if (!field) return {ok: false, reason: 'message-field-not-found'};
      field.focus(); if (field.isContentEditable) field.textContent = text; else { const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set; if (setter) setter.call(field, text); else field.value = text; } field.dispatchEvent(new Event('input', {bubbles: true})); field.dispatchEvent(new Event('change', {bubbles: true}));
      const button = [...document.querySelectorAll('button, [role="button"], a')].filter(visible).find(el => /^(发送|发消息|私信|send|sendmessage|message)$/i.test(String(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, '').trim()));
      if (!button) return {ok: false, reason: 'message-submit-not-found'}; button.click(); return {ok: true, button: String(button.innerText || button.getAttribute('aria-label') || '').trim().slice(0, 40)};
    }, {id, text});
    if (!result?.ok) { const reasons = {'contact-not-observed': '当前页面未观察到白名单联系人标识', 'message-field-not-found': '当前页面没有可识别的私信输入框', 'message-submit-not-found': '当前页面没有可识别的私信发送按钮'}; throw new Error(reasons[result?.reason] || '私信页面元素不可用'); }
    return {platform, contactId: id, url: current.url, title: current.title, state: 'submitted', outcome: 'submitted', targetVerified: true, button: result.button, submittedAt: new Date().toISOString()};
  }

  async close() { try { await this.context?.close(); } catch {} this.context = null; this.page = null; this.state = 'closed'; }
  async #ensurePage() { if (!this.context || !this.page) throw new Error('Playwright 浏览器尚未初始化'); }
}

function validateContactId(value) { const id = String(value || '').trim(); if (!id || id.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('平台联系人标识无效'); return id; }
function findBrowserPath() { const candidates = process.platform === 'linux' ? ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : process.platform === 'darwin' ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')].filter(Boolean); return candidates.find(existsSync) || ''; }
function delay(ms, signal) { return new Promise((resolve, reject) => { let abort; const timer = setTimeout(() => { if (signal && abort) signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms)); if (!signal) return; abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Object.assign(new Error('任务已取消'), {code: 'PLUGIN_CANCELLED'})); }; signal.addEventListener('abort', abort, {once: true}); }); }
