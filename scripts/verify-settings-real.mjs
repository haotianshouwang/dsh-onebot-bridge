// Real DSH + Edge + loopback TLS. No mocks, QQ connection, QR login to external services, or model calls.
import {chromium} from 'playwright-core';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchPreview,ports} from './settings-preview.mjs';
import {totp} from '../src/web/admin-totp.js';
const out=path.resolve(process.env.SETTINGS_EVIDENCE||'acceptance-runs/settings');
await mkdir(out,{recursive:true});
const report={started:new Date().toISOString(),checks:[],modules:[],external:'未连接任何真实账号或模型，未向 QQ、微信或空间发送内容。'};
const check=(v,label)=>{if(!v){report.failedCheck=label;throw new Error('check');}report.checks.push(label);};
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const BUILTINS = ['ai-chat', 'persona', 'welcome', 'poke', 'market'];
const NATIVE = ['qq-group-members', 'qq-media-agent', 'qq-sticker', 'qq-web', 'qq-official-bot',
  'qq-qzone', 'qq-tts', 'qq-memory', 'qq-autonomy', 'qq-emotion'];
const MARKET = ['qq-help', 'qq-keyword'];
const WEB_PAGES = {
  bridge: 'connection', 'web-console': 'account', 'web-auth': 'account', replies: 'permissions', receipts: 'logs',
  'qq-sticker': 'sticker', 'qq-qzone': 'qzone', 'qq-memory': 'memory', 'qq-autonomy': 'autonomy'
};
const DSH_PAGES = {bridge: 'settings', 'web-console': 'security', 'web-auth': 'security', replies: 'permissions', receipts: 'activity'};
const WEB_PLUGIN_TITLES = {sticker: '表情包', qzone: 'QQ 空间', memory: '长期记忆', autonomy: '自主时间'};
const PACKAGE_KIND = {'内置模块': 'builtin', '原生模块': 'native', '声明式扩展': 'extension'};
const sameIds = (items, expected) => items.length === expected.length && expected.every(id => items.includes(id));
const targetRow = (id,group) => `[data-module-id="${id}"][data-group="${group}"]`;
const focused = locator => locator.evaluate(el => el === document.activeElement);
const rowValue = (page, key) => page.rows.find(row => row.key === key)?.value;
function checkModule(snap, id, enabled) {
  check(snap.moduleHealth.rows.some(row => row.id === id && row.registered &&
    row.enabled === enabled && row.state === (enabled ? 'pending' : 'off')), `配置保存与运行状态 ${id} ${enabled ? '启用' : '停用'}`);
}
function decode32(s){let bits=0,v=0,out=[];for(const c of s){v=v<<5|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);bits+=5;if(bits>=8){bits-=8;out.push(v>>>bits&255);}}return Buffer.from(out);}
let stage='启动隔离宿主',live,browser,d,w,faults=new Set();
const step=s=>{stage=s;console.log(s);};
try {
  live=await launchPreview({secure:true});browser=await chromium.launch({channel:process.env.PREVIEW_BROWSER||'msedge'});
  const url=`https://127.0.0.1:${ports.tls}/`, dshRoot=`http://127.0.0.1:${ports.dsh}`;
  const contexts=await Promise.all([{}, {ignoreHTTPSErrors:true}].map(opts=>browser.newContext({viewport:{width:1440,height:900},...opts})));
  for(const ctx of contexts)await ctx.route('**/*',route=>{const u=new URL(route.request().url());return !['http:','https:'].includes(u.protocol)||['127.0.0.1','localhost'].includes(u.hostname)&&Object.values(ports).includes(Number(u.port))?route.continue():route.abort();});
  [d,w]=await Promise.all(contexts.map(ctx=>ctx.newPage()));d.setDefaultTimeout(14000);w.setDefaultTimeout(14000);
  for(const page of [d,w])page.on('pageerror',()=>faults.add(page===d?'DSH':'夜航'));
  // Keep structural evidence even if a fast response replaces duplicate shells.
  // Never record input values, HTML, response bodies or URLs.
  await w.addInitScript(() => {
    new MutationObserver(() => {
      const shells = [...document.querySelectorAll('.shell')];
      if (shells.length < 2 || window.duplicateShells) return;
      window.duplicateShells = shells.map(shell => {
        const ancestors = [];
        for (let node = shell; node; node = node.parentElement) {
          ancestors.push(node.tagName + (node.id === 'root' ? '#root' : ''));
        }
        return {view: shell.dataset.view, ancestors};
      });
    }).observe(document, {childList: true, subtree: true});
  });
  const dsh=async(action,payload={})=>{const resp=await d.request.post(dshRoot+'/api/qq-bridge',{data:{action,...payload}}),res=await resp.json();if(!res.ok)throw Error('action');return res.value;};
  step('主人入口与首次设密');
  await w.goto(url);
  await w.getByText('等待主人配置',{exact:true}).waitFor();
  check((await w.request.post(dshRoot+'/api/qq-bridge',{data:{action:'webSecurity',op:'begin'}})).status()===401,'未登录 DSH 不能绑定');
  check((await w.request.post(dshRoot+'/api/qq-bridge',{data:{action:'officialConnection',op:'qr-status'}})).status()===401,'匿名客户端不能使用官方机器人管理接口');
  await d.goto(live.url);
  await button(d,'继续').click();const onboard=d.getByRole('dialog',{name:'开始使用'});if(await onboard.waitFor({timeout:3000}).then(()=>true,()=>false)){
  await onboard.getByRole('button',{name:'关闭',exact:true}).click();await onboard.waitFor({state:'hidden'});}await button(d,'账号菜单').click();
  await d.getByText('设置',{exact:true}).first().click();
  await d.getByText('QQ 框架',{exact:true}).first().click();
  await d.getByRole('heading',{name:'全模块巡检',exact:true}).waitFor();
  check(await d.locator('#qqb-tab-health').getAttribute('aria-selected')==='true','DSH 设置默认打开模块巡检');
  const tab=name=>d.getByRole('tab',{name,exact:true}).click();
  await tab('网页安全');let pw=randomBytes(25).toString('base64url');
  await d.getByLabel('新的管理密码').fill(pw);
  await d.getByLabel('确认管理密码').fill(pw);
  await button(d,'设置网页密码').click();
  await button(d,'绑定认证器').click();const seed=decode32(await d.locator('.qqb-enroll code').textContent());
  check(await d.getByAltText('仅供当前主人扫描的认证器二维码').evaluate(el=>el.complete&&el.naturalWidth>=150),'真实认证器二维码');
  const current=()=>Math.floor(Date.now()/30000);const enrolled=current();
  await d.getByLabel('认证器验证码').fill(totp(seed,enrolled));
  await button(d,'确认绑定').click();
  await d.locator('.qqb-recovery code').first().waitFor();const codes=await d.locator('.qqb-recovery code').allTextContents();
  check(codes.length===8,'DSH 初设、绑定与领取一次性恢复码');
  await button(d,'我已保存，隐藏恢复码').click();
  step('HTTPS 网页登录');
  await w.reload();const login=async factor=>{await w.getByLabel('管理密码',{exact:true}).fill(pw);
  await w.getByLabel('二次验证',{exact:true}).fill(factor);
  await button(w,'登录控制台').click();
  await w.locator('.shell').waitFor();};
  await login(codes[0]);
  check((await contexts[1].cookies()).some(c=>c.name==='__Host-qqadmin'&&c.secure&&c.httpOnly&&c.sameSite==='Strict'),'TLS 浏览器登录、恢复码与 Secure Cookie');
  step('网页默认首页与书签');
  const monitorHeading = w.getByRole('heading', {name: '监控台', exact: true});
  const healthHeading = w.getByRole('heading', {name: '全模块巡检', exact: true});
  const nav = w.getByRole('navigation', {name: '管理导航'});
  await monitorHeading.waitFor();
  check(new URL(w.url()).hash === '' && await nav.getByRole('button').first().getAttribute('aria-current') === 'page', '无书签登录默认显示运行监控，且是导航首项');
  await w.reload();
  await monitorHeading.waitFor();
  check(await w.locator('.topbar .current').innerText() === '运行监控', '已登录时刷新根地址仍显示运行监控');
  await w.goto(url + '#unknown-view');
  await w.reload();
  await monitorHeading.waitFor();
  check(await w.locator('.shell').getAttribute('data-view') === 'overview', '未知书签回到运行监控');
  const inspectionLink = nav.getByRole('button').nth(1);
  check((await inspectionLink.innerText()).includes('模块巡检'), '模块巡检是网页导航第二项');
  await inspectionLink.click();
  await healthHeading.waitFor();
  await w.reload();
  await healthHeading.waitFor();
  check(new URL(w.url()).hash === '#health', '导航能进入模块巡检，刷新保留巡检书签');
  step('两端响应式巡检');
  await tab('模块巡检');const dims=[[1440,900],[1024,768],[390,844]];
  for(const [width,height] of dims){for(const [page,name,selector] of [[w,'web','.inspection'],[d,'dsh','.qqb-inspection']]){await page.setViewportSize({width,height});
  await page.locator(selector).waitFor();
  await page.locator(selector+' h'+(name==='web'?'1':'3')).first().scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const size=await page.locator(selector).evaluate(el=>({inside:el.scrollWidth<=el.clientWidth+2&&el.clientWidth>=Math.min(innerWidth*0.70,260),root:document.documentElement.scrollWidth<=innerWidth+2}));
  check(size.inside&&size.root,name+' '+width+'px 巡检无横向溢出');
  }}
  for(const page of [w,d])await page.setViewportSize({width:1440,height:900});
  const webView = async view => w.evaluate(v=>location.hash=v,view);
  step('真实宿主模块清单与运行监控');
  let snap = await dsh('snapshot');
  check(snap.settings.enabled === false && !snap.status?.online, '桥接停用且没有外部账号连接');
  const overview = await dsh('monitorAdmin', {op: 'overview'});
  check(Number.isFinite(overview.sampledAt) && Number.isFinite(overview.resources?.current?.at), '读取真实运行监控采样');
  check(sameIds(snap.builtins.map(p => p.id), BUILTINS), '真实宿主已注册预期 5 个内置模块');
  check(sameIds(snap.nativePackages.map(p => p.manifest.id), NATIVE), '真实宿主已注册预期 10 个原生模块');
  for (const [group, expected] of [['内置模块', BUILTINS], ['原生模块', NATIVE]]) {
    const rows = snap.moduleHealth.rows.filter(row => row.group === group);
    check(sameIds(rows.map(row => row.id),expected) && rows.every(row => row.registered && row.state !== 'fault'), group + '均有加载记录且无模块故障');
  }

  step('DSH 主人保存与清除 QQ 官方凭据');
  const officialId = 'qq-official-bot';
  await tab('模块巡检');
  await d.locator('.qqb-health-row' + targetRow(officialId,'原生模块')).getByRole('button').click();
  const official = d.locator(`.qqb-plugin-page[data-package-id="${officialId}"]`);
  const officialPage = () => dsh('pluginPageData', {id: officialId});
  check(!snap.nativePackages.find(p => p.manifest.id === officialId).enabled, 'QQ 官方机器人默认停用');
  await official.getByRole('switch',{name:'启用后自动连接',exact:true}).uncheck();
  await official.getByRole('switch',{name:'启用此插件',exact:true}).check();
  await button(official,'保存插件设置').click();
  const appIdField = official.getByLabel('AppID',{exact:true});
  const secretField = official.getByLabel('AppSecret',{exact:true});
  await appIdField.waitFor();
  snap = await dsh('snapshot');
  checkModule(snap, officialId, true);
  check(snap.nativePackages.find(p => p.manifest.id === officialId).config.autoConnect === false, '官方网关未开启自动连接');

  const appId = 'validation-' + randomBytes(12).toString('hex');
  const secret = randomBytes(25).toString('base64url');
  await appIdField.fill(appId);
  await secretField.fill(secret);
  const saving = d.waitForResponse(response => response.url() === dshRoot + '/api/qq-bridge' &&
    response.request().postDataJSON()?.action === 'officialConnection');
  await button(official,'保存凭据').click();
  const saved = await saving;
  check(saved.ok() && await saved.headerValue('cache-control') === 'no-store', '官方凭据保存响应禁止缓存');
  await official.getByRole('cell',{name:'已配置',exact:true}).waitFor();
  check(await appIdField.inputValue() === '' && await secretField.inputValue() === '' &&
    await official.getByRole('cell',{name:'未连接',exact:true}).isVisible(), 'DSH 已配置但未连接，输入框不回显');
  const stored = await readFile(path.join(live.data, 'state.json'), 'utf8');
  check(Boolean(JSON.parse(stored).framework.pluginData[officialId]?.credentialBox?.tag) &&
    !stored.includes(appId) && !stored.includes(secret), '真实插件存储存在认证密文，不含明文测试凭据');

  const webSession = await (await w.request.get(url + 'api/session')).json();
  check(webSession.authenticated === true && Boolean(webSession.csrf), '独立网页仍已认证');
  const webApi = async data => w.request.post(url+'api/action', {headers:{'x-csrf-token':webSession.csrf},data});
  const webControl = await webApi({action: 'officialConnection', op: 'clear'});
  check(webControl.status() === 400, '持有有效会话与 CSRF 的独立网页不能清除官方凭据');
  check((await w.request.post(dshRoot+'/api/qq-bridge',{data:{action:'officialConnection',op:'qr-status'}})).status()===401,'独立网页的会话不能作为 DSH 主人身份');
  const publicStatus = await webApi({action: 'pluginPageData', id: officialId});
  const statusText = await publicStatus.text();
  check(publicStatus.ok() && rowValue(JSON.parse(statusText).value, '凭据') === '已配置' &&
    !statusText.includes(appId) && !statusText.includes(secret) && !statusText.includes('credentialBox'), '独立网页只读取脱敏运行数据');

  d.once('dialog', dialog => dialog.accept());
  await button(official,'清除凭据').click();
  await official.getByRole('cell',{name:'未配置',exact:true}).waitFor();
  const cleared = await officialPage();
  check(rowValue(cleared, '凭据') === '未配置' && rowValue(cleared, '连接状态') === '未连接', 'DSH 清除加密凭据，保持网关断开');
  await official.getByRole('switch',{name:'启用此插件',exact:true}).uncheck();
  await button(official,'保存插件设置').click();
  await appIdField.waitFor({state:'detached'});
  snap = await dsh('snapshot');
  checkModule(snap, officialId, false);
  report.modules.push({id:officialId, local:'真实 DSH 页面启用、保存与清除加密凭据、停用；不连接腾讯'});

  step('逐项验证模块设置与启停');
  const mutate = async (action,data) => { snap = await dsh(action, {revision:snap.revision,...data}); };
  for (const p of snap.builtins) {
    for (const enabled of [!p.enabled,p.enabled]) {
      await mutate('configureBuiltin', {id:p.id, enabled, config:p.config});
      checkModule(snap, p.id, enabled);
    }
    report.modules.push({id:p.id, local:'真实宿主校验、保存及启停'});
  }
  for (const p of snap.nativePackages.filter(p => p.manifest.id !== officialId)) {
    const id = p.manifest.id;
    const page = await dsh('pluginPageData', {id});
    check(Array.isArray(page?.rows), '读取原生模块设置 ' + id);
    for (const enabled of [!p.enabled,p.enabled]) {
      await mutate('configureNativePackage', {id, enabled, scope:p.scope, automationGrants:p.automationGrants, config:p.config});
      checkModule(snap, id, enabled);
    }
    report.modules.push({id, local:'真实 SDK 加载、设置读取、保存及启停'});
  }
  const catalog = await dsh('catalog');
  const local = catalog.items.filter(entry => entry.source === 'builtin');
  check(sameIds(local.map(entry => entry.id), MARKET), '内置市场包含预期的 2 个声明式扩展');
  for (const {id,version} of local) {
    await mutate('installExtension', {id, source:'builtin', version});
    const p = snap.extensions.find(v => v.manifest.id === id);
    await mutate('configureExtension', {id, enabled:true, config:p.config, scope:p.scope});
    checkModule(snap, id, true);
    await mutate('configureExtension', {id, enabled:false, config:p.config, scope:p.scope});
    check(snap.moduleHealth.rows.some(r => r.id === id && !r.registered && !r.enabled && r.state === 'off'), '停用后卸载声明式运行钩子 ' + id);
    report.modules.push({id, local:'内置源校验、安装、启用、停用'});
  }
  step('入口、监控与账号退出');
  await webView('health');
  await button(w,'刷新巡检').click();
  await w.locator('.inspection-row').nth(snap.moduleHealth.rows.length-1).waitFor();
  await w.locator('[data-filter="off"]').click();
  check(await w.locator('.inspection-row:not([data-state="off"])').count()===0,'巡检按状态筛选');
  await w.locator('[data-filter="all"]').click();
  await tab('模块巡检');
  const routes = [];
  for (const row of snap.moduleHealth.rows) {
    step('巡检入口 ' + row.id);
    const target = targetRow(row.id,row.group);
    const web = WEB_PAGES[row.id] || 'plugins';
    const dshTab = DSH_PAGES[row.id] || 'plugins';
    const kind = PACKAGE_KIND[row.group];
    const card = `[data-package-kind="${kind}"][data-package-id="${row.id}"]`;
    await w.locator('.inspection-row'+target).getByRole('button').click();
    const webPanel = w.locator(`#root > .shell[data-view="${web}"]`);
    await webPanel.locator('.topbar .crumb .current').waitFor();
    const duplicate = await w.evaluate(() => window.duplicateShells);
    if (duplicate) report.duplicateShells = duplicate;
    check(!duplicate && await w.locator('.shell').count() === 1 && await w.locator('.topbar').count() === 1, '网页只挂载一个界面 ' + row.id);
    if (web === 'plugins') {
      check(await focused(webPanel.locator(card)), '网页聚焦对应插件卡 ' + row.id);
      if (row.id === officialId) {
        await button(webPanel.locator(card),'查看官方机器人状态').click();
        const dialog = w.getByRole('dialog',{name:'官方机器人状态',exact:true});
        await dialog.getByText('未配置',{exact:true}).waitFor();
        check(await dialog.getByText('未配置',{exact:true}).isVisible() &&
          await dialog.getByText('未连接',{exact:true}).isVisible() && await dialog.locator('input').count() === 0, '网页官方状态只读且同步清除结果');
        await button(dialog.locator('.modal-foot'),'关闭').click();
      }
    } else if (WEB_PLUGIN_TITLES[web]) {
      await webPanel.getByRole('heading',{name:WEB_PLUGIN_TITLES[web],exact:true,level:1}).waitFor();
      await button(webPanel,'返回插件').waitFor(); // Loaded data, not just the title in the loading state.
      check(true, '网页加载专属管理页 ' + row.id);
    }
    await d.locator('.qqb-health-row'+target).getByRole('button').click();
    await d.locator(`#qqb-tab-${dshTab}[aria-selected="true"]`).waitFor();
    const panel = d.locator(`#qqb-panel[aria-labelledby="qqb-tab-${dshTab}"]`);
    await panel.locator('.qqb-page-title h3').waitFor();
    if (kind === 'builtin') {
      const cardFocus = panel.locator(card);
      await d.waitForFunction(selector => document.activeElement?.matches(selector), card);
      check(await focused(cardFocus), 'DSH 聚焦对应内置卡 ' + row.id);
    } else if (kind) {
      await panel.locator(`.qqb-plugin-page[data-package-id="${row.id}"]`).getByRole('switch',{name:'启用此插件',exact:true}).waitFor();
      check(true, 'DSH 打开对应插件设置 ' + row.id);
    }
    routes.push({id:row.id, group:row.group, state:row.state, registered:row.registered, web, dsh:dshTab});
    await tab('模块巡检');
    await webView('health');
  }
  check(routes.length === BUILTINS.length + NATIVE.length + MARKET.length + Object.keys(DSH_PAGES).length, '覆盖全部双端设置入口');
  report.rows = routes;
  await webView('overview');
  await w.locator('.inspection').waitFor({state:'detached'});
  await w.locator('.shell[data-view="overview"] .topbar .current').waitFor();
  await w.reload();
  await monitorHeading.waitFor();
  check(await w.locator('.shell .topbar .crumb .current').first().innerText() === '运行监控' && new URL(w.url()).hash === '#overview', '旧运行监控入口保留');
  step('网页改密并验证旧会话失效');
  // A second independent, legitimately authenticated client represents another device.
  const other=await browser.newContext({ignoreHTTPSErrors:true});
  const second=await other.request.post(url+'api/login',{data:{password:pw,factor:codes[1]}});
  check(second.status()===200,'改密前另一设备会话有效');
  const next=randomBytes(25).toString('base64url');
  await webView('account');await w.getByLabel('当前密码',{exact:true}).fill(pw);
  await w.getByLabel('新密码',{exact:true}).fill(next);await w.getByLabel('确认新密码',{exact:true}).fill(next);
  await button(w,'更新密码').click();await w.getByText('密码已更新，其他会话已退出',{exact:true}).waitFor();
  check(!(await (await other.request.get(url+'api/session')).json()).authenticated && (await (await w.request.get(url+'api/session')).json()).authenticated,'改密后其他设备失效、当前网页获得新会话');
  check((await other.request.post(url+'api/login',{data:{password:pw,factor:codes[2]}})).status()===401,'原密码不能再登录');
  await other.close();pw=next;
  await webView('health');await w.getByRole('heading',{name:'全模块巡检',exact:true}).waitFor();
  await contexts[1].setOffline(true);
  await w.locator('.topbar').getByRole('button',{name:'退出登录',exact:true}).click();
  await button(w,'重试退出').waitFor();
  check(await w.locator('.shell').count()===0 && await w.getByText('页面已锁定',{exact:true}).count()===1,'断网退出立即锁屏，不误报服务端退出');
  await contexts[1].setOffline(false);
  check((await (await w.request.get(url+'api/session')).json()).authenticated===true,'断网后服务端会话仍有效');
  await button(w,'重试退出').click();
  await w.getByLabel('管理密码',{exact:true}).waitFor();
  check((await (await w.request.get(url+'api/session')).json()).authenticated===false,'重试退出后服务端会话已撤销');
  if(current()===enrolled)await new Promise(r=>setTimeout(r,30000-Date.now()%30000+50));
  await login(totp(seed,current()));seed.fill(0);
  await healthHeading.waitFor();
  check(new URL(w.url()).hash === '#health', '从巡检书签重新登录后仍在模块巡检');
  await tab('网页安全');d.once('dialog',dlg=>dlg.accept());
  await button(d,'撤销全部网页会话').click();
  await d.getByText('全部网页会话已撤销',{exact:true}).waitFor();
  await w.reload();
  await w.getByLabel('管理密码',{exact:true}).waitFor();
  check(true,'新密码与真实 TOTP 再登录、DSH 撤销后网页会话失效');
  check(faults.size===0,'两端无未捕获浏览器错误');
  report.result='通过';
} catch (error) {
  report.result='失败'; report.failedStage=stage;
  report.failureType=error.name; report.failedLine=String(error.stack||'').match(/verify-settings-real\.mjs:(\d+):\d+/)?.[1]||null;
  if (error.code === 'DSH_PREVIEW_STARTUP') report.startupDiagnostic = error.diagnostic;
  report.browserFaults=[...faults];
  if(w) {
    report.duplicateShells ||= await w.evaluate(()=>window.duplicateShells).catch(()=>undefined);
    report.webAuth = await w.request.get(`https://127.0.0.1:${ports.tls}/api/session`).then(async response=>{
      const session=await response.json();
      return Object.fromEntries(['authenticated','configured','locked','factorRequired','awaitingEnrollment'].filter(key=>typeof session[key]==='boolean').map(key=>[key,session[key]]));
    }).catch(()=>null);
  }
  console.error('未通过：',stage,report.failureType,report.failedLine||''); process.exitCode=1;
}
finally{await browser?.close();
  await live?.close();report.finished=new Date().toISOString();
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
