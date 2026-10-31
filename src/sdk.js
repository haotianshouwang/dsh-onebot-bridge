import {AsyncLocalStorage} from 'node:async_hooks';
import {isOwner} from './core/owners.js';
import {validateConfig,validatePackageMetadata,migrateConfig,packagesFor,rememberSettings} from './core/package-model.js';
const safeId=/^qq-[a-z0-9][a-z0-9-]{0,38}$/;
const view=e=>{const out=structuredClone(e);delete out.flag;if(out.parts)out.parts=out.parts.map(p=>p.type==='text'?{type:'text',data:{text:String(p.data.text||'')}}:{type:p.type,data:{}});return Object.freeze(out);};
const limited=(work,ms,controller)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{controller.abort();reject(new Error('插件处理超时'));},ms);
 Promise.resolve().then(work).then(resolve,reject).finally(()=>clearTimeout(timer));
});
export class PluginSDK {
 #eventTickets=new WeakMap();
 constructor({store,permissions,actions,events,media,onChange,automaticReply,log=()=>{}}){
  Object.assign(this,{store,permissions,actions,events,media,onChange,automaticReply,log});this.live=new Map();this.pages=new Map();this.calls=new AsyncLocalStorage();this.tails=new Map();this.waiting=new Map();this.owned=new Map();this.contextProviders=new Map();
  store.data.framework.nativePackages||={};store.data.framework.pluginData||={};this.packages=packagesFor(store);
  for(const p of Object.values(store.data.framework.nativePackages))p.registered=false;
 }
 facade(){return Object.freeze({apiVersion:2,features:['settings-pages','dependencies','config-migrations','event-replies','fault-isolation','shared-queries','context-providers'],catalog:()=>this.actions.catalog(),registerTrustedPackage:m=>this.register(m)});}
 changed(reason){try{void Promise.resolve(this.onChange?.(reason)).catch(e=>this.log('warn',e.message));}catch(e){this.log('warn',e.message);}}
 active(id){const p=this.store.data.framework.nativePackages[id];return this.live.has(id)&&p?.enabled&&!p.uninstalled&&!p.health?.quarantined&&!p.migrationError&&!this.packages.problems(p.manifest,{enabled:true}).length;}
 async hook(id,stage,work,timeout=5000){
  const p=this.store.data.framework.nativePackages[id],controller=new AbortController(),lease={alive:true,signal:controller.signal,stage,generation:this.store.data.framework.generation};
  try{const result=await limited(()=>this.calls.run(lease,()=>work(controller.signal)),timeout,controller);p.health={...p.health,consecutive:0,lastSuccess:new Date().toISOString()};return result;}
  catch(e){
   // 配额、参数错误、取消、网关已受理/结果未知都是预期结果，不能把插件隔离。
   if(['PLUGIN_INPUT','PLUGIN_CANCELLED','QUOTA','ACCEPTED','UNKNOWN_OUTCOME'].includes(e.code))throw e;
   const count=(p.health?.consecutive||0)+1;p.error=String(e.message||e).slice(0,350);p.health={...p.health,consecutive:count,lastError:p.error,stage,at:new Date().toISOString(),totalErrors:(p.health?.totalErrors||0)+1,quarantined:count>=3||p.health?.quarantined===true};
   if(p.health.quarantined){p.enabled=false;this.changed({reason:'quarantine',plugin:id});}await this.store.persist();throw e;
  }finally{lease.alive=false;controller.abort();}
 }
 checkLease(){const lease=this.calls.getStore();if(lease&&(!lease.alive||lease.signal.aborted||lease.generation!==this.store.data.framework.generation))throw Object.assign(new Error('插件回调已结束或取消'),{code:'PLUGIN_CANCELLED'});}
 register(manifest){
  const id=manifest?.id;
  if(!safeId.test(id)||!manifest.name||String(manifest.name).length>80||!/^\d+\.\d+\.\d+$/.test(manifest.version||''))throw new Error('原生包元数据无效');
  if(this.live.has(id)||this.store.data.extensions[id])throw new Error('原生包 ID 已被注册');
  if(!Array.isArray(manifest.capabilities)||manifest.capabilities.some(x=>!['events','actions','resources','storage','automatic-replies','context'].includes(x)))throw new Error('原生包能力声明无效');
  const m=structuredClone({apiVersion:2,type:'native-source',...manifest,runtime:'trusted-native'});validatePackageMetadata(m);
  const automations=m.automations||[];
  if(!Array.isArray(automations)||automations.length>10||new Set(automations.map(a=>a.id)).size!==automations.length)throw new Error('自动回复声明无效');
  for(const a of automations)if(a.configGate&&m.configSchema?.[a.configGate]?.type!=='boolean'||!/^[a-z][a-z0-9-]{0,20}$/.test(a.id)||!['group_increase','group_decrease','group_admin','group_ban','notify'].includes(a.event)||typeof a.title!=='string')throw new Error('自动回复声明无效');
  const old=this.store.data.framework.nativePackages[id];let config={},migrationError=null;
  try{config=migrateConfig(old,m);}catch(e){if(!old)throw e;config=structuredClone(old.config);migrationError=e.message;}
  const item={manifest:m,enabled:!!old?.enabled&&old.manifest.version===m.version&&!migrationError,config,configVersion:migrationError?old.configVersion:(m.configVersion??1),
   scope:old?.scope||{private:true,users:[...this.store.data.settings.allowedUsers],groups:[]},automationGrants:old?.automationGrants||[],
   native:true,registered:true,uninstalled:old?.uninstalled===true,configDeleted:old?.configDeleted===true,generation:m.version,migrationError,error:migrationError||old?.error||null,health:old?.health||{},settingsHistory:old&&old.manifest.version!==m.version?rememberSettings(old):old?.settingsHistory||[]};
  this.store.data.framework.nativePackages[id]=item;this.live.set(id,item);
  const disposers=[];this.owned.set(id,disposers);
  const permit=cap=>{if(!m.capabilities.includes(cap))throw new Error('包未声明 '+cap+' 能力');};
  const scoped=c=>{
   if(!this.active(id)||this.permissions.valid(c))return false;const scope=item.scope;
   return (scope.allUsers===true||scope.users.includes(c.actor))&&(c.kind==='private'?scope.private:scope.groups.includes(c.peer));
  };
  const check=c=>{this.checkLease();if(!scoped(c)||c.plugin!==id)throw new Error('包已停用或执行身份超出作用范围');};
  const write=async updater=>{
   permit('storage');this.checkLease();if(!this.active(id))throw Object.assign(new Error('插件已停用'),{code:'PLUGIN_CANCELLED'});
   const before=this.store.data.framework.pluginData[id]||{},value=updater(structuredClone(before));
   if(value&&typeof value.then==='function')throw new Error('存储更新函数须同步返回');
   const encoded=JSON.stringify(value);if(typeof encoded!=='string'||Buffer.byteLength(encoded)>65536)throw new Error('插件存储超过 64 KiB');
   this.checkLease();this.store.data.framework.pluginData[id]=JSON.parse(encoded);await this.store.persist();return structuredClone(value);
  };
  const api=Object.freeze({
   id,apiVersion:2,active:()=>this.active(id),getConfig:()=>structuredClone(item.config),getScope:()=>({...structuredClone(item.scope),groups:item.scope.groups.filter(g=>this.store.data.framework.listenGroups.includes(g))}),reject:message=>{throw Object.assign(new Error(String(message)),{code:'PLUGIN_INPUT'});},
   isOwner:context=>isOwner(this.store.data.framework,context?.actor),
   // 让插件把长任务移出当前回调的异步上下文：否则回调结束后，任务里的工具调用会继承已失效的租约。
   detach:work=>this.calls.exit(work),
   on:(types,handler)=>{
    permit('events');if(typeof handler!=='function'||!Array.isArray(types)||types.some(t=>!['message','notice','request','meta'].includes(t)))throw new Error('事件订阅无效');
    const dispose=this.events.subscribe('native:'+id+':'+disposers.length,types,e=>{
     if(!this.active(id))return;
     const generation=this.store.data.framework.generation,scope=item.scope;
     if(e.kind==='group'?!scope.groups.includes(e.peer):e.kind==='private'?(!scope.private||!(scope.allUsers||scope.users.includes(e.user))):e.type!=='meta')return;
     if((this.waiting.get(id)||0)>=50){item.health.dropped=(item.health.dropped||0)+1;return;}
     this.waiting.set(id,(this.waiting.get(id)||0)+1);
     const task=(this.tails.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if(!this.active(id)||generation!==this.store.data.framework.generation)return;
      const context=e.type==='message'?this.permissions.issue(e,'plugin',id):null,event=view(e),ticket={event:structuredClone(e),id,generation,open:true};
      this.#eventTickets.set(event,ticket);
      try{await this.hook(id,'event',signal=>handler(event,context,signal),Math.min(30000,Math.max(500,m.eventTimeoutMs||5000)));}
      finally{ticket.open=false;this.permissions.close(context);}
     }).finally(()=>this.waiting.set(id,Math.max(0,(this.waiting.get(id)||1)-1)));
     this.tails.set(id,task);return task;
    });disposers.push(dispose);return dispose;
   },
   action:(name,definition,handler)=>{
    permit('actions');if(!/^[a-z][a-z0-9-]{0,20}$/.test(name)||typeof handler!=='function')throw new Error('动作声明无效');
    const capability='plugin.'+id+'.'+name;if(('qqf_'+capability.replace(/[^a-zA-Z0-9]/g,'_')).length>64)throw new Error('插件动作名称过长');
    const dispose=this.actions.add(capability,String(definition.description||name).slice(0,200),definition.parameters,async(args,parent,signal)=>{
     const context=this.permissions.delegate(parent,id);check(context);
     try{return await this.hook(id,'action',async localSignal=>{const combined=signal?AbortSignal.any([signal,localSignal]):localSignal;try{const result=await handler(args,context,combined);check(context);return result;}catch(e){if(signal?.aborted)throw Object.assign(new Error('插件任务已取消'),{code:'PLUGIN_CANCELLED'});throw e;}},Math.min(30000,Math.max(500,definition.timeoutMs||15000)));}
     finally{this.permissions.close(context);}
    },{plugin:id,ownerOnly:definition.ownerOnly===true,mutating:definition.mutating===true,publicSafe:definition.publicSafe===true,inScope:scoped,available:()=>this.active(id)});
    disposers.push(dispose);return dispose;
   },
   settings:(definition,provider)=>{
    validatePackageMetadata({...m,settings:definition});item.manifest.settings=structuredClone(definition);
    if(provider&&typeof provider!=='function')throw new Error('设置页数据提供器须为函数');
    this.pages.set(id,{definition:structuredClone(definition),provider});return()=>this.pages.delete(id);
   },
   invoke:(capability,args,context,signal)=>{check(context);return this.actions.invoke(capability,args,context,signal);},
   registerContextProvider:provider=>{
    permit('context');if(typeof provider!=='function')throw new Error('上下文提供器须为函数');
    const key='native:'+id+':'+disposers.length;this.contextProviders.set(key,{id,provider});
    const dispose=()=>this.contextProviders.delete(key);disposers.push(dispose);return dispose;
   },
   putResource:(bytes,context,options={})=>{permit('resources');check(context);return this.media.put(bytes,{...options,key:context.key,plugin:id});},
   automaticReply:async(event,automationId,text)=>{
    permit('automatic-replies');this.checkLease();const ticket=this.#eventTickets.get(event),definition=automations.find(a=>a.id===automationId);
    if(!ticket?.open||ticket.id!==id||ticket.generation!==this.store.data.framework.generation||!definition||event.type!=='notice'||event.name!==definition.event||event.kind!=='group')throw new Error('自动回复事件身份无效');
    const valid=()=>this.active(id)&&item.automationGrants.includes(automationId)&&(!definition.configGate||item.config[definition.configGate]===true)&&item.scope.groups.includes(ticket.event.peer);
    if(!valid()||typeof text!=='string'||!text.trim()||text.length>500)throw new Error('自动回复未授权、超出范围或内容无效');
    if(!this.automaticReply)throw new Error('核心自动回复服务不可用');
    return this.automaticReply({id,automationId,event:ticket.event,generation:ticket.generation,expires:Date.now()+30000,valid},text);
   },
   storage:Object.freeze({get:()=>{permit('storage');return structuredClone(this.store.data.framework.pluginData[id]||{});},set:value=>write(()=>value),update:fn=>{if(typeof fn!=='function')throw new Error('存储更新器无效');return write(fn);}}),
   dispose:async()=>{
    if(!this.live.delete(id))return;item.registered=false;this.pages.delete(id);
    for(const dispose of disposers.reverse())dispose();this.owned.delete(id);await this.onChange?.();
   }
  });
  if(m.settings)api.settings(m.settings);
  return api;
 }
 pageList(){
  const result=[];
  for(const [id,item]of this.live){const definition=this.pages.get(id)?.definition||item.manifest.settings;if(!item.uninstalled&&(definition||Object.keys(item.manifest.configSchema||{}).length))result.push({id,native:true,title:definition?.title||item.manifest.name,description:definition?.description||item.manifest.description||'',sections:definition?.sections||[],enabled:item.enabled,config:item.config,scope:item.scope,manifest:item.manifest,automationGrants:item.automationGrants,health:item.health,error:item.error,settingsHistory:item.settingsHistory,dependencyProblems:this.packages.problems(item.manifest,{enabled:true})});}
  return result;
 }
 async pageData(id,query={}){
  if(!this.live.has(id))throw new Error('插件设置页当前未注册');
  const page=this.pages.get(id);if(!page?.provider)return {rows:[],columns:[]};
  return this.hook(id,'settings',async()=>{const result=await page.provider(structuredClone(query));
  if(!result||Buffer.byteLength(JSON.stringify(result))>131072||!Array.isArray(result.rows||[])||(result.rows||[]).length>100)throw new Error('插件设置页数据格式或大小无效');
  const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
  if(result.columns!=null&&(!Array.isArray(result.columns)||result.columns.length>20||result.columns.some(c=>!plain(c)||typeof c.key!=='string'||typeof c.label!=='string'||c.label.length>80||c.format!=null&&c.format!=='datetime'))||
    result.stats!=null&&(!Array.isArray(result.stats)||result.stats.length>10||result.stats.some(s=>!plain(s)||typeof s.label!=='string'||s.label.length>80||!['string','number'].includes(typeof s.value)))||
    (result.rows||[]).some(r=>!plain(r))||result.groups!=null&&(!Array.isArray(result.groups)||result.groups.length>1000||result.groups.some(g=>typeof g!=='string'||!/^[1-9]\d{3,15}$/.test(g)))||
    ['total','offset'].some(k=>result[k]!=null&&(!Number.isSafeInteger(result[k])||result[k]<0))||result.hasMore!=null&&typeof result.hasMore!=='boolean')throw new Error('插件设置页数据格式无效');
  return JSON.parse(JSON.stringify(result));},5000);
 }
 // 回复前向已启用的包取一小段上下文（长期记忆等）。提供器只读、超时即跳过，失败不影响本轮。
 async contextFor(input){
  const parts=[];
  for(const {id,provider} of [...this.contextProviders.values()]){
   if(!this.active(id))continue;
   const controller=new AbortController();
   try{
    const text=await limited(()=>provider(Object.freeze({...input})),1200,controller);
    if(typeof text==='string'&&text.trim())parts.push(text.trim());
   }catch(error){
    this.log('warn','QQ 上下文提供器跳过：'+String(error?.message||error).slice(0,160));
   }
  }
  return parts.join('\n').slice(0,2000);
 }
 async pruneStorage(){
  let changed=false;
  for(const [id,item]of Object.entries(this.store.data.framework.nativePackages)){
   if(item.uninstalled||item.configDeleted)continue;
   const p=item.manifest.storagePolicy,data=this.store.data.framework.pluginData[id];if(!p||!data||!Array.isArray(data[p.collection]))continue;
   const days=Number(item.config[p.daysField]),limit=Number(item.config[p.limitField]),cutoff=Date.now()-days*86400000,groups=item.scope.groups.filter(g=>this.store.data.framework.listenGroups.includes(g));
   if(!Number.isFinite(days)||days<1||!Number.isInteger(limit)||limit<1)continue;
   const rows=data[p.collection].filter(r=>r&&Number(r[p.timestamp])>=cutoff&&(!p.group||groups.includes(String(r[p.group])))).slice(0,Math.min(limit,1000));
   if(JSON.stringify(rows)!==JSON.stringify(data[p.collection])){data[p.collection]=rows;changed=true;}
  }
  if(changed)await this.store.persist();return changed;
 }
 async stop(){for(const [id,ds]of this.owned){const p=this.store.data.framework.nativePackages[id];if(p)p.registered=false;for(const d of ds.reverse())d();}this.live.clear();this.pages.clear();this.owned.clear();this.contextProviders.clear();}
}
