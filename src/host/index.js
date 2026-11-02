import {isOwner} from '../core/owners.js';
import z from '@deepseek-ai/schemastery';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
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
import {activateTTS} from '../builtins/tts/index.js';
import {activateWeb} from '../builtins/web/index.js';
import {StickerStore} from '../core/stickers.js';
import {activateSticker} from '../builtins/sticker/index.js';
import {createStickerAutoSave} from '../builtins/sticker/auto.js';
import {createStickerIntelligence} from '../builtins/sticker/intelligence.js';
import {createStickerModel} from '../builtins/sticker/model.js';
import {safeDownload} from '../core/media.js';
import {readFile} from 'node:fs/promises';
import {activateGroupMembers} from '../builtins/group-members/index.js';
import {activateAutonomy} from '../builtins/autonomy/index.js';
import {activateEmotion} from '../builtins/emotion/index.js';
import {activateMediaAgent} from '../builtins/media-agent/index.js';
import {MediaBrowserService} from '../builtins/media-agent/browser-service.js';
import {readPublic} from '../builtins/web/network.js';
import {startAdminServer} from '../web/admin-server.js';
import {createStickerAdmin} from '../admin/sticker-admin.js';
import {createQzoneAdmin} from '../admin/qzone-admin.js';
import {createMemoryAdmin} from '../admin/memory-admin.js';
import {createAutonomyAdmin} from '../admin/autonomy-admin.js';
import {validateProfile,chatSettings} from '../session/chat-profile.js';
import {Uninstaller} from '../core/uninstall.js';
import { Router } from '../session/router.js';
import {ProactiveMessaging} from '../session/proactive.js';
import {GroupProactive} from '../session/group-proactive.js';
import {TaskStore,taskDetail} from '../session/tasks.js';
import {TaskRunner} from '../session/task-runner.js';
import {ReminderScheduler} from '../session/reminders.js';
import {createVerifyTask} from '../session/verify-task.js';
import {recordProactiveConversation} from '../session/proactive-provenance.js';
import {LifeState} from '../session/life-state.js';
import {SocialEnergy} from '../session/social-energy.js';
import {ProfileStore} from '../session/profile-store.js';
import { Extensions,validateConfig } from '../extensions/index.js';
import { Market } from '../market/index.js';
import { validatePersona,resolvePersona,renderPersona,assertCanDelete,importPersona } from '../personas/index.js';
function parseSecretDecision(text, optionCount){
  const raw=String(text||'').trim();
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start)throw new Error('角色没有返回可解析的秘密空间决定');
  let value;try{value=JSON.parse(raw.slice(start,end+1));}catch{throw new Error('角色返回的秘密空间决定不是有效 JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('角色秘密空间决定格式无效');
  if(typeof value.create!=='boolean')throw new Error('角色秘密空间决定缺少 create');
  const choice=Number(value.choice);
  if(!Number.isInteger(choice)||choice<0||choice>=Math.max(1,optionCount))throw new Error('角色秘密空间决定 choice 越界');
  return {create:value.create,choice,shareWithOwner:value.shareWithOwner===true,reason:String(value.reason||'').slice(0,300)};
}
export const name='dsh-onebot-bridge';
export const inject=['connection','sessionController','workspaceController','credentials','llm','tools','agentPresets','fileUploads','agentDefaultModel','attachments'];
export const Config=z.object({dataDir:z.string().default(path.resolve(process.cwd(),'data','dsh-onebot-bridge'))});
const tokenRef='DSH_ONEBOT_ACCESS_TOKEN';
const secretDeviceKeyRef='QQBOT_SECRET_DEVICE_KEY';
export async function apply(ctx,config) {
  const store=await new Store(config.dataDir).open();let bot,router,closed=false,adminTail=Promise.resolve(),secretDecisionTimer=null,emotion=null,emotionTimer=null,lifeState=null,socialEnergy=null,profileStore=null,lifeTimer=null,socialEnergyTimer=null,profileTimer=null;
  const emotionContext=(key,kind,peer,actor)=>emotion?.service.context({key,kind,peer,actor})||'';
  const storedToken=(await ctx.credentials.resolve(tokenRef))?.value;
  // 私密空间设备密钥放在 DSH 凭据库，不写进 private 目录，避免与密文一起被复制。
  const storedDeviceKey=(await ctx.credentials.resolve(secretDeviceKeyRef))?.value;
  let secretDeviceKey;
  try{secretDeviceKey=storedDeviceKey?Buffer.from(String(storedDeviceKey),'base64url'):null;}catch{secretDeviceKey=null;}
  if(!secretDeviceKey||secretDeviceKey.length!==32){secretDeviceKey=randomBytes(32);await ctx.credentials.set(secretDeviceKeyRef,secretDeviceKey.toString('base64url'));}
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
  lifeState=await new LifeState(path.join(store.dir,'autonomy'),{log}).open();
  socialEnergy=await new SocialEnergy(path.join(store.dir,'autonomy'),{log}).open();
  profileStore=await new ProfileStore(path.join(store.dir,'memory'),{log}).open();
  const lifeEnabled=()=>store.data.framework.nativePackages['qq-autonomy']?.config?.enabled===true;
  // 所有需要“她自己思考”的入口都走同一份上下文：普通回复、意图判断、
  // 主动联系、自主活动和群聊参与共享长期记忆、作息、社交精力与人物画像。
  const sharedContextFor=async msg=>{
    const input={
      key:msg?.key,
      kind:msg?.kind,
      peer:msg?.peer,
      actor:msg?.actor||msg?.user,
      owner:store.data.framework.ownerQQ,
      text:String(msg?.text||'').slice(0,500),
      bot:msg?.bot
    };
    return [
      await sdk.contextFor(input),
      lifeState.context({enabled:lifeEnabled()}),
      socialEnergy.context(),
      profileStore.context({actor:input.actor,owner:input.owner,kind:input.kind,peer:input.peer,bot:input.bot})
    ].filter(Boolean).join('\n');
  };
  native.contextFor=sharedContextFor;
  const syncLifeConfig=()=>{
    const config=store.data.framework.nativePackages['qq-autonomy']?.config||{};
    lifeState.configure({sleepAt:config.sleepAt,wakeAt:config.wakeAt});
    return lifeEnabled();
  };
  const tickLife=async()=>{
    const before=lifeState.state.state;
    const enabled=syncLifeConfig();
    lifeState.tick({enabled});
    socialEnergy.recover({sleeping:lifeState.isSleeping()});
    if(before!==lifeState.state.state||enabled)await Promise.all([lifeState.persist(),socialEnergy.persist()]);
  };
  await tickLife();
  lifeTimer=setInterval(()=>{void tickLife().catch(error=>log('warn','作息状态调度失败：'+String(error?.message||error).slice(0,160)));},30000);
  lifeTimer.unref?.();
  socialEnergyTimer=setInterval(()=>{void socialEnergy.persist().catch(error=>log('warn','社交精力保存失败：'+String(error?.message||error).slice(0,160)));},60000);
  socialEnergyTimer.unref?.();
  profileTimer=setInterval(()=>{void profileStore.persist().catch(error=>log('warn','人物画像保存失败：'+String(error?.message||error).slice(0,160)));},60000);
  profileTimer.unref?.();
  router=new Router(store,native,extensions,log,{permissions,events,actions,builtins,lifeState,lifeEnabled,socialEnergy,profileStore,contextFor:sharedContextFor});
  activateGroupMembers(sdk.facade());
  const mediaBrowser=new MediaBrowserService({profileDir:path.join(store.dir,'media-edge-profile'),log:(level,message)=>log(level,'媒体浏览器：'+message)});
  activateMediaAgent(sdk.facade(),{read:readPublic,browser:mediaBrowser});
  const stickers=await new StickerStore(store.dir).open();
  // 只允许表情包自己和联网查资料包创建的资源：这是"搜到图再收进库"的既有链路。
  const readStickerResource=async(id,context)=>{
   const row=media.items.get(String(id));
   if(!row||row.key!==context.key)throw new Error('表情资源不存在、已过期或不属于当前聊天');
   if(!['qq-sticker','qq-web'].includes(row.plugin))throw new Error('该资源不能收进表情库');
   return readFile(path.join(media.dir,row.id+'.bin'));
  };
  const stickerApi=activateSticker(sdk.facade(),{stickers,readResource:readStickerResource,reactMessage:(...args)=>actions.reactMessage(...args)});
  const stickerScope=()=>({enabled:!closed&&sdk.active('qq-sticker'),generation:store.data.framework.generation,config:stickerApi.getConfig(),scope:stickerApi.getScope()});
  const stickerIntelligence=createStickerIntelligence({stickers,scope:stickerScope,model:createStickerModel({ctx,incoming}),log});
  router.replySticker=options=>stickerIntelligence.choose({...options,history:router.conversation.room(options.message.key).rows.slice(-8).map(({id,user,text,reply})=>({id,user,text:String(text||'').slice(0,250),reply})),emotion:emotion?.service.allowed(options.message.key)?emotion.service.publicState(options.message.key):undefined});
  ctx.effect(()=>()=>stickerIntelligence.stop(), 'qq-sticker intelligence cleanup');
  const stickerAuto=createStickerAutoSave({
   stickers,readResource:readStickerResource,log,inspect:(bytes,context)=>stickerIntelligence.inspect(bytes,context),
   scope:stickerScope,
   fetchMessageBytes:async(message,index)=>{
    const observed=events.observed.get(message.bot+':'+message.id);
    const item=(observed?.media||[]).filter(entry=>entry.type==='image')[index];
    if(!item)return null;
    let url=item.url;
    if(!url){const data=await bot?.request('get_image',{file:item.file},15000);url=data?.data?.url;}
    if(typeof url!=='string'||!url.startsWith('https://'))return null;
    return safeDownload(url,{maxBytes:2*1024*1024});
   }
  });
  activateWeb(sdk.facade(),{onStickerSent:(resourceId,context,meta)=>stickerAuto.fromResource(resourceId,context,meta)});
  const qzoneBackend=createQzoneBackend(()=>bot);
  activateQzone(sdk.facade(),qzoneBackend);
  activateTTS(sdk.facade(),{log});
  const stickerAdmin=createStickerAdmin({stickers,getItem:()=>store.data.framework.nativePackages['qq-sticker'],intelligence:()=>stickerIntelligence.status()});
  const qzoneAdmin=await createQzoneAdmin({
    backend:qzoneBackend,
    dir:path.join(store.dir,'qzone'),
    getItem:()=>store.data.framework.nativePackages['qq-qzone'],
    log,
    friends:async()=>{
      if(!bot?.status?.online)throw new Error('QQ 未连接，无法读取好友列表');
      const rows=await bot.call('get_friend_list');
      if(!Array.isArray(rows))throw new Error('QQ 未返回好友列表');
      return rows.map(f=>({id:String(f.user_id),name:String(f.nickname||f.user_id),remark:String(f.remark||'')})).filter(f=>/^[1-9]\d{3,15}$/.test(f.id));
    }
  }).open();
  // 记忆库依赖 Node 内置 SQLite；不可用时只停用记忆功能，不影响 QQ 桥接本身。
  let memory=null;
  try{
   const {MemoryStore}=await import('../builtins/memory/store.js');
   memory=new MemoryStore(path.join(store.dir,'memory'));
   await memory.open();
   const {activateMemory}=await import('../builtins/memory/index.js');
   activateMemory(sdk.facade(),{store:memory,log});
  }catch(error){log('error','长期记忆库不可用：'+error.message);memory=null;}
  const memoryAdmin=createMemoryAdmin({store:memory,getItem:()=>store.data.framework.nativePackages['qq-memory']});
  const taskStore=await new TaskStore(path.join(store.dir,'tasks')).open();
  actions.installTaskActions(taskStore);
  const reminderScheduler=new ReminderScheduler({
    tasks:taskStore,log,
    available:()=>!closed&&!router.stopped&&store.data.settings.enabled===true&&!store.data.framework.paused&&bot?.status?.online===true,
    guard:r=>{
      if(r.bot!==bot?.status?.bot||!isOwner(store.data.framework,r.actor))return '提醒的账号或主人已变化';
      if(r.key!==r.bot+':'+r.kind+':'+r.peer||!['private','group'].includes(r.kind)||r.kind==='private'&&r.peer!==r.actor)return '提醒目标无效';
      if(r.kind==='group'&&(!store.data.framework.listenGroups.includes(r.peer)||!store.data.settings.groupEnabled||store.data.chatProfiles?.[r.key]?.replyEnabled===false))return '提醒群已停止监听或回复';
      if(!store.data.framework.enabledActions.includes('qq.message.send'))return '发送消息能力已停用';
      return '';
    },
    send:async r=>{
      const msg={type:'message',bot:r.bot,user:r.actor,kind:r.kind,peer:r.peer,key:r.key,id:'reminder-'+randomUUID(),time:Date.now()/1000,text:r.text,mentions:[],parts:[]};
      const execution=permissions.issue(msg,'proactive');
      try{return await actions.invoke('qq.message.send',{segments:[{type:'text',data:{text:r.text}}]},execution);}
      finally{permissions.close(execution);}
    }
  });
  const reminderTimer=setInterval(()=>{void reminderScheduler.tick().catch(()=>log('warn','提醒调度失败，请检查任务记录'));},1000);
  reminderTimer.unref?.();
  // 自主时间：定时问一次“现在要不要做点自己的事”，每次都在受限会话里完成。
  let autonomy=null,autonomyTimer=null,proactive=null,proactiveTimer=null;
  try{
   autonomy=await activateAutonomy(sdk.facade(),{dir:path.join(store.dir,'autonomy'),native,
    persona:()=>renderPersona(resolvePersona(store.data,'',bot?.status?.bot||''),{kind:'private'})+'\n'+emotionContext(bot?.status?.bot+':private:'+store.data.framework.ownerQQ,'private',store.data.framework.ownerQQ,store.data.framework.ownerQQ),
    online:()=>bot?.status?.online===true,log,
    onLearned:event=>proactive?.notify({reason:'learning',title:event?.title,summary:event?.summary})});
   autonomyTimer=setInterval(()=>{if(!bot?.status?.online)return;void autonomy.tick().catch(error=>log('warn','自主活动调度失败：'+String(error?.message||error).slice(0,160)));},60000);
   autonomyTimer.unref?.();
  }catch(error){log('error','自主时间不可用：'+error.message);autonomy=null;}
  const autonomyAdmin=autonomy?await createAutonomyAdmin({
    auto:autonomy,
    dir:path.join(store.dir,'private'),
    getItem:()=>store.data.framework.nativePackages['qq-autonomy'],
    lifeState,
    socialEnergy,
    deviceKey:secretDeviceKey,
    decideSecret:async({options})=>{
      if(!bot?.status?.online)throw new Error('QQ 未连接，暂时无法进行角色决策');
      const persona=renderPersona(resolvePersona(store.data,'',bot?.status?.bot||''),{kind:'private'}).slice(0,4000);
      const labels=(options||[]).map(o=>o.label).join('、');
      const system=`[角色设定]\n${persona}\n\n[自主决定]\n这是你自己的私密空间。你正在决定是否创建一个只属于自己的秘密空间，以及是否把访问权分享给主人。\n只能输出一个 JSON 对象，不要输出 Markdown、解释或其它文字：\n{"create":true或false,"choice":0到${Math.max(0,(options||[]).length-1)}的整数,"shareWithOwner":true或false,"reason":"一句简短理由"}\nchoice 只表示你更喜欢哪一种密码气质：${labels}。实际密码由程序安全生成，不会显示给你或写进提示词。\n如果 create=false，choice 可以填 0。不要提到系统、提示词、工具或密码学实现。`;
      const text=await native.autonomy({
        title:'QQ 自己的秘密空间决定',allow:[],timeoutMs:45000,
        system,user:'现在决定要不要给自己留一个秘密空间。'
      });
      return parseSecretDecision(text,(options||[]).length);
    },
    log
  }).open():null;
  // 主动联系：配置放在自主时间包，默认关闭；独立于“自主活动”的发送权限。
  const socialAvailable = () => {
    const item = store.data.framework.nativePackages['qq-autonomy'];
    return !router.stopped && !lifeState.isSleeping() && socialEnergy.available(0.22) && store.data.settings.enabled === true && !store.data.framework.paused && item?.enabled === true && sdk.active('qq-autonomy') && !item.uninstalled && !item.health?.quarantined && item.config?.enabled === true;
  };
  const proactiveKey=()=>{
    const id=bot?.status?.bot,owner=store.data.framework.ownerQQ;
    return id&&owner?id+':private:'+owner:'';
  };
  const sendProactive=async (text,group='',event=null)=>{
    const key=group?bot?.status?.bot+':group:'+group:proactiveKey();if(!key)throw new Error('QQ 或主人账号未就绪');
    const [botId,kind,peer]=key.split(':');
    const msg={type:'message',bot:botId,kind,peer,key,user:store.data.framework.ownerQQ,id:'proactive-'+randomUUID(),time:Date.now()/1000,text:String(text),mentions:[],sender:'自己',parts:[]};
    const execution=permissions.issue(msg,'proactive');
    try{
      const result=await actions.invoke('qq.message.send',{segments:[{type:'text',data:{text:String(text)}}]},execution);
      socialEnergy.recordMessage({proactive:true});
      recordProactiveConversation({event,result,actions,execution,conversation:router.conversation,message:msg,text});
      return result;
    }finally{permissions.close(execution);}
  };
  try{
    proactive=await new ProactiveMessaging({
      dir:path.join(store.dir,'proactive'),
      config:()=>store.data.framework.nativePackages['qq-autonomy']?.config||{},
      online:()=>bot?.status?.online===true,
      available:()=>socialAvailable(),
      lastOwnerAt:()=>router.lastOwnerAt,
      recent:()=>{
        const key=proactiveKey();if(!key)return '';
        return router.conversation.room(key).rows.slice(-12).map(row=>`${row.user}: ${row.text}`).join('\n');
      },
      compose:options=>native.compose({...options, system: renderPersona(resolvePersona(store.data,proactiveKey(),bot?.status?.bot||''),{kind:'private'})+'\n'+emotionContext(proactiveKey(),'private',store.data.framework.ownerQQ,store.data.framework.ownerQQ)+'\n'+options.system}),
      validateEvent:event=>emotion?.service.canShare(event)===true,
      onEventResult:(event,result)=>emotion?.service.delivery(event,result.state),
      send:(text,event)=>sendProactive(text,'',event),
      log
    }).open();
    const groupSocial = new GroupProactive({
      dir: path.join(store.dir, 'proactive', 'groups'),
      groups: () => store.data.framework.listenGroups,
      eligible: group => {
        const item = store.data.framework.nativePackages['qq-autonomy'];
        const scope = item?.scope;
        return socialAvailable() && item.config.groupProactiveEnabled === true && store.data.settings.groupEnabled === true && store.data.framework.listenGroups.includes(group) && scope?.groups?.includes(group) && (scope.allUsers === true || scope.users?.includes(store.data.framework.ownerQQ)) && store.data.chatProfiles?.[bot?.status?.bot+':group:'+group]?.replyEnabled !== false;
      },
      config: () => store.data.framework.nativePackages['qq-autonomy']?.config || {},
      rows: group => store.data.conversations?.[bot?.status?.bot+':group:'+group]?.rows || [],
      bot: () => bot?.status?.bot || '',
      isOwner: user => isOwner(store.data.framework, user),
      compose: (group, options) => native.compose({...options, group, system: renderPersona(resolvePersona(store.data,bot?.status?.bot+':group:'+group,bot?.status?.bot||''),{kind:'group'})+'\n'+emotionContext(bot?.status?.bot+':group:'+group,'group',group,store.data.framework.ownerQQ)+'\n'+options.system}),
      send: (group, text) => sendProactive(text, group),
      online: () => bot?.status?.online === true,
      log
    });
    let socialRunning = false;
    proactiveTimer=setInterval(()=>{
      if (socialRunning) return;
      socialRunning = true;
      void (async()=>{await proactive.tick();await groupSocial.tick();})()
        .catch(error=>log('warn','主动聊天调度失败：'+String(error?.message||error).slice(0,160)))
        .finally(()=>{socialRunning=false;});
    },60000);
    proactiveTimer.unref?.();
  }catch(error){log('error','主动联系不可用：'+error.message);proactive=null;}
  if(proactive)actions.onTaskEvent=event=>proactive.notify(event).catch(error=>log('warn','任务通知入队失败：'+String(error?.message||error).slice(0,160)));
  try {
    emotion=activateEmotion(sdk.facade(),{
      identity:()=>({bot:bot?.status?.bot||'',owner:store.data.framework.ownerQQ,generation:store.data.framework.generation}),
      rooms:()=>store.data.conversations||{},
      reflect:options=>native.autonomy(options),
      notify:event=>proactive?.notify(event)||false,
      deliveryStatus:eventKey=>proactive?.eventState(eventKey)||'',
      available:()=>!closed&&!router.stopped&&store.data.settings.enabled===true&&!store.data.framework.paused&&bot?.status?.online===true,
      persona:()=>renderPersona(resolvePersona(store.data,'',bot?.status?.bot||''),{kind:'private'}),log
    });
    emotionTimer=setInterval(()=>{void emotion.service.tick().then(()=>{const mood=emotion.service.publicState(proactiveKey()).global;socialEnergy.reflectEmotion(mood);}).catch(()=>log('warn','情绪与见闻调度未完成'));},15000);
    emotionTimer.unref?.();
  } catch(error) { log('error','情绪与见闻插件不可用：'+error.message); }
  // 有限任务执行器：只在主人开启 taskRunnerEnabled 后推进已存在的 planning/executing 任务。
  let taskRunner=null,taskRunnerTimer=null;
  const taskRunnerTools=['plugin.qq-web.search','plugin.qq-web.read','plugin.qq-web.image-search','plugin.qq-memory.recall','plugin.qq-memory.remember','qq.history.get','qq.group.info','qq.members.list','qq.message.get','core.status'];
  const verifyTask=createVerifyTask({actions,permissions,store,getBot:()=>bot,getMemory:()=>memory});
  let memoryReviewTimer=null;
  const queueExpiredMemoryReviews=async()=>{
    if(!memoryAdmin||!taskStore)return;
    let rows=[];
    try{rows=memoryAdmin.expired({limit:5}).items||[];}catch(error){log('warn','过期记忆扫描失败：'+String(error?.message||error).slice(0,120));return;}
    const day=new Date().toISOString().slice(0,10);
    for(const row of rows){
      // 同一记忆只保留一个未结束的复查任务，避免每 6 小时重复堆积。
      const active=taskStore.list({limit:100}).filter(task=>!['done','failed','cancelled'].includes(task.status));
      if(active.some(task=>(task.memoryIds||[]).includes(row.id)))continue;
      if(active.length>=50){log('warn','过期记忆复查任务已达活动上限，暂停创建');break;}
      try{
        const task=await taskStore.create({
          goal:'复查过期记忆：'+String(row.text||'').slice(0,120),
          reason:'记忆已过期，需要重新核实来源或标记不确定',
          completion:'重新读取来源并确认、修正或标记该记忆',
          plan:['重新读取来源','核实并更新记忆'],
          verificationMethod:'manual',
          idempotencyKey:'memory-review:'+row.id+':'+day
        });
        await taskStore.attachMemory(task.id,row.id);
        // 进入 planning 才会被执行器推进；manual 验证仍要主人确认后才 done。
        await taskStore.transition(task.id,'analyzing','过期记忆复查');
        await taskStore.transition(task.id,'planning','等待任务执行器');
      }catch(error){log('warn','过期记忆复查任务创建失败：'+String(error?.message||error).slice(0,120));}
    }
  };
  if(memoryAdmin&&taskStore){
    setTimeout(()=>{void queueExpiredMemoryReviews();},15000).unref?.();
    memoryReviewTimer=setInterval(()=>{void queueExpiredMemoryReviews();},6*60*60*1000);
    memoryReviewTimer.unref?.();
  }
  if(taskStore&&typeof native.autonomy==='function')try{
    taskRunner=new TaskRunner({
      tasks:taskStore,
      enabled:()=>store.data.framework.nativePackages['qq-autonomy']?.config?.taskRunnerEnabled===true,
      now:()=>Date.now(),
      log,
      verifyTask,
      // 恢复/每步执行前重新检查运行条件；失败时任务落为 failed，不静默继续。
      guard:()=>{
        if(!store.data.framework.ownerQQ)return '未配置主人 QQ';
        if(!store.data.settings.enabled)return 'QQ 桥接已停用';
        if(store.data.framework.paused)return 'QQ 回复已暂停';
        if(!bot?.status?.online)return 'QQ 未连接';
        return null;
      },
      onDone:task=>actions.onTaskEvent?.({reason:'task',title:task.goal,summary:task.verification?.note||task.completion||''}),
      executeStep:async({task,index,title,completion})=>{
        const persona=renderPersona(resolvePersona(store.data,'',bot?.status?.bot||''),{kind:'private'}).slice(0,4000);
        const raw=await native.autonomy({
          title:'QQ 任务步骤',allow:taskRunnerTools,audit:true,timeoutMs:120000,
          system:`[任务]\n目标：${task.goal}\n完成条件：${completion||'按任务记录判断'}\n第 ${index+1} 步：${title}\n\n只完成这一步，不要发 QQ 消息、不要@任何人、不要修改权限。使用允许的工具获取真实结果；没有工具结果就明确说做不了。最后用一两句话说明本步结果。\n[角色设定]\n${persona}`,
          user:`执行任务步骤：${title}`
        });
        const tools=(raw?.tools||[]).filter(row=>row.ok===true&&!['failed','denied','unknown','cancelled'].includes(row.state||row.outcome));
        // 只读步骤失败可以安全重试；一旦本步调用过写操作，就不自动重放。
        const idempotent=tools.every(row=>row.mutating!==true);
        if(!tools.length)return {ok:false,error:'本步没有成功的工具结果',idempotent:true};
        // 写操作必须拿到可靠状态；unknown/failed 不能当作步骤成功。
        const writes=tools.filter(row=>row.mutating===true);
        const badWrite=writes.find(row=>!['confirmed','submitted','accepted'].includes(row.state||''));
        if(badWrite)return {ok:false,error:'写操作没有可靠结果：'+(badWrite.state||'unknown'),idempotent:false};
        const verified=tools.every(row=>row.verified===true);
        const states=tools.map(row=>row.state||row.outcome||'unknown');
        const state=verified?'confirmed':states.includes('submitted')?'submitted':states.includes('accepted')?'accepted':'unknown';
        return {ok:state!=='unknown',idempotent,tool:tools.map(row=>row.capability).join(','),state,verified,traceId:tools.find(row=>row.traceId)?.traceId||'',outcome:states.join(','),text:raw.text};
      }
    });
    taskRunnerTimer=setInterval(()=>{void taskRunner.tick().catch(error=>log('warn','任务执行失败：'+String(error?.message||error).slice(0,160)));},60000);
    taskRunnerTimer.unref?.();
  }catch(error){log('error','任务执行器不可用：'+error.message);taskRunner=null;}
  // 独立管理站点：只监听本机，自带密码登录；启动失败只记日志，不影响 QQ 桥接。
  let admin=null;
  try{admin=await startAdminServer({
    dir:path.join(store.dir,'admin'),action,
    asset:async({kind,id,url},meta)=>{
      if(!meta?.session)throw Object.assign(new Error('请先登录'),{status:401});
      if(kind==='sticker'){
        const image=await stickerAdmin.image(id);
        return {mime:image.mime,bytes:image.bytes};
      }
      if(kind==='qzone-image')return qzoneAdmin.image(url);
      if(kind==='qzone-avatar')return qzoneAdmin.avatar(id);
      throw Object.assign(new Error('不支持的资源'),{status:404});
    },
    onSessionEnd:session=>autonomyAdmin?.lockSession(session),
    log
  });}
  catch(error){log('warn','独立管理站点启动失败：'+error.message);admin=null;}
  // 角色自主决定是否创建秘密空间：只在她启用且 QQ 在线时尝试一次；决策结果持久化，不重复覆盖。
  if(autonomyAdmin&&store.data.framework.nativePackages['qq-autonomy']?.config?.secretAutoDecide!==false){
    secretDecisionTimer=setTimeout(()=>{
      if(closed||!autonomy?.api?.active?.())return;
      if(!bot?.status?.online)return;
      void autonomyAdmin.ensureDecision({force:false}).catch(error=>log('warn','秘密空间自主决策失败：'+String(error?.message||error).slice(0,160)));
    },12000);
    secretDecisionTimer.unref?.();
  }
  const uninstaller=new Uninstaller(store,{builtins,extensions,beforeChange:async()=>{invalidate(store);await native.revoke();}});
  const maintenance=setInterval(()=>sdk.pruneStorage().catch(e=>log('warn',e.message)),60000);maintenance.unref?.();
  events.subscribe('core-router',['message'],msg=>{
   router.receive(msg);
   // 自动收藏是旁路：失败只记日志，不影响消息处理。
   if(msg.parts?.some(part=>part.type==='image'))void stickerAuto.fromMessage(msg,{actor:msg.user,peer:msg.peer,kind:msg.kind,key:msg.key}).catch(()=>{});
  });
  events.subscribe('core-notices',['notice'],async event=>{await router.poke(event);await router.notice(event);});
  async function connect(){
    if(bot)await bot.stop();bot=new OneBot(store.data.settings,token,log);router.attach(bot);
    bot.on('event',event=>{events.receive(event).catch(e=>log('error',e.message));});
    bot.on('ready',()=>{router.recover().catch(e=>log('error',e.message));});
    if(store.data.settings.enabled)try{await bot.start();}catch(e){log('error','OneBot 启动失败：'+e.message);}
  }
  function snapshot(){
    return {participation:router.participation.snapshot(),chatProfiles:store.data.chatProfiles,promptStatus:native.lastPromptCheck,presetStatus:native.presetStatus,mediaStatus:incoming.status,proactive:proactive?.status?.()||null,tasks:taskStore.status(),taskDetails:taskStore.list({limit:10}).map(taskDetail),pluginPages:[...sdk.pageList(),...Object.entries(store.data.extensions).filter(([,p])=>p.manifest.hostApiVersion===2).map(([id,p])=>({id,native:false,title:p.manifest.settings?.title||p.manifest.name,description:p.manifest.settings?.description||p.manifest.description,sections:p.manifest.settings?.sections||[],...p,dependencyProblems:packages.problems(p.manifest,{enabled:true})}))],framework:{...store.data.framework,pluginData:undefined,retiredSessions:store.data.framework.retiredSessions.map(({sessionId,archived,error})=>({sessionId,archived,error}))},builtins:builtins.list(),capabilities:actions.catalog(),systemDenied:SYSTEM_DENIED,eventState:events.snapshot(),revision:store.data.revision,diagnostics:router.diagnostics,settings:store.data.settings,tokenConfigured:Boolean(token),status:bot?.status,
      personas:store.data.personas,personaDefaults:store.data.personaDefaults,bindings:store.data.bindings,
      sessions:store.data.sessions,nativePackages:Object.values(store.data.framework.nativePackages).map(p=>({...p,dependencyProblems:packages.problems(p.manifest,{enabled:true})})),extensions:Object.values(store.data.extensions).map(p=>({...p,dependencyProblems:packages.problems(p.manifest,{enabled:true})})),sources:store.data.sources,
      logs:store.data.logs.slice(-100),jobs:store.data.inbox.slice(-30).map(({persona,reply,flow,...j})=>({...j,batchCount:flow?.parts.length||1,message:{key:j.message.key,text:j.message.text.slice(0,120)}})),
      compatibility:{dsh:'0.2.1-rc.2',extensionApi:2,framework:FRAMEWORK_VERSION},dataDir:store.dir};
  }
  function chatIdentity(key){
    const parts=String(key||'').split(':');if(parts.length!==3||parts[0]!==bot?.status.bot||!['group','private'].includes(parts[1])||!/^\d{4,16}$/.test(parts[2]))throw Error('请选择当前机器人下的群或好友');
    return {type:'message',bot:parts[0],kind:parts[1],peer:parts[2],key:String(key),user:parts[1]==='private'?parts[2]:store.data.framework.ownerQQ};
  }
  async function action(body,meta={}){
    if(closed)throw new Error('插件已停止');const {action,revision}=body;
    if(action==='snapshot')return snapshot();
    if(action==='stickerAdmin'){
      const op=String(body.op||'overview');
      if(op==='overview')return stickerAdmin.overview();
      if(op==='list')return stickerAdmin.list(body.query||body);
      if(op==='remove')return stickerAdmin.remove(body.id);
      if(op==='annotate')return stickerAdmin.annotate(body);
      throw new Error('不支持的表情包管理操作');
    }
    if(action==='qzoneAdmin'){
      const op=String(body.op||'overview');
      if(op==='overview')return qzoneAdmin.overview();
      if(op==='friends')return qzoneAdmin.friendList(body.query||body);
      if(op==='refresh-friends')return {items:await qzoneAdmin.refreshFriends(),overview:qzoneAdmin.overview()};
      if(op==='feed')return qzoneAdmin.list(body.query||body);
      if(op==='sync'){
        const result=await qzoneAdmin.sync({friendIds:body.friendIds||[],reason:'manual'});
        return {result,overview:qzoneAdmin.overview()};
      }
      throw new Error('不支持的空间管理操作');
    }
    if(action==='memoryAdmin'){
      const op=String(body.op||'overview');
      if(op==='overview')return memoryAdmin.overview();
      if(op==='list')return memoryAdmin.list(body.query||body);
      if(op==='get')return memoryAdmin.get(body.id);
      if(op==='create')return memoryAdmin.create(body);
      if(op==='update')return memoryAdmin.update(body);
      if(op==='remove')return memoryAdmin.remove(body.id);
      if(op==='graph')return memoryAdmin.graph(body.query||body);
      if(op==='reviewOverview')return memoryAdmin.reviewOverview(body.query||body);
      if(op==='reviewComplete')return memoryAdmin.reviewComplete(body);
      throw new Error('不支持的记忆管理操作');
    }
    if(action==='autonomyAdmin'){
      if(!autonomyAdmin)throw new Error('自主时间管理服务不可用');
      const op=String(body.op||'overview');
      if(op==='overview')return autonomyAdmin.overview();
      if(op==='diaryList')return autonomyAdmin.diaryList(body.query||body);
      if(op==='diaryGet')return autonomyAdmin.diaryGet(body.id);
      if(op==='diaryCreate')return autonomyAdmin.diaryCreate(body);
      if(op==='diaryUpdate')return autonomyAdmin.diaryUpdate(body);
      if(op==='diaryDelete')return autonomyAdmin.diaryDelete(body.id);
      if(op==='activityList')return autonomyAdmin.activityList(body.query||body);
      if(op==='activityCreate')return autonomyAdmin.activityCreate(body);
      if(op==='activityUpdate')return autonomyAdmin.activityUpdate(body);
      if(op==='activityDelete')return autonomyAdmin.activityDelete(body.id);
      if(op==='timeSummary')return autonomyAdmin.timeSummary(body.query||body);
      throw new Error('不支持的自主时间管理操作');
    }
    if(action==='secretAdmin'){
      if(!autonomyAdmin)throw new Error('私密空间服务不可用');
      if(!meta?.adminSession)throw Object.assign(new Error('秘密空间只能从管理站点访问'),{status:403});
      const vaultSession=String(body.vaultSession||'');
      if(!/^[a-zA-Z0-9-]{16,80}$/.test(vaultSession))throw new Error('秘密空间页面会话无效，请刷新页面');
      return autonomyAdmin.secret(String(body.op||'status'),body,meta.adminSession+'|'+vaultSession);
    }
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
      const configInput={...(body.config||{})};
      if(Array.isArray(body.preserveSecrets))for(const key of body.preserveSecrets){
        if(typeof key!=='string'||!/^[a-zA-Z]\w{0,40}$/.test(key))throw new Error('敏感字段名无效');
        if(!configInput[key]&&p.config?.[key])configInput[key]=p.config[key];
      }
      const next=checkConfig(p.manifest,configInput),automationGrants=body.automationGrants??p.automationGrants??[];
      if(!Array.isArray(automationGrants)||automationGrants.some(id=>!(p.manifest.automations||[]).some(a=>a.id===id)))throw new Error('自动回复授权无效');
      p.settingsHistory=rememberSettings(p);p.configDeleted=false;p.config=next;p.configVersion=p.manifest.configVersion??1;p.scope={private:!!scope.private,allUsers:scope.allUsers===true,users,groups};p.automationGrants=[...new Set(automationGrants)];p.enabled=body.enabled===true;p.uninstalled=false;p.migrationError=null;p.error=null;p.health={...p.health,quarantined:false,consecutive:0};
      invalidate(store);await native.revoke();await sdk.pruneStorage();await store.persist();
      if(body.id==='qq-autonomy')await autonomyAdmin?.applyRetention();
      return snapshot();
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
  ctx.effect(()=>()=>{closed=true;clearInterval(emotionTimer);clearInterval(reminderTimer);clearInterval(maintenance);clearInterval(autonomyTimer);clearInterval(proactiveTimer);clearInterval(taskRunnerTimer);clearInterval(memoryReviewTimer);clearInterval(lifeTimer);clearInterval(socialEnergyTimer);clearInterval(profileTimer);clearTimeout(secretDecisionTimer);qzoneAdmin.stopScheduler();disposeFetch();autonomyAdmin?.vault?.lockAll();void(async()=>{await lifeState?.persist();await socialEnergy?.persist();await profileStore?.persist();await router.stop();await bot?.stop();await extensions.stop();await sdk.stop();await mediaBrowser.close();memory?.close();await admin?.close();await media.stop();await store.persist();})().catch(e=>ctx.logger.warn('QQ bridge cleanup: '+e.message));},'qq-bridge cleanup');
  await sdk.pruneStorage();await market.start();await media.start();await extensions.start();await native.start();await connect();qzoneAdmin.startScheduler();log('info','QQ 桥接插件已就绪，数据目录：'+store.dir);
}
