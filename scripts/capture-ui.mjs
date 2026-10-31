// 使用无头 Edge + CDP 对隔离验收站点做交互截图。
// 仅用于本地 UI 验收；不连接 3097 的真实管理状态。
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const base = process.env.VISUAL_URL || 'http://127.0.0.1:4010';
const out = process.env.VISUAL_OUT || 'F:\\大肥鱼\\verify';
const profile = await mkdtemp(path.join(os.tmpdir(), 'edge-cdp-'));
await mkdir(out, {recursive: true});
const port = 9333;
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-allow-origins=*', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'
], {stdio: 'ignore'});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function endpoint() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = (await response.json()).filter(page => page.type === 'page' && page.webSocketDebuggerUrl);
        if (pages.length) return pages[0].webSocketDebuggerUrl;
      }
    } catch { /* 等待启动 */ }
    await sleep(200);
  }
  throw new Error('Edge 页面调试端口未就绪');
}

const ws = new WebSocket(await endpoint());
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let id = 0;
const pending = new Map();
const errors = [];
ws.on('message', raw => {
  const message = JSON.parse(String(raw));
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'uncaught exception');
  }
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    errors.push(message.params.entry.text);
  }
  if (message.id && pending.has(message.id)) {
    const {resolve, reject} = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const messageId = ++id;
  pending.set(messageId, {resolve, reject});
  ws.send(JSON.stringify({id: messageId, method, params}));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
const viewportWidth = Number(process.env.VISUAL_WIDTH) || 1440;
const viewportHeight = Number(process.env.VISUAL_HEIGHT) || 1000;
await send('Emulation.setDeviceMetricsOverride', {width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1, mobile: false});

async function navigate(route) {
  await send('Page.navigate', {url: base + '/#' + route});
  await sleep(3200);
}
async function shot(name) {
  const result = await send('Page.captureScreenshot', {format: 'png'});
  await writeFile(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
  console.log('captured', name);
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
  return result.result?.value;
}

try {
  await navigate('sticker');
  await shot('sticker');
  await navigate('sticker');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='详情'); b?.click(); return true; })()`);
  await sleep(700);
  await shot('sticker-detail');
  await send('Page.navigate', {url: base + '/#sticker'});
  await sleep(1200);

  await navigate('qzone');
  await evaluate(`(() => {
    const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='同步好友动态');
    button?.click(); return 'clicked';
  })()`);
  await sleep(2600);
  await shot('qzone-posts');

  await navigate('memory/review');
  await sleep(1200);
  await shot('memory-review');
  await navigate('memory/graph');
  await shot('memory-graph');
  await evaluate(`(() => {
    const input=[...document.querySelectorAll('input')].find(x=>x.placeholder.includes('搜索记忆'));
    if(!input) return 'no-input';
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,'生日'); input.dispatchEvent(new Event('input',{bubbles:true}));
    const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='定位');
    button?.click(); return 'clicked';
  })()`);
  await sleep(1200);
  await shot('memory-graph-focus');
  await navigate('memory');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='查看'); b?.click(); return true; })()`);
  await sleep(700);
  await shot('memory-detail');

  await navigate('autonomy/secret');
  await sleep(1000);
  await shot('autonomy-secret');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='立即锁定'); b?.click(); return true; })()`);
  await sleep(1000);
  await shot('autonomy-secret-locked');

  await navigate('autonomy/diary');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='编辑'); b?.click(); return true; })()`);
  await sleep(500);
  await shot('autonomy-diary-edit');
  await send('Page.navigate', {url: base + '/#autonomy'});
  await sleep(1200);
  if (errors.length) {
    console.error('BROWSER_ERRORS');
    for (const error of errors) console.error('- ' + error);
    process.exitCode = 1;
  } else {
    console.log('browser console clean');
  }
} finally {
  try { await send('Browser.close'); } catch { /* 忽略 */ }
  ws.close();
  browser.kill();
  await sleep(300);
  try { await rm(profile, {recursive: true, force: true}); } catch { /* Edge 可能仍持有 Crashpad 临时文件 */ }
}
