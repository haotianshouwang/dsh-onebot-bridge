// 独立管理站点：只监听 127.0.0.1，密码登录后提供 QQ 框架的常用设置。
//
// 安全基线：
// - scrypt 口令哈希、内存会话（12 小时绝对/30 分钟空闲）、HttpOnly + SameSite=Strict Cookie；
// - 所有写请求要求会话内 CSRF 令牌；登录每 IP 15 分钟 5 次失败即限速；
// - 校验 Host 与 Origin，防 DNS rebinding 与跨站提交；严格 CSP；请求体上限；
// - 只转发白名单内的桥接动作，不暴露原始网关调用、媒体上传和任意代执行。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminAuth, validatePassword } from './admin-auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'qqadmin';
const MAX_BODY = 256 * 1024;
const ALLOWED_ACTIONS = new Set([
  'snapshot', 'test', 'preview', 'catalog', 'chatDetails', 'groups', 'friends', 'mediaInfo', 'selfTest',
  'saveSettings', 'saveConversation', 'saveChatProfile', 'clearChatProfile', 'saveFramework',
  'configureBuiltin', 'configureNativePackage', 'configureExtension', 'pluginPageData',
  'savePersona', 'importPersona', 'deletePersona', 'setDefault', 'clearBotDefault', 'bindPersona', 'resetSession',
  'prepareUninstall', 'cancelUninstall', 'confirmUninstall', 'restorePackage', 'restorePluginSettings',
  'stickerAdmin', 'qzoneAdmin', 'memoryAdmin', 'autonomyAdmin', 'secretAdmin'
]);

function headers(extra = {}) {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...extra
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, headers({ 'content-type': type, 'content-length': Buffer.byteLength(payload), ...extra }));
  res.end(payload);
}

function sendJson(res, status, value, extra = {}) {
  send(res, status, value, 'application/json; charset=utf-8', extra);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function cookie(value, maxAge = 43200) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体不是 JSON'), { status: 400 }); }
}

function sameOrigin(req, port) {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const origin = req.headers.origin;
  if (origin && !allowed.has(String(origin))) return false;
  const host = String(req.headers.host || '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

export async function startAdminServer({dir, action, asset, onSessionEnd, log = () => {}, port = Number(process.env.QQBOT_ADMIN_PORT) || 3097, host = '127.0.0.1'} = {}) {
  if (typeof action !== 'function') throw new Error('管理站点缺少桥接处理器');
  const auth = await new AdminAuth(dir).open();
  // 资源按请求读取，改完 public/ 下的页面刷新即可看到；启动时先读一遍，缺文件时尽早失败。
  const assets = new Map();
  for (const [name, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/assets/app.css', 'app.css', 'text/css; charset=utf-8'],
    ['/assets/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/assets/star-map.js', 'star-map.js', 'text/javascript; charset=utf-8']
  ]) assets.set(name, { file, type });
  await Promise.all([...assets.values()].map(asset => readFile(path.join(PUBLIC_DIR, asset.file))));

  let tail = Promise.resolve();
  const runAction = (body, meta) => {
    const task = tail.then(() => action(body, meta));
    tail = task.catch(() => {});
    return task;
  };
  const endSession = token => {
    try { onSessionEnd?.(token); } catch (error) { log('warn', '会话结束回调失败：' + error.message); }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const address = String(req.socket.remoteAddress || '');
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(address)) return sendJson(res, 403, { ok: false, error: '只允许本机访问' });
      if (!sameOrigin(req, port)) return sendJson(res, 403, { ok: false, error: '来源校验失败' });

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      if (method === 'GET' && assets.has(pathname)) {
        const asset = assets.get(pathname);
        try {
          const body = await readFile(path.join(PUBLIC_DIR, asset.file));
          res.writeHead(200, headers({ 'content-type': asset.type, 'content-length': body.length, 'cache-control': 'no-cache' }));
          return res.end(body);
        } catch (error) {
          log('error', '页面资源读取失败：' + error.message);
          return sendJson(res, 500, { ok: false, error: '页面资源缺失，请重新安装插件' });
        }
      }

      if (method === 'GET' && pathname === '/api/session') {
        const session = auth.session(parseCookies(req)[COOKIE]);
        return sendJson(res, 200, {ok: true, configured: auth.configured, authenticated: Boolean(session), csrf: session?.csrf || null});
      }

      // 图片按会话鉴权，直接返回二进制；CSP 的 img-src 'self' 允许同源地址，
      // 不把 QQ 图片域名或 Cookie 暴露给浏览器。
      const imageRoutes = {'/api/sticker-image': 'sticker', '/api/qzone-image': 'qzone-image', '/api/qzone-avatar': 'qzone-avatar'};
      if (method === 'GET' && imageRoutes[pathname]) {
        const token = parseCookies(req)[COOKIE];
        const session = auth.session(token);
        if (!session) return sendJson(res, 401, {ok: false, error: '请先登录'});
        if (typeof asset !== 'function') return sendJson(res, 404, {ok: false, error: '资源接口未启用'});
        try {
          const image = await asset({
            kind: imageRoutes[pathname],
            id: url.searchParams.get('id') || '',
            url: url.searchParams.get('url') || ''
          }, {session: token, ip: address});
          if (!image?.bytes?.length || !/^image\/(png|jpeg|gif|webp)$/.test(String(image.mime || ''))) return sendJson(res, 404, {ok: false, error: '图片不存在'});
          res.writeHead(200, headers({
            'content-type': image.mime,
            'content-length': image.bytes.length,
            'cache-control': 'private, max-age=300',
            'content-disposition': 'inline'
          }));
          return res.end(image.bytes);
        } catch (error) {
          return sendJson(res, error.status || 404, {ok: false, error: String(error?.message || error).slice(0, 120)});
        }
      }

      if (method !== 'POST') return sendJson(res, 405, {ok: false, error: '不支持的请求'});
      if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { ok: false, error: '只接受 JSON' });

      if (pathname === '/api/setup') {
        if (auth.configured) return sendJson(res, 409, { ok: false, error: '已经设置过密码' });
        const body = await readJson(req);
        const invalid = validatePassword(body.password);
        if (invalid) return sendJson(res, 400, { ok: false, error: invalid });
        await auth.setPassword(body.password);
        const { token, csrf } = auth.createSession({ ip: address, ua: req.headers['user-agent'] });
        await auth.audit({ outcome: 'setup', ip: address, ua: req.headers['user-agent'] });
        return sendJson(res, 200, { ok: true, csrf }, { 'set-cookie': cookie(token) });
      }

      if (pathname === '/api/login') {
        if (!auth.configured) return sendJson(res, 409, { ok: false, error: '还没有设置密码' });
        const wait = auth.loginBlocked(address);
        if (wait) return sendJson(res, 429, { ok: false, error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` }, { 'retry-after': String(wait) });
        const body = await readJson(req);
        if (await auth.verify(body.password)) {
          auth.loginSucceeded(address);
          const { token, csrf } = auth.createSession({ ip: address, ua: req.headers['user-agent'] });
          await auth.audit({ outcome: 'login', ip: address, ua: req.headers['user-agent'] });
          return sendJson(res, 200, { ok: true, csrf }, { 'set-cookie': cookie(token) });
        }
        auth.loginFailed(address);
        await auth.audit({ outcome: 'login-failed', ip: address, ua: req.headers['user-agent'] });
        return sendJson(res, 401, { ok: false, error: '密码不正确' });
      }

      const token = parseCookies(req)[COOKIE];
      const session = auth.session(token);

      if (pathname === '/api/logout') {
        endSession(token);
        auth.destroy(token);
        return sendJson(res, 200, {ok: true}, {'set-cookie': cookie('', 0)});
      }

      if (!session) return sendJson(res, 401, { ok: false, error: '请先登录' });
      const csrf = String(req.headers['x-csrf-token'] || '');
      if (!csrf || csrf !== session.csrf) return sendJson(res, 403, { ok: false, error: 'CSRF 校验失败，请刷新页面' });

      if (pathname === '/api/password') {
        const body = await readJson(req);
        if (!(await auth.verify(body.current))) return sendJson(res, 401, { ok: false, error: '当前密码不正确' });
        const invalid = validatePassword(body.password);
        if (invalid) return sendJson(res, 400, { ok: false, error: invalid });
        await auth.setPassword(body.password);
        for (const key of auth.sessions.keys()) { endSession(key); auth.destroy(key); }
        const fresh = auth.createSession({ip: address, ua: req.headers['user-agent']});
        await auth.audit({ outcome: 'password-changed', ip: address, ua: req.headers['user-agent'] });
        return sendJson(res, 200, { ok: true, csrf: fresh.csrf }, { 'set-cookie': cookie(fresh.token) });
      }

      if (pathname === '/api/action') {
        const body = await readJson(req);
        const name = body?.action;
        if (typeof name !== 'string' || !ALLOWED_ACTIONS.has(name)) return sendJson(res, 400, { ok: false, error: '不支持的操作' });
        const { action: _action, ...payload } = body;
        try {
          const value = await runAction({action: name, ...payload}, {adminSession: token, session: token, ip: address});
          return sendJson(res, 200, {ok: true, value});
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message || error).slice(0, 300) });
        }
      }

      return sendJson(res, 404, { ok: false, error: '页面不存在' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { ok: false, error: String(error?.message || error).slice(0, 300) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  log('info', '独立管理站点：http://127.0.0.1:' + port + (auth.configured ? '' : '（首次打开需要设置密码）'));

  return {
    port,
    close: () => new Promise(resolve => {
      try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
      server.close(() => resolve());
    })
  };
}
