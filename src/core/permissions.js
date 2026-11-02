import {freeMode} from './freedom.js';
import { randomUUID } from 'node:crypto';
import {isOwner,validateOwners} from './owners.js';
const qq=/^[1-9]\d{3,15}$/;
export const SYSTEM_DENIED=['系统命令与任意脚本','任意本机文件、凭据与 Token','提权、动态安装、子代理与任意 MCP','踢人、封禁、授予管理员、退群与解散','删除好友、批量群发、原始 OneBot action'];
const baselineQueries=new Set(['core.status','qq.group.info','qq.member.info','qq.members.list','qq.message.get','qq.history.get','plugin.qq-web.search','plugin.qq-web.read','plugin.qq-web.image-search']);
const forbidden=/(?:shell|powershell|pwsh|bash|exec|run_code|credential|cookies|csrf|clientkey|restart|clean_cache|delete_friend|group_kick|group_ban|whole_ban|group_admin|group_leave|quick_operation|subagent|^raw\.)/i;
export function validatePolicy(input, catalog) {
  if(!input)throw new Error('请填写有效的主人 QQ 号');const owners=validateOwners(input);
  const known=new Map(catalog.map(c=>[c.id,c]));
  const enabledActions=[...new Set(input.enabledActions||[])];
  if(enabledActions.some(id=>!known.has(id)||forbidden.test(id)))throw new Error('包含未知或禁止的能力');
  if(!Array.isArray(input.grants)||input.grants.length>100)throw new Error('最多配置 100 项授权');
  const grants=input.grants.map(g=>{
    if(!known.has(g.capability)||!enabledActions.includes(g.capability))throw new Error('请先启用授权对应的能力');
    if(known.get(g.capability).ownerOnly)throw new Error('该能力仅主人可用，不能下放');
    const allUsers=g.allUsers===true;if(allUsers&&!g.deny&&!known.get(g.capability).publicSafe)throw new Error('面向所有用户只能开放标记为安全查询的能力');
    const users=[...new Set((g.users||[]).map(String))],groups=[...new Set((g.groups||[]).map(String))];
    if(!allUsers&&!users.length||users.some(x=>!qq.test(x))||groups.some(x=>!qq.test(x)))throw new Error('授权须指定有效的用户和群号');
    if(!g.private&&!groups.length)throw new Error('授权须选择私聊或指定群');
    const expires=g.expires||'';
    if(expires&&(!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.now()))throw new Error('授权到期时间无效');
    const perMinute=Number(g.perMinute??5);
    if(!Number.isInteger(perMinute)||perMinute<1||perMinute>30)throw new Error('每分钟额度须为 1–30');
    return {id:typeof g.id==='string'&&/^[\w-]{1,60}$/.test(g.id)?g.id:randomUUID(),capability:g.capability,allUsers,users,groups,private:!!g.private,deny:g.deny===true,expires,perMinute};
  });
  return {...owners,enabledActions,grants};
}
export class Permissions {
  #contexts=new WeakSet();
  #used=new WeakMap();
  #leases=new WeakMap();
  constructor(store){this.store=store;this.boot=randomUUID();this.usage=new Map();}
  issue(msg,mode='agent',plugin='core') {
    if(!['private','group'].includes(msg.kind)||!qq.test(msg.user)||!qq.test(msg.bot)||!qq.test(msg.peer)||!msg.id||msg.key!==msg.bot+':'+msg.kind+':'+msg.peer||msg.kind==='private'&&msg.peer!==msg.user)throw new Error('执行身份不完整');
    // traceId 把一次消息处理、工具调用、审计和任务步骤关联起来；同一条 QQ 消息固定同一个值。
    const traceId=String(msg.traceId||'').slice(0,200)||(msg.key+':'+String(msg.id)).slice(0,200);
    const c=Object.freeze({actor:msg.user,bot:msg.bot,kind:msg.kind,peer:msg.peer,key:msg.key,messageId:msg.id,traceId,
      generation:this.store.data.framework.generation,boot:this.boot,id:randomUUID(),mode,plugin});
    this.#contexts.add(c);this.#used.set(c,new Set());this.#leases.set(c,{open:true,expires:Date.now()+this.store.data.settings.turnTimeout*1000});return c;
  }
  delegate(parent,plugin){const invalid=this.valid(parent);if(invalid)throw new Error(invalid);const c=Object.freeze({...parent,id:randomUUID(),plugin});this.#contexts.add(c);this.#used.set(c,this.#used.get(parent));this.#leases.set(c,{open:true,parent:this.#leases.get(parent),expires:Date.now()+this.store.data.settings.turnTimeout*1000});return c;}
  observer(parent){const invalid=this.valid(parent);if(invalid)throw Error(invalid);const c=Object.freeze({...parent,id:randomUUID(),mode:'observer'});this.#contexts.add(c);this.#used.set(c,new Set());this.#leases.set(c,{open:true,parent:this.#leases.get(parent),expires:Date.now()+15000});return c;}
  textOnly(parent){const invalid=this.valid(parent);if(invalid)throw Error(invalid);const c=Object.freeze({...parent,id:randomUUID(),mode:'rewrite'});this.#contexts.add(c);this.#used.set(c,new Set());this.#leases.set(c,{open:true,parent:this.#leases.get(parent),expires:Date.now()+this.store.data.settings.turnTimeout*1000});return c;}
  hasUsed(c){return (this.#used.get(c)?.size||0)>0;}
  close(c){if(c&&this.#leases.has(c))this.#leases.get(c).open=false;}
  valid(c){
    if(!c||!this.#contexts.has(c)||c.boot!==this.boot)return '无效的执行身份';
    let lease=this.#leases.get(c);while(lease){if(!lease.open||lease.expires<Date.now())return '执行上下文已失效或到期';lease=lease.parent;}
    if(c.generation!==this.store.data.framework.generation)return '权限或插件已变更，本轮授权已撤销';
    if(!this.store.data.settings.enabled)return 'QQ 连接已停用';
    const f=this.store.data.framework;
    if(c.kind==='group'&&!f.listenGroups.includes(c.peer))return '该群不在监听范围';
    if(c.kind==='private'&&!isOwner(f,c.actor)&&(!f.listenPrivate||!(f.listenAllPrivate||f.listenUsers.includes(c.actor))))return '该用户不在私聊监听范围';
    return null;
  }
  resultReason(c){const invalid=this.valid(c);if(invalid)return invalid;for(const cap of this.#used.get(c)||[]){const reason=this.decision(cap,c);if(reason)return '结果发送前复核失败：'+reason;}return null;}
  owner(c){return !this.valid(c)&&isOwner(this.store.data.framework,c.actor);}
  decision(cap,c) {
    const invalid=this.valid(c);if(invalid)return invalid;
    if(c.mode==='observer')return '参与判断不允许工具调用';
    if(c.mode==='rewrite')return '回复改写不允许任何工具调用';
    if(c.mode==='poke')return '戳一戳只作互动，不执行工具';
    if(c.mode==='context'&&(!cap?.publicSafe||cap.mutating||cap.ownerOnly))return '同群接话仅使用已授权的安全查询，修改和管理操作需要明确唤醒';
    if(c.mode==='ambient')return '随机参与只聊天，不执行工具';
    if(!cap||forbidden.test(cap.id))return '系统禁止或未知能力';
    const f=this.store.data.framework;
    if(cap.available&&!cap.available())return '功能包已停用';
    if(!f.enabledActions.includes(cap.id))return '主人尚未启用此能力';
    const matches=g=>g.capability===cap.id&&(g.users.includes(c.actor)||g.allUsers===true&&!isOwner(f,c.actor))&&(!g.expires||Date.parse(g.expires)>Date.now())&&
      (c.kind==='private'?g.private:g.groups.includes(c.peer));
    if(f.grants.some(g=>g.deny&&matches(g)))return '此范围已明确拒绝';
    if(cap.privateOnly&&c.kind!=='private')return '此能力仅在私聊可用';
    if(cap.ownerOnly&&!this.owner(c))return '此能力仅主人可用';
    if(cap.riskLevel==='C'&&!['chat','agent'].includes(c.mode))return 'C 级操作需要主人明确确认';
    if(cap.inScope&&!cap.inScope(c))return '此插件未对当前聊天开放';
    if(cap.publicSafe&&!cap.mutating&&!cap.ownerOnly&&baselineQueries.has(cap.id)&&(c.kind==='group'||cap.plugin==='qq-web')&&['chat','context'].includes(c.mode))return null;
    if(this.owner(c))return null;
    if(!f.grants.some(g=>!g.deny&&matches(g)&&(!g.allUsers||cap.publicSafe)))return '此工具尚未向当前用户开放';
    return null;
  }
  assert(cap,c,consume=false){
    const reason=this.decision(cap,c);
    if(reason){this.audit('denied',cap?.id||'unknown',c,reason,cap?.riskLevel||'');throw new Error(reason);}
    if(consume){
      this.#used.get(c)?.add(cap);
      const grants=this.store.data.framework.grants.filter(g=>!g.deny&&g.capability===cap.id&&(g.users.includes(c.actor)||g.allUsers===true&&cap.publicSafe)&&
        (!g.expires||Date.parse(g.expires)>Date.now())&&(c.kind==='private'?g.private:g.groups.includes(c.peer)));
      const limit=this.owner(c)?30:Math.min(...grants.map(g=>g.perMinute),30);
      const key=c.actor+':'+c.key+':'+cap.id,now=Date.now(),recent=(this.usage.get(key)||[]).filter(t=>now-t<60000);
      if(!freeMode(this.store)&&recent.length>=limit)throw new Error('此能力调用过于频繁');
      recent.push(now);this.usage.set(key,recent);
      if(this.usage.size>2000)this.usage.delete(this.usage.keys().next().value);
    }
  }
  audit(outcome,cap,c,reason='',riskLevel='',state='',extra={}){
    const rows=this.store.data.framework.audit;
    rows.push({time:new Date().toISOString(),outcome,state:String(state||''),capability:cap,riskLevel:String(riskLevel||''),traceId:String(c?.traceId||'').slice(0,200),actor:c?.actor||'',kind:c?.kind||'',peer:c?.peer||'',errorClass:String(extra.errorClass||''),durationMs:Number.isFinite(extra.durationMs)?extra.durationMs:null,reason:String(reason).slice(0,250)});
    if(rows.length>300)rows.splice(0,rows.length-300);
  }
}
export function invalidate(store){store.data.framework.generation++;store.data.revision++;return store.data.framework.generation;}
