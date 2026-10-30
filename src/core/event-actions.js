import {isOwner} from './owners.js';
import {createHash} from 'node:crypto';
export class EventActions{
 #tickets=new WeakMap();
 constructor(store,{bot,authorize,cooldowns=()=>new Map()}={}){Object.assign(this,{store,bot,authorize,cooldowns});this.fallbackCooldowns=new Map();}
 issue(event,valid){const ticket=Object.freeze({});this.#tickets.set(ticket,{event:structuredClone(event),valid,generation:this.store.data.framework.generation,expires:Date.now()+120000,used:false});return ticket;}
 check(row){
  const e=row?.event,b=this.bot(),f=this.store.data.framework;
  if(!row||row.used||row.generation!==f.generation||row.expires<Date.now()||!row.valid()||!this.store.data.settings.enabled||f.paused||!f.listenNotices)throw Error('事件动作授权已失效');
  if(e.type!=='notice'||e.name!=='notify'||e.subtype!=='poke'||e.target!==e.bot||e.user===e.bot||e.bot!==b?.status.bot||!['group','private'].includes(e.kind)||e.key!==e.bot+':'+e.kind+':'+e.peer||[e.user,e.peer].some(x=>!/^\d{4,16}$/.test(x)||!Number.isSafeInteger(Number(x)))||!Number.isFinite(e.time)||Math.abs(Date.now()/1000-e.time)>300)throw Error('戳一戳事件无效');
  if(e.kind==='group'?!f.listenGroups.includes(e.peer):e.peer!==e.user||!isOwner(f,e.user)&&(!f.listenPrivate||!f.listenAllPrivate&&!f.listenUsers.includes(e.user)))throw Error('事件不在监听范围');
  const m={type:'message',...e,type:'message',id:'event-action',text:'戳一戳互动',mentions:[e.bot]};if(this.authorize(m))throw Error('此聊天不允许互动');
  if(!f.enabledActions.includes('qq.poke'))throw Error('主人尚未启用戳一戳动作');if(!/napcat/i.test(String(b.status.version?.app_name||'')))throw Error('当前网关未声明支持回戳');return b;
 }
 async poke(ticket){const row=this.#tickets.get(ticket),b=this.check(row),e=row.event,f=this.store.data.framework;
  const id='poke-'+createHash('sha256').update([e.bot,e.kind,e.peer,e.user,e.target,e.time,e.id].join('|')).digest('hex'),outbox=f.pokeOutbox??=[];if(outbox.some(r=>r.id===id))return {outcome:'duplicate'};
  const bucket=e.bot+':'+e.user,cooldowns=this.cooldowns()||this.fallbackCooldowns,now=Date.now();if(now-(cooldowns.get(bucket)||0)<60000)throw Error('回戳冷却中，同一对象每分钟最多一次');
  const record={id,plugin:'poke',peer:e.peer,user:e.user,status:'queued',at:new Date().toISOString()};outbox.push(record);if(outbox.length>200)outbox.splice(0,outbox.length-200);await this.store.persist();
  try{this.check(row);row.used=true;cooldowns.set(bucket,now);record.status='sending';const result=await b.request(e.kind==='group'?'group_poke':'friend_poke',{user_id:Number(e.user),...e.kind==='group'?{group_id:Number(e.peer)}:{}},15000);record.status=result.outcome==='confirmed'?'confirmed':'accepted';return result;}
  catch(error){record.status=record.status==='queued'?'cancelled':error.code==='FAILED'?'failed':'unknown';record.error=String(error.message).slice(0,200);throw error;}finally{await this.store.persist();}
 }
}
