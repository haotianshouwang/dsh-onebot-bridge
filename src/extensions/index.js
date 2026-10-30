import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateConfig,validatePackageMetadata,packagesFor} from '../core/package-model.js';
export {validateConfig} from '../core/package-model.js';
export function contentHash(files){const hash=createHash('sha256');for(const name of Object.keys(files).sort())hash.update(name+'\0').update(files[name]);return hash.digest('hex');}
export function validateManifest(m){
 if(!m||!/^qq-[a-z0-9][a-z0-9-]{0,55}$/.test(m.id))throw new Error('扩展 ID 必须以 qq- 开头');
 if(!/^\d+\.\d+\.\d+$/.test(m.version)||m.hostApiVersion!==2||m.runtime!=='declarative'||m.entry!=='rules.json')throw new Error('当前只支持 API 2 声明式插件；JavaScript 扩展不会执行');
 if(!m.name||String(m.name).length>80)throw new Error('插件名称无效');
 if(!Array.isArray(m.capabilities)||m.capabilities.some(c=>!['commands','inbound','notice','actions'].includes(c)))throw new Error('插件权限无效');
 return validatePackageMetadata(m);
}
export function validateRules(value,manifest){
 if(!value||!Array.isArray(value.rules)||value.rules.length>50)throw new Error('规则格式无效，最多 50 条');
 const rules=value.rules.map(r=>{
  if(!r||!['command','contains','notice'].includes(r.type)||typeof r.match!=='string'||!r.match||r.match.length>80)throw new Error('规则匹配条件无效');
  const capability=r.type==='command'?'commands':r.type==='notice'?'notice':'inbound';
  if(!manifest.capabilities.includes(capability))throw new Error('规则使用了未声明的权限');
  if(r.type==='command'&&(!/^\/[^\s]{1,30}$/.test(r.match)))throw new Error('命令格式无效');
  if(typeof r.reply!=='string'||r.reply.length>4000)throw new Error('规则回复无效');
  return {type:r.type,match:r.match,reply:r.reply};
 });
 if(!Array.isArray(value.actions||[])||(value.actions||[]).length>10)throw new Error('动作数量无效');
 const actions=(value.actions||[]).map(a=>{
  if(!manifest.capabilities.includes('actions')||!a||!(/^[a-z][a-z0-9-]{0,30}$/).test(a.id)||typeof a.reply!=='string'||a.reply.length>4000||('qqf_plugin_'+manifest.id+'_'+a.id).length>64)throw new Error('声明式动作无效或名称过长');
  return {id:a.id,description:String(a.description||a.id).slice(0,150),reply:a.reply};
 });
 if(new Set(actions.map(a=>a.id)).size!==actions.length)throw new Error('动作 ID 重复');
 return {rules,actions};
}
export class Extensions {
 constructor(store,log,actions){this.store=store;this.log=log;this.actions=actions;this.packages=packagesFor(store);this.live=new Map();}
 async load(id){
  await this.unload(id);const item=this.store.data.extensions[id];if(!item?.enabled||item.uninstalled)return;
  const disposers=[];
  try{
   this.packages.assert(item.manifest,{enabled:true});
   const dir=path.join(this.store.dir,'extensions',id,...item.runtimeDir?[item.runtimeDir]:[]);
   const files={'manifest.json':await readFile(path.join(dir,'manifest.json')),'rules.json':await readFile(path.join(dir,'rules.json'))};
   if(item.integrity&&contentHash(files)!==item.integrity)throw new Error('插件文件完整性校验失败');
   const manifest=validateManifest(JSON.parse(files['manifest.json'].toString('utf8')));
   if(manifest.id!==id||manifest.version!==item.manifest.version)throw new Error('插件 ID 或版本与安装记录不一致');
   const rules=validateRules(JSON.parse(files['rules.json'].toString('utf8')),manifest),config=validateConfig(manifest,item.config);
   const render=text=>text.replace(/\{\{config\.([a-zA-Z]\w*)\}\}/g,(_,key)=>String(config[key]??''));
   for(const a of rules.actions)if(this.actions)disposers.push(this.actions.add('plugin.'+id+'.'+a.id,a.description,{type:'object',properties:{},additionalProperties:false,required:[]},async(_args,c)=>{if(!this.scoped(id,{user:c.actor,kind:c.kind,peer:c.peer}))throw new Error('插件作用范围不允许此聊天');return {text:render(a.reply)};},{plugin:id,publicSafe:true,inScope:c=>this.scoped(id,{user:c.actor,kind:c.kind,peer:c.peer}),available:()=>this.available(id)}));
   this.live.set(id,{manifest,...rules,render,disposers});item.error=null;item.health={...item.health,quarantined:false,consecutive:0};
  }catch(e){for(const dispose of disposers)dispose();item.enabled=false;item.error=e.message;this.log('warn','插件未加载：'+id+' '+e.message);await this.store.persist();throw e;}
 }
 available(id){const item=this.store.data.extensions[id];return !!item?.enabled&&!item.uninstalled&&this.live.has(id)&&!this.packages.problems(item.manifest,{enabled:true}).length;}
 async unload(id){const item=this.live.get(id);this.live.delete(id);for(const dispose of item?.disposers||[])dispose();}
 async start(){
  const pending=new Set(Object.entries(this.store.data.extensions).filter(([,p])=>p.enabled).map(([id])=>id));
  for(let pass=0;pass<=pending.size+1&&pending.size;pass++){
   let progress=false;for(const id of [...pending])if(!this.packages.problems(this.store.data.extensions[id].manifest,{enabled:true}).length){try{await this.load(id);}catch{}pending.delete(id);progress=true;}
   if(!progress)break;
  }
  for(const id of pending){const p=this.store.data.extensions[id];p.error=this.packages.problems(p.manifest,{enabled:true}).join('；');}
 }
 scoped(id,msg){const scope=this.store.data.extensions[id]?.scope;return this.available(id)&&!!scope&&(scope.allUsers===true||scope.users.includes(msg.user))&&(msg.kind==='private'?scope.private:scope.groups.includes(msg.peer));}
 async inbound(msg){
  for(const [id,item]of this.live){
   if(!this.scoped(id,msg))continue;
   for(const rule of item.rules)if(rule.type==='command'&&msg.text.trim().split(/\s/)[0]===rule.match||rule.type==='contains'&&msg.text.includes(rule.match))return item.render(rule.reply);
  }return null;
 }
 async notices(event){
  const replies=[];for(const [id,item]of this.live){
   const scope=this.store.data.extensions[id]?.scope;if(!this.available(id)||!scope?.groups.includes(event.peer)||event.kind!=='group')continue;
   for(const rule of item.rules)if(rule.type==='notice'&&rule.match===event.name)replies.push({id,text:item.render(rule.reply)});
  }return replies;
 }
 async transform(_hook,text){return text;}
 async stop(){for(const id of this.live.keys())await this.unload(id);}
}
