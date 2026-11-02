import {publicText} from './output.js';
const reasons={intent:'分析这句话在和谁交流',rhythm:'话题相关，按参与节奏继续旁听',mentioned:'被叫到',quoted:'正在回复我的消息',called:'叫了我的名字',followup:'同一人的连续追问',context:'接着刚才的话题',ambient:'尝试参与群聊',private:'私聊消息',poke:'戳一戳',management:'主人管理',plugin:'功能包回复',addressed:'这句话在问我',related:'可以补充当前话题',other:'这句话在和其他人交谈',complete:'目前没有需要补充的内容','need-more':'等待对方补充',stale:'话题已变化，略过旧回复',budget:'参与判断达到预算，继续旁听',unavailable:'参与判断暂不可用，继续旁听',merged:'已合并同一人的连续消息',cancelled:'对方取消了这次回复',expired:'这条回复已过时',waiting:'等待连续消息',responding:'正在准备回应',quiet:'保持旁听'};
export function decision(value){
 let raw=String(value||'').trim().replace(/^\x60\x60\x60(?:json)?\s*|\x60\x60\x60$/g,'').trim();if(raw.length>3000)throw Error('参与判断过长');
 const d=JSON.parse(raw);if(!d||!['reply','wait','silent'].includes(d.action)||!['addressed','related','other','complete','need-more','stale'].includes(d.reason))throw Error('参与判断格式无效');
 const result={action:d.action,reason:d.reason};
 if(d.addressee!==undefined){if(!['self','member','group','unknown'].includes(d.addressee))throw Error('受话人无效');result.addressee=d.addressee;}
 if(d.antecedentId!==undefined){if(typeof d.antecedentId!=='string'||d.antecedentId.length>80)throw Error('承接消息无效');result.antecedentId=d.antecedentId;}
 if(d.correction!==undefined){if(typeof d.correction!=='boolean')throw Error('纠正标记无效');result.correction=d.correction;}
 const textField=(key,max)=>{if(d[key]===undefined)return;if(typeof d[key]!=='string'||d[key].length>max)throw Error('意图字段无效：'+key);result[key]=d[key].trim();};
 const boolField=key=>{if(d[key]===undefined)return;if(typeof d[key]!=='boolean')throw Error('意图字段无效：'+key);result[key]=d[key];};
 const listField=(key,maxItems,maxLength)=>{if(d[key]===undefined)return;if(!Array.isArray(d[key])||d[key].length>maxItems||d[key].some(x=>typeof x!=='string'||x.length>maxLength))throw Error('意图字段无效：'+key);result[key]=d[key].map(x=>x.trim()).filter(Boolean);};
 textField('primaryIntent',80);textField('topic',120);textField('conversationReference',120);textField('evidence',300);textField('suggestedAction',120);
 listField('secondaryIntents',3,80);listField('emotionalCues',5,60);listField('needsTools',10,80);
 boolField('needsMemory');boolField('needsWebSearch');boolField('needsClarification');
 if(d.confidence!==undefined){if(typeof d.confidence!=='number'||!Number.isFinite(d.confidence)||d.confidence<0||d.confidence>1)throw Error('意图置信度无效');result.confidence=d.confidence;}
 if(result.addressee==='member'&&result.reason==='addressed')return {...result,action:'silent',reason:'other'};
 if(result.addressee==='unknown'&&result.reason==='addressed')return {...result,action:'wait',reason:'need-more'};
 return result;
}
export class Participation{
 constructor({now=()=>Date.now()}={}){this.now=now;this.rooms=new Map();this.pending=new Map();this.jobs=new Set();this.activity=[];this.budgets=new Map();this.stopped=false;}
 note(msg){const old=this.rooms.get(msg.key),room={seq:(old?.seq||0)+1,at:this.now(),user:msg.user,id:msg.id};this.rooms.set(msg.key,room);if(this.rooms.size>1000)this.rooms.delete(this.rooms.keys().next().value);for(const job of this.jobs)if(job.message.key===msg.key&&job.flow.phase==='observing')job.flow.wake?.();return room.seq;}
 record(msg,state,reason,extra={}){const row={at:new Date(this.now()).toISOString(),key:msg.key,kind:msg.kind,peer:msg.peer,user:msg.user,messageId:msg.id,state,reason,label:reasons[reason]||publicText(String(reason)).slice(0,120),...extra};this.activity.unshift(row);this.activity=this.activity.slice(0,80);return row;}
 begin(job,settings){this.jobs.add(job);job.flow={phase:settings.mergeWindowMs>0?'collecting':'ready',firstAt:this.now(),lastAt:this.now(),coveredSeq:this.rooms.get(job.message.key)?.seq||0,serials:[job.message.id],parts:[job.message],version:1};this.pending.set(job.message.key+'|'+job.message.user,job);}
 merge(msg,mode){const job=this.pending.get(msg.key+'|'+msg.user);if(!job||job.mode!==mode||job.flow.phase!=='collecting'||job.flow.parts.length>=5||msg.interaction||msg.mentions?.some(id=>id!==msg.bot)||String(msg.reply||'')!==String(job.message.reply||''))return null;
  job.flow.parts.push(msg);job.flow.serials.push(msg.id);job.flow.lastAt=this.now();job.flow.coveredSeq=this.rooms.get(msg.key)?.seq||0;job.flow.version++;
  const first=job.flow.parts[0],last=job.flow.parts.at(-1),parts=job.flow.parts.flatMap(x=>x.parts||[]);
  job.message={...first,text:job.flow.parts.map(x=>x.text.slice(0,4000)).join('\n').slice(0,16000),parts,mentions:[...new Set(job.flow.parts.flatMap(x=>x.mentions||[]))],time:last.time,batch:job.flow.parts.map(x=>({id:x.id,text:x.text.slice(0,4000)}))};
  this.record(msg,'merged','merged',{into:job.message.id});return job;
 }
 async collect(job,settings){while(!this.stopped&&job.flow.phase==='collecting'){
  const delay=Math.min(job.flow.lastAt+(settings.mergeWindowMs||0),job.flow.firstAt+(settings.maxCollectMs||5000))-this.now();if(delay<=0)break;
  await new Promise(resolve=>{const timer=setTimeout(()=>{job.flow.wake=null;resolve();},delay);job.flow.wake=()=>{clearTimeout(timer);job.flow.wake=null;resolve();};});
 }if(this.stopped)throw Error('聊天调度已停止');job.flow.phase='ready';}
 finish(job){this.jobs.delete(job);job.flow&&(job.flow.phase='finished');const key=job.message.key+'|'+job.message.user;if(this.pending.get(key)===job)this.pending.delete(key);}
 permit(key,settings={}){if(settings.freeMode)return true;const now=this.now(),times=(this.budgets.get(key)||[]).filter(t=>now-t<3600000);if(times.length>=(settings.intentPerHour??30)||times.filter(t=>now-t<60000).length>=(settings.intentPerMinute??6))return false;times.push(now);this.budgets.set(key,times);if(this.budgets.size>1000)this.budgets.delete(this.budgets.keys().next().value);return true;}
 obsolete(job,settings){if(job.cancelledByUser)return 'cancelled';if(this.now()-job.flow.firstAt>(settings.staleAfterSec??60)*1000&&(this.rooms.get(job.message.key)?.seq||0)>job.flow.coveredSeq)return 'expired';return null;}
 cancelBy(msg){if(!/^(?:不用(?:回|回答|查|做|处理)(?:了)?|别(?:回|回答|查|做)(?:了)?|取消(?:刚才的)?(?:请求|任务|回复)?)[。！!\s]*$/.test(msg.text))return false;let found=false;for(const job of this.jobs)if(job.message.key===msg.key&&job.message.user===msg.user&&job.mode==='chat'&&!['sending','done','accepted'].includes(job.status)){job.cancelledByUser=true;job.flow.wake?.();found=true;}return found;}
 snapshot(){return {activity:this.activity,rooms:[...this.jobs].filter(j=>j.flow.phase!=='finished').map(j=>({id:j.id,key:j.message.key,user:j.message.user,phase:j.flow.phase,messageCount:j.flow.parts.length,since:new Date(j.flow.firstAt).toISOString()}))};}
 stop(){this.stopped=true;for(const j of this.jobs)j.flow.wake?.();}
}
