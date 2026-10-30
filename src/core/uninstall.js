import {randomUUID} from 'node:crypto';
import {packagesFor,validateConfig} from './package-model.js';
const emptyScope=()=>({private:false,allUsers:false,users:[],groups:[]});
const defaults=m=>{try{return validateConfig(m,{});}catch{return {};}};
export class Uninstaller{
 constructor(store,{builtins,extensions,beforeChange=async()=>{},now=()=>Date.now()}={}){Object.assign(this,{store,builtins,extensions,beforeChange,now});this.tickets=new Map();}
 target(kind,id){
  if(typeof id!=='string'||!/^[a-z][a-z0-9-]{0,60}$/.test(id))throw Error('插件 ID 无效');let item,manifest;
  if(kind==='builtin'){item=this.store.data.framework.builtins[id];manifest=this.builtins.list().find(p=>p.id===id);}
  else if(kind==='native'){item=this.store.data.framework.nativePackages?.[id];manifest=item?.manifest;}
  else if(kind==='extension'){item=this.store.data.extensions[id];manifest=item?.manifest;}
  else throw Error('插件类型无效');
  if(!item||!manifest||item.uninstalled)throw Error('插件不存在或已卸载');return {item,manifest};
 }
 prepare({kind,id,configChoice,revision}){
  if(revision!==this.store.data.revision)throw Error('设置已变更，请刷新后重新选择');if(!['keep','delete'].includes(configChoice))throw Error('请选择保留或删除配置');
  const {manifest}=this.target(kind,id);packagesFor(this.store).protect(id);
  for(const [id,t]of this.tickets)if(t.expires<this.now())this.tickets.delete(id);if(this.tickets.size>=50)throw Error('待确认操作过多，请取消旧操作');
  const ticket=randomUUID(),expires=this.now()+120000;
  const clear=configChoice==='keep'?[]:kind==='builtin'?this.builtins.clearList(id):['该包配置、作用范围、自动化许可及设置历史','该包旧版本中保存的配置','该包专属的工具启用与范围授权'];
  const plan={ticket,kind,id,name:manifest.name,version:manifest.version||'1.0.0',configChoice,revision,expires,clear,retained:['插件代码文件及可用安装记录','人设正文、聊天记录和插件业务数据','主人身份、OneBot 凭据及其他插件设置'],hostNote:kind==='native'&&!manifest.bundled?'仅移除 QQ 框架的功能注册；DSH 宿主模块仍由 DSH 管理。':''};
  this.tickets.set(ticket,plan);return structuredClone(plan);
 }
 cancel(ticket){this.tickets.delete(ticket);return {cancelled:true};}
 async confirm({ticket,confirmed,revision}){
  const plan=this.tickets.get(ticket);if(!plan||plan.expires<this.now()){this.tickets.delete(ticket);throw Error('卸载确认已过期，请重新选择');}
  if(confirmed!==true)throw Error('需要在第二步明确确认卸载');if(revision!==plan.revision||revision!==this.store.data.revision)throw Error('设置已变更，原卸载确认失效');
  const {item,manifest}=this.target(plan.kind,plan.id);if((manifest.version||'1.0.0')!==plan.version)throw Error('插件版本已变化，请重新确认');packagesFor(this.store).protect(plan.id);this.tickets.delete(ticket);
  await this.beforeChange();
  if(plan.kind==='builtin')this.builtins.remove(plan.id,{deleteConfig:plan.configChoice==='delete'});
  else{
   if(plan.kind==='extension')await this.extensions.unload(plan.id);
   item.enabled=false;item.uninstalled=true;
   if(plan.configChoice==='delete'){
    item.config=defaults(manifest);item.scope=emptyScope();item.automationGrants=[];item.settingsHistory=[];item.configDeleted=true;
    if(item.history)item.history=item.history.map(h=>({...h,config:defaults(h.manifest||manifest),scope:emptyScope(),automationGrants:[],settingsHistory:[]}));
    const prefix='plugin.'+plan.id+'.',f=this.store.data.framework;f.grants=f.grants.filter(g=>!g.capability?.startsWith(prefix));f.enabledActions=f.enabledActions.filter(id=>!id.startsWith(prefix));
   }
  }
  item.uninstalledAt=new Date(this.now()).toISOString();item.uninstallChoice=plan.configChoice;await this.store.persist();return {id:plan.id,kind:plan.kind,uninstalled:true,configChoice:plan.configChoice};
 }
}
