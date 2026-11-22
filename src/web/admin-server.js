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
import { AdminAuth } from './admin-auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
// Serve both halves from the same installed three.js version.
const THREE_BUILD = path.dirname(fileURLToPath(import.meta.resolve('three')));
const THREE_MODULE = path.join(THREE_BUILD, 'three.module.min.js');
const THREE_CORE_MODULE = path.join(THREE_BUILD, 'three.core.min.js');
const COOKIE = 'qqadmin';
const MAX_BODY = 256 * 1024;
const ALLOWED_ACTIONS = new Set([
  'snapshot', 'test', 'preview', 'catalog', 'chatDetails', 'groups', 'friends', 'mediaInfo', 'selfTest',
  'saveSettings', 'saveConversation', 'saveChatProfile', 'clearChatProfile', 'saveFramework',
  'configureBuiltin', 'configureNativePackage', 'configureExtension', 'pluginPageData',
  'savePersona', 'importPersona', 'deletePersona', 'setDefault', 'clearBotDefault', 'bindPersona', 'resetSession',
  'prepareUninstall', 'cancelUninstall', 'confirmUninstall', 'restorePackage', 'restorePluginSettings',
  'stickerAdmin', 'qzoneAdmin', 'memoryAdmin', 'autonomyAdmin', 'secretAdmin', 'monitorAdmin'
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

export function adminEndpoint(publicOrigin, port) {
  if (!publicOrigin) return {url:`http://127.0.0.1:${port}/`, secure:false};
  let url; try { url = new URL(publicOrigin); } catch { /* rejected below */ }
  if (!url || url.protocol !== 'https:' || !url.hostname || url.origin !== publicOrigin.replace(/\/$/, '')) throw new Error('QQBOT_ADMIN_ORIGIN 必须是一个完整 HTTPS 来源，不含路径、用户信息或参数');
  return {url:url.origin + '/', secure:true, origin:url.origin, host:url.host};
}
function sameOrigin(req, port, endpoint) {
  const host = req.headers.host, origin = req.headers.origin;
  if (endpoint.secure) return host === endpoint.host && req.headers['x-forwarded-proto'] === 'https' && (!origin || origin === endpoint.origin);
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host) && (!origin || origin === `http://${host}`);
}
export async function startAdminServer({dir, auth:shared, action, asset, onSessionEnd, log = () => {}, port = Number(process.env.QQBOT_ADMIN_PORT) || 3097, host = '127.0.0.1', publicOrigin = process.env.QQBOT_ADMIN_ORIGIN} = {}) {
  if (typeof action !== 'function') throw new Error('管理站点缺少桥接处理器');
  if (!['127.0.0.1','::1'].includes(host)) throw new Error('管理站点必须监听回环地址');
  const endpoint = adminEndpoint(publicOrigin, port);
  const name = endpoint.secure ? '__Host-qqadmin' : COOKIE;
  const cookie = (value, age=43200) => `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${endpoint.secure ? '; Secure' : ''}`;
  const auth = shared || await new AdminAuth(dir,{onSessionEnd}).open();
  // 资源按请求读取，改完 public/ 下的页面刷新即可看到；启动时先读一遍，缺文件时尽早失败。
  const assets = new Map();
  for (const [name, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/assets/app.css', 'app.css', 'text/css; charset=utf-8'],
    ['/assets/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/assets/monitor-dashboard.js', 'monitor-dashboard.js', 'text/javascript; charset=utf-8'],
    ['/assets/star-map.js', 'star-map.js', 'text/javascript; charset=utf-8'],
    ['/assets/three.module.js', THREE_MODULE, 'text/javascript; charset=utf-8'],
    ['/assets/three.core.min.js', THREE_CORE_MODULE, 'text/javascript; charset=utf-8']
  ]) assets.set(name, { file, type });
  const assetPath = value => path.isAbsolute(value.file) ? value.file : path.join(PUBLIC_DIR, value.file);
  await Promise.all([...assets.values()].map(value => readFile(assetPath(value))));

  const server = http.createServer(async (req, res) => {
    try {
      const address = String(req.socket.remoteAddress || '');
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(address)) return sendJson(res, 403, { ok: false, error: '只允许本机访问' });
      if (endpoint.secure) res.setHeader('strict-transport-security', 'max-age=31536000');
      if (!sameOrigin(req, server.address().port, endpoint)) return sendJson(res, 403, { ok: false, error: '来源校验失败' });

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      if ((method === 'GET' || method === 'HEAD') && assets.has(pathname)) {
        const asset = assets.get(pathname);
        try {
          if (method === 'HEAD') { res.writeHead(200, headers({'content-type': asset.type})); return res.end(); }
          const body = await readFile(assetPath(asset));
          res.writeHead(200, headers({ 'content-type': asset.type, 'content-length': body.length, 'cache-control': 'no-cache' }));
          return res.end(body);
        } catch (error) {
          log('error', '页面资源读取失败：' + error.message);
          return sendJson(res, 500, { ok: false, error: '页面资源缺失，请重新安装插件' });
        }
      }

      if (method === 'GET' && pathname === '/api/session') {
        const session = auth.session(parseCookies(req)[name]);
        return sendJson(res, 200, {ok: true, configured: auth.configured, locked: auth.corrupt, factorRequired: endpoint.secure || Boolean(auth.record?.mfa), awaitingEnrollment: endpoint.secure && !auth.record?.mfa, authenticated: Boolean(session), csrf: session?.csrf || null});
      }

      // 图片按会话鉴权，直接返回二进制；CSP 的 img-src 'self' 允许同源地址，
      // 不把 QQ 图片域名或 Cookie 暴露给浏览器。
      const imageRoutes = {'/api/sticker-image': 'sticker', '/api/qzone-image': 'qzone-image', '/api/qzone-avatar': 'qzone-avatar', '/api/bot-avatar': 'bot-avatar'};
      if (method === 'GET' && imageRoutes[pathname]) {
        const token = parseCookies(req)[name];
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

      if (pathname === '/api/setup') return sendJson(res,403,{ok:false,error:'请由主人在 DSH 设置中初始化'});
      if (pathname === '/api/login') {
        const body = await readJson(req);
        const proof = await auth.login(body.password, body.factor, endpoint.secure, {ip:address,ua:req.headers['user-agent']});
        if (proof.unavailable) return sendJson(res,409,{ok:false,error:'网页登录尚不可用，请检查 DSH 网页安全设置'});
        if (proof.wait) return sendJson(res,429,{ok:false,error:'尝试次数过多，请稍后重试'},{'retry-after':String(proof.wait)});
        if (!proof.token) return sendJson(res,401,{ok:false,error:'登录凭据不正确或验证码已使用'});
        return sendJson(res,200,{ok:true,csrf:proof.csrf},{'set-cookie':cookie(proof.token)});
      }
      const token = parseCookies(req)[name];
      const session = auth.session(token);

      if (!session) return sendJson(res, 401, { ok: false, error: '请先登录' });
      const csrf = String(req.headers['x-csrf-token'] || '');
      if (!csrf || csrf !== session.csrf) return sendJson(res, 403, { ok: false, error: 'CSRF 校验失败，请刷新页面' });

      if (pathname === '/api/logout') {
        auth.destroy(token);
        return sendJson(res, 200, {ok:true}, {'set-cookie':cookie('',0)});
      }
      if (pathname === '/api/password') {
        const body = await readJson(req);
        let fresh; try { fresh = await auth.changePassword(token, body.current, body.password); }
        catch (e) { return sendJson(res,400,{ok:false,error:e.message}); }
        return sendJson(res,200,{ok:true,csrf:fresh.csrf},{'set-cookie':cookie(fresh.token)});
      }
      if (pathname === '/api/action') {
        const body = await readJson(req);
        const name = body?.action;
        if (typeof name !== 'string' || !ALLOWED_ACTIONS.has(name)) return sendJson(res, 400, { ok: false, error: '不支持的操作' });
        const { action: _action, ...payload } = body;
        try {
          const value = await action({action: name, ...payload}, {adminSession: token, session: token, ip: address});
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
  const actualPort = server.address().port;
  const {url} = adminEndpoint(publicOrigin, actualPort);
  log('info', '独立管理站点：' + url);
  return {
    port:actualPort, url,
    close: () => new Promise(resolve => {
      auth.revokeAll();
      try { server.closeAllConnections?.(); } catch { /* already stopped */ }
      server.close(() => resolve());
    })
  };
}
