// Fresh real DSH web profile; never import an existing account, URL token or environment secrets.
import {mkdir, writeFile, readFile, symlink, realpath, mkdtemp, unlink, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {previewProxy} from './settings-preview-proxy.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const local='127.0.0.1';
export const ports={dsh:43880,admin:43897,tls:43898};
export async function launchPreview({cli=process.env.DSH_PREVIEW_CLI,secure=false,open=false}={}) {
  if(!cli || !existsSync(cli))throw new Error('请通过 DSH_PREVIEW_CLI 指定已安装的 DSH bin.js');
  for(const port of Object.values(ports))await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',()=>reject(new Error(`隔离端口 ${port} 已被占用`)));s.listen(port,local,()=>s.close(resolve));});
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'night-watch-preview-'))),work=path.join(root,'work'),home=path.join(root,'home');
  const profile=path.join(home,'profiles','web'), modules=path.join(profile,'node_modules');
  const data=path.join(work,'data','dsh-onebot-bridge'); await mkdir(data,{recursive:true});await mkdir(modules,{recursive:true});
  await symlink(await realpath(source),path.join(modules,'dsh-onebot-bridge'),process.platform==='win32'?'junction':'dir');
  await writeFile(path.join(profile,'package.json'),JSON.stringify({name:'night-watch-preview',private:true,dependencies:{'dsh-onebot-bridge':'file:'+source},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-onebot-bridge']}}}));
  await writeFile(path.join(profile,'cordis.patch.yml'),'[]\n');
  let installed=path.dirname(path.resolve(cli));
  while(path.basename(installed)!=='node_modules') {
    const parent=path.dirname(installed);
    if(parent===installed)throw new Error('Cannot locate isolated DSH dependencies');
    installed=parent;
  }
  const scoped=path.join(modules,'@deepseek-ai');await mkdir(scoped,{recursive:true});
  for(const bundle of ['dsh-base','dsh-web-app'])await symlink(await realpath(path.join(installed,'@deepseek-ai',bundle)),path.join(scoped,bundle),process.platform==='win32'?'junction':'dir');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|programfiles(\(x86\))?|programw6432|systemdrive)$/i.test(k)));
  Object.assign(env,{HOME:root,USERPROFILE:root,LOCALAPPDATA:path.join(root,'local'),APPDATA:path.join(root,'roaming'),DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',QQBOT_ADMIN_PORT:String(ports.admin)});
  if(secure)env.QQBOT_ADMIN_ORIGIN=`https://${local}:${ports.tls}`;
  const init=spawnSync(process.execPath,['--input-type=module','-e',`import {defaults} from ${JSON.stringify(pathToFileURL(path.join(source,'src/host/store.js')).href)}; const s=defaults();Object.assign(s.settings,{enabled:false,url:'ws://127.0.0.1:43899',reversePort:43900,adminConsoleEnabled:true});s.sources=[];console.log(JSON.stringify(s));`],{cwd:work,env,encoding:'utf8',windowsHide:true});
  if(init.status!==0)throw new Error('无法生成隔离默认状态');
  const state=JSON.parse(init.stdout);if(path.dirname(home)!==root || path.dirname(work)!==root || state.settings.enabled!==false || state.settings.url!=='ws://127.0.0.1:43899' || state.settings.reversePort!==43900 || state.sources.length)throw new Error('隔离检查失败');
  await writeFile(path.join(data,'state.json'),JSON.stringify(state),{flag:'wx'});
  let stopProxy;
  if(secure)stopProxy=await previewProxy(root,ports);
  const child=spawn(process.execPath,['--import',pathToFileURL(path.join(source,'scripts/settings-isolation-guard.mjs')).href,cli,'--profile','web','--host',local,'--port',String(ports.dsh),...open?[]:['--no-open']],{cwd:work,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let closing;
  const close=()=>closing??=(async()=>{
    if(child.exitCode===null && !child.signalCode)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
    await stopProxy?.();
    const parent=await realpath(os.tmpdir());
    if(path.dirname(root)!==parent || !/^night-watch-preview-[a-z0-9]+$/i.test(path.basename(root)) || await realpath(root)!==root)throw Error('拒绝清理非预览目录');
    for(const link of [path.join(modules,'dsh-onebot-bridge'),...['dsh-base','dsh-web-app'].map(id=>path.join(scoped,id))]) await unlink(link);
    await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:300});
  })();
  const url=await new Promise((resolve,reject)=>{
    // The DSH output can contain a session URL. Keep it only in memory, and
    // allowlist diagnostic labels instead of attempting to redact arbitrary logs.
    const status=new Set();
    const diagnostic=()=>[...status].join('、')||'无启动输出';
    const stop=()=>{clearTimeout(timer);for(const discard of readers)discard();};
    const fail=(message)=>{stop();reject(Object.assign(new Error(message),{code:'DSH_PREVIEW_STARTUP',diagnostic:diagnostic()}));};
    const timer=setTimeout(()=>fail('隔离 DSH 启动超时'),180000);
    child.once('error',()=>fail('无法启动隔离 DSH 子进程'));
    child.once('exit',code=>fail('隔离 DSH 已退出：'+code));
    const consume=(stream,name)=>{
      let tail='';
      const read=chunk=>{
        status.add(name);
        tail=(tail+chunk.toString().replace(/\x1b\[[0-9;]*m/g,'')).slice(-8192);
        for(const [pattern,label] of [
          [/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/,'缺少依赖'],
          [/EADDRINUSE/,'端口占用'], [/EACCES|隔离预览禁止连接/,'访问受限'],
          [/SyntaxError|ReferenceError|TypeError/,'运行时异常'],
          [/StartupError|Full diagnostics:/,'宿主启动失败'],
          [/install|pnpm/i,'依赖初始化'], [/dsh web:/,'网页服务启动信息']
        ])if(pattern.test(tail))status.add(label);
        const match=tail.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_%.-]+)\s/);
        if(!match || new URL(match[1]).port!==String(ports.dsh))return;
        stop();
        resolve(match[1]);
      };
      stream.on('data',read);
      return ()=>{stream.off('data',read);stream.resume();tail='';};
    };
    const readers=[consume(child.stdout,'stdout'),consume(child.stderr,'stderr')];
  }).catch(async error=>{await close();throw error;});
  return {root,home,work,data,url,child,close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const live=await launchPreview({open:process.argv.includes('--open'),secure:process.argv.includes('--https')});
  console.log('隔离控制台：'+(process.argv.includes('--https')?'https://127.0.0.1:43898/':'http://127.0.0.1:43897/')+'  ·  Ctrl+C 停止。');
  process.once('SIGINT',()=>void live.close());process.once('SIGTERM',()=>void live.close());
}
