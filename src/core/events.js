import {isOwner} from './owners.js';
import { randomUUID } from 'node:crypto';
export function listening(f,event){
  if(event.kind==='group')return f.listenGroups.includes(event.peer);
  if(event.kind==='private')return event.type==='message'&&isOwner(f,event.user)||f.listenPrivate&&(f.listenAllPrivate||f.listenUsers.includes(event.user));
  return event.type==='meta';
}
export class Events {
  constructor(store,log){this.store=store;this.log=log;this.listeners=new Map();this.recent=[];this.requests=store.data.requestInbox||[];this.requests=this.requests.filter(x=>Date.now()-x.receivedAt<86400000).slice(0,50);for(const r of this.requests)if(r.state==='submitting')r.state='unknown';store.data.requestInbox=this.requests;this.observed=new Map();this.count=0;}
  subscribe(id,types,handler){this.listeners.set(id,{types:new Set(types),handler});return()=>this.listeners.delete(id);}
  async receive(event){
    const f=this.store.data.framework;
    if(!this.store.data.settings.enabled||!listening(f,event))return false;
    if(event.type==='notice'&&!f.listenNotices||event.type==='request'&&!f.listenRequests)return false;
    this.count++;
    this.recent.unshift({time:new Date().toISOString(),type:event.type,name:event.name||event.kind,peer:event.peer||'',user:event.user||'',id:event.id||''});
    this.recent=this.recent.slice(0,50);
    if(event.type==='message'){
      this.observed.set(event.bot+':'+event.id,{key:event.key,user:event.user,time:Date.now(),bot:event.bot,media:(event.parts||[]).filter(p=>['image','record','video'].includes(p.type)).slice(0,20).map(p=>({type:p.type,file:String(p.data.file||'').slice(0,2048),url:String(p.data.url||'').slice(0,2048)})),forwards:(event.parts||[]).filter(p=>p.type==='forward').map(p=>String(p.data.id))});
      if(this.observed.size>2000)this.observed.delete(this.observed.keys().next().value);
    }
    if(event.type==='request'){
      if(!this.requests.some(x=>x.flag===event.flag&&x.bot===event.bot)){
        this.requests.unshift({...event,requestId:randomUUID(),receivedAt:Date.now(),state:'pending'});
        this.requests.splice(50);await this.store.persist();
      }
    }
    await Promise.all([...this.listeners].filter(([,x])=>x.types.has(event.type)).map(async([id,x])=>{try{await x.handler(structuredClone(event));}catch(e){this.log('warn','事件处理失败：'+id+' '+e.message);}}));
    return true;
  }
  hasMessage(c,id){const row=this.observed.get(c.bot+':'+id);return !!row&&row.key===c.key&&Date.now()-row.time<3600000;}
  snapshot(){return {count:this.count,recent:this.recent,requests:this.requests.map(({flag,...r})=>r)};}
}
