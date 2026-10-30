import {isOwner} from '../core/owners.js';
import z from '@deepseek-ai/schemastery';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store,validateSettings,ids } from './store.js';
import { OneBot } from '../onebot/index.js';
import {IncomingMedia} from '../session/incoming.js';
import { NativeDSH } from '../session/native.js';
import { Permissions,validatePolicy,invalidate,SYSTEM_DENIED } from '../core/permissions.js';
import { Events } from '../core/events.js';
import { Media } from '../core/media.js';
import { Actions } from '../core/actions.js';
import { Builtins } from '../builtins/index.js';
import {PluginSDK} from '../sdk.js';
import {packagesFor,FRAMEWORK_VERSION,rememberSettings,migrateConfig,validateConfig as checkConfig} from '../core/package-model.js';
import {activateQzone} from '../builtins/qzone/index.js';
import {createQzoneBackend} from '../builtins/qzone/backend.js';
import {activateWeb} from '../builtins/web/index.js';
import {activateGroupMembers} from '../builtins/group-members/index.js';
import {validateProfile,chatSettings} from '../session/chat-profile.js';
import {Uninstaller} from '../core/uninstall.js';
import { Router } from '../session/router.js';
import { Extensions,validateConfig } from '../extensions/index.js';
import { Market } from '../market/index.js';
import { validatePersona,resolvePersona,renderPersona,assertCanDelete,importPersona } from '../personas/index.js';
export const name='dsh-onebot-bridge';
export const inject=['connection','sessionController','workspaceController','credentials','llm','tools','agentPresets','fileUploads','agentDefaultModel','attachments'];
export const Config=z.object({dataDir:z.string().default(path.resolve(process.cwd(),'data','dsh-onebot-bridge'))});
const tokenRef='DSH_ONEBOT_ACCESS_TOKEN';
export async function apply(ctx,config) {
  const store=await new Store(config.dataDir).open();let bot,router,closed=false,adminTail=Promise.resolve();
  const storedToken=(await ctx.credentials.resolve(tokenRef))?.value;
  let token=storedToken||(!store.data.tokenInitialized?process.env.QQBOT_ACCESS_TOKEN||'':'');
  if(token&&!storedToken)await ctx.credentials.set(tokenRef,token);
  if(!store.data.tokenInitialized){store.data.tokenInitialized=true;await store.persist();}
  const log=(level,message,detail)=>{const safe=String(message).replaceAll(token||'\0','[已隐藏]');store.log(level,safe,detail);ctx.logger[level==='error'?'warn':level]?.(safe);};
  const permissions=new Permissions(store),events=new Events(store,log),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store);
  const incoming=new IncomingMedia(store,permissions,log),native=new NativeDSH(ctx,store,permissions,actions,incoming);
  const sdk=new PluginSDK({store,permissions,events,media,actions,onChange:async reason=>{if(reason?.reason==='quarantine'){store.data.revision++;await store.persist();return;}invalidate(store);await native.revoke();await store.persist();},automaticReply:(receipt,text)=>router.automaticReply(receipt,text),log});
  const packages=packagesFor(store);
  ctx.provide('qqFramework',sdk.facade());
  const extensions=new Extensions(store,log,actions);
  const market=new Market(store,extensions,path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../examples'),log);
  router=new Router(store,native,extensions,log,{permissions,events,actions,builtins});
  activateGroupMembers(sdk.facade());
  activateWeb(sdk.facade());
  activateQzone(sdk.facade(),createQzoneBackend(()=>bot));
  const uninstaller=new Uninstaller(store,{builtins,extensions,beforeChange:async()=>{invalidate(store);await native.revoke();}});
  const maintenance=setInterval(()=>sdk.pruneStorage().catch(e=>log('warn',e.message)),60000);maintenance.unref?.();
  events.subscribe('core-router',['message'],msg=>router.receive(msg));
  events.subscribe('core-notices',['notice'],async event=>{await router.poke(event);await router.notice(event);});
  async function connect(){
    if(bot)await bot.stop();bot=new OneBot(store.data.settings,token,log);router.attach(bot);
    bot.on('event',event=>{events.receive(event).catch(e=>log('error',e.message));});
    bot.on('ready',()=>{router.recover().catch(e=>log('error',e.message));});
    if(store.data.settings.enabled)try{await bot.start();}catch(e){log('error','OneBot 启动失败：'+e.message);}
  }
  function snapshot(){
    return {participation:router.participation.snapshot(),chatProfiles:store.data.chatProfiles,promptStatus:native.lastPromptCheck,presetStatus:native.presetStatus,mediaStatus:incoming.status,pluginPages:[...sdk.pageList(),...Object.entries(store.data.extensions).filter(([,p])=>p.manifest.hostApiVersion===2).map(([id,p])=>({id,native:false,title:p.manifest.settings?.title||p.manifest.name,description:p.manifest.settings?.description||p.manifest.description,sections:p.manifest.settings?.sections||[],...p,dependencyProblems:packages.problems(p.manifest,{enabled:true})}))],framework:{...store.data.framework,pluginData:undefined,retiredSessions:store.data.framework.retiredSessions.map(({sessionId,archived,error})=>({sessionId,archived,error}))},builtins:builtins.list(),capabilities:actions.catalog(),systemDenied:SYSTEM_DENIED,eventState:events.snapshot(),revision:store.data.revision,diagnostics:router.diagnostics,settings:store.data.settings,tokenConfigured:Boolean(token),status:bot?.status,
      personas:store.data.personas,personaDefaults:store.data.personaDefaults,bindings:store.data.bindings,
      sessions:store.data.sessions,nativePackages:Object.values(store.data.framework.nativePackages).map(p=>({...p,dependencyProblems:packages.problems(p.manifest,{enabled:true})})),extensions:Object.values(store.data.extensions).map(p=>({...p,dependencyProblems:packages.problems(p.manifest,{enabled:true})})),sources:store.data.sources,
      logs:store.data.logs.slice(-100),jobs:store.data.inbox.slice(-30).map(({persona,reply,flow,...j})=>({...j,batchCount:flow?.parts.length||1,message:{key:j.message.key,text:j.message.text.slice(0,120)}})),
      compatibility:{dsh:'0.2.1-rc.2',extensionApi:2,framework:FRAMEWORK_VERSION},dataDir:store.dir};
  }
  function chatIdentity(key){
    const parts=String(key||'').split(':');if(parts.length!==3||parts[0]!==bot?.status.bot||!['group','private'].includes(parts[1])||!/^\d{4,16}$/.test(parts[2]))throw Error('请选择当前机器人下的群或好友');
    return {type:'message',bot:parts[0],kind:parts[1],peer:parts[2],key:String(key),user:parts[1]==='private'?parts[2]:store.data.framework.ownerQQ};
  }
  async function action(body){
    if(closed)throw new Error('插件已停止');const {action,revision}=body;
    if(action==='snapshot')return snapshot();
    if(action==='prepareUninstall')return uninstaller.prepare(body);
    if(action==='cancelUninstall')return uninstaller.cancel(body.ticket);
    if(action==='confirmUninstall'){await uninstaller.confirm(body);await sdk.pruneStorage();return snapshot();}
    if(['removeBuiltin','removeNativePackage','removeExtension'].includes(action))throw Error('请使用统一卸载流程，选择配置处理方式后再次确认');
    if(action==='chatDetails'){
      const m=chatIdentity(body.key),profile=store.data.chatProfiles?.[m.key]||{},f=store.data.framework,execution=permissions.issue({...m,id:'local-preview'},'agent');
      let tools;try{tools=actions.catalog().map(cap=>({id:cap.id,name:cap.description,ownerOnly:!!cap.ownerOnly,publicSafe:!!cap.publicSafe,enabled:cap.enabled,reason:permissions.decision(actions.definitions.get(cap.id),execution)}));}finally{permissions.close(execution);}
      return {revision:store.data.revision,key:m.key,kind:m.kind,peer:m.peer,actor:m.user,profile,replyReason:router.reason({...m,id:'local-preview',text:'配置效果预览',mentions:[m.bot]},'chat'),personaId:store.data.bindings[m.key]?.personaId||'',resolvedPersona:builtins.persona(m).name,listening:m.kind==='group'?f.listenGroups.includes(m.peer):isOwner(f,m.peer)||f.listenPrivate&&(f.listenAllPrivate||f.listenUsers.includes(m.peer)),tools};
    }
    if(action==='mediaInfo')return incoming.modelInfo(ctx);
    if(action==='saveMediaSettings'){if(revision!==store.data.revision)throw Error('配置已变更，请刷新');const next={...store.data.settings};for(const key of ['mediaImages','mediaAudio','mediaFiles','mediaVideo']){if(typeof body.settings?.[key]!=='boolean')throw Error('媒体设置无效');next[key]=body.settings[key];}store.data.settings=validateSettings(next);invalidate(store);await native.revoke();await store.persist();return snapshot();}
    if(action==='pluginPageData'){return body.native===false?{rows:[],columns:[]}:sdk.pageData(String(body.id),body.query||{});}
    if(action==='catalog'){if(!builtins.enabled('market'))throw new Error('插件市场包已停用');return market.catalog();}
    if(action==='friends'){const rows=await bot.call('get_friend_list');if(!Array.isArray(rows))throw new Error('QQ 未返回好友列表');return {items:rows.map(f=>({id:String(f.user_id),name:String(f.nickname||f.user_id),remark:String(f.remark||'')})).filter(f=>/^[1-9]\d{3,15}$/.test(f.id))};}
    if(action==='groups'){
      const groups=await bot.call('get_group_list');
      if(!Array.isArray(groups))throw new Error('QQ 未返回群列表');
      return {items:groups.map(g=>({id:String(g.group_id),name:String(g.group_name||g.group_id)})).filter(g=>/^\d+$/.test(g.id))};
    }
    if(action==='selfTest'){
      const testUser=store.data.framework.ownerQQ;
      if(!bot?.status.bot)throw new Error('请先连接 OneBot 再测试');
      const msg={id:'self-test-'+randomUUID(),bot:bot.status.bot,user:testUser,kind:'private',peer:testUser,key:bot.status.bot+':private:'+testUser,text:'这是本地 QQ 桥接插件联调。请只回复“桥接测试成功”，不要调用任何工具。'};
      const session=await native.create(msg),execution=permissions.issue(msg,'agent');
      try{
        const persona=resolvePersona(store.data,'',bot?.status.bot||'');
        const isolation=await native.isolationProbe(session.sessionId,execution);
        const rewriteContext=permissions.textOnly(execution);let textOnlyIsolation;try{textOnlyIsolation=await native.isolationProbe(session.sessionId,rewriteContext);}finally{permissions.close(rewriteContext);}
        const observerContext=permissions.observer(execution);let observerIsolation;try{observerIsolation=await native.isolationProbe(session.sessionId,observerContext);}finally{permissions.close(observerContext);}
        const text=await native.run(session.sessionId,{requestId:'qq-self-test-'+randomUUID(),message:msg},renderPersona(persona,msg),execution);
        log('info','DSH 原生会话测试成功（未发送 QQ 消息）');
        return {message:text,sessionId:session.sessionId,isolation,textOnlyIsolation,observerIsolation};
      }finally{permissions.close(execution);await native.reset(session);}
    }
    if(action==='preview'){const p=body.persona?validatePersona(body.persona):resolvePersona(store.data,body.key||'',body.bot||'');return {text:renderPersona(p,{kind:body.kind||'private'})};}
    if(action==='test'){
      const settings=validateSettings(body.settings||store.data.settings);
      if(settings.mode==='reverse')return {message:'反向 WS 是监听模式。保存后请让 NapCat 连接，再查看运行状态；不会额外打开一个监听端口。'};
      const probe=new OneBot(settings,body.token||token);
      try{
        const ready=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('连接测试超时')),12000);probe.once('ready',s=>{clearTimeout(t);resolve(s);});});
        await probe.start();const result=await ready;return {message:'连接成功',...result};
      }finally{await probe.stop();}
    }
    if(revision!==store.data.revision)throw new Error('配置已被其他页面修改，请刷新后重试。');
    if(action==='clearChatProfile'){const m=chatIdentity(body.key);delete store.data.chatProfiles[m.key];invalidate(store);await native.revoke();await store.persist();return snapshot();}
    if(action==='saveChatProfile'){
      const m=chatIdentity(body.key),profile=validateProfile(body.profile),f=store.data.framework;
      if(typeof body.listening!=='boolean')throw Error('请选择是否接收消息');
      const personaId=String(body.personaId||'');if(personaId&&!builtins.enabled('persona'))throw Error('人设包已停用');if(personaId&&!store.data.personas.some(p=>p.id===personaId))throw Error('人设不存在');
      const settings=structuredClone(store.data.settings),listenGroups=[...f.listenGroups],listenUsers=[...f.listenUsers];
      if(m.kind==='group'){
        if(body.listening&&!listenGroups.includes(m.peer))listenGroups.push(m.peer);
        if(!body.listening){const i=listenGroups.indexOf(m.peer);if(i>=0)listenGroups.splice(i,1);}
        if(profile.replyEnabled){if(!body.listening)throw Error('回复前请开启接收消息');settings.groupEnabled=true;settings.allowedGroups=[...new Set([...settings.allowedGroups,m.peer])];}
      }else{
        if(!body.listening&&isOwner(f,m.peer))throw Error('主人管理私聊始终保留');
        if(!body.listening&&f.listenAllPrivate)throw Error('当前接收所有私聊；请先在全局设置改为指定好友');
        if(body.listening&&!listenUsers.includes(m.peer))listenUsers.push(m.peer);if(!body.listening){const i=listenUsers.indexOf(m.peer);if(i>=0)listenUsers.splice(i,1);}
        if(profile.replyEnabled){if(!body.listening)throw Error('回复前请开启接收消息');settings.privateEnabled=true;settings.allowedUsers=[...new Set([...settings.allowedUsers,m.peer])];}
      }
      const next=validateSettings(settings);store.data.chatProfiles??={};if(!store.data.chatProfiles[m.key]&&Object.keys(store.data.chatProfiles).length>=200)throw Error('最多保存 200 个聊天配置');
      store.data.chatProfiles[m.key]=profile;store.data.settings=next;f.listenGroups=listenGroups;f.listenUsers=listenUsers;if(m.kind==='private'&&body.listening)f.listenPrivate=true;
      if(personaId)store.data.bindings[m.key]={personaId};else delete store.data.bindings[m.key];
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();if(bot)bot.settings=next;return snapshot();
    }
    if(action==='restorePackage'){
      if(typeof body.id!=='string'||!/^[a-z][a-z0-9-]{0,60}$/.test(body.id))throw Error('插件 ID 无效');
      if(body.kind==='extension')await market.restore(body.id);
      else if(body.kind==='builtin'){const p=store.data.framework.builtins[body.id];if(!p?.uninstalled||!builtins.list().some(x=>x.id===body.id))throw Error('此内置包未卸载');p.uninstalled=false;p.enabled=false;}
      else if(body.kind==='native'){const p=store.data.framework.nativePackages[body.id];if(!p?.uninstalled||!p.registered||!sdk.live.has(body.id))throw Error('宿主包未加载，需先在 DSH 加载');p.uninstalled=false;p.enabled=false;}
      else throw Error('插件类型无效');
      invalidate(store);await native.revoke();await store.persist();return snapshot();
    }
    if(action==='saveFramework'){
      const f=store.data.framework,input=body.framework||{},policy=validatePolicy(input,actions.catalog());
      const listenUsers=ids(input.listenUsers),listenGroups=ids(input.listenGroups);
      Object.assign(f,policy,{listenUsers,listenGroups,listenPrivate:input.listenPrivate===true,listenAllPrivate:input.listenAllPrivate===true,listenNotices:input.listenNotices===true,listenRequests:input.listenRequests===true,paused:input.paused===true});
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    if(action==='configureNativePackage'){
      const p=store.data.framework.nativePackages[body.id];if(!p||!sdk.live.has(body.id))throw new Error('原生包当前未注册');if(p.uninstalled)throw Error('请先重新安装此功能包');
      const scope=body.scope||p.scope,groups=ids(scope.groups),users=ids(scope.users);if(groups.some(g=>!store.data.framework.listenGroups.includes(g)))throw new Error('插件群超出监听范围');
      if(body.enabled===true)packages.assert(p.manifest,{enabled:true});else packages.protect(body.id);
      const next=checkConfig(p.manifest,body.config),automationGrants=body.automationGrants??p.automationGrants??[];
      if(!Array.isArray(automationGrants)||automationGrants.some(id=>!(p.manifest.automations||[]).some(a=>a.id===id)))throw new Error('自动回复授权无效');
      p.settingsHistory=rememberSettings(p);p.configDeleted=false;p.config=next;p.configVersion=p.manifest.configVersion??1;p.scope={private:!!scope.private,allUsers:scope.allUsers===true,users,groups};p.automationGrants=[...new Set(automationGrants)];p.enabled=body.enabled===true;p.uninstalled=false;p.migrationError=null;p.error=null;p.health={...p.health,quarantined:false,consecutive:0};
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    if(action==='configureBuiltin'){
      if(store.data.framework.builtins[body.id]?.uninstalled)throw Error('请先重新安装此内置包');if(!body.enabled)packages.protect(body.id);
      builtins.configure(body.id,body.enabled,body.config);
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    if(action==='uploadMedia'||action==='invokeAction'){
      const parts=String(body.key||'').split(':');
      if(parts.length!==3||parts[0]!==bot?.status.bot||!['private','group'].includes(parts[1])||!/^\d{4,16}$/.test(parts[2]))throw new Error('请指定当前机器人下的有效聊天');
      const msg={id:'local-admin-'+randomUUID(),bot:parts[0],user:store.data.framework.ownerQQ,kind:parts[1],peer:parts[2],key:body.key};
      const context=permissions.issue(msg,'agent');
      const invalid=permissions.valid(context);if(invalid)throw new Error(invalid);
      if(action==='uploadMedia'){
        if(typeof body.base64!=='string'||body.base64.length>11200000||!(/^[A-Za-z0-9+/]+={0,2}$/).test(body.base64))throw new Error('资源 Base64 无效');
        try{return await media.put(Buffer.from(body.base64,'base64'),{key:msg.key,purpose:body.purpose||'image',name:body.name,plugin:'core'});}finally{permissions.close(context);}
      }
      try{return await actions.invoke(body.capability,body.arguments||{},context,AbortSignal.timeout(30000));}finally{permissions.close(context);}
    }
    if(action==='saveConversation'){
      const keys=['intentRecognition','intentPerMinute','intentPerHour','actionTextMode','actionTextProbability','interjectionMode','interjectionProbability','privateEnabled','groupEnabled','groupMentionOnly','groupReplyMode','groupReplyProbability','groupReplyCooldown','groupAutoLimit','botAliases','followupEnabled','followupWindowSec','followupMaxTurns','pokeReplyEnabled','pokeReplyCooldown','allowedUsers','allowedGroups','privateAudience','groupAudience','replySplit','replyQuoteMode','mergeWindowMs','maxCollectMs','staleAfterSec','decisionEnabled','sendInterval','maxReplyChars','replyTotalChars','replyMaxParts'];
      const input={...store.data.settings};for(const key of keys)if(Object.hasOwn(body.settings||{},key))input[key]=body.settings[key];
      const settings=validateSettings(input),f=store.data.framework;
      store.data.settings=settings;
      if(settings.privateEnabled){f.listenPrivate=true;f.listenAllPrivate=settings.privateAudience==='all';f.listenUsers=[...settings.allowedUsers];}
      if(settings.groupEnabled)f.listenGroups=[...new Set([...f.listenGroups,...settings.allowedGroups])];
      for(const grant of f.grants)if(grant.allUsers&&!grant.deny&&grant.id.startsWith('shared-')&&actions.definitions.get(grant.capability)?.publicSafe)grant.groups=settings.groupEnabled?settings.allowedGroups.filter(g=>f.listenGroups.includes(g)):[];
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();if(bot)bot.settings=settings;return snapshot();
    }
    if(action==='saveSettings'){
      const settings=validateSettings({...body.settings,preset:''});const newToken=body.clearToken?'':typeof body.token==='string'&&body.token?body.token:token;
      if(newToken.length>4096||/[\r\n]/.test(newToken))throw new Error('Access Token 无效');
      if(settings.mode==='reverse'&&!newToken)throw new Error('反向 WS 必须设置 Access Token');
      const tokenChanged=newToken!==token;if(tokenChanged){if(newToken)await ctx.credentials.set(tokenRef,newToken);else await ctx.credentials.unset(tokenRef);token=newToken;}
      const previous=store.data.settings,wireChanged=tokenChanged||['enabled','mode','url','reverseHost','reversePort','reversePath'].some(k=>previous[k]!==settings[k]);
      await store.change(revision,d=>{d.settings=settings;});invalidate(store);await native.revoke();await store.persist();if(wireChanged)await connect();else if(bot)bot.settings=settings;return snapshot();
    }
    if(['savePersona','importPersona','deletePersona','clearBotDefault','setDefault','bindPersona'].includes(action)&&!builtins.enabled('persona'))throw new Error('人设包已停用或卸载');
    if(action==='savePersona'){
      const previous=body.id?store.data.personas.find(p=>p.id===body.id):undefined;
      if(body.id&&!previous)throw new Error('人设已删除');
      const p=validatePersona(body.persona,previous);await store.change(revision,d=>{if(previous)d.personas[d.personas.indexOf(previous)]=p;else d.personas.push(p);});return snapshot();
    }
    if(action==='importPersona'){
      const p=importPersona(String(body.text||''),body.format);await store.change(revision,d=>d.personas.push(p));return snapshot();
    }
    if(action==='deletePersona'){
      assertCanDelete(store.data,body.id);await store.change(revision,d=>{d.personas=d.personas.filter(p=>p.id!==body.id);});return snapshot();
    }
    if(action==='clearBotDefault'){
      if(!/^\d{4,16}$/.test(body.bot))throw new Error('机器人 QQ 号无效');
      await store.change(revision,d=>{delete d.personaDefaults.bots[body.bot];});return snapshot();
    }
    if(action==='setDefault'){
      if(!store.data.personas.some(p=>p.id===body.id))throw new Error('人设不存在');
      if(body.bot&&!/^\d{4,16}$/.test(body.bot))throw new Error('机器人 QQ 号无效');
      await store.change(revision,d=>{if(body.bot)d.personaDefaults.bots[body.bot]=body.id;else d.personaDefaults.global=body.id;});return snapshot();
    }
    if(action==='bindPersona'||action==='resetSession'){
      if(!/^\d{4,16}:(private|group):\d{4,16}$/.test(body.key))throw new Error('会话键格式应为 机器人QQ:private或group:对方QQ或群号');
      if(action==='bindPersona'&&body.id&&!store.data.personas.some(p=>p.id===body.id))throw new Error('人设不存在');
      await router.rebind(body.key,()=>{if(action==='bindPersona'){if(body.id)store.data.bindings[body.key]={personaId:body.id};else delete store.data.bindings[body.key];
        if(body.keepContext&&store.data.sessions[body.key])store.data.sessions[body.key].personaId=resolvePersona(store.data,body.key,body.key.split(':')[0]).id;}store.data.revision++;},body.keepContext===true&&action!=='resetSession');return snapshot();
    }
    if(action==='saveSources'){
      if(!Array.isArray(body.sources)||body.sources.length>10)throw new Error('最多配置 10 个市场源');
      const sources=body.sources.map(s=>{
        if(!['local','https'].includes(s.kind))throw new Error('市场源类型无效');
        if(s.kind==='local'&&!path.isAbsolute(s.location))throw new Error('本地市场索引需要绝对路径');
        if(s.kind==='https'){const u=new URL(s.location);if(u.protocol!=='https:'||u.username||u.password)throw new Error('市场索引需要 HTTPS');}
        return {id:s.id&&/^[a-z0-9-]{1,50}$/.test(s.id)&&s.id!=='builtin'?s.id:randomUUID(),name:String(s.name||'自定义市场').slice(0,80),kind:s.kind,location:String(s.location)};});
      await store.change(revision,d=>{d.sources=sources;});return snapshot();
    }
    if(action==='rollbackExtension'){
      await market.rollback(body.id,body.generation);invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    if(action==='removeNativePackage'){
      const p=store.data.framework.nativePackages[body.id];if(!p?.manifest.bundled)throw new Error('此原生包需在 DSH 插件管理中卸载');
      packages.protect(body.id);p.settingsHistory=rememberSettings(p);p.enabled=false;p.uninstalled=true;p.automationGrants=[];
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    if(action==='restorePluginSettings'){
      const p=body.native?store.data.framework.nativePackages[body.id]:store.data.extensions[body.id];
      if(!p||!Number.isInteger(body.index)||body.index<0||body.index>4)throw new Error('设置历史不存在');
      const old=p.settingsHistory?.[body.index];if(!old)throw new Error('设置历史不存在');
      const config=migrateConfig({...p,config:old.config,configVersion:old.configVersion},p.manifest),scope=old.scope;
      const groups=ids(scope?.groups),users=ids(scope?.users);if(groups.some(g=>!store.data.framework.listenGroups.includes(g)))throw new Error('历史设置中的群已不在监听范围，请先调整监听');
      packages.protect(body.id);const history=rememberSettings(p);p.config=config;p.configVersion=p.manifest.configVersion??1;p.scope={private:!!scope.private,allUsers:scope.allUsers===true,users,groups};p.enabled=false;
      p.automationGrants=(old.automationGrants||[]).filter(id=>(p.manifest.automations||[]).some(a=>a.id===id));p.settingsHistory=history;p.error=null;p.migrationError=null;
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    if(action==='installExtension'){if(!builtins.enabled('market'))throw new Error('插件市场包已停用');await market.install(body.source,body.id,body.version);invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();}
    if(action==='removeExtension'){await market.remove(body.id);invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();}
    if(action==='configureExtension'){
      const e=store.data.extensions[body.id];if(!e)throw new Error('扩展不存在');if(e.uninstalled)throw Error('请先重新安装此扩展');
      if(body.enabled)packages.assert(e.manifest,{enabled:true});else packages.protect(body.id);
      const old=structuredClone(e),nextConfig=validateConfig(e.manifest,body.config);
      const scope=body.scope||e.scope||{private:true,users:store.data.settings.allowedUsers,groups:store.data.framework.listenGroups};
      const nextScope={private:!!scope.private,allUsers:scope.allUsers===true,users:ids(scope.users),groups:ids(scope.groups)};
      if(nextScope.groups.some(g=>!store.data.framework.listenGroups.includes(g)))throw new Error('插件群范围须在监听范围内');
      e.settingsHistory=rememberSettings(e);e.configDeleted=false;e.config=nextConfig;e.scope=nextScope;e.enabled=body.enabled===true;
      try{if(e.enabled)await extensions.load(body.id);else await extensions.unload(body.id);}
      catch(error){Object.assign(e,old,{error:error.message});if(old.enabled)try{await extensions.load(body.id);}catch{}await store.persist();throw error;}
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();return snapshot();
    }
    throw new Error('不支持的操作');
  }
  const disposeFetch=ctx.connection.fetch.register({path:'/api/qq-bridge',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try{
      // Mutating operations remain under DSH's owner authentication and same-origin checks.
      // DSH Connection verifies Host/Origin and signed owner identity before dispatch.
      // Its internal carrier URL is not the browser's public origin.
      if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({ok:false,error:'仅接受 JSON'},{status:415});
      const raw=await request.text();if(raw.length>12*1024*1024)return Response.json({ok:false,error:'请求过大'},{status:413});
      const body=JSON.parse(raw);if(body.action!=='uploadMedia'&&raw.length>160000)throw new Error('请求过大');
      const readOnly=['snapshot','preview','catalog','groups','friends','pluginPageData','mediaInfo'].includes(body.action);
      const task=readOnly?action(body):adminTail.then(()=>action(body));if(!readOnly)adminTail=task.catch(()=>{});
      return Response.json({ok:true,value:await task});
    }catch(error){await store.persist().catch(()=>{});return Response.json({ok:false,error:String(error.message||error).replaceAll(token||'\0','[已隐藏]')},{status:400});}
  }});
  ctx.effect(()=>()=>{closed=true;clearInterval(maintenance);disposeFetch();void(async()=>{await router.stop();await bot?.stop();await extensions.stop();await sdk.stop();await media.stop();await store.persist();})().catch(e=>ctx.logger.warn('QQ bridge cleanup: '+e.message));},'qq-bridge cleanup');
  await sdk.pruneStorage();await market.start();await media.start();await extensions.start();await native.start();await connect();log('info','QQ 桥接插件已就绪，数据目录：'+store.dir);
}
