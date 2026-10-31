/* QQ 框架独立管理控制台：原生 ES 模块，无第三方依赖。 */
import {createStarMap} from './star-map.js';

const state = {
  csrf: null, data: null, view: 'overview', busy: false, ui: {}, starMap: null,
  // 页面级随机标识：刷新即换新值，秘密空间因此必须重新输入密码。
  vaultSession: globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))
};
const root = document.getElementById('root');
const toastEl = document.getElementById('toast');

const VIEWS = [
  ['overview', '总览', '运行状态、最近活动与快捷操作'],
  ['connection', '连接', 'OneBot 地址、Token 与模型'],
  ['chat', '聊天', '范围、参与方式与分条'],
  ['listen', '监听', '接收哪些私聊、群和通知'],
  ['permissions', '权限', '主人、动作授权与执行记录'],
  ['plugins', '插件', '内置包、原生包与声明式扩展'],
  ['sticker', '表情包', '收藏、分类、图片与收集规则', 'plugins'],
  ['qzone', 'QQ 空间', '真实空间动态、读取状态与设置', 'plugins'],
  ['memory', '长期记忆', '记忆库、星图与复习曲线', 'plugins'],
  ['autonomy', '自主时间', '活动、日记、时间记录与秘密空间', 'plugins'],
  ['logs', '日志', '运行日志、审计与诊断'],
  ['account', '安全', '管理密码与会话']
];
const PLUGIN_VIEWS = new Set(['sticker', 'qzone', 'memory', 'autonomy']);
const PAGE_ACTIONS = {sticker: 'stickerAdmin', qzone: 'qzoneAdmin', memory: 'memoryAdmin', autonomy: 'autonomyAdmin'};

const ICONS = {
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  logout: 'M15 17l5-5-5-5M20 12H9M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6',
  external: 'M14 4h6v6M20 4l-9 9M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M9 5v14M15 5v14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l4 4',
  plus: 'M12 5v14M5 12h14',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M8.5 9.5h.01',
  qzone: 'M12 3a9 9 0 1 0 9 9M12 3v9h9',
  memory: 'M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1 1 7.5V17a4 4 0 0 1-8 0v-1.5A4 4 0 0 1 8 8V7a4 4 0 0 1 4-4zM9 8h6M9 16h6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  lock: 'M6 11h12v10H6zM9 11V8a3 3 0 0 1 6 0v3',
  trash: 'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5',
  edit: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6'
};

function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

function iconButton(name, label, onClick) {
  return el('button', {
    class: 'icon-button', type: 'button', title: label, 'aria-label': label,
    onclick: onClick
  }, icon(name));
}

let clockTimer = null;
function clockParts() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    date: `${pad(now.getMonth() + 1)}.${pad(now.getDate())} 周${'日一二三四五六'[now.getDay()]}`
  };
}
function startClock() {
  const timeEl = document.getElementById('clock-time');
  if (!timeEl) return;
  const dateEl = document.getElementById('clock-date');
  const tick = () => {
    const parts = clockParts();
    timeEl.textContent = parts.time;
    if (dateEl) dateEl.textContent = parts.date;
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}
function stopClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'oninput') node.addEventListener('input', value);
    else if (key === 'onchange') node.addEventListener('change', value);
    else if (key === 'onsubmit') node.addEventListener('submit', value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast' + (error ? ' error' : '');
  toastEl.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toastEl.hidden = true; }, 4200);
}

function button(label, onClick, opts = {}) {
  return el('button', {
    class: 'button' + (opts.primary ? ' primary' : '') + (opts.ghost ? ' ghost' : '') + (opts.danger ? ' danger' : '') + (opts.small ? ' small' : ''),
    type: opts.type || 'button',
    disabled: opts.disabled,
    onclick: opts.disabled ? undefined : onClick
  }, opts.icon ? icon(opts.icon, 14) : null, label);
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', {}, label), control, hint ? el('small', {}, hint) : null);
}

function textInput(value, onInput, opts = {}) {
  return el('input', {
    type: opts.type || 'text',
    value: value ?? '',
    placeholder: opts.placeholder || '',
    maxlength: opts.maxLength,
    class: opts.mono ? 'mono' : undefined,
    autocomplete: opts.autocomplete || 'off',
    spellcheck: 'false',
    oninput: event => onInput(event.target.value)
  });
}

function numberInput(value, onInput, opts = {}) {
  return el('input', {
    type: 'number', value: value ?? '', min: opts.min, max: opts.max, step: opts.step || 1,
    oninput: event => onInput(event.target.value)
  });
}

function textArea(value, onInput, opts = {}) {
  return el('textarea', {
    rows: opts.rows || 4,
    maxlength: opts.maxLength,
    placeholder: opts.placeholder || '',
    class: opts.mono ? 'mono' : undefined,
    oninput: event => onInput(event.target.value)
  }, String(value ?? ''));
}

function select(value, onChange, options) {
  return el('select', { onchange: event => onChange(event.target.value) },
    options.map(([key, label]) => el('option', { value: key, selected: String(value) === String(key) }, label)));
}

function toggle(label, checked, onChange, help) {
  const input = el('input', { type: 'checkbox', checked: !!checked, onchange: event => onChange(event.target.checked) });
  return el('label', { class: 'toggle' },
    input,
    el('span', { class: 'switch', 'aria-hidden': 'true' }),
    el('span', { class: 'toggle-text' }, label, help ? el('small', {}, help) : null));
}

function card(title, desc, ...children) {
  return el('section', { class: 'card' },
    title ? el('header', {}, el('div', {}, el('h2', {}, title), desc ? el('p', { class: 'desc' }, desc) : null)) : null,
    ...children);
}

function grid(children, columns = 2) {
  return el('div', { class: 'grid ' + (columns === 3 ? 'three' : columns === 4 ? 'four' : columns === 1 ? '' : 'two') }, children);
}

function stat(label, value, hint) {
  return el('div', { class: 'stat' }, el('span', { class: 'label' }, label), el('span', { class: 'value' }, value), hint ? el('span', { class: 'hint' }, hint) : null);
}

function pill(text, kind = '') {
  return el('span', { class: 'pill' + (kind ? ' ' + kind : '') }, text);
}

function timeText(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function listOf(values) {
  return (values || []).join('\n');
}

function parseList(text) {
  return [...new Set(String(text || '').split(/[\s,，]+/).map(value => value.trim()).filter(Boolean))];
}

function savebar(note, onSave, label = '保存') {
  return el('div', {class: 'savebar'}, el('small', {}, note || '保存后立即生效'), button(label, onSave, {primary: true}));
}

function resetDraftButton(key) {
  return button('恢复为当前配置', () => { uiFor(key).draft = null; render(); }, {ghost: true, small: true});
}

function pageHeader(title, desc, meta = [], actions = []) {
  return el('header', {class: 'page-head'},
    el('div', {},
      el('p', {class: 'eyebrow'}, 'PLUGIN'),
      el('h1', {}, title),
      desc ? el('p', {class: 'desc'}, desc) : null,
      meta.length ? el('div', {class: 'head-meta'}, ...meta) : null),
    actions.length ? el('div', {class: 'page-actions'}, ...actions) : null);
}

function statePill(enabled, error) {
  if (error) return pill('异常', 'bad');
  return pill(enabled ? '已启用' : '已停用', enabled ? 'ok' : 'warn');
}

function pluginEnableToggle(overview, key, id) {
  let enabled = overview.enabled === true;
  return toggle('启用插件', enabled, value => {
    const payload = {id, enabled: value, config: overview.config, scope: overview.scope};
    if (key === 'memory' && overview.secrets?.embeddingKeyConfigured) payload.preserveSecrets = ['embeddingKey'];
    pageAction(key, 'configureNativePackage', payload, value ? '插件已启用' : '插件已停用');
  }, enabled ? '停用后后端动作立即失效' : '启用后动作与页面数据恢复');
}

function stateBox(title, message, action) {
  return el('div', {class: 'state-box'}, el('strong', {}, title), message ? el('p', {}, message) : null, action || null);
}

function tabs(items, current, onPick) {
  return el('div', {class: 'tabs', role: 'tablist'}, items.map(([id, label]) => el('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-current': current === id ? 'page' : undefined,
    onclick: () => onPick(id)
  }, label)));
}

function pager(total, offset, limit, onChange) {
  const end = Math.min(total, offset + limit);
  return el('div', {class: 'pagination'},
    el('span', {}, total ? `第 ${offset + 1}–${end} 条 · 共 ${total} 条` : '共 0 条'),
    el('span', {class: 'row'},
      button('上一页', () => onChange(Math.max(0, offset - limit)), {ghost: true, small: true, disabled: offset <= 0}),
      button('下一页', () => onChange(offset + limit), {ghost: true, small: true, disabled: end >= total})));
}

function dateText(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayText(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function bytesText(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function tagList(values) {
  return values?.length ? el('div', {class: 'tag-list'}, values.map(value => el('span', {class: 'tag'}, value))) : null;
}

function closeModal() {
  document.querySelectorAll('.modal-backdrop').forEach(node => node.remove());
}

function openModal(title, subtitle, body, actions = []) {
  closeModal();
  const box = el('div', {class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
    el('header', {class: 'modal-head'},
      el('div', {}, el('h2', {}, title), subtitle ? el('p', {}, subtitle) : null),
      el('button', {class: 'modal-close', type: 'button', 'aria-label': '关闭', onclick: closeModal}, '×')),
    el('div', {class: 'modal-body'}, body),
    actions.length ? el('footer', {class: 'modal-foot'}, ...actions) : null);
  const wrap = el('div', {class: 'modal-backdrop', onclick: event => { if (event.target === wrap) closeModal(); }}, box);
  document.body.append(wrap);
  return wrap;
}

function confirmDialog(title, message, onConfirm, label = '确认') {
  openModal(title, '', el('p', {class: 'notice'}, message), [
    button('取消', closeModal, {ghost: true}),
    button(label, () => { closeModal(); onConfirm(); }, {danger: true})
  ]);
}

function formatError(error) {
  return String(error?.message || error || '请求失败').slice(0, 300);
}

async function fetchJson(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  let json;
  try { json = await response.json(); } catch { json = { ok: false, error: '服务返回了无法解析的内容' }; }
  if (!response.ok || json.ok === false) {
    const error = new Error(json.error || ('HTTP ' + response.status));
    error.status = response.status;
    throw error;
  }
  return json;
}

async function secureApi(action, payload = {}) {
  const body = {action, revision: state.data?.revision, ...payload};
  if (action === 'secretAdmin') body.vaultSession = state.vaultSession;
  const response = await fetch('/api/action', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-csrf-token': state.csrf || ''},
    body: JSON.stringify(body)
  });
  let json;
  try { json = await response.json(); } catch { json = { ok: false, error: '服务返回了无法解析的内容' }; }
  if (response.status === 401) { state.data = null; state.csrf = null; renderAuth('login', '会话已过期，请重新登录'); throw new Error('请重新登录'); }
  if (!response.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + response.status));
  return json.value;
}

async function act(action, payload, done = '已保存') {
  if (state.busy) return false;
  state.busy = true;
  try {
    state.data = await secureApi(action, payload);
    toast(done);
    render();
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  } finally {
    state.busy = false;
  }
}

const pageCache = new Map();
function uiFor(key) {
  state.ui ||= {};
  state.ui[key] ||= {};
  return state.ui[key];
}

async function loadPage(key, work, {force = false} = {}) {
  const current = pageCache.get(key);
  if (current?.loading) return;
  if (!force && current?.data && !current.error) return;
  pageCache.set(key, {...(current || {}), loading: true, error: null});
  if (state.view === key) render();
  try {
    const data = await work();
    pageCache.set(key, {data, loading: false, error: null, at: Date.now()});
  } catch (error) {
    if (error.message === '请重新登录') return;
    pageCache.set(key, {...(current || {}), loading: false, error: formatError(error), data: current?.data || null});
    toast(formatError(error), true);
  }
  if (state.view === key) render();
}

async function pageAction(key, action, payload, done) {
  if (state.busy) return false;
  state.busy = true;
  try {
    const value = await secureApi(action, payload);
    toast(done);
    if (state.ui?.[key]?.draft) state.ui[key].draft = null;
    pageCache.delete(key);
    await loadPage(key, pageLoaders[key], {force: true});
    return value;
  } catch (error) {
    if (error.message !== '请重新登录') toast(formatError(error), true);
    return false;
  } finally {
    state.busy = false;
  }
}

function pageStatus(key) {
  const page = pageCache.get(key);
  if (!page || (page.loading && !page.data)) return {loading: true};
  if (page.error && !page.data) return {error: page.error};
  return {data: page.data, loading: page.loading, error: page.error};
}

const pageLoaders = {};

function renderAuth(mode, error = '') {
  stopClock();
  clear(root);
  const setup = mode === 'setup';
  let password = '', confirm = '';
  const errorBox = el('div', { class: 'auth-error', role: 'alert' }, error);
  errorBox.hidden = !error;
  const form = el('form', { class: 'auth-form' },
    field('管理密码', textInput('', value => { password = value; }, { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', placeholder: setup ? '至少 10 位' : '输入管理密码' })),
    setup ? field('确认密码', textInput('', value => { confirm = value; }, { type: 'password', autocomplete: 'new-password', placeholder: '再输入一次' })) : null,
    button(setup ? '设置密码并进入' : '登录', null, { primary: true, type: 'submit' }),
    errorBox
  );
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (setup && password !== confirm) { errorBox.textContent = '两次输入的密码不一致'; errorBox.hidden = false; return; }
    try {
      const path = setup ? '/api/setup' : '/api/login';
      const json = await fetchJson(path, { password });
      state.csrf = json.csrf;
      await load();
    } catch (failure) {
      errorBox.textContent = failure.message;
      errorBox.hidden = false;
    }
  });
  const stage = el('aside', { class: 'auth-stage' },
    el('div', { class: 'auth-brand' },
      el('span', { class: 'mark' }, 'Q'),
      el('div', {}, el('strong', {}, 'QQ 框架'), el('small', {}, 'Night Watch Console'))),
    el('div', { class: 'auth-copy' },
      el('p', { class: 'eyebrow' }, setup ? 'FIRST RUN' : 'ADMIN ACCESS'),
      el('h1', {}, setup ? '给控制台' : '守夜人的', el('br'), setup ? '一把钥匙。' : '控制台。'),
      el('p', { class: 'auth-quote' }, '“Always on, quietly.”'),
      el('p', { class: 'auth-lede' }, setup
        ? '第一次打开需要设置管理密码。它只保存在本机，使用 scrypt 哈希，不会写进日志或插件状态。'
        : 'OneBot 11 桥接、受限 Agent 与功能包。管理站点只在本机开放，不经过外网。'),
      el('div', { class: 'auth-facts' },
        el('span', {}, '只监听 127.0.0.1'),
        el('span', {}, 'scrypt 哈希'),
        el('span', {}, '会话 12 小时'))),
    el('div', { class: 'auth-meta' }, el('span', {}, 'QQ 框架 · Night Watch'), el('span', {}, '127.0.0.1:3097')));
  const panel = el('main', { class: 'auth-panel' },
    el('div', { class: 'auth-card' },
      el('p', { class: 'eyebrow' }, setup ? 'SET PASSWORD' : 'SIGN IN'),
      el('h2', {}, setup ? '初始化管理密码' : '登录管理控制台'),
      el('p', { class: 'auth-sub' }, setup
        ? '密码至少 10 位，不能是常见弱密码。设置后即可进入控制台。'
        : 'QQ 框架独立管理站点。默认只允许本机访问，30 分钟无操作自动登出。'),
      form,
      el('p', { class: 'auth-hint' }, 'http://127.0.0.1:3097 · 仅本机')));
  root.append(el('div', { class: 'auth' }, stage, panel));
}

async function load() {
  try {
    state.data = await secureApi('snapshot');
    render();
  } catch (error) {
    if (error.message !== '请重新登录') renderAuth('login', error.message);
  }
}

function shellPage() {
  const current = VIEWS.find(view => view[0] === state.view) || VIEWS[0];
  const data = state.data;
  const online = data.status?.online === true;
  const paused = data.framework?.paused === true;
  const top = VIEWS.filter(view => !view[3]);
  const pluginViews = VIEWS.filter(view => view[3] === 'plugins');
  const pluginParent = top.findIndex(view => view[0] === 'plugins');
  const navButtons = [];
  top.forEach(([id, label], index) => {
    navButtons.push(el('button', {
      type: 'button', 'aria-current': state.view === id ? 'page' : undefined,
      onclick: () => go(id)
    }, el('span', {class: 'idx'}, String(index + 1).padStart(2, '0')), el('span', {}, label)));
    if (id !== 'plugins') return;
    navButtons.push(el('div', {class: 'nav-group'},
      el('div', {class: 'nav-group-title'}, '功能包'),
      el('div', {class: 'nav nav-sub'}, pluginViews.map(([childId, childLabel], childIndex) => el('button', {
        type: 'button', 'aria-current': state.view === childId ? 'page' : undefined,
        onclick: () => go(childId)
      }, el('span', {class: 'idx'}, String(pluginParent + 1).padStart(2, '0') + '.' + (childIndex + 1)), el('span', {}, childLabel))))));
  });
  const nav = el('nav', {class: 'nav', 'aria-label': '管理导航'}, navButtons);
  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' },
      el('div', { class: 'logo' }, 'Q'),
      el('div', {}, el('strong', {}, 'QQ 框架'), el('small', {}, 'Night Watch'))),
    nav,
    el('div', { class: 'side-foot' },
      el('div', { class: 'side-status' },
        el('span', { class: 'led' + (online ? ' ok' : '') }),
        el('div', {},
          el('strong', {}, online ? (paused ? '收发已暂停' : '在线值守') : '等待连接'),
          el('small', {}, data.status?.bot || 'NapCat 未连接'))),
      el('dl', { class: 'side-meta' },
        el('div', {}, el('dt', {}, '版本'), el('dd', {}, data.compatibility?.framework || '—')),
        el('div', {}, el('dt', {}, '会话'), el('dd', {}, '12h · 本地'))),
      el('button', { class: 'link-btn', type: 'button', onclick: logout }, '退出登录')));
  const topbar = el('header', { class: 'topbar' },
    el('div', { class: 'crumb' },
      el('span', {}, '控制台'), el('i', {}, '/'), el('span', { class: 'current' }, current[1])),
    el('div', { class: 'topbar-actions' },
      el('div', { class: 'clock' },
        el('strong', { id: 'clock-time' }, '--:--:--'),
        el('span', { id: 'clock-date' }, '')),
      pill(online ? (paused ? '已暂停' : '在线') : '未连接', online ? (paused ? 'warn' : 'ok') : 'warn'),
      iconButton('refresh', '刷新状态', () => load()),
      iconButton('logout', '退出登录', logout)));
  const content = el('div', { class: 'content' }, ...[].concat(viewContent()));
  return el('div', { class: 'shell' }, sidebar,
    el('main', {}, topbar, content,
      el('footer', { class: 'foot' },
        el('span', {}, `QQ 框架 ${data.compatibility?.framework || '—'} · DSH ${data.compatibility?.dsh || '—'}`),
        el('span', {}, '127.0.0.1:3097 · 数据仅存本机'))));
}

function render() {
  if (!state.data) return;
  stopClock();
  state.starMap?.destroy();
  state.starMap = null;
  clear(root).append(shellPage());
  startClock();
  root.querySelectorAll('[data-count]').forEach(node => { node.textContent = node.dataset.count; });
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf || '' }, body: '{}' });
  } catch { /* 忽略 */ }
  state.data = null; state.csrf = null; state.ui = {}; pageCache.clear(); closeModal();
  renderAuth('login');
}

function viewFromHash() {
  const [id, tab] = location.hash.replace(/^#\/?/, '').split('/');
  if (!VIEWS.some(view => view[0] === id)) return 'overview';
  if (tab && PLUGIN_VIEWS.has(id)) {
    state.ui ||= {};
    state.ui[id] ||= {};
    state.ui[id].tab = tab;
  }
  return id;
}

function go(id) {
  if (id === state.view) return;
  if (state.ui?.autonomy?.dirty && !window.confirm('日记还有未保存的修改，确定离开吗？')) return;
  closeModal();
  state.view = id;
  try { history.replaceState(null, '', '#' + id); } catch { /* 忽略 */ }
  render();
}

function viewContent() {
  switch (state.view) {
    case 'connection': return connectionView();
    case 'chat': return chatView();
    case 'listen': return listenView();
    case 'permissions': return permissionsView();
    case 'plugins': return pluginsView();
    case 'sticker': return stickerView();
    case 'qzone': return qzoneView();
    case 'memory': return memoryView();
    case 'autonomy': return autonomyView();
    case 'logs': return logsView();
    case 'account': return accountView();
    default: return overviewView();
  }
}

function dial(online, paused) {
  const stateText = paused && online ? 'PAUSED' : online ? 'ONLINE' : 'OFFLINE';
  return el('div', { class: 'dial' + (online && !paused ? ' is-on' : '') + (online ? '' : ' is-off') },
    el('span', { class: 'ring' }),
    el('span', { class: 'ring inner' }),
    el('span', { class: 'ticks' }),
    el('div', { class: 'core' },
      el('span', { class: 'state' }, stateText),
      el('span', { class: 'num' }, state.data?.status?.bot || 'NO SIGNAL')));
}

function vital(label, value, hint) {
  const number = el('span', { class: 'v' }, String(value));
  if (typeof value === 'number') number.dataset.count = String(value);
  return el('div', { class: 'vital' },
    el('span', { class: 'k' }, label),
    number,
    hint ? el('span', { class: 'h' }, hint) : null);
}

function bar(label, value, total, dim = false) {
  const percent = total > 0 ? Math.min(100, Math.round(value / total * 100)) : 0;
  const fill = el('span', { class: 'fill' });
  fill.style.setProperty('--p', percent + '%');
  return el('div', { class: 'bar' + (dim ? ' dim' : '') },
    el('div', { class: 'bl' }, el('span', {}, label), el('b', {}, total > 0 ? `${value} · ${percent}%` : String(value))),
    el('div', { class: 'track' }, fill));
}

function overviewView() {
  const data = state.data;
  const framework = data.framework || {};
  const capabilities = data.capabilities || [];
  const online = data.status?.online === true;
  const paused = framework.paused === true;
  const enabled = (framework.enabledActions || []).length;
  const builtinOn = (data.builtins || []).filter(item => item.enabled).length;
  const nativeOn = (data.nativePackages || []).filter(item => item.enabled).length;
  const groups = (framework.listenGroups || []).length;
  const users = (framework.listenUsers || []).length;
  const allPrivate = framework.listenAllPrivate === true;
  const received = data.diagnostics?.received ?? 0;
  const accepted = data.diagnostics?.accepted ?? 0;
  const ignored = data.diagnostics?.ignored ?? 0;
  const stateText = online ? (paused ? '已暂停收发' : '在线值守') : '等待 NapCat 连接';
  const listenText = allPrivate ? '所有私聊' : `${users} 位联系人`;

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'hero-copy' },
      el('p', { class: 'eyebrow' }, 'LIVE STATUS'),
      el('h1', {}, 'QQ 框架'),
      el('p', { class: 'hero-lead' }, `OneBot 11 桥接、受限 Agent 与功能包。当前${stateText}，监听 ${groups} 个群与 ${listenText}。`),
      el('div', { class: 'hero-meta' },
        el('span', {}, online ? '连接正常' : '连接中断'),
        el('span', {}, `${enabled} 项动作启用`),
        el('span', {}, `${builtinOn + nativeOn} 个功能包运行中`),
        el('span', {}, `主人 ${framework.ownerQQ || '—'}`)),
      el('div', { class: 'hero-row' },
        button(paused ? '恢复收发' : '暂停收发', () => act('saveFramework', { framework: { ...framework, paused: !paused } }, paused ? '已恢复' : '已暂停'), { primary: true, icon: paused ? 'play' : 'pause' }),
        button('打开 DSH', () => window.open('http://127.0.0.1:3080', '_blank', 'noopener'), { ghost: true, icon: 'external' }),
        button('刷新状态', () => load(), { ghost: true, icon: 'refresh' })),
      online ? null : el('p', { class: 'notice warn mt' }, 'NapCat 尚未连接：检查 OneBot 地址与 Token，或在 NapCat 扫码登录。')),
    el('div', { class: 'hero-aside' },
      dial(online, paused),
      el('div', { class: 'bot-name' },
        data.status?.nickname || (online ? '已连接' : '未连接'),
        el('small', {}, data.status?.bot ? 'QQ ' + data.status.bot : 'NO SESSION'))));

  const vitals = el('div', { class: 'vitals' },
    vital('已启用动作', enabled, `${capabilities.length} 项能力`),
    vital('运行中的包', builtinOn + nativeOn, `内置 ${builtinOn} · 原生 ${nativeOn}`),
    vital('监听群', groups, listenText),
    vital('本次接收', received, `接受 ${accepted} · 忽略 ${ignored}`));

  const audit = (framework.audit || []).slice(-8).reverse();
  const names = new Map(capabilities.map(cap => [cap.id, cap.description]));
  const tone = { completed: 'ok', denied: 'warn', failed: 'bad', started: '', unknown: 'warn' };
  const outcomeText = { denied: '已拒绝', started: '开始', completed: '完成', failed: '失败', unknown: '结果未知' };
  const events = el('section', { class: 'card' },
    el('header', {}, el('div', {},
      el('h2', {}, '最近事件'),
      el('p', { class: 'desc' }, '权限与动作执行记录，最新的在上'))),
    audit.length
      ? el('div', { class: 'timeline' }, audit.map(row => el('div', { class: 'tl ' + (tone[row.outcome] || '') },
        el('span', { class: 'dotn' }),
        el('div', {},
          el('div', { class: 't' }, names.get(row.capability) || outcomeText[row.outcome] || row.capability),
          el('div', { class: 'm' },
            el('span', { class: 'mono' }, row.capability),
            ` · ${row.actor || '—'} · ${row.kind === 'group' ? '群 ' : '私聊 '}${row.peer || ''}`,
            row.reason ? ` · ${row.reason}` : null)),
        el('div', { class: 'time' }, timeText(row.time)))))
      : el('p', { class: 'empty' }, '暂无记录'));

  const diagnostics = el('section', { class: 'card' },
    el('header', {}, el('div', {},
      el('h2', {}, '运行诊断'),
      el('p', { class: 'desc' }, '本轮运行的消息流向'))),
    el('div', { class: 'bars' },
      bar('接收消息', received, received),
      bar('接受处理', accepted, received),
      bar('忽略', ignored, received, true)),
    el('p', { class: 'notice' }, '最近忽略原因：' + (data.diagnostics?.recentIgnored?.[0]?.reason || '无')));

  return [hero, vitals, el('div', { class: 'grid two' }, events, diagnostics)];
}

function connectionView() {
  const settings = state.data.settings;
  const connText = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', closed: '已断开', idle: '空闲' };
  const draft = {
    enabled: settings.enabled, mode: settings.mode, url: settings.url,
    reverseHost: settings.reverseHost, reversePort: settings.reversePort, reversePath: settings.reversePath,
    provider: settings.provider || '', model: settings.model || ''
  };
  let token = '', clearToken = false, testResult = '';
  const testNote = el('small', { class: 'muted' });
  const reverse = el('div', { class: 'form-grid span-2' },
    field('监听地址', select(draft.reverseHost, value => { draft.reverseHost = value; }, [['127.0.0.1', '127.0.0.1'], ['::1', '::1']])),
    field('监听端口', numberInput(draft.reversePort, value => { draft.reversePort = value; }, { min: 1024, max: 65535 })),
    field('连接路径', textInput(draft.reversePath, value => { draft.reversePath = value; }, { mono: true, placeholder: '/onebot/v11' })));
  reverse.hidden = (draft.mode || 'forward') !== 'reverse';
  const form = el('div', { class: 'form-grid' },
    el('div', { class: 'span-2' }, toggle('启用 QQ 桥接', draft.enabled, value => { draft.enabled = value; }, '关闭后暂停收发，但保留设置与数据')),
    field('连接方式', select(draft.mode || 'forward', value => {
      draft.mode = value; reverse.hidden = value !== 'reverse';
      forwardFields.hidden = value === 'reverse';
    }, [['forward', '正向 WebSocket'], ['reverse', '反向 WebSocket']])),
    field('状态', el('div', { class: 'row' }, pill(state.data.status?.online ? '在线' : '未连接', state.data.status?.online ? 'ok' : 'warn'), el('span', { class: 'faint' }, connText[state.data.status?.state] || state.data.status?.state || ''))),
    el('div', { class: 'span-2', id: 'forward-fields' }, field('WebSocket 地址', textInput(draft.url, value => { draft.url = value; }, { mono: true, placeholder: 'ws://127.0.0.1:3001' }))),
    reverse,
    field('模型提供方', textInput(draft.provider, value => { draft.provider = value; }, { placeholder: '留空使用 DSH 默认' })),
    field('模型 ID', textInput(draft.model, value => { draft.model = value; }, { placeholder: '留空使用 DSH 默认' })),
    field('OneBot Token', textInput('', value => { token = value; }, { type: 'password', autocomplete: 'new-password', placeholder: state.data.tokenConfigured ? '已配置，留空保持不变' : '未配置' })),
    el('div', { class: 'row' }, toggle('清除已保存的 Token', clearToken, value => { clearToken = value; })));
  const forwardFields = form.querySelector('#forward-fields');
  const save = () => act('saveSettings', { settings: { ...settings, ...draft, reversePort: Number(draft.reversePort) }, token, clearToken }, '连接设置已保存');
  const test = async () => {
    testNote.textContent = '正在测试…';
    try {
      const result = await secureApi('test', { settings: { ...settings, ...draft, reversePort: Number(draft.reversePort) }, token });
      testNote.textContent = result.message + (result.bot ? ' · QQ ' + result.bot : '');
    } catch (error) { testNote.textContent = error.message; }
  };
  return card('OneBot 连接', 'NapCat 与本框架之间的 WebSocket。修改 Token 后需要与 NapCat 一侧保持一致。', form,
    el('div', { class: 'savebar' }, testNote, el('div', { class: 'row' }, button('测试连接', test, { ghost: true }), button('保存连接设置', save, { primary: true }))),
    el('p', { class: 'notice mt' }, 'Token 不会回显。留空表示保持当前值；勾选“清除”并保存会删除已保存的 Token。'));
}

function chatView() {
  const settings = state.data.settings;
  const draft = {
    privateEnabled: settings.privateEnabled, privateAudience: settings.privateAudience || 'allowlist',
    groupEnabled: settings.groupEnabled, groupAudience: settings.groupAudience || 'allowlist',
    allowedUsers: listOf(settings.allowedUsers), allowedGroups: listOf(settings.allowedGroups),
    groupReplyMode: settings.groupReplyMode || 'direct', groupReplyProbability: settings.groupReplyProbability ?? 10,
    groupReplyCooldown: settings.groupReplyCooldown ?? 30, groupAutoLimit: settings.groupAutoLimit ?? 2,
    replySplit: settings.replySplit || 'natural', replyQuoteMode: settings.replyQuoteMode || 'off',
    replyTotalChars: settings.replyTotalChars ?? 240, replyMaxParts: settings.replyMaxParts ?? 2,
    sendInterval: settings.sendInterval ?? 1100, maxReplyChars: settings.maxReplyChars ?? 1800,
    botAliases: listOf(settings.botAliases), intentRecognition: settings.intentRecognition !== false
  };
  const form = el('div', { class: 'form-grid' },
    toggle('允许私聊', draft.privateEnabled, value => { draft.privateEnabled = value; }, '关闭后普通私聊不再回复'),
    field('私聊范围', select(draft.privateAudience, value => { draft.privateAudience = value; }, [['allowlist', '指定用户'], ['all', '所有私聊用户']])),
    toggle('允许群聊', draft.groupEnabled, value => { draft.groupEnabled = value; }, '还需在“监听”里勾选群'),
    field('群聊参与方式', select(draft.groupReplyMode, value => { draft.groupReplyMode = value; }, [['direct', '被叫到时'], ['smart', '自然参与'], ['all', '每条都回复']])),
    field('自然参与概率（%）', numberInput(draft.groupReplyProbability, value => { draft.groupReplyProbability = value; }, { min: 0, max: 100 })),
    field('随机参与冷却（秒）', numberInput(draft.groupReplyCooldown, value => { draft.groupReplyCooldown = value; }, { min: 0, max: 600 })),
    field('每群每分钟上限', numberInput(draft.groupAutoLimit, value => { draft.groupAutoLimit = value; }, { min: 1, max: 10 })),
    field('分条方式', select(draft.replySplit, value => { draft.replySplit = value; }, [['natural', '自然分条'], ['paragraphs', '按空行'], ['length', '按字数'], ['single', '整段发送']])),
    field('引用回复', select(draft.replyQuoteMode, value => { draft.replyQuoteMode = value; }, [['off', '不引用'], ['follow', '跟随原消息'], ['always', '总是引用']])),
    field('每轮总字数', numberInput(draft.replyTotalChars, value => { draft.replyTotalChars = value; }, { min: 80, max: 4000 })),
    field('每轮最多条数', numberInput(draft.replyMaxParts, value => { draft.replyMaxParts = value; }, { min: 1, max: 6 })),
    field('分条间隔（毫秒）', numberInput(draft.sendInterval, value => { draft.sendInterval = value; }, { min: 0, max: 10000 })),
    field('单条最大字数', numberInput(draft.maxReplyChars, value => { draft.maxReplyChars = value; }, { min: 200, max: 4000 })),
    toggle('语义识别（判断是否该接话）', draft.intentRecognition, value => { draft.intentRecognition = value; }),
    field('机器人称呼', textArea(draft.botAliases, value => { draft.botAliases = value; }, { rows: 3, placeholder: '每行一个，例如：小鱼' }), '群里用这些称呼叫她时优先唤醒'),
    field('允许的私聊用户', textArea(draft.allowedUsers, value => { draft.allowedUsers = value; }, { rows: 4, placeholder: '每行一个 QQ 号' }), '“所有私聊用户”时忽略'),
    field('允许回复的群', textArea(draft.allowedGroups, value => { draft.allowedGroups = value; }, { rows: 4, placeholder: '每行一个群号' }), '必须同时在监听范围里'));
  const save = () => act('saveConversation', {
    settings: {
      ...state.data.settings,
      privateEnabled: draft.privateEnabled, privateAudience: draft.privateAudience,
      groupEnabled: draft.groupEnabled, groupAudience: draft.groupAudience,
      allowedUsers: parseList(draft.allowedUsers), allowedGroups: parseList(draft.allowedGroups),
      groupReplyMode: draft.groupReplyMode,
      groupReplyProbability: Number(draft.groupReplyProbability), groupReplyCooldown: Number(draft.groupReplyCooldown),
      groupAutoLimit: Number(draft.groupAutoLimit), replySplit: draft.replySplit, replyQuoteMode: draft.replyQuoteMode,
      replyTotalChars: Number(draft.replyTotalChars), replyMaxParts: Number(draft.replyMaxParts),
      sendInterval: Number(draft.sendInterval), maxReplyChars: Number(draft.maxReplyChars),
      botAliases: parseList(draft.botAliases), intentRecognition: draft.intentRecognition
    }
  }, '聊天设置已保存');
  return card('聊天与回复', '接收范围、群聊参与方式和分条节奏。群号还需要在“监听”里勾选才会收到消息。', form,
    savebar('保存后新的消息立即使用这套设置', save));
}

function listenView() {
  const framework = state.data.framework;
  const draft = {
    listenPrivate: framework.listenPrivate, listenAllPrivate: framework.listenAllPrivate,
    listenUsers: listOf(framework.listenUsers), listenGroups: listOf(framework.listenGroups),
    listenNotices: framework.listenNotices, listenRequests: framework.listenRequests, paused: framework.paused
  };
  const form = el('div', { class: 'form-grid' },
    el('div', { class: 'span-2' }, toggle('暂停机器人', draft.paused, value => { draft.paused = value; }, '暂停后不回复任何 QQ 消息，但保留管理与工具任务')),
    toggle('监听私聊', draft.listenPrivate, value => { draft.listenPrivate = value; }),
    toggle('接收所有私聊', draft.listenAllPrivate, value => { draft.listenAllPrivate = value; }, '打开后不再需要逐个填用户'),
    toggle('监听群消息', true, () => {}, '群列表决定监听哪些群'),
    toggle('记录通知（入群、管理员等）', draft.listenNotices, value => { draft.listenNotices = value; }),
    toggle('接收好友/加群请求', draft.listenRequests, value => { draft.listenRequests = value; }),
    field('监听的私聊用户', textArea(draft.listenUsers, value => { draft.listenUsers = value; }, { rows: 5, placeholder: '每行一个 QQ 号' })),
    field('监听的群', textArea(draft.listenGroups, value => { draft.listenGroups = value; }, { rows: 5, placeholder: '每行一个群号' })));
  const save = () => act('saveFramework', {
    framework: {
      ...framework,
      listenPrivate: draft.listenPrivate, listenAllPrivate: draft.listenAllPrivate,
      listenUsers: parseList(draft.listenUsers), listenGroups: parseList(draft.listenGroups),
      listenNotices: draft.listenNotices, listenRequests: draft.listenRequests, paused: draft.paused
    }
  }, '监听设置已保存');
  return card('监听范围', '决定哪些私聊、群和通知会进入框架。监听不等于回复，回复范围在“聊天”里。', form,
    savebar('保存后立即生效', save));
}

function permissionsView() {
  const framework = state.data.framework;
  const capabilities = state.data.capabilities || [];
  const enabled = new Set(framework.enabledActions || []);
  let ownerQQ = framework.ownerQQ || '';
  let ownerQQs = listOf(framework.ownerQQs || []);
  let paused = framework.paused;
  const boxes = [];
  const groups = new Map();
  for (const cap of capabilities) {
    const key = cap.id.startsWith('plugin.') ? cap.id.split('.')[1] : cap.id.split('.')[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cap);
  }
  const capGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => el('div', { class: 'cap-group' },
    el('h4', {}, name === 'core' ? '核心' : name === 'qq' ? 'QQ 动作' : '插件 · ' + name),
    items.map(cap => {
      const input = el('input', { type: 'checkbox', checked: enabled.has(cap.id), onchange: event => { if (event.target.checked) enabled.add(cap.id); else enabled.delete(cap.id); } });
      boxes.push(cap.id);
      return el('label', { class: 'cap' }, input,
        el('span', {}, el('span', { class: 'name' }, cap.description || cap.id), el('span', { class: 'id' }, cap.id)),
        el('span', { class: 'tags' },
          cap.ownerOnly ? el('span', { class: 'tag' }, '仅主人') : null,
          cap.mutating ? el('span', { class: 'tag' }, '修改') : null,
          cap.publicSafe ? el('span', { class: 'tag' }, '可共享') : null));
    })));
  const grants = framework.grants || [];
  const save = () => act('saveFramework', {
    framework: {
      ...framework, ownerQQ, ownerQQs: parseList(ownerQQs), paused,
      enabledActions: [...new Set([
        ...(framework.enabledActions || []).filter(id => !capabilities.some(cap => cap.id === id)),
        ...capabilities.filter(cap => enabled.has(cap.id)).map(cap => cap.id)
      ])]
    }
  }, '权限已保存');
  const owners = el('div', { class: 'form-grid' },
    field('主要主人 QQ', textInput(ownerQQ, value => { ownerQQ = value; })),
    field('其他主人 QQ', textArea(ownerQQs, value => { ownerQQs = value; }, { rows: 3, placeholder: '每行一个' })),
    el('div', { class: 'span-2' }, toggle('暂停机器人', paused, value => { paused = value; }, '权限变更会撤销旧任务授权')));
  const grantTable = grants.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ['动作', '范围', '用户', '群', '额度', '到期', '拒绝'].map(head => el('th', {}, head)))),
    el('tbody', {}, grants.map(grant => el('tr', {},
      el('td', {}, grant.capability),
      el('td', {}, grant.allUsers ? '所有用户' : grant.private ? '私聊' : '群'),
      el('td', {}, (grant.users || []).join('、') || '—'),
      el('td', {}, (grant.groups || []).join('、') || '—'),
      el('td', {}, String(grant.perMinute ?? '') + '/分钟'),
      el('td', {}, grant.expires ? timeText(grant.expires) : '长期'),
      el('td', {}, grant.deny ? '拒绝' : '允许')))))) : el('p', { class: 'muted' }, '还没有特殊授权规则。');
  return el('div', { class: 'grid', style: 'gap:18px' },
    card('主人', '主人可以在私聊和允许的群里使用已启用动作。修改会撤销旧任务。', owners),
    card('动作授权', '逐项启用能力。普通用户除了这里的动作，还需要在“特殊范围”里单独授权；该页暂未提供，请到 DSH 编辑。', el('div', { class: 'caps' }, capGroups), savebar('保存后立即生效，旧任务授权会被撤销', save)),
    card('特殊范围（只读）', '按用户、群、额度和到期时间的授权规则。编辑仍在 DSH 的“主人与权限”里完成。', grantTable));
}

function configForm(manifest, config) {
  const schema = manifest?.configSchema || {};
  const draft = { ...config };
  const controls = [];
  const node = el('div', { class: 'form-grid' });
  for (const [key, fieldDef] of Object.entries(schema)) {
    const title = fieldDef.title || key;
    if (fieldDef.type === 'boolean') {
      controls.push({ key, fieldDef, title });
      node.append(el('div', { class: 'span-2' }, toggle(title, draft[key] === true, value => { draft[key] = value; }, fieldDef.description)));
      continue;
    }
    let control;
    if (fieldDef.type === 'number') {
      control = numberInput(draft[key] ?? fieldDef.default, value => { draft[key] = value; }, { min: fieldDef.min, max: fieldDef.max });
    } else if (fieldDef.type === 'string[]') {
      control = textArea(listOf(draft[key] || []), value => { draft[key] = value; }, { rows: 3, placeholder: '每行一个' });
    } else if (fieldDef.type === 'string' && Array.isArray(fieldDef.enum)) {
      control = select(draft[key] ?? fieldDef.default, value => { draft[key] = value; }, fieldDef.enum.map(value => [value, value]));
    } else {
      control = (fieldDef.multiline || (fieldDef.maxLength || 0) > 200)
        ? textArea(draft[key] ?? fieldDef.default ?? '', value => { draft[key] = value; }, { rows: 3, maxLength: fieldDef.maxLength })
        : textInput(draft[key] ?? fieldDef.default ?? '', value => { draft[key] = value; }, { maxLength: fieldDef.maxLength });
    }
    controls.push({ key, fieldDef, title });
    node.append(field(title, control, fieldDef.description));
  }
  const read = () => {
    const out = {};
    for (const [key, fieldDef] of Object.entries(schema)) {
      const value = draft[key] ?? fieldDef.default;
      if (fieldDef.type === 'number') {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(titleOf(key, fieldDef) + ' 必须是数字');
        if (fieldDef.min != null && number < fieldDef.min) throw new Error(titleOf(key, fieldDef) + ' 不能小于 ' + fieldDef.min);
        if (fieldDef.max != null && number > fieldDef.max) throw new Error(titleOf(key, fieldDef) + ' 不能大于 ' + fieldDef.max);
        out[key] = number;
      } else if (fieldDef.type === 'boolean') out[key] = value === true;
      else if (fieldDef.type === 'string[]') out[key] = parseList(value);
      else out[key] = String(value ?? '');
    }
    return out;
  };
  return { node, read };
}

function titleOf(key, fieldDef) {
  return fieldDef?.title || key;
}

function scopeEditor(scope) {
  const draft = { private: scope?.private !== false, allUsers: scope?.allUsers === true, users: listOf(scope?.users || []), groups: listOf(scope?.groups || []) };
  const node = el('div', { class: 'form-grid' },
    toggle('允许私聊', draft.private, value => { draft.private = value; }),
    toggle('对所有用户生效', draft.allUsers, value => { draft.allUsers = value; }, '只建议用于安全查询类插件'),
    field('指定用户', textArea(draft.users, value => { draft.users = value; }, { rows: 3, placeholder: '每行一个 QQ 号' })),
    field('指定群', textArea(draft.groups, value => { draft.groups = value; }, { rows: 3, placeholder: '每行一个群号' })));
  const read = () => ({ private: draft.private, allUsers: draft.allUsers, users: parseList(draft.users), groups: parseList(draft.groups) });
  return { node, read };
}

function pluginCard(item, kind) {
  const manifest = item.manifest || {};
  const name = manifest.name || item.name || item.id;
  const version = manifest.version || item.version || '1.0.0';
  const description = manifest.description || item.description || '';
  const kindLabel = kind === 'builtin' ? '内置包' : kind === 'extension' ? '声明式扩展' : '原生包';
  let enabled = item.enabled === true;
  const scope = scopeEditor(item.scope);
  const config = configForm(manifest, item.config || {});
  const save = () => {
    if (kind === 'builtin') return act('configureBuiltin', { id: item.id, enabled, config: item.config || {} }, '内置包已保存');
    let values;
    try { values = config.read(); } catch (error) { toast(error.message, true); return; }
    if (kind === 'extension') return act('configureExtension', { id: item.id, enabled, config: values, scope: scope.read() }, '扩展已保存');
    return act('configureNativePackage', { id: item.id, enabled, config: values, scope: scope.read() }, '插件已保存');
  };
  const head = el('div', { class: 'pkg-head' },
    el('div', { class: 'pkg-title' },
      el('h3', {}, name, el('span', { class: 'tag' }, kindLabel)),
      el('p', { class: 'desc' }, description),
      el('div', { class: 'meta' }, el('span', { class: 'tag' }, 'v' + version), el('span', { class: 'tag' }, item.id))),
    el('div', { class: 'pkg-actions' },
      toggle('启用', enabled, value => { enabled = value; }),
      button('保存', save, { small: true })));
  const body = el('div', { class: 'pkg-body' },
    el('details', {}, el('summary', {}, '作用范围'), scope.node),
    Object.keys(manifest.configSchema || {}).length ? el('details', {}, el('summary', {}, '插件设置'), config.node) : null,
    el('p', { class: 'pkg-note' }, '保存后会重新加载该插件'));
  return el('div', { class: 'pkg' }, head, kind === 'builtin' ? null : body);
}

function pluginsView() {
  const data = state.data;
  const builtins = (data.builtins || []).map(item => pluginCard(item, 'builtin'));
  const natives = (data.nativePackages || []).map(item => pluginCard(item, 'native'));
  const extensions = (data.extensions || []).map(item => pluginCard(item, 'extension'));
  return el('div', {class: 'grid', style: 'gap:18px'},
    card('专属管理页', '表情包、QQ 空间、长期记忆和自主时间有独立页面，读取真实索引、动态、SQLite 记录与本机文件。',
      el('div', {class: 'row'},
        button('表情包', () => go('sticker'), {ghost: true, icon: 'image'}),
        button('QQ 空间', () => go('qzone'), {ghost: true, icon: 'qzone'}),
        button('长期记忆', () => go('memory'), {ghost: true, icon: 'memory'}),
        button('自主时间', () => go('autonomy'), {ghost: true, icon: 'clock'}))),
    card('内置包', 'AI 聊天、人设、欢迎、戳一戳与市场。完整的配置在 DSH 设置中编辑。', el('div', {class: 'pkg'}, builtins)),
    card('原生功能包', '语音、记忆、自主时间、表情包、空间等。可以在这里启用、调范围与常用设置。', el('div', {class: 'pkg'}, natives)),
    card('声明式扩展', '市场安装的规则包。只含 manifest 与固定规则，不执行脚本。', el('div', {class: 'pkg'}, extensions.length ? extensions : el('p', {class: 'muted'}, '还没有安装扩展。'))));
}

function logsView() {
  const logs = (state.data.logs || []).slice(-60).reverse();
  const audit = (state.data.framework.audit || []).slice(-20).reverse();
  return el('div', { class: 'grid', style: 'gap:18px' },
    el('section', { class: 'card' },
      el('header', {}, el('div', {}, el('h2', {}, '运行日志'), el('p', { class: 'desc' }, '最近的框架日志，倒序排列'))),
      logs.length ? el('div', { class: 'list' }, logs.map(row => el('div', { class: 'list-item' },
        el('div', { class: 'what' }, row.message, row.detail ? el('small', { class: 'mono' }, JSON.stringify(row.detail).slice(0, 180)) : null),
        el('div', { class: 'when' }, timeText(row.time) + ' · ' + row.level)))) : el('p', { class: 'muted' }, '暂无日志')),
    el('section', { class: 'card' },
      el('header', {}, el('div', {}, el('h2', {}, '权限审计'), el('p', { class: 'desc' }, '动作开始、完成、失败与拒绝'))),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, ['时间', '风险', '动作', '结果', '身份', '聊天', '原因'].map(head => el('th', {}, head)))),
          el('tbody', {},
            audit.map(row => el('tr', {},
              el('td', {}, timeText(row.time)),
              el('td', {}, row.riskLevel || '—'),
              el('td', { class: 'mono' }, row.capability),
              el('td', {}, ({ denied: '拒绝', started: '开始', completed: '完成', failed: '失败', unknown: '未知' }[row.outcome] || row.outcome)),
              el('td', {}, row.actor || '—'),
              el('td', {}, (row.kind === 'group' ? '群 ' : '私聊 ') + (row.peer || '')),
              el('td', {}, row.reason || '—')
            )))
          )
        )
      )
    );
}

function accountView() {
  let current = '', next = '', confirm = '';
  const form = el('div', { class: 'form-grid' },
    field('当前密码', textInput('', value => { current = value; }, { type: 'password', autocomplete: 'current-password' })),
    field('新密码', textInput('', value => { next = value; }, { type: 'password', autocomplete: 'new-password', placeholder: '至少 10 位' })),
    field('确认新密码', textInput('', value => { confirm = value; }, { type: 'password', autocomplete: 'new-password' })));
  const change = async () => {
    if (next !== confirm) { toast('两次输入的新密码不一致', true); return; }
    try {
      const json = await fetch('/api/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf || '' }, body: JSON.stringify({ current, password: next }) });
      const result = await json.json();
      if (!json.ok || result.ok === false) throw new Error(result.error || '修改失败');
      state.csrf = result.csrf;
      toast('密码已更新，其他会话已退出');
    } catch (error) { toast(error.message, true); }
  };
  return el('div', { class: 'grid', style: 'gap:18px' },
    card('修改管理密码', '修改后所有旧会话立即失效，需要在其他设备重新登录。密码使用 scrypt 哈希保存在 data/dsh-onebot-bridge/admin/admin.json。', form,
      savebar('新密码至少 10 位，不能是常见弱密码', change, '更新密码')),
    card('会话与访问', '管理站点只监听 127.0.0.1，使用 HttpOnly + SameSite=Strict Cookie；会话 12 小时绝对过期、30 分钟无操作过期。', el('div', { class: 'grid two' },
      stat('监听地址', '127.0.0.1:3097'),
      stat('传输', 'HTTP（本机）', '远程访问请自行加 HTTPS 反向代理'),
      stat('登录限速', '5 次 / 15 分钟'),
      stat('请求保护', 'CSRF + Origin + Host 校验'))));
}

/* ============================================================
   四个功能包的管理页
   ============================================================ */

function pluginLoading(key, title) {
  const status = pageStatus(key);
  if (status.loading) return stateBox('正在读取' + title, '数据来自本机插件与持久化文件，请稍候。');
  if (status.error) return stateBox(title + '读取失败', status.error, button('重试', () => loadPage(key, pageLoaders[key], {force: true}), {ghost: true}));
  return null;
}

function stickerDraft(overview) {
  const ui = uiFor('sticker');
  if (!ui.draft) {
    const config = overview.config || {};
    ui.draft = {
      autoSaveIncoming: config.autoSaveIncoming === true,
      autoSaveSent: config.autoSaveSent === true,
      meaningEnabled: config.meaningEnabled !== false,
      collectProbability: config.collectProbability ?? 100,
      collectCooldownSec: config.collectCooldownSec ?? 0,
      maxPerMessage: config.maxPerMessage ?? 3,
      maxStickers: config.maxStickers ?? 300,
      listLimit: config.listLimit ?? 8,
      excludeKeywords: (config.excludeKeywords || []).join('\n')
    };
  }
  return ui.draft;
}

function stickerView() {
  const ui = uiFor('sticker');
  if (!pageCache.has('sticker')) loadPage('sticker', pageLoaders.sticker);
  const loading = pluginLoading('sticker', '表情包');
  if (loading) return [pageHeader('表情包', '收藏、分类与使用本机表情库。', [], []), loading];
  const {overview, list} = pageCache.get('sticker').data;
  const draft = stickerDraft(overview);
  const items = list.items || [];
  const categories = overview.categories || [];

  const head = pageHeader('表情包', overview.description || '收藏群里的表情、可按情绪和标签检索。', [
    statePill(overview.enabled, overview.error),
    pill(`共 ${overview.stats.total} 张`, ''),
    overview.error ? pill('异常：' + overview.error, 'bad') : null
  ], [
    pluginEnableToggle(overview, 'sticker', 'qq-sticker'),
    button('返回插件', () => go('plugins'), {ghost: true}),
    button('刷新', () => loadPage('sticker', pageLoaders.sticker, {force: true}), {ghost: true, icon: 'refresh'})
  ]);

  const stats = el('div', {class: 'stat-grid'},
    stat('已收藏', String(overview.stats.total), `上限 ${overview.stats.max} 张`),
    stat('今日新增', String(overview.stats.today), '按本机时区统计'),
    stat('分类', String(categories.filter(row => row.emotion).length), categories.find(row => !row.emotion)?.count ? `另有 ${categories.find(row => !row.emotion).count} 张未分类` : '全部已分类'),
    stat('最近收集', overview.stats.lastCollectedAt ? dateText(overview.stats.lastCollectedAt) : '尚无记录', bytesText(overview.stats.bytes)));

  const search = textInput(ui.query || '', value => { ui.query = value; }, {placeholder: '名称 / 标签 / 用途'});
  const emotionSelect = select(ui.emotion || '', value => { ui.emotion = value; }, [['', '全部情绪'], ...categories.map(row => [row.emotion, `${row.label}（${row.count}）`])]);
  const sourceSelect = select(ui.source || '', value => { ui.source = value; }, [['', '全部来源'], ...(overview.sources || []).map(row => [row.source, `${row.label}（${row.count}）`])]);
  const sortSelect = select(ui.sort || 'recent', value => { ui.sort = value; }, [['recent', '最近使用'], ['oldest', '最早收藏'], ['name', '名称'], ['used', '使用次数']]);
  const fromInput = el('input', {type: 'date', value: ui.from || '', onchange: event => { ui.from = event.target.value; }});
  const toInput = el('input', {type: 'date', value: ui.to || '', onchange: event => { ui.to = event.target.value; }});
  const applyFilters = () => { ui.offset = 0; loadPage('sticker', pageLoaders.sticker, {force: true}); };
  const toolbar = el('div', {class: 'toolbar-card'},
    el('div', {class: 'filter-grid'},
      field('搜索', search),
      field('情绪', emotionSelect),
      field('来源', sourceSelect),
      field('排序', sortSelect),
      button('应用筛选', applyFilters, {primary: true})),
    el('div', {class: 'filter-grid dates'},
      field('开始日期', fromInput),
      field('结束日期', toInput)),
    el('div', {class: 'filter-chips'},
      el('button', {class: 'chip', type: 'button', 'aria-pressed': !ui.emotion, onclick: () => { ui.emotion = ''; applyFilters(); }}, '全部'),
      categories.map(row => el('button', {
        class: 'chip', type: 'button', 'aria-pressed': ui.emotion === row.emotion,
        onclick: () => { ui.emotion = row.emotion; applyFilters(); }
      }, `${row.label} ${row.count}`))));

  const cards = items.length ? el('div', {class: 'sticker-grid'}, items.map(row => {
    const img = el('img', {src: row.imageUrl, alt: row.name, loading: 'lazy', onerror: event => {
      const parent = event.target.parentElement;
      if (!parent) return;
      parent.replaceChildren(el('div', {class: 'broken'}, '图片无法读取，可能已被移动或删除'));
    }});
    return el('article', {class: 'sticker-card'},
      el('button', {class: 'thumb', type: 'button', 'aria-label': '查看 ' + row.name, onclick: () => openStickerDetail(row)}, img),
      el('div', {class: 'info'},
        el('strong', {title: row.name}, row.name),
        el('div', {class: 'sub'}, el('span', {}, row.emotionLabel), el('span', {}, row.sourceLabel)),
        el('div', {class: 'sub'}, el('span', {}, dateText(row.createdAt)), el('span', {}, row.usedAt ? '已使用' : '未使用')),
        el('div', {class: 'row'}, button('详情', () => openStickerDetail(row), {small: true, ghost: true}), button('删除', () => confirmDeleteSticker(row), {small: true, danger: true}))));
  })) : el('p', {class: 'empty'}, ui.query || ui.emotion || ui.source || ui.from || ui.to ? '没有符合筛选条件的表情。' : '还没有收集到表情。先在插件设置里开启自动收藏，或在 QQ 里使用收藏动作。');

  const listCard = card('表情库', '图片按内容哈希去重；列表只读取索引，点开详情才读取原图。', toolbar, cards,
    pager(list.total, list.offset, list.limit, offset => { ui.offset = offset; loadPage('sticker', pageLoaders.sticker, {force: true}); }));

  const settingsCard = card('收集与分类设置', '这里的概率、冷却、上限和排除词会直接参与自动收藏判定。',
    el('div', {class: 'form-grid'},
      el('div', {class: 'span-2'}, toggle('群里收到的图自动收进库', draft.autoSaveIncoming, value => { draft.autoSaveIncoming = value; }, '只作用于插件作用范围内的聊天')),
      el('div', {class: 'span-2'}, toggle('她发出去的图自动收进库', draft.autoSaveSent, value => { draft.autoSaveSent = value; }, '联网搜图并成功发送后收藏')),
      el('div', {class: 'span-2'}, toggle('允许联网查表情含义', draft.meaningEnabled, value => { draft.meaningEnabled = value; })),
      field('收集概率（%）', numberInput(draft.collectProbability, value => { draft.collectProbability = value; }, {min: 0, max: 100}), '每条图片消息/每次发图只抽一次；100 表示都收'),
      field('收集冷却（秒）', numberInput(draft.collectCooldownSec, value => { draft.collectCooldownSec = value; }, {min: 0, max: 3600}), '同一聊天两次自动收集的最小间隔'),
      field('单条消息最多收几张', numberInput(draft.maxPerMessage, value => { draft.maxPerMessage = value; }, {min: 1, max: 10}), '超出的图片不会读取'),
      field('表情库上限（张）', numberInput(draft.maxStickers, value => { draft.maxStickers = value; }, {min: 10, max: 1000})),
      field('检索返回数量', numberInput(draft.listLimit, value => { draft.listLimit = value; }, {min: 1, max: 20})),
      field('排除关键词', textArea(draft.excludeKeywords, value => { draft.excludeKeywords = value; }, {rows: 3, placeholder: '每行一个；消息包含这些词时不自动收藏'}), '只影响自动收集，不影响手动收藏')),
    el('p', {class: 'notice'}, '自动收藏是系统行为，不受工具授权影响；作用范围仍由插件的私聊/群范围决定。'),
    (() => {
      const save = () => pageAction('sticker', 'configureNativePackage', {
        id: 'qq-sticker', enabled: overview.enabled, scope: overview.scope,
        config: {
          autoSaveIncoming: draft.autoSaveIncoming,
          autoSaveSent: draft.autoSaveSent,
          meaningEnabled: draft.meaningEnabled,
          collectProbability: Number(draft.collectProbability),
          collectCooldownSec: Number(draft.collectCooldownSec),
          maxPerMessage: Number(draft.maxPerMessage),
          maxStickers: Number(draft.maxStickers),
          listLimit: Number(draft.listLimit),
          excludeKeywords: parseList(draft.excludeKeywords)
        }
      }, '表情包设置已保存').then(ok => { if (ok) ui.draft = null; });
      return savebar('保存后插件会重新加载设置；概率与冷却立即参与下一次判定', save);
    })());
  settingsCard.querySelector('.savebar')?.prepend(resetDraftButton('sticker'));

  return [head, stats, el('div', {class: 'split'}, listCard, settingsCard)];
}

function confirmDeleteSticker(row) {
  confirmDialog('删除表情', `将从本机表情库删除「${row.name}」。如果有其他记录引用同一文件，图片文件会保留。`, async () => {
    await pageAction('sticker', 'stickerAdmin', {op: 'remove', id: row.id}, '已删除');
  }, '删除');
}

function autonomyDraft(overview) {
  const ui = uiFor('autonomy');
  if (!ui.draft) {
    const config = overview.config || {};
    ui.draft = {
      enabled: config.enabled === true,
      activeHours: config.activeHours || '09:00-23:30',
      runLimitMode: config.runLimitMode || 'recommended',
      maxRunsPerDay: config.maxRunsPerDay ?? 8,
      autoRecordActivities: config.autoRecordActivities !== false,
      diaryRetentionMode: config.diaryRetentionMode || 'none',
      diaryRetentionCount: config.diaryRetentionCount ?? 1000,
      diaryRetentionDays: config.diaryRetentionDays ?? 365,
      activityRetentionMode: config.activityRetentionMode || 'none',
      activityRetentionCount: config.activityRetentionCount ?? 5000,
      activityRetentionDays: config.activityRetentionDays ?? 365,
      timelinePageSize: config.timelinePageSize ?? 50,
      diaryEnabled: config.diaryEnabled !== false,
      diaryHour: config.diaryHour ?? 22,
      learnEnabled: config.learnEnabled !== false,
      learnEveryHours: config.learnEveryHours ?? 8,
      slangEnabled: config.slangEnabled !== false,
      slangEveryHours: config.slangEveryHours ?? 2,
      qzonePostEnabled: config.qzonePostEnabled === true,
      browseEnabled: config.browseEnabled === true,
      browseTargets: (config.browseTargets || []).join('\n'),
      browseEveryHours: config.browseEveryHours ?? 4,
      commentEnabled: config.commentEnabled === true,
      secretAutoDecide: config.secretAutoDecide !== false,
      proactiveEnabled: config.proactiveEnabled === true,
      proactiveInactiveMinutes: config.proactiveInactiveMinutes ?? 240,
      proactiveDailyLimit: config.proactiveDailyLimit ?? 2,
      proactiveMinIntervalMinutes: config.proactiveMinIntervalMinutes ?? 180,
      proactiveQuietHours: config.proactiveQuietHours || '23:00-08:00',
      proactiveAllowCasual: config.proactiveAllowCasual === true,
      proactiveAllowTask: config.proactiveAllowTask === true,
      proactiveAllowLearning: config.proactiveAllowLearning === true,
      proactiveMaxChars: config.proactiveMaxChars ?? 240,
      taskRunnerEnabled: config.taskRunnerEnabled === true
    };
  }
  return ui.draft;
}

function autonomyView() {
  const ui = uiFor('autonomy');
  ui.tab ||= 'activities';
  if (!pageCache.has('autonomy')) loadPage('autonomy', pageLoaders.autonomy);
  const loading = pluginLoading('autonomy', '自主时间');
  if (loading) return [pageHeader('自主时间', '她自己的时间、日记与秘密。', [], []), loading];
  const {overview, diaries, activities, time} = pageCache.get('autonomy').data;
  const draft = autonomyDraft(overview);
  const head = pageHeader('自主时间', overview.description || '活动、日记和时间记录均保存在本机，秘密空间独立加密。', [
    statePill(overview.enabled, overview.error),
    pill(`今日 ${overview.today.runs}/${overview.today.maxRuns} 次`),
    overview.next ? pill('当前可安排：' + overview.next.label, '') : pill('当前没有到期的自主活动', '')
  ], [
    pluginEnableToggle(overview, 'autonomy', 'qq-autonomy'),
    button('返回插件', () => go('plugins'), {ghost: true}),
    button('刷新', () => { pageCache.delete('autonomy'); loadPage('autonomy', pageLoaders.autonomy, {force: true}); }, {ghost: true, icon: 'refresh'})
  ]);
  const tabsRow = tabs([
    ['activities', '日常活动'], ['diary', '日记'], ['time', '时间记录'], ['settings', '设置'], ['secret', '秘密空间']
  ], ui.tab, tab => {
    ui.tab = tab;
    try { history.replaceState(null, '', '#autonomy/' + tab); } catch { /* 忽略 */ }
    if (tab === 'secret') loadSecretStatus();
    render();
  });
  const stats = el('div', {class: 'stat-grid'},
    stat('今日自主活动', String(overview.today.runs), overview.config.runLimitMode === 'unlimited' ? '不设固定业务上限' : `上限 ${overview.today.maxRuns} 次`),
    stat('日记', String(diaries.total), '自动与手动分开标记'),
    stat('活动记录', String(activities.total), '自动活动与手动补记'),
    stat('最近活动', overview.lastActivity ? dateText(overview.lastActivity.start) : '尚无', overview.lastActivity?.title || '等待第一次自主活动'));
  let body;
  if (ui.tab === 'diary') body = autonomyDiaryView(diaries, ui);
  else if (ui.tab === 'time') body = autonomyTimeView(time);
  else if (ui.tab === 'settings') body = [autonomySettingsView(overview, draft), proactiveStatusView(state.data.proactive), taskStatusView(state.data.tasks)];
  else if (ui.tab === 'secret') body = autonomySecretView(ui);
  else body = autonomyActivitiesView(activities, ui);
  return [head, stats, tabsRow, body];
}

function taskStatusView(tasks) {
  if (!tasks) return card('自主任务状态', '任务存储尚未在当前宿主进程加载。', el('p', {class: 'empty'}, '重启宿主后这里会显示真实任务统计。'));
  const latest = tasks.latest ? `${tasks.latest.goal} · ${tasks.latest.status}` : '尚无任务';
  return card('自主任务状态', '任务状态来自持久化 TaskStore；创建计划不等于执行完成。',
    el('div', {class: 'stat-grid'},
      stat('任务总数', String(tasks.total || 0), '真实持久化记录'),
      stat('活动任务', String(tasks.active || 0), '未完成或未取消'),
      stat('等待授权', String(tasks.waitingApproval || 0), '需要明确授权'),
      stat('失败任务', String(tasks.failed || 0), '可在任务详情重试')),
    el('p', {class: 'section-note'}, '最近任务：' + latest + '。任务动作默认未启用，需在权限页启用 qq.task.* 后才能由模型调用。'));
}

function proactiveStatusView(status) {
  if (!status) return card('主动联系状态', '主动联系服务尚未在当前宿主进程加载。', el('p', {class: 'empty'}, '重启宿主后这里会显示真实调度状态。'));
  const rows = el('div', {class: 'kv'},
    el('dt', {}, '开关'), el('dd', {}, status.enabled ? '已启用' : '未启用'),
    el('dt', {}, '今日已尝试'), el('dd', {}, `${status.today || 0}/${status.dailyLimit || 0}`),
    el('dt', {}, '不活跃阈值'), el('dd', {}, `${status.inactiveMinutes || 0} 分钟`),
    el('dt', {}, '最短间隔'), el('dd', {}, `${status.minIntervalMinutes || 0} 分钟`),
    el('dt', {}, '安静时段'), el('dd', {}, status.quietHours || '—'),
    el('dt', {}, '最近尝试'), el('dd', {}, status.lastAttemptAt ? dateText(status.lastAttemptAt) : '尚无'),
    el('dt', {}, '最近发送'), el('dd', {}, status.lastSentAt ? dateText(status.lastSentAt) : '尚无'),
    el('dt', {}, '最近结果'), el('dd', {}, status.lastOutcome || '尚无'));
  const history = (status.recent || []).length
    ? el('div', {class: 'list'}, status.recent.slice(0, 8).map(row => el('div', {class: 'list-item'},
      el('div', {class: 'what'}, el('strong', {}, row.outcome || 'unknown'), el('p', {class: 'muted'}, `${row.reason || ''} · ${row.chars || 0} 字${row.error ? ' · ' + row.error : ''}`)),
      el('div', {class: 'when'}, dateText(row.at)))))
    : el('p', {class: 'empty'}, '还没有主动联系记录。');
  return card('主动联系状态', '这里只显示真实调度记录；没有发送就不会显示成功。',
    rows, el('p', {class: 'section-note'}, '内容正文不写入审计历史，只保留结果、原因和字数。'), history);
}

function autonomyActivitiesView(activities, ui) {
  const all = activities.items || [];
  const month = ui.calendarMonth || new Date().toISOString().slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const days = new Date(year, monthNumber, 0).getDate();
  const start = first.getDay();
  const byDay = new Map();
  for (const row of all) {
    const key = dayText(row.start);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }
  const todayKey = dayText(new Date().toISOString());
  const cells = [];
  for (let i = 0; i < start; i += 1) cells.push(el('div', {class: 'day empty'}));
  for (let day = 1; day <= days; day += 1) {
    const key = `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const rows = byDay.get(key) || [];
    cells.push(el('button', {
      class: 'day' + (key === todayKey ? ' today' : '') + (rows.length ? ' has' : ''),
      type: 'button', onclick: () => { ui.activityDate = ui.activityDate === key ? '' : key; render(); }
    }, el('b', {}, String(day)), rows.length ? el('small', {}, `${rows.length} 项 · ${rows[0].title}`) : null));
  }
  const calendar = el('div', {},
    el('div', {class: 'row', style: 'justify-content:space-between;margin-bottom:8px'},
      button('上个月', () => { const d = new Date(year, monthNumber - 2, 1); ui.calendarMonth = d.toISOString().slice(0, 7); render(); }, {ghost: true, small: true}),
      el('strong', {}, `${year} 年 ${monthNumber} 月`),
      button('下个月', () => { const d = new Date(year, monthNumber, 1); ui.calendarMonth = d.toISOString().slice(0, 7); render(); }, {ghost: true, small: true})),
    el('div', {class: 'calendar'}, ['日', '一', '二', '三', '四', '五', '六'].map(day => el('div', {class: 'dow'}, day)), cells));
  const filtered = ui.activityDate ? all.filter(row => dayText(row.start) === ui.activityDate) : all;
  const timeline = filtered.length ? el('div', {class: 'timeline-list'}, filtered.map(row => el('div', {class: 'activity'},
    el('div', {class: 'when'}, dateText(row.start), el('br'), `${row.minutes} 分钟`),
    el('div', {class: 'what'}, el('strong', {}, row.title), row.description ? el('p', {}, row.description) : null,
      el('div', {class: 'row'}, pill(row.categoryLabel, ''), pill(row.source === 'autonomy' ? '自动记录' : '手动创建', row.source === 'autonomy' ? '' : 'ok'))),
    el('div', {class: 'side'}, button('编辑', () => openActivityEditor(row), {small: true, ghost: true}), row.source === 'manual' ? button('删除', () => confirmDeleteActivity(row), {small: true, danger: true}) : null)))) :
    el('p', {class: 'empty'}, ui.activityDate ? '这一天没有活动记录。' : '还没有活动记录。可以手动补记，或启用自主时间后让她自动写入。');
  return el('div', {class: 'grid two'},
    card('日历', '点击日期筛选下方时间线；自动活动来自真实运行日志。', calendar),
    card('时间线', ui.activityDate ? `筛选：${ui.activityDate}` : '全部活动，按开始时间倒序。',
      el('div', {class: 'row'}, button('新建活动', openActivityCreate, {primary: true, small: true, icon: 'plus'}), ui.activityDate ? button('清除日期', () => { ui.activityDate = ''; render(); }, {ghost: true, small: true}) : null),
      timeline,
      activities.hasMore ? el('div', {class: 'row'}, button('加载更多活动', loadMoreAutonomyActivities, {ghost: true, small: true})) : null),
    el('div', {class: 'span-2'}, el('p', {class: 'notice'}, '自动记录只在“自动活动写入时间线”开启时产生；关闭后不影响自主活动本身。')));
}

async function loadMoreAutonomyActivities() {
  const data = pageCache.get('autonomy')?.data;
  if (!data?.activities) return;
  const pageSize = Math.max(20, Math.min(200, Number(data.overview.config?.timelinePageSize) || 50));
  try {
    const next = await secureApi('autonomyAdmin', {op: 'activityList', query: {offset: data.activities.items.length, limit: pageSize}});
    data.activities.items.push(...(next.items || []));
    data.activities.total = next.total;
    data.activities.hasMore = next.hasMore;
    render();
  } catch (error) {
    toast(formatError(error), true);
  }
}

function openActivityCreate() {
  openActivityEditor(null);
}

function openActivityEditor(row) {
  const fields = row ? {
    title: row.title, description: row.description || '', start: localInput(row.start), end: localInput(row.end),
    category: row.category, diaryId: row.diaryId || ''
  } : {
    title: '', description: '', start: localInput(new Date().toISOString()), end: localInput(new Date(Date.now() + 30 * 60000).toISOString()),
    category: 'other', diaryId: ''
  };
  const isEdit = Boolean(row);
  const body = el('div', {class: 'form-grid'},
    el('div', {class: 'span-2'}, field('标题', textInput(fields.title, value => { fields.title = value; }))),
    field('开始时间', el('input', {type: 'datetime-local', value: fields.start, onchange: event => { fields.start = event.target.value; }})),
    field('结束时间', el('input', {type: 'datetime-local', value: fields.end, onchange: event => { fields.end = event.target.value; }})),
    field('类别', select(fields.category, value => { fields.category = value; }, [['other', '其他'], ['work', '工作'], ['rest', '休息'], ['life', '生活'], ['diary', '写日记'], ['learn', '学习'], ['slang', '学黑话'], ['qzone', '空间'], ['browse', '翻空间']])),
    el('div', {class: 'span-2'}, field('描述', textArea(fields.description, value => { fields.description = value; }, {rows: 3, maxLength: 1000}))));
  openModal(isEdit ? '编辑活动' : '新建活动', '手动补记会标记为“手动创建”', body, [
    button('取消', closeModal, {ghost: true}),
    button('保存', () => {
      closeModal();
      const payload = {title: fields.title, description: fields.description, start: fields.start, end: fields.end, category: fields.category, diaryId: fields.diaryId};
      pageAction('autonomy', 'autonomyAdmin', isEdit ? {op: 'activityUpdate', id: row.id, ...payload} : {op: 'activityCreate', ...payload}, isEdit ? '活动已更新' : '活动已创建');
    }, {primary: true})
  ]);
}

function confirmDeleteActivity(row) {
  confirmDialog('删除活动', `将删除手动记录「${row.title}」；自动活动不会被删除。`, () => {
    pageAction('autonomy', 'autonomyAdmin', {op: 'activityDelete', id: row.id}, '活动已删除');
  }, '删除');
}

function autonomyDiaryView(diaries, ui) {
  const rows = diaries.items || [];
  const search = textInput(ui.diaryQuery || '', value => { ui.diaryQuery = value; }, {placeholder: '搜索标题、正文或心情'});
  const from = el('input', {type: 'date', value: ui.diaryFrom || '', onchange: event => { ui.diaryFrom = event.target.value; }});
  const to = el('input', {type: 'date', value: ui.diaryTo || '', onchange: event => { ui.diaryTo = event.target.value; }});
  const apply = () => { ui.diaryOffset = 0; reloadAutonomyDiaries(); };
  const toolbar = el('div', {class: 'filter-grid'},
    field('搜索', search), field('开始日期', from), field('结束日期', to), button('筛选', apply, {primary: true}));
  const list = rows.length ? el('div', {class: 'list'}, rows.map(row => el('div', {class: 'list-item'},
    el('div', {class: 'what'}, el('button', {class: 'link-btn', type: 'button', onclick: () => openDiaryDetail(row.id)}, row.title || '未命名日记'),
      el('div', {class: 'row'}, pill(row.sourceLabel, row.source === 'manual' ? 'ok' : ''), el('span', {class: 'faint'}, dateText(row.at)),
        row.mood ? el('span', {class: 'tag'}, row.mood) : null),
      el('small', {class: 'muted'}, row.excerpt)),
    el('div', {class: 'when'}, `${row.words} 字`, el('div', {class: 'row'}, button('查看', () => openDiaryDetail(row.id), {small: true, ghost: true}), button('编辑', () => editDiary(row.id), {small: true, ghost: true})))))) : el('p', {class: 'empty'}, ui.diaryQuery || ui.diaryFrom || ui.diaryTo ? '没有符合条件的日记。' : '还没有日记。她可以在自主时间写，也可以手动新建。');
  return card('日记', '正文保存在本机 diary.jsonl；自动生成的日记与手动创建会分别标记。', toolbar, list,
    pager(diaries.total, diaries.offset, diaries.limit, offset => { ui.diaryOffset = offset; reloadAutonomyDiaries(); }),
    el('div', {class: 'row'}, button('新建日记', openDiaryCreate, {primary: true, icon: 'plus'})));
}

function reloadAutonomyDiaries() {
  pageCache.delete('autonomy');
  loadPage('autonomy', pageLoaders.autonomy, {force: true});
}

async function editDiary(id) {
  try {
    const entry = await secureApi('autonomyAdmin', {op: 'diaryGet', id});
    openDiaryEditor(entry);
  } catch (error) {
    toast(formatError(error), true);
  }
}

async function openDiaryDetail(id) {
  try {
    const entry = await secureApi('autonomyAdmin', {op: 'diaryGet', id});
    const body = el('div', {class: 'stack'},
      el('div', {class: 'row'}, pill(entry.sourceLabel, entry.source === 'manual' ? 'ok' : ''), el('span', {class: 'faint'}, dateText(entry.at)), entry.mood ? pill(entry.mood, '') : null),
      el('h3', {}, entry.title || '未命名日记'),
      el('p', {style: 'white-space:pre-wrap;line-height:1.9'}, entry.text));
    openModal('日记详情', '正文只在本机读取', body, [
      button('关闭', closeModal, {ghost: true}),
      button('删除', () => { closeModal(); confirmDeleteDiary(entry); }, {danger: true}),
      button('编辑', () => { closeModal(); openDiaryEditor(entry); }, {primary: true})
    ]);
  } catch (error) { toast(formatError(error), true); }
}

function openDiaryCreate() {
  openDiaryEditor(null);
}

function openDiaryEditor(entry) {
  const fields = entry ? {title: entry.title || '', mood: entry.mood || '', text: entry.text} : {title: '', mood: '', text: ''};
  const ui = uiFor('autonomy');
  const body = el('div', {class: 'form-grid'},
    field('标题（可选）', textInput(fields.title, value => { fields.title = value; ui.dirty = true; })),
    field('心情（可选）', textInput(fields.mood, value => { fields.mood = value; ui.dirty = true; })),
    el('div', {class: 'span-2'}, field('正文', textArea(fields.text, value => { fields.text = value; ui.dirty = true; }, {rows: 12, maxLength: 2000, placeholder: '写点什么。最多 2000 字。'}))));
  const save = () => {
    if (!fields.text.trim()) { toast('日记正文不能为空', true); return; }
    closeModal();
    ui.dirty = false;
    pageAction('autonomy', 'autonomyAdmin', entry ? {op: 'diaryUpdate', id: entry.id, title: fields.title, mood: fields.mood, text: fields.text} : {op: 'diaryCreate', title: fields.title, mood: fields.mood, text: fields.text}, entry ? '日记已更新' : '日记已创建');
  };
  openModal(entry ? '编辑日记' : '新建日记', '未保存内容会在离开页面前提示', body, [
    button('取消', () => { ui.dirty = false; closeModal(); }, {ghost: true}),
    button('保存', save, {primary: true})
  ]);
}

function confirmDeleteDiary(entry) {
  confirmDialog('删除日记', `将永久删除「${entry.title || '未命名日记'}」及其正文。此操作不可恢复。`, () => {
    pageAction('autonomy', 'autonomyAdmin', {op: 'diaryDelete', id: entry.id}, '日记已删除');
  }, '删除');
}

function autonomyTimeView(time) {
  const max = Math.max(1, ...(time.byCategory || []).map(row => row.minutes));
  const bars = (time.byCategory || []).length ? el('div', {class: 'bars'}, time.byCategory.map(row => el('div', {class: 'bar'},
    el('div', {class: 'bl'}, el('span', {}, row.label), el('b', {}, `${row.minutes} 分钟`)),
    el('div', {class: 'track'}, el('span', {class: 'fill', style: `--p:${Math.round(row.minutes / max * 100)}%`}))))) : el('p', {class: 'empty'}, '这个时间段还没有活动记录。');
  return el('div', {class: 'grid two'},
    card('时间汇总', `${dayText(time.from)} 至 ${dayText(time.to)}，来自真实活动记录。`, bars,
      el('p', {class: 'section-note'}, `合计 ${time.totalMinutes} 分钟。`)),
    card('按天统计', '用于查看时间投入，不替代日历。', (time.byDay || []).length ? el('div', {class: 'table-wrap'}, el('table', {class: 'table'},
      el('thead', {}, el('tr', {}, ['日期', '分钟', '小时'].map(head => el('th', {}, head)))),
      el('tbody', {}, time.byDay.map(row => el('tr', {}, el('td', {}, row.day), el('td', {}, String(row.minutes)), el('td', {}, (row.minutes / 60).toFixed(1))))))) : el('p', {class: 'empty'}, '暂无数据')));
}

function autonomySettingsView(overview, draft) {
  const save = () => pageAction('autonomy', 'configureNativePackage', {
    id: 'qq-autonomy', enabled: overview.enabled, scope: overview.scope,
    config: {
      enabled: draft.enabled,
      activeHours: draft.activeHours,
      runLimitMode: draft.runLimitMode,
      maxRunsPerDay: Number(draft.maxRunsPerDay),
      autoRecordActivities: draft.autoRecordActivities,
      diaryRetentionMode: draft.diaryRetentionMode,
      diaryRetentionCount: Number(draft.diaryRetentionCount),
      diaryRetentionDays: Number(draft.diaryRetentionDays),
      activityRetentionMode: draft.activityRetentionMode,
      activityRetentionCount: Number(draft.activityRetentionCount),
      activityRetentionDays: Number(draft.activityRetentionDays),
      timelinePageSize: Number(draft.timelinePageSize),
      diaryEnabled: draft.diaryEnabled,
      diaryHour: Number(draft.diaryHour),
      learnEnabled: draft.learnEnabled,
      learnEveryHours: Number(draft.learnEveryHours),
      slangEnabled: draft.slangEnabled,
      slangEveryHours: Number(draft.slangEveryHours),
      qzonePostEnabled: draft.qzonePostEnabled,
      browseEnabled: draft.browseEnabled,
      browseTargets: parseList(draft.browseTargets),
      browseEveryHours: Number(draft.browseEveryHours),
      commentEnabled: draft.commentEnabled,
      secretAutoDecide: draft.secretAutoDecide,
      proactiveEnabled: draft.proactiveEnabled,
      proactiveInactiveMinutes: Number(draft.proactiveInactiveMinutes),
      proactiveDailyLimit: Number(draft.proactiveDailyLimit),
      proactiveMinIntervalMinutes: Number(draft.proactiveMinIntervalMinutes),
      proactiveQuietHours: draft.proactiveQuietHours,
      proactiveAllowCasual: draft.proactiveAllowCasual,
      proactiveAllowTask: draft.proactiveAllowTask,
      proactiveAllowLearning: draft.proactiveAllowLearning,
      proactiveMaxChars: Number(draft.proactiveMaxChars),
      taskRunnerEnabled: draft.taskRunnerEnabled
    }
  }, '自主时间设置已保存');
  const settingsBar = savebar('保存后调度器会读取新配置；修改不会伪造活动记录', save);
  settingsBar.prepend(resetDraftButton('autonomy'));
  const runLimitControl = draft.runLimitMode === 'unlimited'
    ? el('p', {class: 'notice'}, '不设固定业务次数上限；调度仍每分钟最多一次，并受活动时段与外部接口限制。')
    : draft.runLimitMode === 'recommended'
      ? el('p', {class: 'section-note'}, '推荐上限：每天 8 次。切换“自定义”后才使用下面的数值。')
      : field('每天最多活动次数', numberInput(draft.maxRunsPerDay, value => { draft.maxRunsPerDay = value; }, {min: 1, max: 1440}));
  const diaryRetentionControl = draft.diaryRetentionMode === 'count'
    ? field('保留日记篇数', numberInput(draft.diaryRetentionCount, value => { draft.diaryRetentionCount = value; }, {min: 1, max: 100000}))
    : draft.diaryRetentionMode === 'days'
      ? field('日记保留天数', numberInput(draft.diaryRetentionDays, value => { draft.diaryRetentionDays = value; }, {min: 1, max: 3650}))
      : el('p', {class: 'section-note'}, '日记不主动按数量删除。');
  const activityRetentionControl = draft.activityRetentionMode === 'count'
    ? field('保留活动条数', numberInput(draft.activityRetentionCount, value => { draft.activityRetentionCount = value; }, {min: 1, max: 100000}))
    : draft.activityRetentionMode === 'days'
      ? field('活动保留天数', numberInput(draft.activityRetentionDays, value => { draft.activityRetentionDays = value; }, {min: 1, max: 3650}))
      : el('p', {class: 'section-note'}, '活动记录不主动按数量删除。');
  return card('自主时间设置', '所有活动开关都会影响真实调度；发空间和评论默认关闭。',
    el('div', {class: 'form-grid'},
      el('div', {class: 'span-2'}, toggle('启用自主时间', draft.enabled, value => { draft.enabled = value; }, '关闭后不安排任何自主活动，也不注入时间上下文')),
      field('活动时段', textInput(draft.activeHours, value => { draft.activeHours = value; }, {placeholder: '09:00-23:30'})),
      field('次数策略', select(draft.runLimitMode, value => { draft.runLimitMode = value; render(); }, [['recommended', '系统推荐'], ['custom', '自定义'], ['unlimited', '不限制业务次数']])),
      runLimitControl,
      el('div', {class: 'span-2'}, toggle('自动活动写入时间线', draft.autoRecordActivities, value => { draft.autoRecordActivities = value; })),
      el('div', {class: 'span-2'}, toggle('自己写日记', draft.diaryEnabled, value => { draft.diaryEnabled = value; })),
      field('几点之后写日记', numberInput(draft.diaryHour, value => { draft.diaryHour = value; }, {min: 0, max: 23})),
      el('div', {class: 'span-2'}, toggle('自己上网学习', draft.learnEnabled, value => { draft.learnEnabled = value; })),
      field('学习间隔（小时）', numberInput(draft.learnEveryHours, value => { draft.learnEveryHours = value; }, {min: 1, max: 48})),
      el('div', {class: 'span-2'}, toggle('学群里的黑话', draft.slangEnabled, value => { draft.slangEnabled = value; })),
      field('黑话间隔（小时）', numberInput(draft.slangEveryHours, value => { draft.slangEveryHours = value; }, {min: 1, max: 24})),
      el('div', {class: 'span-2'}, toggle('自己发空间说说', draft.qzonePostEnabled, value => { draft.qzonePostEnabled = value; }, '默认关闭；仍受 QQ 空间包的每日上限和可见范围约束')),
      el('div', {class: 'span-2'}, toggle('自己翻空间', draft.browseEnabled, value => { draft.browseEnabled = value; })),
      el('div', {class: 'span-2'}, field('可浏览的 QQ', textArea(draft.browseTargets, value => { draft.browseTargets = value; }, {rows: 3, placeholder: '每行一个；留空则不翻空间'}))),
      field('翻空间间隔（小时）', numberInput(draft.browseEveryHours, value => { draft.browseEveryHours = value; }, {min: 1, max: 48})),
      el('div', {class: 'span-2'}, toggle('看到有趣的就评论', draft.commentEnabled, value => { draft.commentEnabled = value; }, '每天最多一条，且必须来自本次实际浏览到的说说')),
      el('div', {class: 'span-2'}, toggle('让她自主决定秘密空间', draft.secretAutoDecide, value => { draft.secretAutoDecide = value; }, '由现有受限 Agent 决定是否创建、密码气质和是否分享；用户不设置密码')),
      el('div', {class: 'span-2'}, toggle('允许主动联系主人', draft.proactiveEnabled, value => { draft.proactiveEnabled = value; }, '默认关闭；开启后仍需不活跃、安静时段、每日上限和最短间隔；无真实内容时不发送')),
      field('未互动多少分钟后考虑（分钟）', numberInput(draft.proactiveInactiveMinutes, value => { draft.proactiveInactiveMinutes = value; }, {min: 30, max: 10080})),
      field('每日最多主动消息', numberInput(draft.proactiveDailyLimit, value => { draft.proactiveDailyLimit = value; }, {min: 0, max: 20})),
      field('最短间隔（分钟）', numberInput(draft.proactiveMinIntervalMinutes, value => { draft.proactiveMinIntervalMinutes = value; }, {min: 30, max: 1440})),
      field('安静时段', textInput(draft.proactiveQuietHours, value => { draft.proactiveQuietHours = value; }, {placeholder: '23:00-08:00'})),
      field('主动消息最多字数', numberInput(draft.proactiveMaxChars, value => { draft.proactiveMaxChars = value; }, {min: 40, max: 500})),
      el('div', {class: 'span-2'}, toggle('允许普通闲聊式主动联系', draft.proactiveAllowCasual, value => { draft.proactiveAllowCasual = value; }, '关闭时只跟进最近对话里真实存在的未完成事项')),
      el('div', {class: 'span-2'}, toggle('允许任务完成通知', draft.proactiveAllowTask, value => { draft.proactiveAllowTask = value; }, '仅任务进入 done 后，且仍受频率/安静时段限制')),
      el('div', {class: 'span-2'}, toggle('允许学习进展通知', draft.proactiveAllowLearning, value => { draft.proactiveAllowLearning = value; }, '仅真实学习结果后，且仍受频率/安静时段限制')),
      el('div', {class: 'span-2'}, toggle('允许自动推进持久化任务', draft.taskRunnerEnabled, value => { draft.taskRunnerEnabled = value; }, '默认关闭；只推进已明确进入 planning/executing 的任务，每步必须有工具结果；不发 QQ 消息'))),
    el('div', {class: 'card'}, el('header', {}, el('h2', {}, '历史保留与分页'), el('p', {class: 'desc'}, '“不主动删除”不代表无限加载；列表仍分页读取。')),
      el('div', {class: 'form-grid'},
        field('日记保留策略', select(draft.diaryRetentionMode, value => { draft.diaryRetentionMode = value; render(); }, [['none', '不主动按数量删除'], ['count', '按篇数'], ['days', '按天数']])),
        diaryRetentionControl,
        field('活动保留策略', select(draft.activityRetentionMode, value => { draft.activityRetentionMode = value; render(); }, [['none', '不主动按数量删除'], ['count', '按条数'], ['days', '按天数']])),
        activityRetentionControl,
        field('时间线每页条数', numberInput(draft.timelinePageSize, value => { draft.timelinePageSize = value; }, {min: 20, max: 200})))),
    settingsBar);
}

function autonomySecretView(ui) {
  if (ui.secretError) return stateBox('秘密空间不可用', ui.secretError, button('重试', loadSecretStatus, {ghost: true}));
  const status = ui.secretStatus;
  if (!status) { loadSecretStatus(); return stateBox('正在读取秘密空间', '只读取初始化状态，不解密正文。'); }
  if (status.corrupt) return stateBox('秘密空间文件损坏', '为避免覆盖可能还能恢复的密文，系统不会自动初始化。请先从备份恢复文件，或在确认后清空。', button('清空并重新设置', openSecretReset, {danger: true}));
  if (!status.configured) return secretDecisionView(status);
  if (status.mode === 'character') {
    if (status.character?.shareWithOwner !== true) return secretPrivateView(status);
    if (!status.unlocked) return secretShareView(status);
    return secretUnlockedView(status, ui.secretItems || []);
  }
  // 旧版用户设置密码的空间：保留原密码解锁，避免已有数据失联。
  if (!status.unlocked) return secretLegacyUnlockView(status);
  return secretUnlockedView(status, ui.secretItems || []);
}

function secretDecisionView(status) {
  const decision = status.decision || {};
  const unavailable = status.deviceKeyAvailable === false;
  const declined = decision.status === 'declined';
  const failed = decision.status === 'error';
  const title = unavailable ? '设备凭据不可用' : declined ? '她暂时没有创建秘密空间' : failed ? '她的决定没有完成' : '等她决定';
  const message = unavailable
    ? '角色密码需要宿主设备凭据封装。当前凭据不可用，系统不会生成用户密码来替代。'
    : declined
      ? `她选择暂时不创建。${decision.reason ? '理由：' + decision.reason : ''}`
      : failed
        ? `上次决策失败：${decision.lastError || '模型没有返回可解析结果'}`
        : '秘密空间不要求你设置密码。首次启用后，她会在自己的受限会话里决定是否创建、选择密码气质，以及是否与你分享。程序负责生成高强度密码并用设备凭据封装。';
  const action = unavailable ? null : button(declined || failed ? '再次询问她' : '请她决定', () => {
    secretAction('decide', {force: true}, '已请求她决定').then(ok => { if (ok) loadSecretStatus(); });
  }, {primary: true});
  return el('div', {class: 'secret-lock'},
    el('div', {class: 'lock-mark'}, 'HER'),
    el('h3', {}, title),
    el('p', {}, message),
    el('div', {class: 'secret-form'}, action,
      el('p', {class: 'faint'}, '决策来自现有受限 Agent，不是前端随机数；不创建时会保持未初始化。')));
}

function secretPrivateView(status) {
  return el('div', {class: 'secret-lock'},
    el('div', {class: 'lock-mark'}, 'HER'),
    el('h3', {}, '她设置了密码，并选择保密'),
    el('p', {}, `这里保存 ${status.entries} 条秘密。密码由她自主设置，普通界面不会显示，也没有用户输入密码的入口。`),
    status.character?.reason ? el('p', {class: 'section-note'}, '她的理由：' + status.character.reason) : null,
    el('p', {class: 'faint'}, '如果她以后选择分享，这里会出现“请求查看”入口；未分享时不会返回标题或正文。'));
}

function secretShareView(status) {
  return el('div', {class: 'secret-lock'},
    el('div', {class: 'lock-mark'}, 'OPEN'),
    el('h3', {}, '她愿意与你分享这个空间'),
    el('p', {}, `这里保存 ${status.entries} 条秘密。密码仍不会显示；只有你主动请求，才会在本次管理会话中解锁。`),
    el('div', {class: 'secret-form'},
      button('请求查看', () => secretAction('request-share', {}, '她已允许本次查看').then(ok => { if (ok) loadSecretStatus(); }), {primary: true}),
      el('p', {class: 'faint'}, '15 分钟无操作、退出登录或刷新页面后会重新锁定。')));
}

function secretLegacyUnlockView(status) {
  let password = '';
  return el('div', {class: 'secret-lock'},
    el('div', {class: 'lock-mark'}, 'OLD'),
    el('h3', {}, '旧版秘密空间已锁定'),
    el('p', {}, `这是旧版“用户设置密码”的空间，保存了 ${status.entries} 条秘密。新空间不再要求你设置密码；这里保留原密码解锁，以免旧数据失联。`),
    el('div', {class: 'secret-form'},
      field('原密码', textInput('', value => { password = value; }, {type: 'password', autocomplete: 'current-password'})),
      button('解锁旧版空间', () => secretAction('unlock', {password}, '已解锁').then(ok => { if (ok) loadSecretStatus(); }), {primary: true})),
    status.corrupt ? el('p', {class: 'notice danger'}, '秘密空间文件损坏，正文不可读取；请从备份恢复或确认后重置。') : null);
}

function secretUnlockedView(status, items) {
  return el('div', {class: 'grid', style: 'gap:14px'},
    el('div', {class: 'row', style: 'justify-content:space-between'},
      el('div', {class: 'row'}, pill('已解锁', 'ok'),
        el('span', {class: 'faint'}, `${status.entries} 条秘密 · ${Math.round(status.autoLockSeconds / 60)} 分钟无操作自动锁定`),
        status.mode === 'character' ? pill('角色密码', '') : pill('旧版密码', 'warn')),
      el('div', {class: 'row'}, button('新建秘密', openSecretCreate, {primary: true, icon: 'plus'}),
        status.legacy ? button('修改密码', openSecretPassword, {ghost: true}) : null,
        button('立即锁定', () => secretAction('lock', {}, '已锁定').then(() => loadSecretStatus()), {ghost: true}))),
    items.length ? el('div', {class: 'secret-list'}, items.map(item => el('div', {class: 'secret-item'},
      el('div', {}, el('strong', {}, item.title), el('small', {}, `创建 ${dateText(item.createdAt)} · 修改 ${dateText(item.updatedAt)}`)),
      el('div', {class: 'row'}, button('查看', () => openSecretDetail(item.id), {small: true, ghost: true}), button('删除', () => confirmDeleteSecret(item), {small: true, danger: true}))))) :
      el('p', {class: 'empty'}, '秘密空间是空的。点击“新建秘密”写入第一条。'),
    el('div', {class: 'card danger-zone'},
      el('header', {}, el('h2', {}, '设备凭据与恢复'), el('p', {class: 'desc'}, '密码和正文不会写入普通日志。角色密码由设备凭据封装；设备凭据丢失时无法恢复正文，只能清空空间。')),
      button('清空秘密空间', openSecretReset, {danger: true})));
}

function openSecretCreate() {
  const fields = {title: '', text: ''};
  const body = el('div', {class: 'form-grid'},
    el('div', {class: 'span-2'}, field('标题', textInput(fields.title, value => { fields.title = value; }, {maxLength: 80}))),
    el('div', {class: 'span-2'}, field('正文', textArea(fields.text, value => { fields.text = value; }, {rows: 10, maxLength: 10000}))),
    el('p', {class: 'notice'}, '正文只在保存时加密；关闭弹窗后不会保留在本页面的全局状态中。'));
  openModal('新建秘密', '仅当前解锁会话可见', body, [
    button('取消', closeModal, {ghost: true}),
    button('保存', () => {
      const title = fields.title, text = fields.text;
      closeModal();
      secretAction('create', {title, text}, '秘密已保存').then(ok => { if (ok) loadSecretStatus(); });
    }, {primary: true})
  ]);
}

function openSecretDetail(id) {
  secureApi('secretAdmin', {op: 'get', id}).then(({secret}) => {
    const body = el('div', {class: 'stack'},
      el('p', {class: 'faint'}, `创建 ${dateText(secret.createdAt)} · 修改 ${dateText(secret.updatedAt)}`),
      el('p', {style: 'white-space:pre-wrap;line-height:1.9'}, secret.body));
    openModal(secret.title, '解密内容仅显示在本次弹窗中', body, [
      button('关闭', closeModal, {ghost: true}),
      button('复制正文', () => confirmDialog('复制秘密正文', '复制后正文会进入系统剪贴板，其他程序可能读取它。确定要主动分享这段内容吗？', async () => {
        try {
          await navigator.clipboard.writeText(secret.body);
          toast('正文已复制到剪贴板');
        } catch {
          toast('浏览器拒绝了剪贴板访问', true);
        }
      }, '复制')),
      button('编辑', () => { closeModal(); openSecretEditor(secret); }, {primary: true})
    ]);
  }).catch(error => toast(formatError(error), true));
}

function openSecretEditor(secret) {
  const fields = {title: secret.title, text: secret.body};
  const body = el('div', {class: 'form-grid'},
    el('div', {class: 'span-2'}, field('标题', textInput(fields.title, value => { fields.title = value; }, {maxLength: 80}))),
    el('div', {class: 'span-2'}, field('正文', textArea(fields.text, value => { fields.text = value; }, {rows: 10, maxLength: 10000}))));
  openModal('编辑秘密', '保存后重新加密', body, [
    button('取消', closeModal, {ghost: true}),
    button('保存', () => {
      const title = fields.title, text = fields.text;
      closeModal();
      secretAction('update', {id: secret.id, title, text}, '秘密已更新').then(ok => { if (ok) loadSecretStatus(); });
    }, {primary: true})
  ]);
}

function confirmDeleteSecret(item) {
  confirmDialog('删除秘密', `将永久删除「${item.title}」及其密文。此操作不可恢复。`, () => {
    secretAction('remove', {id: item.id}, '秘密已删除').then(ok => { if (ok) loadSecretStatus(); });
  }, '删除');
}

function openSecretPassword() {
  let current = '', next = '', confirm = '';
  const body = el('div', {class: 'form-grid'},
    field('当前密码', textInput('', value => { current = value; }, {type: 'password'})),
    field('新密码', textInput('', value => { next = value; }, {type: 'password'})),
    field('确认新密码', textInput('', value => { confirm = value; }, {type: 'password'})));
  openModal('修改秘密空间密码', '会用新密钥重新加密所有秘密', body, [
    button('取消', closeModal, {ghost: true}),
    button('更新密码', () => {
      if (next !== confirm) { toast('两次输入的新密码不一致', true); return; }
      closeModal();
      secretAction('change-password', {current, password: next}, '密码已更新').then(ok => { if (ok) loadSecretStatus(); });
    }, {primary: true})
  ]);
}

function openSecretReset() {
  let confirmation = '';
  const body = el('div', {class: 'stack'},
    el('p', {class: 'notice danger'}, '这会永久删除全部秘密正文，无法恢复。只有在你确认不再需要这些内容时才继续。'),
    field('输入 RESET 确认', textInput('', value => { confirmation = value; }, {placeholder: 'RESET'})));
  openModal('清空秘密空间', '不可恢复', body, [
    button('取消', closeModal, {ghost: true}),
    button('清空并重新设置', () => {
      closeModal();
      secretAction('reset', {confirmation}, '秘密空间已清空').then(ok => { if (ok) loadSecretStatus(); });
    }, {danger: true})
  ]);
}

async function secretAction(op, payload, done) {
  try {
    await secureApi('secretAdmin', {op, ...payload});
    toast(done);
    const ui = uiFor('autonomy');
    if (op === 'lock' || op === 'reset') ui.secretItems = [];
    await loadSecretStatus();
    return true;
  } catch (error) {
    toast(formatError(error), true);
    return false;
  }
}

async function loadSecretStatus() {
  const ui = uiFor('autonomy');
  if (ui.secretLoading) return;
  ui.secretLoading = true; ui.secretError = '';
  try {
    const result = await secureApi('secretAdmin', {op: 'status'});
    ui.secretStatus = result.status;
    if (result.status?.unlocked) {
      const list = await secureApi('secretAdmin', {op: 'list'});
      ui.secretItems = list.items || [];
    } else {
      ui.secretItems = [];
    }
  } catch (error) {
    ui.secretError = formatError(error);
    ui.secretItems = [];
  } finally {
    ui.secretLoading = false;
    if (uiFor('autonomy').tab === 'secret') render();
  }
}

function memoryDraft(overview) {
  const ui = uiFor('memory');
  if (!ui.draft) {
    const config = overview.config || {};
    ui.draft = {
      autoRecall: config.autoRecall !== false,
      autoRecallMode: config.autoRecallMode || 'semantic',
      autoRecallLimit: config.autoRecallLimit ?? 6,
      contextChars: config.contextChars ?? 800,
      embeddingProvider: config.embeddingProvider || 'off',
      embeddingUrl: config.embeddingUrl || '',
      embeddingModel: config.embeddingModel || 'BAAI/bge-m3',
      embeddingKey: '',
      clearEmbeddingKey: false,
      maxMemories: config.maxMemories ?? 2000,
      retentionDays: config.retentionDays ?? 730
    };
  }
  return ui.draft;
}

function memoryView() {
  const ui = uiFor('memory');
  ui.tab ||= 'list';
  if (!pageCache.has('memory')) loadPage('memory', pageLoaders.memory);
  const loading = pluginLoading('memory', '长期记忆');
  if (loading) return [pageHeader('长期记忆', '本机 SQLite 中的真实记忆。', [], []), loading];
  const {overview, list} = pageCache.get('memory').data;
  const draft = memoryDraft(overview);
  const head = pageHeader('长期记忆', overview.description || '记忆保存在本机 SQLite，按用户、群和通用范围隔离。', [
    statePill(overview.enabled, overview.error),
    pill(`共 ${overview.stats.total} 条`),
    pill(`${overview.stats.due} 条待复习`, overview.stats.due ? 'warn' : ''),
    ...(overview.stats.expired ? [pill(`${overview.stats.expired} 条可能过期`, 'warn')] : [])
  ], [
    pluginEnableToggle(overview, 'memory', 'qq-memory'),
    button('返回插件', () => go('plugins'), {ghost: true}),
    button('新建记忆', openMemoryCreate, {primary: true, icon: 'plus'}),
    button('刷新', () => { pageCache.delete('memory'); loadPage('memory', pageLoaders.memory, {force: true}); }, {ghost: true, icon: 'refresh'})
  ]);

  const tabsRow = tabs([['list', '记忆库'], ['graph', '星图'], ['review', '复习曲线'], ['settings', '设置']], ui.tab, tab => {
    ui.tab = tab;
    try { history.replaceState(null, '', '#memory/' + tab); } catch { /* 忽略 */ }
    if (tab === 'graph' && !ui.graph) loadMemoryGraph();
    if (tab === 'review' && !ui.review) loadMemoryReview(ui.reviewId || '');
    render();
  });

  const stats = el('div', {class: 'stat-grid'},
    stat('记忆总数', String(overview.stats.total), `向量覆盖 ${overview.stats.vectors} 条`),
    stat('待复习', String(overview.stats.due), '按当前复习模型计算'),
    stat('今日复习', String(overview.stats.reviewedToday), `历史复习 ${overview.stats.reviewedTotal} 次`),
    stat('最近更新', overview.stats.latest ? dateText(overview.stats.latest) : '尚无', '数据保存在本机 SQLite'));

  let body;
  if (ui.tab === 'graph') body = memoryGraphView(overview);
  else if (ui.tab === 'review') body = memoryReviewView(overview);
  else if (ui.tab === 'settings') body = memorySettingsView(overview, draft);
  else body = memoryListView(overview, list);

  return [head, stats, tabsRow, body];
}

function memoryListView(overview, list) {
  const ui = uiFor('memory');
  const search = textInput(ui.query || '', value => { ui.query = value; }, {placeholder: '搜索正文或标签'});
  const scope = select(ui.scope || '', value => { ui.scope = value; }, [['', '全部范围'], ['global', '通用'], ['user', '用户'], ['group', '群']]);
  const kind = select(ui.kind || '', value => { ui.kind = value; }, [['', '全部类型'], ['fact', '事实'], ['preference', '偏好'], ['event', '经历'], ['note', '笔记']]);
  const sort = select(ui.sort || 'updated', value => { ui.sort = value; }, [['updated', '最近更新'], ['created', '最近创建'], ['oldest', '最早更新'], ['importance', '重要度']]);
  const apply = () => { ui.offset = 0; reloadMemoryList(); };
  const toolbar = el('div', {class: 'toolbar-card'},
    el('div', {class: 'filter-grid'},
      field('搜索', search), field('范围', scope), field('类型', kind), field('排序', sort),
      button('应用筛选', apply, {primary: true})));
  const rows = list.items || [];
  let table;
  if (rows.length) {
    const body = rows.map(row => {
      const memoryCell = el('td', {},
        el('button', {class: 'link-btn', type: 'button', onclick: () => openMemoryDetail(row.id)}, row.text.length > 70 ? row.text.slice(0, 70) + '…' : row.text),
        tagList(row.tags));
      const scopeCell = el('td', {}, row.scope === 'global' ? '通用' : row.scope === 'group' ? '群 ' + row.owner : '用户 ' + row.owner);
      const reviewCell = el('td', {}, row.reviewCount ? `${row.reviewCount} 次` + (row.due ? ' · 待复习' : '') : (row.due ? '待首次复习' : '—'));
      const actions = el('td', {}, el('div', {class: 'row'},
        button('查看', () => openMemoryDetail(row.id), {small: true, ghost: true}),
        button('删除', () => confirmDeleteMemory(row), {small: true, danger: true})));
      return el('tr', {}, memoryCell, scopeCell, el('td', {}, row.kindLabel), el('td', {}, String(row.importance)), el('td', {}, dateText(row.updatedAt)), reviewCell, actions);
    });
    table = el('div', {class: 'table-wrap'}, el('table', {class: 'table'},
      el('thead', {}, el('tr', {}, ['记忆', '范围', '类型', '重要度', '更新', '复习', '操作'].map(head => el('th', {}, head)))),
      el('tbody', {}, body)));
  } else {
    table = el('p', {class: 'empty'}, ui.query || ui.scope || ui.kind ? '没有符合筛选条件的记忆。' : '记忆库还是空的。可以在 QQ 对话中让她记住，或手动新建。');
  }
  return card('记忆库', '编辑正文会清除旧向量，避免用旧语义检索新文本；删除不可恢复。', toolbar, table,
    pager(list.total, list.offset, list.limit, offset => { ui.offset = offset; reloadMemoryList(); }));
}

function reloadMemoryList() {
  const ui = uiFor('memory');
  pageCache.delete('memory');
  loadPage('memory', pageLoaders.memory, {force: true});
}

function openMemoryDetail(id) {
  secureApi('memoryAdmin', {op: 'get', id}).then(({memory, reviews, review, related = [], historyNote = ''}) => {
    const fields = {text: memory.text, kind: memory.kind, tags: (memory.tags || []).join(' '), importance: memory.importance};
    const reviewText = review.count ? `已复习 ${review.count} 次；下次建议 ${dateText(review.nextDue)}` : `尚未复习；建议 ${dateText(review.nextDue)}`;
    const body = el('div', {class: 'stack'},
      el('dl', {class: 'kv'},
        el('dt', {}, '范围'), el('dd', {}, memory.scope === 'global' ? '通用' : memory.scope === 'group' ? '群 ' + memory.owner : '用户 ' + memory.owner),
        el('dt', {}, '来源'), el('dd', {}, memory.source || '未知'),
        el('dt', {}, '创建'), el('dd', {}, dateText(memory.createdAt)),
        el('dt', {}, '更新'), el('dd', {}, dateText(memory.updatedAt)),
        el('dt', {}, '使用'), el('dd', {}, `${memory.useCount} 次` + (memory.usedAt ? '，最近 ' + dateText(memory.usedAt) : '')),
        el('dt', {}, '复习'), el('dd', {}, reviewText),
        el('dt', {}, '理论保持度'), el('dd', {}, `${Math.round(review.retention * 100)}%（按模型估算，不是实际测量）`)),
      el('div', {class: 'form-grid'},
        el('div', {class: 'span-2'}, field('正文', textArea(fields.text, value => { fields.text = value; }, {rows: 7, maxLength: 500}))),
        field('类型', select(fields.kind, value => { fields.kind = value; }, [['fact', '事实'], ['preference', '偏好'], ['event', '经历'], ['note', '笔记']])),
        field('重要度（1–5）', numberInput(fields.importance, value => { fields.importance = value; }, {min: 1, max: 5})),
        el('div', {class: 'span-2'}, field('标签', textInput(fields.tags, value => { fields.tags = value; }, {placeholder: '空格分隔，最多 5 个'})))),
      el('p', {class: 'notice'}, '修改正文会清除旧向量；下次写入或检索时才会重新生成。'),
      historyNote ? el('p', {class: 'section-note'}, historyNote) : null,
      related.length ? el('div', {}, el('h3', {}, '关联记录（推断）'), el('div', {class: 'list'}, related.map(row => el('div', {class: 'list-item'},
        el('div', {class: 'what'}, el('button', {class: 'link-btn', type: 'button', onclick: () => { closeModal(); openMemoryDetail(row.id); }}, row.label), el('small', {class: 'muted'}, row.relation)),
        el('div', {class: 'when'}, row.kind === 'similarity' ? '相似' : '标签'))))) : null,
      reviews.length ? el('div', {}, el('h3', {}, '复习记录'), el('div', {class: 'list'}, reviews.map(row => el('div', {class: 'list-item'},
        el('div', {class: 'what'}, row.note || '完成一次复习'), el('div', {class: 'when'}, dateText(row.reviewedAt)))))) : null);
    openModal('记忆详情', memory.scopeLabel, body, [
      button('关闭', closeModal, {ghost: true}),
      button('记录复习', () => {
        closeModal();
        pageAction('memory', 'memoryAdmin', {op: 'reviewComplete', id: memory.id}, '已记录复习').then(() => { if (uiFor('memory').tab === 'review') loadMemoryReview(memory.id); });
      }, {ghost: true}),
      button('删除', () => { closeModal(); confirmDeleteMemory(memory); }, {danger: true}),
      button('保存修改', () => {
        closeModal();
        pageAction('memory', 'memoryAdmin', {op: 'update', id: memory.id, text: fields.text, kind: fields.kind, tags: fields.tags, importance: Number(fields.importance)}, '记忆已更新');
      }, {primary: true})
    ]);
  }).catch(error => toast(formatError(error), true));
}

function confirmDeleteMemory(row) {
  confirmDialog('删除记忆', `将永久删除「${String(row.text).slice(0, 40)}…」及其复习记录。此操作不可撤销。`, async () => {
    await pageAction('memory', 'memoryAdmin', {op: 'remove', id: row.id}, '记忆已删除');
  }, '删除');
}

function openMemoryCreate() {
  const fields = {scope: 'user', owner: '', kind: 'fact', text: '', tags: '', importance: 3};
  const ownerField = field('用户 QQ / 群号', textInput(fields.owner, value => { fields.owner = value; }));
  const body = el('div', {class: 'form-grid'},
    field('范围', select(fields.scope, value => { fields.scope = value; ownerField.hidden = value === 'global'; }, [['user', '用户'], ['group', '群'], ['global', '通用']])),
    ownerField,
    field('类型', select(fields.kind, value => { fields.kind = value; }, [['fact', '事实'], ['preference', '偏好'], ['event', '经历'], ['note', '笔记']])),
    field('重要度（1–5）', numberInput(fields.importance, value => { fields.importance = value; }, {min: 1, max: 5})),
    el('div', {class: 'span-2'}, field('正文', textArea(fields.text, value => { fields.text = value; }, {rows: 5, maxLength: 500}))),
    el('div', {class: 'span-2'}, field('标签', textInput(fields.tags, value => { fields.tags = value; }))));
  openModal('新建记忆', '手动写入本机记忆库', body, [
    button('取消', closeModal, {ghost: true}),
    button('保存', () => {
      closeModal();
      pageAction('memory', 'memoryAdmin', {op: 'create', scope: fields.scope, owner: fields.owner, kind: fields.kind, text: fields.text, tags: fields.tags, importance: Number(fields.importance)}, '记忆已创建');
    }, {primary: true})
  ]);
}

function memoryGraphView(overview) {
  const ui = uiFor('memory');
  const graph = ui.graph;
  if (ui.graphLoading) return stateBox('正在计算星图', '节点来自真实记忆；连线由共享标签或已保存向量计算。');
  if (ui.graphError) return stateBox('星图加载失败', ui.graphError, button('重试', () => loadMemoryGraph(), {ghost: true}));
  if (!graph) { loadMemoryGraph(); return stateBox('正在准备星图', '读取记忆索引与标签。'); }
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const canvas = el('canvas', {class: 'star-canvas', 'aria-label': '记忆关系星图'});
  const tooltip = el('div', {class: 'star-tooltip', hidden: true});
  const panel = el('aside', {class: 'star-panel', hidden: true});
  const stage = el('div', {class: 'star-stage'}, canvas, tooltip, panel);
  const pauseButton = button('暂停动态', () => {
    const paused = state.starMap?.togglePause();
    pauseButton.textContent = paused ? '恢复动态' : '暂停动态';
  }, {ghost: true, small: true});
  const search = textInput(ui.starQuery || '', value => { ui.starQuery = value; }, {placeholder: '搜索记忆，定位节点'});
  const scope = select(ui.starScope || '', value => {
    ui.starScope = value;
    state.starMap?.setScope(value);
  }, [['', '全部范围'], ['global', '通用'], ['user', '用户'], ['group', '群']]);
  const locate = () => {
    const count = state.starMap?.search(ui.starQuery || '') || 0;
    toast(count ? `找到 ${count} 条匹配记忆` : '没有匹配的记忆', !count);
  };
  const controls = el('div', {class: 'star-controls'},
    field('搜索', search),
    field('范围', scope),
    button('定位', locate, {ghost: true, small: true}),
    pauseButton,
    button('重置视角', () => { state.starMap?.reset(); pauseButton.textContent = state.starMap?.isPaused() ? '恢复动态' : '暂停动态'; }, {ghost: true, small: true}));
  const mount = () => {
    if (!canvas.isConnected) return;
    state.starMap?.destroy();
    state.starMap = createStarMap({
      canvas, tooltip, panel, nodes, edges,
      onSelect: node => renderStarPanel(node, panel),
      onClosePanel: () => { /* panel hidden by module */ }
    });
    pauseButton.textContent = state.starMap.isPaused() ? '恢复动态' : '暂停动态';
  };
  setTimeout(mount, 0);
  const content = el('div', {class: 'grid', style: 'gap:12px'},
    controls,
    stage,
    el('div', {class: 'row'},
      pill('通用', ''), pill('用户', ''), pill('群', ''),
      el('span', {class: 'faint'}, '大小=重要度 · 颜色=范围 · 亮度=最近活跃 · 实线=共享标签 · 虚线=向量相似度')),
    el('p', {class: 'notice'}, graph.note || '连线是推断关系。'),
    el('p', {class: 'section-note'}, '拖动旋转、滚轮缩放、双击聚焦；点击节点在右侧查看，点击“完整详情”不会重置视角。'));
  return card('记忆星图', '节点对应真实记忆记录；没有标签或向量的孤立节点不会凭空连线。', content);
}

async function renderStarPanel(node, panel) {
  if (!panel) return;
  panel.hidden = false;
  clear(panel);
  panel.append(
    el('div', {class: 'star-panel-head'},
      el('div', {}, el('p', {class: 'eyebrow'}, 'MEMORY'), el('h3', {}, String(node.label || '记忆'))),
      button('关闭', () => state.starMap?.select(null), {ghost: true, small: true})),
    el('p', {class: 'faint'}, `范围 ${node.scope} · 重要度 ${node.importance} · 关联 ${node.degree || 0}`),
    tagList(node.tags),
    stateBox('正在读取完整记忆', '只有真实 SQLite 记录会出现在这里。'));
  try {
    const detail = await secureApi('memoryAdmin', {op: 'get', id: node.id});
    if (!panel.isConnected) return;
    clear(panel);
    const memory = detail.memory;
    const children = [
      el('div', {class: 'star-panel-head'},
        el('div', {}, el('p', {class: 'eyebrow'}, 'MEMORY'), el('h3', {}, memory.text.slice(0, 32))),
        button('关闭', () => state.starMap?.select(null), {ghost: true, small: true})),
      el('p', {class: 'faint'}, `${memory.scopeLabel} · ${memory.kindLabel} · 重要度 ${memory.importance}`),
      el('p', {class: 'star-panel-text'}, memory.text),
      tagList(memory.tags),
      detail.related?.length ? el('div', {}, el('h4', {}, '关联（推断）'), el('div', {class: 'star-related'}, detail.related.map(row => button(row.label, () => state.starMap?.focus(row.id), {ghost: true, small: true})))) : null,
      detail.conflicts?.some(row => !row.resolvedAt) ? (() => { const conflict = detail.conflicts.find(row => !row.resolvedAt); return el('div', {}, el('h4', {}, '未处理冲突'), el('p', {class: 'faint'}, conflict.newText + ' ← ' + (conflict.oldSourceUrl || '无来源')), el('div', {class: 'row'}, button('标记已处理', () => pageAction('memory', 'memoryAdmin', {op: 'resolveConflict', conflictId: conflict.id}, '冲突已标记处理').then(() => openMemoryDetail(memory.id)), {ghost: true, small: true}))); })() : null,
      el('p', {class: 'faint'}, detail.historyAvailable ? '' : '未保存逐次编辑历史；冲突记录保留在 memory_conflicts。'),
      el('div', {class: 'row'},
        button('完整详情', () => openMemoryDetail(memory.id), {primary: true, small: true}),
        button('记录复习', () => {
          pageAction('memory', 'memoryAdmin', {op: 'reviewComplete', id: memory.id}, '已记录复习');
        }, {ghost: true, small: true}))
    ].filter(Boolean);
    panel.append(...children);
  } catch (error) {
    panel.append(el('p', {class: 'notice danger'}, formatError(error)));
  }
}

function memoryReviewView(overview) {
  const ui = uiFor('memory');
  if (ui.reviewLoading) return stateBox('正在计算复习计划', '读取理论上限与真实复习记录。');
  if (ui.reviewError) return stateBox('复习数据加载失败', ui.reviewError, button('重试', () => loadMemoryReview(ui.reviewId || ''), {ghost: true}));
  const data = ui.review;
  if (!data) { loadMemoryReview(ui.reviewId || ''); return stateBox('正在准备复习视图', '读取记忆与复习记录。'); }
  const due = data.due || [];
  const dueList = due.length ? el('div', {class: 'list'}, due.map(row => el('div', {class: 'list-item'},
    el('div', {class: 'what'}, el('button', {class: 'link-btn', type: 'button', onclick: () => loadMemoryReview(row.id)}, row.text.length > 60 ? row.text.slice(0, 60) + '…' : row.text),
      el('small', {class: 'muted'}, `建议 ${dateText(row.dueAt)} · 已复习 ${row.reviewCount} 次`)),
    el('div', {class: 'when'}, button('查看曲线', () => loadMemoryReview(row.id), {small: true, ghost: true}))))) : el('p', {class: 'empty'}, '当前没有到期需要复习的记忆。');
  const detail = data.detail;
  const chart = detail ? memoryCurveChart(detail, data.model) : el('p', {class: 'empty'}, '选择一条记忆，查看它的理论遗忘曲线与真实复习记录。');
  const dueCard = card('待复习', '按真实创建/复习时间和集中管理的复习间隔计算；不是随机提醒。', dueList,
    el('p', {class: 'notice'}, data.model.note),
    el('p', {class: 'section-note'}, '当前没有后台推送提醒；下次建议时间按真实复习记录计算，需要管理员打开页面查看。'));
  const chartCard = card('艾宾浩斯复习曲线', detail ? `${detail.memory.text.slice(0, 70)}…` : '理论曲线', chart,
    detail ? el('div', {class: 'row'}, button('记录一次复习', () => {
      pageAction('memory', 'memoryAdmin', {op: 'reviewComplete', id: detail.memory.id}, '已记录复习').then(() => loadMemoryReview(detail.memory.id));
    }, {primary: true}), el('span', {class: 'faint'}, `实际复习 ${detail.reviews.length} 次`)) : null);
  const params = card('模型参数', '参数集中定义在 src/builtins/memory/store.js，修改需同步文档。',
    el('dl', {class: 'kv'},
      el('dt', {}, '间隔（小时）'), el('dd', {}, data.model.intervalsHours.join('、')),
      el('dt', {}, '基础稳定度'), el('dd', {}, `${data.model.baseStabilityHours} 小时`),
      el('dt', {}, '公式'), el('dd', {}, data.model.formula)));
  return [el('div', {class: 'split'}, dueCard, chartCard), params];
}

function memoryCurveChart(detail, model) {
  const width = 600, height = 300, pad = 40;
  const maxDay = 30;
  const x = day => pad + (day / maxDay) * (width - pad * 2);
  const y = value => height - pad - value * (height - pad * 2);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart');
  for (let i = 0; i <= 4; i += 1) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(x(0))); line.setAttribute('y1', String(y(i / 4)));
    line.setAttribute('x2', String(x(maxDay))); line.setAttribute('y2', String(y(i / 4)));
    line.setAttribute('class', 'gridline');
    svg.append(line);
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', '4'); label.setAttribute('y', String(y(i / 4) + 3));
    label.textContent = Math.round(i * 25) + '%';
    svg.append(label);
  }
  const axis = document.createElementNS(svgNS, 'line');
  axis.setAttribute('x1', String(x(0))); axis.setAttribute('y1', String(y(0)));
  axis.setAttribute('x2', String(x(maxDay))); axis.setAttribute('y2', String(y(0)));
  axis.setAttribute('class', 'axis');
  svg.append(axis);
  for (const day of [0, 7, 14, 21, 30]) {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', String(x(day) - 4)); label.setAttribute('y', String(height - 12));
    label.textContent = day + 'd';
    svg.append(label);
  }
  const points = detail.series.map(point => `${x(point.day)},${y(point.retention)}`).join(' ');
  const path = document.createElementNS(svgNS, 'polyline');
  path.setAttribute('points', points);
  path.setAttribute('class', 'theory');
  svg.append(path);
  const created = new Date(detail.memory.createdAt).getTime();
  for (const review of detail.reviews) {
    const hours = Math.max(0, (new Date(review.reviewedAt).getTime() - created) / 3600000);
    const day = Math.min(maxDay, hours / 24);
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(x(day))); circle.setAttribute('cy', String(y(0.02)));
    circle.setAttribute('r', '3.5'); circle.setAttribute('class', 'actual');
    svg.append(circle);
  }
  const legend = document.createElementNS(svgNS, 'text');
  legend.setAttribute('x', String(x(1))); legend.setAttribute('y', String(y(0.08)));
  legend.textContent = '实线：理论保持度（模型估算） · 圆点：真实复习记录';
  svg.append(legend);
  return el('div', {}, svg, el('p', {class: 'section-note'}, '理论曲线按 24 小时基础稳定度与重要度、复习次数计算；真实记录只来自 memory_reviews 表。'));
}

function memorySettingsView(overview, draft) {
  const save = () => {
    const config = {
      autoRecall: draft.autoRecall,
      autoRecallMode: draft.autoRecallMode,
      autoRecallLimit: Number(draft.autoRecallLimit),
      contextChars: Number(draft.contextChars),
      embeddingProvider: draft.embeddingProvider,
      embeddingUrl: draft.embeddingUrl,
      embeddingModel: draft.embeddingModel,
      embeddingKey: draft.embeddingKey,
      maxMemories: Number(draft.maxMemories),
      retentionDays: Number(draft.retentionDays)
    };
    const payload = {id: 'qq-memory', enabled: overview.enabled, scope: overview.scope, config};
    if (!draft.clearEmbeddingKey && overview.secrets?.embeddingKeyConfigured) payload.preserveSecrets = ['embeddingKey'];
    pageAction('memory', 'configureNativePackage', payload, '记忆设置已保存');
  };
  const settingsBar = savebar('保存后新配置立即用于下一轮记忆写入与回忆', save);
  settingsBar.prepend(resetDraftButton('memory'));
  return card('记忆设置', '修改会保存到插件配置并重新加载；嵌入密钥不会回显到浏览器。',
    el('div', {class: 'form-grid'},
      el('div', {class: 'span-2'}, toggle('回复前自动回忆', draft.autoRecall, value => { draft.autoRecall = value; }, '只读取当前聊天可见的记忆')),
      field('回忆方式', select(draft.autoRecallMode, value => { draft.autoRecallMode = value; }, [['semantic', '语义'], ['keyword', '关键词']])),
      field('自动回忆条数', numberInput(draft.autoRecallLimit, value => { draft.autoRecallLimit = value; }, {min: 1, max: 12})),
      field('注入最多字数', numberInput(draft.contextChars, value => { draft.contextChars = value; }, {min: 200, max: 2000})),
      field('嵌入来源', select(draft.embeddingProvider, value => { draft.embeddingProvider = value; }, [['siliconflow', '硅基流动'], ['openai', 'OpenAI 兼容'], ['off', '关闭（关键词）']])),
      field('嵌入模型', textInput(draft.embeddingModel, value => { draft.embeddingModel = value; })),
      el('div', {class: 'span-2'}, field('嵌入地址', textInput(draft.embeddingUrl, value => { draft.embeddingUrl = value; }, {placeholder: '留空使用供应商默认地址', mono: true}))),
      el('div', {class: 'span-2'}, field('嵌入密钥', textInput('', value => { draft.embeddingKey = value; }, {type: 'password', autocomplete: 'new-password', placeholder: overview.secrets?.embeddingKeyConfigured ? '已配置；留空保持不变' : '尚未配置'}))),
      el('div', {class: 'span-2'}, toggle('清除已保存的嵌入密钥', draft.clearEmbeddingKey, value => { draft.clearEmbeddingKey = value; }, '勾选并保存后，后续需要重新填写密钥')),
      field('最多记忆条数', numberInput(draft.maxMemories, value => { draft.maxMemories = value; }, {min: 100, max: 10000})),
      field('保留天数', numberInput(draft.retentionDays, value => { draft.retentionDays = value; }, {min: 30, max: 3650}))),
    el('p', {class: 'notice'}, '容量与保留天数由框架定时清理；清理优先丢弃低重要度、久未使用的记忆。'),
    overview.retrievalModel?.description ? el('p', {class: 'section-note'}, '检索评分（实际使用）：' + overview.retrievalModel.description) : null,
    settingsBar);
}

async function loadMemoryGraph() {
  const ui = uiFor('memory');
  ui.graphLoading = true; ui.graphError = ''; render();
  try {
    ui.graph = await secureApi('memoryAdmin', {op: 'graph', query: {limit: 120, scope: ui.graphScope || ''}});
  } catch (error) {
    ui.graphError = formatError(error);
  } finally {
    ui.graphLoading = false;
    if (uiFor('memory').tab === 'graph') render();
  }
}

async function loadMemoryReview(id = '') {
  const ui = uiFor('memory');
  ui.reviewLoading = true; ui.reviewError = ''; ui.reviewId = id; render();
  try {
    ui.review = await secureApi('memoryAdmin', {op: 'reviewOverview', query: {id}});
  } catch (error) {
    ui.reviewError = formatError(error);
  } finally {
    ui.reviewLoading = false;
    if (uiFor('memory').tab === 'review') render();
  }
}

function qzoneDraft(overview) {
  const ui = uiFor('qzone');
  if (!ui.draft) {
    const config = overview.config || {};
    ui.draft = {
      publishEnabled: config.publishEnabled === true,
      commentEnabled: config.commentEnabled === true,
      visibility: config.visibility || 'friends',
      dailyLimitMode: config.dailyLimitMode || 'recommended',
      readPerHour: config.readPerHour ?? 30,
      publishPerDay: config.publishPerDay ?? 3,
      commentPerDay: config.commentPerDay ?? 5,
      cooldownSec: config.cooldownSec ?? 60,
      allowedTargets: (config.allowedTargets || []).join('\n'),
      autoSync: config.autoSync === true,
      syncIntervalMinutes: config.syncIntervalMinutes ?? 15,
      syncBatchFriends: config.syncBatchFriends ?? 5,
      postsPerFriend: config.postsPerFriend ?? 5,
      retentionMode: config.retentionMode || 'none',
      retentionCount: config.retentionCount ?? 5000,
      retentionDays: config.retentionDays ?? 365
    };
  }
  return ui.draft;
}

function qzoneAvatar(id, size = 28) {
  const img = el('img', {class: 'friend-avatar', src: '/api/qzone-avatar?id=' + encodeURIComponent(id), alt: '', loading: 'lazy', onerror: event => {
    event.target.replaceWith(el('span', {class: 'friend-avatar fallback'}, String(id).slice(-2)));
  }});
  img.style.width = size + 'px';
  img.style.height = size + 'px';
  return img;
}

function qzoneView() {
  const ui = uiFor('qzone');
  const qzoneCache = pageCache.get('qzone');
  if (!qzoneCache || (!qzoneCache.loading && Date.now() - (qzoneCache.at || 0) > 30000)) loadPage('qzone', pageLoaders.qzone, {force: Boolean(qzoneCache?.data)});
  const loading = pluginLoading('qzone', 'QQ 空间');
  if (loading) return [pageHeader('QQ 空间', '好友列表与真实空间动态。', [], []), loading];
  const data = pageCache.get('qzone').data;
  const {overview, feed} = data;
  const friends = data.friends || {items: []};
  const draft = qzoneDraft(overview);
  const status = overview.status || {};
  const posts = feed?.items || [];
  const friendFilter = String(ui.friendQuery || '').trim().toLowerCase();
  const visibleFriends = (friends.items || []).filter(friend => !friendFilter || friend.name.toLowerCase().includes(friendFilter) || friend.remark.toLowerCase().includes(friendFilter) || friend.id.includes(friendFilter));
  const postQuery = String(ui.qzoneQuery || '').trim().toLowerCase();
  const visiblePosts = postQuery ? posts.filter(post => String(post.text || '').toLowerCase().includes(postQuery) || String(post.friendName || '').toLowerCase().includes(postQuery) || String(post.friendId).includes(postQuery)) : posts;
  const head = pageHeader('QQ 空间', '自动读取已连接账号的好友列表，并按授权范围同步好友动态；不要求逐个手动输入好友。', [
    statePill(overview.enabled, overview.error),
    pill(`${status.friendCount || 0} 位好友`),
    status.lastSyncError ? pill('最近同步有错误', 'bad') : status.lastSyncAt ? pill('已同步', 'ok') : pill('尚未同步', 'warn')
  ], [
    pluginEnableToggle(overview, 'qzone', 'qq-qzone'),
    button('返回插件', () => go('plugins'), {ghost: true}),
    button('刷新页面', () => loadPage('qzone', pageLoaders.qzone, {force: true}), {ghost: true, icon: 'refresh'})
  ]);

  const stats = el('div', {class: 'stat-grid'},
    stat('好友', String(status.friendCount || 0), status.friendErrors ? `${status.friendErrors} 位读取失败` : '来自已连接账号'),
    stat('动态缓存', String(status.feedCount || 0), feed?.syncedAt ? '同步于 ' + dateText(feed.syncedAt) : '尚未同步'),
    stat('最近同步', status.lastSyncAt ? dateText(status.lastSyncAt) : '尚无', status.syncInProgress ? `进行中 ${status.syncDone}/${status.syncTotal}` : '后台同步与页面分页分离'),
    stat('本次读取', String(status.lastFetched || 0) + ' 条', status.lastSuccess ? dateText(status.lastSuccess) : '尚无请求'));

  const friendSearch = textInput(ui.friendQuery || '', value => { ui.friendQuery = value; render(); }, {placeholder: '搜索好友昵称或 QQ'});
  const friendList = visibleFriends.length ? el('div', {class: 'friend-list'}, visibleFriends.map(friend => el('button', {
    class: 'friend-item' + (ui.friendId === friend.id ? ' active' : ''), type: 'button',
    onclick: () => { ui.friendId = ui.friendId === friend.id ? '' : friend.id; ui.feedOffset = 0; reloadQzoneFeed(); }
  }, qzoneAvatar(friend.id),
  el('span', {class: 'friend-copy'}, el('strong', {}, friend.remark || friend.name), el('small', {}, 'QQ ' + friend.id)),
  el('span', {class: 'friend-count'}, String(friend.postCount || 0), friend.error ? el('small', {class: 'bad-text'}, '读取失败') : null)))) :
    el('p', {class: 'empty'}, friends.error ? friends.error : '暂无好友；请确认 QQ 已登录且 OneBot 支持好友列表。');
  const friendCard = card('好友', '好友列表来自 OneBot get_friend_list；点击好友筛选动态。',
    field('搜索好友', friendSearch),
    friends.error ? el('p', {class: 'notice danger'}, friends.error) : null,
    friendList);

  const feedToolbar = el('div', {class: 'toolbar-card'},
    el('div', {class: 'filter-grid wide'},
      field('搜索动态', textInput(ui.qzoneQuery || '', value => { ui.qzoneQuery = value; }, {placeholder: '正文、昵称或 QQ'})),
      field('排序', select(ui.qzoneOrder || 'desc', value => { ui.qzoneOrder = value; reloadQzoneFeed(); }, [['desc', '最新在前'], ['asc', '最早在前']])),
      button(ui.syncing ? '同步中…' : '同步好友动态', syncQzone, {primary: true, disabled: ui.syncing || !overview.enabled}),
      button('加载更多缓存', loadMoreQzoneFeed, {ghost: true, disabled: ui.feedLoadingMore || !feed?.hasMore})),
    status.lastSyncError ? el('p', {class: 'notice danger'}, '最近同步错误：' + status.lastSyncError) : null);
  const feedBody = (() => {
    if (ui.feedError || feed?.error) return stateBox('动态读取失败', ui.feedError || feed.error, button('重试', () => loadPage('qzone', pageLoaders.qzone, {force: true}), {ghost: true}));
    if (!visiblePosts.length) return el('p', {class: 'empty'}, ui.qzoneQuery ? '没有匹配的动态。' : status.friendCount ? '还没有同步到动态。点“同步好友动态”读取授权范围内的好友空间。' : '先确认好友列表与 QQ 登录状态。');
    return el('div', {}, visiblePosts.map(qzonePost));
  })();
  const feedCard = card('好友动态', ui.friendId ? `筛选好友：${(friends.items || []).find(row => row.id === ui.friendId)?.name || ui.friendId}` : '按发布时间显示已同步的真实动态。', feedToolbar, feedBody,
    feed?.hasMore ? el('div', {class: 'row'}, button(ui.feedLoadingMore ? '加载中…' : '加载更多缓存', loadMoreQzoneFeed, {ghost: true, disabled: ui.feedLoadingMore})) : null);

  const settingsBar = savebar('保存后插件重新加载；自动同步使用后端调度，不是前端轮询', () => pageAction('qzone', 'configureNativePackage', {
    id: 'qq-qzone', enabled: overview.enabled, scope: overview.scope,
    config: {
      publishEnabled: draft.publishEnabled,
      commentEnabled: draft.commentEnabled,
      visibility: draft.visibility,
      dailyLimitMode: draft.dailyLimitMode,
      readPerHour: Number(draft.readPerHour),
      publishPerDay: Number(draft.publishPerDay),
      commentPerDay: Number(draft.commentPerDay),
      cooldownSec: Number(draft.cooldownSec),
      allowedTargets: parseList(draft.allowedTargets),
      autoSync: draft.autoSync,
      syncIntervalMinutes: Number(draft.syncIntervalMinutes),
      syncBatchFriends: Number(draft.syncBatchFriends),
      postsPerFriend: Number(draft.postsPerFriend),
      retentionMode: draft.retentionMode,
      retentionCount: Number(draft.retentionCount),
      retentionDays: Number(draft.retentionDays)
    }
  }, 'QQ 空间设置已保存'));
  settingsBar.prepend(resetDraftButton('qzone'));
  const limitFields = draft.dailyLimitMode === 'unlimited'
    ? el('p', {class: 'notice'}, '已选择不限制业务每日写入次数；冷却和 QQ 接口配额仍然生效。')
    : draft.dailyLimitMode === 'recommended'
      ? el('p', {class: 'section-note'}, '推荐上限：每天发布 3 条、评论 5 条。切换“自定义”后才使用下面的数值。')
      : el('div', {class: 'form-grid'},
        field('24 小时最多发布', numberInput(draft.publishPerDay, value => { draft.publishPerDay = value; }, {min: 1, max: 100})),
        field('24 小时最多评论', numberInput(draft.commentPerDay, value => { draft.commentPerDay = value; }, {min: 1, max: 200})));
  const retentionFields = draft.retentionMode === 'count'
    ? field('保留最近动态条数', numberInput(draft.retentionCount, value => { draft.retentionCount = value; }, {min: 1, max: 100000}))
    : draft.retentionMode === 'days'
      ? field('保留最近天数', numberInput(draft.retentionDays, value => { draft.retentionDays = value; }, {min: 1, max: 3650}))
      : el('p', {class: 'section-note'}, '不主动按数量删除缓存；仍会受磁盘和接口配额约束。');
  const settingsCard = card('读取、同步与写入设置', '所有限制都会持久化并影响后端逻辑；不限制业务次数不等于无限调用 QQ 接口。',
    el('div', {class: 'form-grid'},
      el('div', {class: 'span-2'}, toggle('允许发布说说', draft.publishEnabled, value => { draft.publishEnabled = value; }, '写入仍只能由主人在 QQ 对话中发起')),
      el('div', {class: 'span-2'}, toggle('允许评论', draft.commentEnabled, value => { draft.commentEnabled = value; })),
      field('新说说可见范围', select(draft.visibility, value => { draft.visibility = value; }, [['friends', '好友可见'], ['self', '仅自己'], ['public', '公开']])),
      field('每日写入限制', select(draft.dailyLimitMode, value => { draft.dailyLimitMode = value; render(); }, [['recommended', '系统推荐'], ['custom', '自定义'], ['unlimited', '不限制业务次数']])),
      limitFields,
      field('写入冷却（秒）', numberInput(draft.cooldownSec, value => { draft.cooldownSec = value; }, {min: 30, max: 3600})),
      field('每小时读取保护', numberInput(draft.readPerHour, value => { draft.readPerHour = value; }, {min: 1, max: 120})),
      el('div', {class: 'span-2'}, toggle('自动同步好友动态', draft.autoSync, value => { draft.autoSync = value; }, '后端按间隔串行分批读取，不使用前端轮询')),
      field('同步间隔（分钟）', numberInput(draft.syncIntervalMinutes, value => { draft.syncIntervalMinutes = value; }, {min: 2, max: 1440})),
      field('每批好友数', numberInput(draft.syncBatchFriends, value => { draft.syncBatchFriends = value; }, {min: 1, max: 200})),
      field('每位好友动态数', numberInput(draft.postsPerFriend, value => { draft.postsPerFriend = value; }, {min: 1, max: 20})),
      field('历史保留策略', select(draft.retentionMode, value => { draft.retentionMode = value; render(); }, [['none', '不主动按数量删除'], ['count', '按条数保留'], ['days', '按天数保留']])),
      retentionFields,
      el('div', {class: 'span-2'}, field('允许浏览/评论的 QQ', textArea(draft.allowedTargets, value => { draft.allowedTargets = value; }, {rows: 2, placeholder: '留空表示不额外限制；不绕过空间隐私'})))),
    settingsBar);

  return [head, stats, el('div', {class: 'split qzone-layout'}, friendCard, feedCard), settingsCard];
}

function qzonePost(post) {
  const detail = () => openQzonePost(post);
  return el('article', {class: 'post'},
    el('div', {class: 'post-head'},
      el('div', {class: 'row'}, qzoneAvatar(post.friendId, 26), el('strong', {}, post.friendName || post.userName || 'QQ ' + post.friendId)),
      el('time', {}, dateText(post.time))),
    el('p', {class: 'post-text'}, post.text || '（没有正文）'),
    post.images?.length ? el('div', {class: 'post-images'}, post.images.map(url => el('img', {
      src: '/api/qzone-image?url=' + encodeURIComponent(url), alt: '空间图片', loading: 'lazy',
      onerror: event => event.target.replaceWith(el('span', {class: 'post-image-broken'}, '图片加载失败'))
    }))) : null,
    el('div', {class: 'post-meta'},
      el('span', {}, `点赞 ${post.likeCount || 0}${post.likes?.length ? ' · ' + post.likes.slice(0, 3).map(x => x.name || x.userId).join('、') : ''}`),
      el('span', {}, `评论 ${post.commentCount || 0}${post.comments?.length ? ' · 已读取 ' + post.comments.length + ' 条' : ''}`),
      post.liked ? el('span', {class: 'ok-text'}, '当前账号已点赞') : null,
      !post.images?.length ? el('span', {class: 'faint'}, '接口未返回图片') : null),
    post.comments?.length ? el('div', {class: 'comment-preview'}, post.comments.slice(0, 2).map(comment => el('p', {},
      el('strong', {}, comment.name || ('QQ ' + comment.userId) + '：'), comment.text))) : null,
    el('div', {class: 'post-actions'},
      button('查看详情', detail, {small: true, ghost: true}),
      post.url ? el('a', {href: post.url, target: '_blank', rel: 'noopener noreferrer'}, '在 QQ 空间打开') : null));
}

function openQzonePost(post) {
  const body = el('div', {class: 'stack'},
    el('div', {class: 'post-head'}, el('div', {class: 'row'}, qzoneAvatar(post.friendId, 30), el('strong', {}, post.friendName || post.userName)), el('time', {}, dateText(post.time))),
    el('p', {class: 'post-text'}, post.text || '（没有正文）'),
    post.images?.length ? el('div', {class: 'post-images'}, post.images.map(url => el('img', {src: '/api/qzone-image?url=' + encodeURIComponent(url), alt: '空间图片'}))) : el('p', {class: 'section-note'}, '接口没有返回图片。'),
    el('div', {class: 'kv'},
      el('dt', {}, '点赞'), el('dd', {}, `${post.likeCount || 0}${post.likes?.length ? '：' + post.likes.map(x => x.name || x.userId).join('、') : '（名单未返回）'}`),
      el('dt', {}, '评论'), el('dd', {}, `${post.commentCount || 0}${post.comments?.length ? '：' + post.comments.length + ' 条' : '（列表未返回）'}`),
      el('dt', {}, '当前账号'), el('dd', {}, post.liked ? '已点赞' : '接口未返回/未点赞')),
    post.comments?.length ? el('div', {}, el('h3', {}, '评论'), el('div', {class: 'list'}, post.comments.map(comment => el('div', {class: 'list-item'},
      el('div', {class: 'what'}, el('strong', {}, comment.name || 'QQ ' + comment.userId), el('p', {class: 'muted'}, comment.text)),
      el('div', {class: 'when'}, dateText(comment.time || 0)))))) : null,
    post.url ? el('a', {href: post.url, target: '_blank', rel: 'noopener noreferrer'}, '在 QQ 空间打开') : null);
  openModal('空间动态', post.friendName || ('QQ ' + post.friendId), body, [button('关闭', closeModal, {ghost: true})]);
}

async function syncQzone() {
  const ui = uiFor('qzone');
  if (ui.syncing) return;
  ui.syncing = true; ui.feedError = ''; render();
  try {
    const result = await secureApi('qzoneAdmin', {op: 'sync'});
    ui.feedError = '';
    toast(`同步完成：${result.result?.friends || 0} 位好友，新增 ${result.result?.newPosts || 0} 条`);
    pageCache.delete('qzone');
    await loadPage('qzone', pageLoaders.qzone, {force: true});
  } catch (error) {
    ui.feedError = formatError(error);
    toast(ui.feedError, true);
    pageCache.delete('qzone');
    await loadPage('qzone', pageLoaders.qzone, {force: true});
  } finally {
    ui.syncing = false;
    if (state.view === 'qzone') render();
  }
}

async function loadMoreQzoneFeed() {
  const ui = uiFor('qzone');
  if (ui.feedLoadingMore) return;
  ui.feedLoadingMore = true; render();
  try {
    const feed = pageCache.get('qzone')?.data?.feed;
    const result = await secureApi('qzoneAdmin', {op: 'feed', query: {offset: (feed?.items?.length || 0), limit: 20, friendId: ui.friendId || '', order: ui.qzoneOrder || 'desc'}});
    if (feed) {
      feed.items = [...feed.items, ...(result.items || [])];
      feed.hasMore = result.hasMore;
      feed.total = result.total;
    }
  } catch (error) {
    toast(formatError(error), true);
  } finally {
    ui.feedLoadingMore = false;
    render();
  }
}

async function reloadQzoneFeed() {
  const ui = uiFor('qzone');
  const current = pageCache.get('qzone')?.data;
  if (!current) return;
  try {
    const feed = await secureApi('qzoneAdmin', {op: 'feed', query: {offset: 0, limit: 20, friendId: ui.friendId || '', order: ui.qzoneOrder || 'desc'}});
    current.feed = feed;
    ui.feedError = '';
    render();
  } catch (error) {
    ui.feedError = formatError(error);
    toast(ui.feedError, true);
    render();
  }
}

function openStickerDetail(row) {
  const fields = {
    name: row.name,
    emotion: row.emotion || '',
    tags: (row.tags || []).join(' '),
    usage: row.usage || ''
  };
  const preview = el('img', {class: 'sticker-preview', src: row.imageUrl, alt: row.name, onerror: event => {
    event.target.replaceWith(el('div', {class: 'empty'}, '图片无法读取'));
  }});
  const body = el('div', {class: 'split'},
    el('div', {}, preview),
    el('div', {class: 'stack'},
      el('dl', {class: 'kv'},
        el('dt', {}, '来源'), el('dd', {}, row.sourceLabel),
        el('dt', {}, '收集时间'), el('dd', {}, dateText(row.createdAt)),
        el('dt', {}, '最近使用'), el('dd', {}, row.usedAt ? dateText(row.usedAt) : '未使用'),
        el('dt', {}, '文件'), el('dd', {}, `${row.mime} · ${bytesText(row.size)}`),
        el('dt', {}, '尺寸'), el('dd', {}, row.width && row.height ? `${row.width} × ${row.height}` : '未记录')),
      el('div', {class: 'form-grid'},
        field('名称', textInput(fields.name, value => { fields.name = value; })),
        field('情绪', select(fields.emotion, value => { fields.emotion = value; }, [['', '未分类'], ...['开心', '无语', '生气', '难过', '惊讶', '撒娇', '得意', '尴尬', '疑惑', '其他'].map(value => [value, value])])),
        el('div', {class: 'span-2'}, field('标签', textInput(fields.tags, value => { fields.tags = value; }, {placeholder: '空格分隔'}))),
        el('div', {class: 'span-2'}, field('用途', textArea(fields.usage, value => { fields.usage = value; }, {rows: 3, maxLength: 120}))))));
  openModal(row.name, row.emotionLabel + ' · ' + row.sourceLabel, body, [
    button('关闭', closeModal, {ghost: true}),
    button('删除', () => { closeModal(); confirmDeleteSticker(row); }, {danger: true}),
    button('保存分类', () => {
      closeModal();
      pageAction('sticker', 'stickerAdmin', {op: 'annotate', id: row.id, name: fields.name, emotion: fields.emotion, tags: fields.tags, usage: fields.usage}, '分类已保存');
    }, {primary: true})
  ]);
}

pageLoaders.sticker = async () => {
  const ui = uiFor('sticker');
  const overview = await secureApi('stickerAdmin', {op: 'overview'});
  const list = await secureApi('stickerAdmin', {
    op: 'list',
    query: {
      query: ui.query || '', emotion: ui.emotion || '', source: ui.source || '',
      from: ui.from || '', to: ui.to || '',
      sort: ui.sort || 'recent', offset: ui.offset || 0, limit: 24
    }
  });
  return {overview, list};
};

pageLoaders.qzone = async () => {
  const ui = uiFor('qzone');
  const overview = await secureApi('qzoneAdmin', {op: 'overview'});
  let friends = {items: [], total: 0};
  let feed = {items: [], total: 0, hasMore: false, offset: 0, limit: 20};
  let friendsError = '', feedError = '';
  try {
    friends = await secureApi('qzoneAdmin', {op: 'friends', query: {query: ''}});
  } catch (error) {
    friendsError = formatError(error);
  }
  try {
    feed = await secureApi('qzoneAdmin', {op: 'feed', query: {offset: 0, limit: 20, friendId: ui.friendId || '', order: ui.qzoneOrder || 'desc'}});
  } catch (error) {
    feedError = formatError(error);
  }
  if (friendsError) friends.error = friendsError;
  if (feedError) feed.error = feedError;
  return {overview, friends, feed};
};

pageLoaders.memory = async () => {
  const ui = uiFor('memory');
  const overview = await secureApi('memoryAdmin', {op: 'overview'});
  const list = await secureApi('memoryAdmin', {
    op: 'list',
    query: {
      query: ui.query || '', scope: ui.scope || '', kind: ui.kind || '',
      sort: ui.sort || 'updated', offset: ui.offset || 0, limit: 20
    }
  });
  return {overview, list};
};

pageLoaders.autonomy = async () => {
  const ui = uiFor('autonomy');
  const overview = await secureApi('autonomyAdmin', {op: 'overview'});
  const pageSize = Math.max(20, Math.min(200, Number(overview.config?.timelinePageSize) || 50));
  const [diaries, activities, time] = await Promise.all([
    secureApi('autonomyAdmin', {
      op: 'diaryList',
      query: {query: ui.diaryQuery || '', from: ui.diaryFrom || '', to: ui.diaryTo || '', offset: ui.diaryOffset || 0, limit: pageSize}
    }),
    secureApi('autonomyAdmin', {op: 'activityList', query: {offset: 0, limit: pageSize}}),
    secureApi('autonomyAdmin', {op: 'timeSummary', query: {}})
  ]);
  return {overview, diaries, activities, time};
};

window.addEventListener('beforeunload', event => {
  if (!state.ui?.autonomy?.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('hashchange', () => {
  if (state.ui?.autonomy?.dirty && !window.confirm('日记还有未保存的修改，确定离开吗？')) return;
  const next = viewFromHash();
  state.view = next;
  closeModal();
  render();
});

boot().then(() => {}).catch(error => {
  clear(root).append(el('div', { class: 'auth-panel', style: 'min-height:100vh' },
    el('div', { class: 'auth-card' },
      el('p', { class: 'eyebrow' }, 'CONNECTION FAILED'),
      el('h2', {}, '无法加载控制台'),
      el('p', { class: 'auth-sub' }, error.message))));
});

async function boot() {
  state.view = viewFromHash();
  const session = await fetchJson('/api/session');
  if (!session.configured) return renderAuth('setup');
  if (!session.authenticated) return renderAuth('login');
  state.csrf = session.csrf;
  await load();
}
