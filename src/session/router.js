import {isOwner} from '../core/owners.js';
import { createHash,randomUUID } from 'node:crypto';
import { accessReason,accessMessages,chunks } from '../onebot/index.js';
import { invalidate } from '../core/permissions.js';
import {packagesFor} from '../core/package-model.js';
import {EventActions} from '../core/event-actions.js';
import {PokePackage} from '../builtins/poke/index.js';
import {replyParts} from './split.js';
import {Participation,decision} from './participation.js';
import {chatSettings} from './chat-profile.js';
import {ReplyGate} from './reply-gate.js';
import {Conversation} from './conversation.js';
import {boundedReply,replyLimits,quoteReply} from './output.js';
import {styleAdvice,reviewReply} from './style.js';
import {expressionChoice,expressionAdvice,applyExpression} from './expression.js';
import {SAFE_PRESET} from './native.js';
// 一个聊天太久没说话就让旧会话退役：DSH 的会话可以长期复用，但无限增长既费上下文也难排查。
const SESSION_IDLE_MS=6*3600000;
const goneLog=/session\/not-found|session not found|no such session|会话不存在|会话已删除|会话已归档/i;
function isSessionGone(e){return goneLog.test(String(e?.code||'')+' '+String(e?.message||e||''));}
export function controlCommand(text){
 const value=String(text||'').trim().replace(/^(?:请帮我|麻烦你?|帮我|请)\s*/,'').replace(/[。！!？?]+$/,'');
 if(/^(?:查看|查询|看看|看一下)?(?:QQ\s*)?机器人(?:运行)?状态$/.test(value))return '状态';
 if(/^(?:暂停|停止)机器人(?:回复)?$/.test(value))return '暂停';
 if(/^(?:恢复|继续)机器人(?:回复)?$/.test(value))return '恢复';
 if(/^(?:新建|重置|清空)(?:当前聊天)?上下文$/.test(value))return '新上下文';
 if(value==='查看人设')return '人设';
 if(value.startsWith('切换人设 '))return '人设 '+value.slice(5).trim();
 if(value==='查看插件')return '插件';
 if(value==='查看授权')return '授权';
 if(value.startsWith('撤销授权 '))return '撤销 '+value.slice(5).trim();
 const match=/^(启用|打开|关闭|停用)(?:插件|功能包)?\s*(ai-chat|persona|welcome|market|poke|AI\s*聊天|人设|入群欢迎|插件市场|戳一戳互动|戳一戳)$/i.exec(value);
 if(match){const names={'ai聊天':'ai-chat',人设:'persona',入群欢迎:'welcome',插件市场:'market',戳一戳互动:'poke',戳一戳:'poke'},name=match[2].replace(/\s/g,'').toLowerCase();return (['启用','打开'].includes(match[1])?'启用':'停用')+' '+(names[name]||name);}
 return null;
}

export class Router {
 constructor(store,native,extensions,log,{permissions,actions,builtins,events,contextFor}={}){
  Object.assign(this,{store,native,extensions,log,permissions,actions,builtins,events,contextFor});
  this.conversation=new Conversation(store);this.participation=new Participation();this.pokes=new Map();
  if(actions)actions.onSent=(c,id,text)=>{
   this.conversation.sent({bot:c.bot,kind:c.kind,peer:c.peer,key:c.key,id:c.messageId},id,text);
   const job=this.store.data.inbox.find(j=>j.id===c.key+':'+c.messageId);
   if(job&&!(job.message.interaction==='poke'&&job.message.pokeContinue===false)){const wake=job.message.interaction==='poke'?{poke:true}:this.wakes.get(job.id);this.replyGate.replied(job.message,wake,chatSettings(this.store,job.message),text);}
  };
  this.gated=new Set();this.replyGate=new ReplyGate({continuations:store.data.continuations??={}});this.wakes=new Map();this.queues=new Map();this.contexts=new Map();this.rate=new Map();this.sendTail=Promise.resolve();this.stopped=false;this.lastOwnerAt=0;this.boot=randomUUID();
  this.eventActions=new EventActions(store,{bot:()=>this.bot,authorize:m=>this.reason(m,'interaction'),cooldowns:()=>this.actions?.pokeCooldowns});
  this.pokePackage=new PokePackage(store,{bot:()=>this.bot,access:m=>this.reason(m,'interaction'),canAI:()=>this.builtins.enabled('ai-chat'),deliver:m=>this.receive(m),pending:key=>this.queues.get(key),back:(e,valid)=>this.eventActions.poke(this.eventActions.issue(e,valid)),continued:m=>{this.replyGate.decide(m,chatSettings(this.store,m));this.replyGate.replied(m,{poke:true},chatSettings(this.store,m),'');},log});this.pokes=this.pokePackage.cooldowns;
  this.diagnostics={received:0,accepted:0,ignored:0,lastIncoming:null,recentIgnored:[]};
 }
 attach(bot){this.bot=bot;this.actions?.attach(bot);this.native.incoming?.attach(bot);}
 queue(key,fn){
  const task=(this.queues.get(key)||Promise.resolve()).then(fn),tracked=task.catch(e=>this.log('warn',e.message));this.queues.set(key,tracked);
  return task.finally(()=>{if(this.queues.get(key)===tracked)this.queues.delete(key);});
 }
 isOwner(msg){return !['notice','request','meta'].includes(msg.type)&&['private','group'].includes(msg.kind)&&isOwner(this.store.data.framework,msg.user);}
 // 结构化会话轨迹：同一条消息的所有事件共享 job.id（bot:kind:peer:messageId），
 // 只记录会话标识与会话 ID，不写消息正文、昵称、凭据或 Cookie。
 traceSession(job,event,extra={}){
  try{this.log('info','QQ 会话轨迹',{job:job?.id||null,sessionId:extra.sessionId??job?.sessionId??null,event,...extra});}catch{}
 }
 // session 只在"代次/人设/空闲过期"时退役；执行身份仍然每轮新建，见 receive() 里的 permissions.issue。
 stampSession(session,job){
  session.personaId=job.persona.id;session.personaVersion=job.persona.version;
  // 插件重载或设置变更只撤销旧任务与旧授权，不丢弃会话上下文；权限本来就在每轮重新校验。
  session.generation=this.store.data.framework.generation;
  session.lastActivity=new Date().toISOString();session.boot=this.boot;job.sessionId=session.sessionId;return session;
 }
 sessionExpired(session){
  if(session.safePreset&&session.safePreset!==SAFE_PRESET)return true;
  const last=Date.parse(session.lastActivity||session.createdAt||'');
  return Number.isFinite(last)&&Date.now()-last>SESSION_IDLE_MS;
 }
 async retireSession(session){
  try{await this.native.reset(session);}catch(e){this.log('warn','退役 QQ 会话时忽略错误：'+String(e?.message||e));}
 }
 async poke(event){return this.pokePackage.handle(event);}
 classify(msg){
  if(msg.interaction==='poke')return 'chat';
  if(this.isOwner(msg)&&controlCommand(msg.text))return 'control';
  if(this.isOwner(msg)&&!this.builtins.enabled('ai-chat'))return 'agent';
  return 'chat';
 }
 reason(msg,mode){
  const f=this.store.data.framework;
  if(!this.store.data.settings.enabled)return 'bridge-disabled';
  if(this.isOwner(msg)&&msg.kind==='private'&&mode==='control')return null;
  if(this.isOwner(msg)&&msg.kind==='private'&&mode==='agent')return f.paused?'paused':null;
  if(this.store.data.chatProfiles?.[msg.key]?.replyEnabled===false&&mode!=='control')return '该聊天已暂停回复';
  const settings=chatSettings(this.store,msg);const reason=accessReason(settings.groupReplyMode?{...settings,groupMentionOnly:false}:settings,msg);if(reason)return reason;
  if(f.paused&&!(mode==='control'&&this.isOwner(msg)))return 'paused';
  if(msg.interaction==='poke'&&!this.pokePackage.active())return '戳一戳包已停用';
  if(mode==='chat'&&!this.builtins.acceptsChat(msg)&&!(msg.interaction==='poke'&&typeof msg.pokeFixedText==='string'))return 'chat-disabled';return null;
 }
 ignore(msg,reason){
  this.diagnostics.ignored++;this.participation.record(msg,'silent',reason);
  this.diagnostics.recentIgnored.unshift({time:new Date().toISOString(),kind:msg.kind,peer:msg.peer,user:msg.user,reason,message:accessMessages[reason]||reason});
  this.diagnostics.recentIgnored=this.diagnostics.recentIgnored.slice(0,12);
 }
 async receive(msg){
  if(this.stopped)return;this.diagnostics.received++;this.diagnostics.lastIncoming=new Date().toISOString();
  if(this.isOwner(msg))this.lastOwnerAt=Date.now();
  const mode=this.classify(msg),reason=this.reason(msg,mode);
  // Fixed command packs may still reply with ordinary AI chat switched off.
  if(reason&&!(reason==='chat-disabled'&&await this.extensions.inbound(msg)!=null)){this.ignore(msg,reason);return;}
  if(!msg.text||Math.abs(Date.now()/1000-msg.time)>300)return;
  const id=msg.bot+':'+msg.kind+':'+msg.peer+':'+msg.id;
  if(this.store.data.recent.includes(id)||this.store.data.inbox.some(j=>j.id===id))return;
  this.native.incoming?.capture(msg);for(const part of msg.parts||[])this.native.incoming?.sources?.set(part,{messageId:msg.id});this.conversation.remember(msg);
  if(this.gated.has(id))return;this.gated.add(id);if(this.gated.size>4000)this.gated.delete(this.gated.values().next().value);
  this.participation.note(msg);
  const fixed=mode==='chat'?await this.extensions.inbound(msg):null;
  if(mode==='chat'&&fixed==null&&!msg.interaction){
   if(this.participation.cancelBy(msg)){for(const pending of this.participation.jobs)if(pending.cancelledByUser){this.permissions.close(this.contexts.get(pending.id));if(pending.sessionId)void this.native.cancel?.(pending.sessionId)?.catch(()=>{});}this.participation.record(msg,'silent','cancelled');return;}
   const merged=this.participation.merge(msg,mode);if(merged){this.store.data.recent.push(id);this.store.data.recent=this.store.data.recent.slice(-4000);await this.store.persist();return;}
  }
  const quoted=this.actions?.sent?.get(msg.bot+':'+msg.reply);
  const pending=[...this.participation.jobs].some(j=>j.message.key===msg.key&&j.message.user===msg.user&&!j.cancelledByUser&&Date.now()-j.flow.firstAt<=(this.store.data.settings.followupWindowSec??120)*1000&&(this.wakes.get(j.id)?.direct||j.message.interaction==='poke'));
  const wake=this.replyGate.decide(msg,chatSettings(this.store,msg),{pending,quoted:(!!quoted&&quoted.key===msg.key&&Date.now()-quoted.time<3600000)||!!(msg.reply&&this.conversation.find(msg,msg.reply)?.user===msg.bot),control:mode==='control'&&this.isOwner(msg),fixed:fixed!=null});
  if(!wake.allow){this.ignore(msg,wake.reason);return;}
  msg=this.native.incoming?.withRecent(msg,wake)||msg;
  const now=Date.now(),recent=(this.rate.get(msg.user)||[]).filter(t=>now-t<60000);
  if(recent.length>=15||this.store.data.inbox.filter(j=>['collecting','deciding','observing','queued','running'].includes(j.status)).length>=100){wake.release();this.ignore(msg,'消息过于频繁');return;}
  recent.push(now);this.rate.set(msg.user,recent);if(this.rate.size>1000)this.rate.delete(this.rate.keys().next().value);
  const job={id,requestId:'qq-'+createHash('sha256').update(id).digest('hex'),message:msg,mode,status:'queued',wakeReason:msg.interaction==='poke'?'poke':wake.reason,generation:this.store.data.framework.generation,createdAt:new Date().toISOString()};
  const settings=chatSettings(this.store,msg);this.participation.begin(job,{...settings,mergeWindowMs:mode==='chat'&&fixed==null&&!msg.interaction?settings.mergeWindowMs:0});
  this.participation.record(msg,job.flow.phase==='collecting'?'collecting':'ready',job.flow.phase==='collecting'?'waiting':job.wakeReason);
  this.contexts.set(id,this.permissions.issue(msg,msg.interaction==='poke'?'poke':wake.intent||wake.contextual?'context':wake.ambient?'ambient':mode));this.wakes.set(id,wake);
  this.diagnostics.accepted++;this.store.data.inbox.push(job);await this.store.persist();void this.queue(mode==='control'&&this.isOwner(msg)?'owner-control:'+msg.bot:msg.key,()=>this.process(job));
 }
 async recover(){/* Original receipts are never reconstructed from durable QQ text. */}
 async control(msg){
  if(!this.isOwner(msg))return '机器人管理仅限主人使用。';
  const command=controlCommand(msg.text),f=this.store.data.framework;
  if(!command)return '可以直接说明你要管理的机器人设置。';
  if(command==='状态')return 'QQ '+(this.bot?.status.online?'在线':'离线')+'；回复'+(f.paused?'已暂停':'已启用')+'；已启用 '+Object.values(f.builtins).filter(x=>x.enabled).length+' 个内置包；'+f.enabledActions.length+' 项动作。';
  if(command==='暂停'||command==='恢复'){f.paused=command==='暂停';invalidate(this.store);await this.native.revoke();await this.store.persist();return f.paused?'已暂停回复，主人管理仍可用。':'已恢复回复。';}
  if(command==='新上下文'){await this.resetChat(msg.key);return '已新建当前聊天上下文，旧记录已归档。';}
  if(command==='人设'){if(!this.builtins.enabled('persona'))return '人设包未安装或已停用。';return this.store.data.personas.map(p=>p.name+' · '+p.id).join('\n');}
  if(command.startsWith('人设 ')){
   if(!this.builtins.enabled('persona'))return '人设包未安装或已停用。';
   const name=command.slice(3).trim(),p=this.store.data.personas.find(p=>p.id===name||p.name===name);if(!p)return '没有找到这个人设。';
   await this.resetChat(msg.key);this.store.data.bindings[msg.key]={personaId:p.id};this.store.data.revision++;await this.store.persist();return '当前聊天已切换为 '+p.name+'。';
  }
  if(command==='插件')return this.builtins.list().map(p=>p.id+' · '+p.name+' · '+(p.enabled?'开启':'停用')).join('\n');
  if(/^(启用|停用) /.test(command)){
   const [verb,id]=command.split(/\s+/,2),p=f.builtins[id];if(!p)return '请填写已安装的内置包 ID。市场安装仅在本机界面进行。';if(p.uninstalled)return '此包已卸载，请在插件页面重新安装并检查设置后启用。';
   if(verb==='停用')packagesFor(this.store).protect(id);
   this.builtins.configure(id,verb==='启用',p.config);invalidate(this.store);await this.native.revoke();await this.store.persist();return '已'+verb+' '+id+'。';
  }
  if(command==='授权')return f.grants.length?f.grants.map(g=>g.id+' · '+g.capability+' · '+g.users.join(',')+(g.deny?' · 拒绝':'')).join('\n'):'尚未向其他用户开放执行权限。';
  if(command.startsWith('撤销 ')){const id=command.slice(3).trim(),old=f.grants.length;f.grants=f.grants.filter(g=>g.id!==id);if(f.grants.length===old)return '授权 ID 不存在。';invalidate(this.store);await this.native.revoke();await this.store.persist();return '授权已撤销。';}
  return '这项设置请在 QQ 框架的设置页面调整。';
 }
 async styledReply(sessionId,job,prompt,context){
  job.expressionSelection??=expressionChoice(chatSettings(this.store,job.message));prompt+='\n[本轮表达偏好]\n'+expressionAdvice(job.expressionSelection);
  if(job.message.pokePlan)return this.native.run(sessionId,job,prompt,context);
  const recent=this.conversation.recentReplies(job.message),advice=styleAdvice(recent,job.message.text),fullPrompt=prompt+'\n[当前表达要求]\n'+advice.text;
  let result=await this.native.run(sessionId,job,fullPrompt,context);
  const review=reviewReply(result,recent,job.message.text);
  if(!review.repeat||this.permissions.hasUsed(context))return result;
  const child=this.permissions.textOnly(context);job.styleReview={redrafted:true,reason:review.reason};
  try{
   const message={...job.message,parts:[],quoted:[],quoteMissing:false,groupContext:'',text:'[框架草稿修订：上一条助手草稿尚未发送]\n请重新回答前一条实际用户消息。'+review.reason+'。换一个贴合当前问题的表达，不复述旧梗、不解释改写过程，只输出给对方的正文。'};
   result=await this.native.run(sessionId,{requestId:job.requestId+'-style-1',message},fullPrompt,child);
   const invalid=this.permissions.resultReason(context);if(invalid)throw Error(invalid);
   if(reviewReply(result,recent,job.message.text).repeat){job.skipReply=true;job.styleReview.suppressed=true;return '';}
   return result;
  }finally{this.permissions.close(child);}
 }
 async chooseParticipation(job,context,{draft=''}={}){
  if(!this.participation.permit(job.message.key,chatSettings(this.store,job.message))){this.participation.record(job.message,'silent','budget');return false;}
  job.flow.phase='deciding';job.status='deciding';job.decisionSeq=this.participation.rooms.get(job.message.key)?.seq||0;
  try{
   let memoryContext='';
   if(this.contextFor)try{memoryContext=await this.contextFor(job.message);}catch(e){this.log('warn','意图上下文跳过：'+String(e.message||e).slice(0,160));}
   const d=decision(await this.native.decide(job.message,context,{background:this.conversation.context({...job.message,id:''}),memoryContext,names:this.conversation.names(job.message.key),draft,identity:{aliases:this.store.data.settings.botAliases||[],nickname:this.bot?.status.nickname||'',persona:this.builtins.prompt(this.builtins.persona(job.message),job.message).slice(0,4000)},signal:job.wakeReason}));
   job.participationDecision=d;this.participation.record(job.message,d.action==='wait'?'observing':d.action==='reply'?'ready':'silent',d.reason,{intent:{primaryIntent:d.primaryIntent||'',topic:d.topic||'',confidence:d.confidence??null}});return d;
  }
  catch(e){if(this.permissions.valid(context))throw e;this.participation.record(job.message,'silent','unavailable');return false;}
 }
 async process(job){
  let msg=job.message,context=this.contexts.get(job.id);
  if(this.stopped)return;
  try{
   const settings=chatSettings(this.store,msg);await this.participation.collect(job,settings);msg=job.message;
   if(msg.reply&&!msg.interaction){const enriched=await this.conversation.enrich(msg,this.bot,this.native.incoming);msg=enriched;job.message=enriched;}
   const obsolete=this.participation.obsolete(job,settings);if(obsolete){job.skipReply=true;job.status='skipped';this.participation.record(msg,'silent',obsolete);return;}
   const wake=this.wakes.get(job.id),selective=job.mode==='chat'&&!msg.interaction&&(wake?.intent||wake?.ambient||wake?.contextual)&&(wake?.intent||settings.decisionEnabled!==false)&&typeof this.native.decide==='function';
   if(wake?.intent&&typeof this.native.decide!=='function'){job.skipReply=true;job.status='skipped';this.participation.record(msg,'silent','unavailable');return;}
   job.selective=selective;
   if(selective){
    let d=await this.chooseParticipation(job,context);
    if(d?.action==='wait'){job.status='observing';job.flow.phase='observing';const before=job.decisionSeq??0;if((this.participation.rooms.get(msg.key)?.seq||0)<=before)await new Promise(r=>{const timer=setTimeout(()=>{job.flow.wake=null;r();},Math.min(2500,settings.maxCollectMs||5000));job.flow.wake=()=>{clearTimeout(timer);job.flow.wake=null;r();};});
     d=(this.participation.rooms.get(msg.key)?.seq||0)>before?await this.chooseParticipation(job,context):false;
    }
    if(!d||d.action!=='reply'){job.status='skipped';job.skipReply=true;return;}
    if(wake?.intent){if(!this.replyGate.admitIntent(msg,wake,settings,d)){job.status='skipped';job.skipReply=true;this.participation.record(msg,'silent','rhythm');return;}
     this.permissions.close(context);context=this.permissions.issue(msg,wake.direct?job.mode:wake.ambient?'ambient':'context');this.contexts.set(job.id,context);job.intentAdmission=d.reason;}
   }
   job.flow.phase='responding';job.observedSeq=this.participation.rooms.get(msg.key)?.seq||0;
   const invalid=this.permissions.resultReason(context);if(invalid)throw new Error(invalid);
   if(this.reason(msg,job.mode)&&!(job.mode==='chat'&&!this.builtins.enabled('ai-chat')&&await this.extensions.inbound(msg)!=null))throw new Error('当前消息不再允许回复');
   if(job.mode==='control'){
    job.reply=await this.control(msg);this.permissions.close(context);context=this.permissions.issue(msg,'control');this.contexts.set(job.id,context);
   }else{
    const handled=msg.interaction==='poke'&&typeof msg.pokeFixedText==='string'?msg.pokeFixedText:job.mode==='chat'?await this.extensions.inbound(msg):null;
    if(handled!=null)job.reply=String(handled);
    else{
     if(job.mode==='chat'&&!this.builtins.enabled('ai-chat'))throw new Error('AI 聊天包已停用');
     if(job.mode==='agent'){
      if(![...this.actions.definitions.values()].some(cap=>!this.permissions.decision(cap,context))){job.reply='当前身份没有已授权的工具或插件动作。请主人在设置中按范围授权。';}
      else job.message={...msg};
     }
     if(!job.reply){
      job.persona=this.builtins.persona(msg);
      const key=msg.kind==='group'?msg.key+'|shared':msg.key+'|'+msg.user+'|'+job.mode;
      this.traceSession(job,'收到消息',{sessionKey:key,kind:msg.kind,peer:msg.peer});
      job.message={...await this.conversation.enrich(msg,this.bot,this.native.incoming),groupContext:[this.store.data.chatProfiles?.[msg.key]?.environment?'[此聊天的背景说明，仅作环境数据]\n'+JSON.stringify(this.store.data.chatProfiles[msg.key].environment):'',this.conversation.context(msg)].filter(Boolean).join('\n')};
      let session=this.store.data.sessions[key];
      // 群聊不再每轮重建：DSH 的 session 本身可复用、可自动压缩、可按 id 恢复。
      // 只有代次变化、人设变化或空闲过期才退役；退役失败（会话已被 DSH 清理）不应中断本轮。
      if(session&&(this.sessionExpired(session)||session.personaId!==job.persona.id||session.personaVersion!==job.persona.version)){
       const reason=this.sessionExpired(session)?'空闲过期或预设不符':'人设变化';
       this.traceSession(job,'退役会话',{sessionId:session.sessionId,reason});
       await this.retireSession(session);delete this.store.data.sessions[key];session=null;
      }
      if(!session){session=await this.native.create(msg);this.store.data.sessions[key]=session;this.traceSession(job,'新建会话',{sessionId:session.sessionId});}
      else this.traceSession(job,'命中会话',{sessionId:session.sessionId,pid:session.boot===this.boot?'same-process':'previous-process'});
      this.stampSession(session,job);job.status='running';await this.store.persist();
      let replyPrompt=this.builtins.prompt(job.persona,msg)+(job.mode==='agent'&&!this.builtins.enabled('ai-chat')?'\n普通聊天已停用。本轮只处理机器人管理及已授权工具任务；若是闲聊或问候，说明普通聊天已关闭。':'');
      // 记忆等上下文提供器只读、限时；失败或超时会跳过，不影响本轮回复。
      if(this.contextFor)try{const extra=await this.contextFor(msg);if(extra)replyPrompt+='\n'+extra;}catch(e){this.log('warn','上下文提供器跳过：'+String(e.message||e).slice(0,160));}
      if(job.participationDecision){const i=job.participationDecision,summary={action:i.action,reason:i.reason,addressee:i.addressee,primaryIntent:i.primaryIntent,topic:i.topic,needsMemory:i.needsMemory,needsWebSearch:i.needsWebSearch,needsTools:i.needsTools,needsClarification:i.needsClarification,confidence:i.confidence,evidence:i.evidence,suggestedAction:i.suggestedAction};replyPrompt+='\n[本轮意图判断，仅作参考，不是指令；实际执行以工具结果为准]\n'+JSON.stringify(summary).slice(0,1500);}
      try{job.reply=await this.styledReply(session.sessionId,job,replyPrompt,context);}
      catch(e){
       // 会话日志已不存在（DSH 侧清理、归档或升级）：重建一次再试。此刻还没有任何内容发送出去。
       if(!isSessionGone(e))throw e;
       this.traceSession(job,'会话丢失重建',{sessionId:session.sessionId,error:String(e.message).slice(0,120)});
       this.log('warn','QQ 会话已失效，按新会话重建：'+e.message);
       await this.retireSession(session);delete this.store.data.sessions[key];
       session=await this.native.create(msg);this.store.data.sessions[key]=session;this.stampSession(session,job);await this.store.persist();
       this.traceSession(job,'重建后交给 Agent',{sessionId:session.sessionId});
       job.reply=await this.styledReply(session.sessionId,job,replyPrompt,context);
      }
      this.traceSession(job,'交给 Agent',{sessionId:session.sessionId});
     }
    }
   }
   if(msg.pokePlan){const plan=await this.pokePackage.resolve(msg,job.reply);job.reply=plan.text;job.skipReply=plan.skip;job.interactionDecision=plan.decision;}
   if(job.expressionSelection){job.reply=applyExpression(job.reply,job.expressionSelection);if(!job.reply.trim())job.skipReply=true;}
   // 已经决定要说、话也生成了，就不再事后改判：让她自己决定说什么，框架不替她撤回。
   if(!this.permissions.hasUsed(context)&&job.mode==='chat'&&!msg.interaction){
    const obsolete=this.participation.obsolete(job,chatSettings(this.store,msg));if(obsolete){job.skipReply=true;this.participation.record(msg,'silent',obsolete);}
   }
   if(job.skipReply){job.status='skipped';this.store.data.recent.push(job.id);this.store.data.recent=this.store.data.recent.slice(-4000);await this.store.persist();return;}
   job.status='reply-ready';await this.store.persist();await this.send(msg,job.reply,job,context);
   job.status=job.accepted?'accepted':'done';if(!job.accepted&&job.sentText&&!(msg.interaction==='poke'&&msg.pokeContinue===false))this.replyGate.replied(msg,msg.interaction==='poke'?{poke:true}:this.wakes.get(job.id),chatSettings(this.store,msg),job.sentText);
   this.participation.record(msg,'replied',job.wakeReason,{mergedCount:job.flow.parts.length});this.store.data.recent.push(job.id);this.store.data.recent=this.store.data.recent.slice(-4000);
  }catch(e){
   job.status=e.code==='ACCEPTED'?'accepted':job.status==='sending'?'uncertain':/撤销|失效|变更|停止|取消/.test(e.message)?'cancelled':'failed';job.error=String(e.message||e);
   this.participation.record(msg,job.cancelledByUser?'silent':'failed',job.cancelledByUser?'cancelled':'unavailable');this.log('warn','QQ 消息处理：'+job.error);
  }finally{
   this.participation.finish(job);this.permissions.close(context);this.contexts.delete(job.id);this.wakes.get(job.id)?.release();this.wakes.delete(job.id);
   const terminal=this.store.data.inbox.filter(j=>!['collecting','deciding','observing','queued','running','reply-ready','sending'].includes(j.status));
   if(terminal.length>200){const remove=new Set(terminal.slice(0,terminal.length-200));this.store.data.inbox=this.store.data.inbox.filter(j=>!remove.has(j));}await this.store.persist();
  }
 }
 send(msg,text,job,context){
  const check=()=>{
   if(this.stopped)throw new Error('QQ 发送已停止');
   if(job.flow&&!this.permissions.hasUsed(context)){const obsolete=this.participation.obsolete(job,chatSettings(this.store,msg));if(obsolete)throw Error(obsolete==='cancelled'?'对方取消了回复':'旧回复已过时，已取消发送');}
   const invalid=this.permissions.resultReason(context);if(invalid)throw new Error(invalid);
   if(this.reason(msg,job.mode)&&!(this.reason(msg,job.mode)==='chat-disabled'&&job.mode==='chat'&&job.reply))throw new Error('回复权限已撤销');
   if(this.bot?.status.bot!==msg.bot)throw new Error('OneBot 账号已变更');
  };
  const run=async()=>{
   check();job.status='sending';await this.store.persist();
   const settings=msg.interaction==='poke'?{...this.store.data.settings,replyTotalChars:Math.min(80,this.store.data.settings.replyTotalChars??240),replyMaxParts:1}:this.store.data.settings,remaining=this.actions?.remainingOutput?.(context)||replyLimits(settings);if(remaining.parts<=0||remaining.chars<=0)return;
   const source=text;
   text=boundedReply(text,{...settings,replyTotalChars:Math.min(replyLimits(settings).chars,remaining.chars),replyMaxParts:Math.min(replyLimits(settings).parts,remaining.parts)},[this.bot?.token]);
   if(!text.trim())return;
   if(this.actions?.hasSent?.(context))return;
   const parts=replyParts(text,settings.replySplit,settings.maxReplyChars,Math.min(remaining.parts,replyLimits(settings).parts),source);
   for(let i=0;i<parts.length;i++){
    const wait=Math.max(0,(this.lastSend||0)+this.store.data.settings.sendInterval-Date.now());if(wait)await new Promise(r=>setTimeout(r,wait));check();
    const outcome=await this.actions.request(msg.kind==='group'?'send_group_msg':'send_private_msg',{[msg.kind==='group'?'group_id':'user_id']:Number(msg.peer),message:[...i===0&&quoteReply(msg,settings.replyQuoteMode)?[{type:'reply',data:{id:msg.id}}]:[],{type:'text',data:{text:parts[i]}}]},context);
    this.lastSend=Date.now();
    if(outcome.outcome==='accepted'){job.accepted=true;break;}
    job.sentText=(job.sentText||'')+parts[i]+'\n';
    this.actions.remember(context,outcome.data?.message_id);
   }
  };
  const task=this.sendTail.then(run);this.sendTail=task.catch(()=>{});return task;
 }
 async notice(event){
  if(event.kind!=='group'||Math.abs(Date.now()/1000-event.time)>300)return;
  const f=this.store.data.framework,generation=f.generation,rows=await this.extensions.notices(event);
  rows.push(...this.builtins.welcome(event));
  for(const row of rows){
   const run=async()=>{
    if(this.stopped||this.store.data.framework.generation!==generation||f.paused||!this.store.data.settings.enabled||!f.listenGroups.includes(event.peer)||this.bot?.status.bot!==event.bot)return;
    if(row.id==='welcome'?!f.builtins.welcome.enabled:!this.extensions.live.has(row.id))return;
    const key=event.bot+':notice:'+event.name+':'+event.peer+':'+event.user+':'+event.time+':'+row.id;
    if(this.store.data.recent.includes(key))return;this.store.data.recent.push(key);this.store.data.recent=this.store.data.recent.slice(-4000);await this.store.persist();
    const bucket='notice:'+event.peer,now=Date.now(),recent=(this.rate.get(bucket)||[]).filter(t=>now-t<60000);if(recent.length>=10)return;recent.push(now);this.rate.set(bucket,recent);
    const wait=Math.max(0,(this.lastSend||0)+this.store.data.settings.sendInterval-Date.now());if(wait)await new Promise(r=>setTimeout(r,wait));
    if(this.stopped||this.store.data.framework.generation!==generation||this.bot?.status.bot!==event.bot)return;
    const text=boundedReply(row.text,this.store.data.settings,[this.bot?.token]);
    this.lastSend=Date.now();const result=await this.bot.request('send_group_msg',{group_id:Number(event.peer),message:[{type:'text',data:{text}}]});
    if(result.outcome==='confirmed'){this.actions.remember({bot:event.bot,key:event.key},result.data?.message_id);this.conversation.sent({...event,id:''},result.data?.message_id,text);}
   };
   const task=this.sendTail.then(run);this.sendTail=task.catch(e=>this.log('warn','事件回复未完成：'+e.message));await this.sendTail;
  }
 }
 async automaticReply(receipt,text){
  const f=this.store.data.framework,e=receipt.event,rows=f.automaticOutbox||(f.automaticOutbox=[]);
  const check=()=>{
   if(this.stopped||Date.now()>receipt.expires||receipt.generation!==this.store.data.framework.generation||!receipt.valid()||f.paused||!this.store.data.settings.enabled||!f.listenGroups.includes(e.peer)||e.kind!=='group'||this.bot?.status.bot!==e.bot)throw new Error('事件自动回复授权已失效');
  };
  check();if(Math.abs(Date.now()/1000-e.time)>300)throw new Error('事件已过期');
  const id=createHash('sha256').update([receipt.id,receipt.automationId,e.bot,e.peer,e.name,e.subtype,e.user,e.operator,e.time,e.id].join(':')).digest('hex');
  const prior=rows.find(r=>r.id===id);if(prior)return {outcome:'duplicate',previous:prior.status};
  if(rows.filter(r=>['queued','sending'].includes(r.status)).length>=50)throw new Error('自动回复队列已满');
  const bucket='automatic:'+receipt.id+':'+e.peer,now=Date.now(),recent=(this.rate.get(bucket)||[]).filter(t=>now-t<60000);
  if(recent.length>=3)throw new Error('该插件在此群的自动回复达到每分钟 3 次上限');
  recent.push(now);this.rate.set(bucket,recent);
  const job={id,plugin:receipt.id,rule:receipt.automationId,group:e.peer,subject:e.user,authority:'configured-event-rule',status:'queued',at:new Date().toISOString()};
  rows.push(job);if(rows.length>200)rows.splice(0,rows.length-200);await this.store.persist();
  const run=async()=>{
   try{
    check();const wait=Math.max(0,(this.lastSend||0)+this.store.data.settings.sendInterval-Date.now());if(wait)await new Promise(r=>setTimeout(r,wait));
    check();job.status='sending';await this.store.persist();check();
    text=boundedReply(text,this.store.data.settings,[this.bot?.token]);
    const result=await this.bot.request('send_group_msg',{group_id:Number(e.peer),message:[{type:'text',data:{text}}]});
    if(result.outcome==='confirmed')this.conversation.sent({...e,id:''},result.data?.message_id,text);
    job.status=result.outcome==='confirmed'?'confirmed':'accepted';this.lastSend=Date.now();if(result.outcome==='confirmed')this.actions.remember({bot:e.bot,key:e.key},result.data?.message_id);
    return {outcome:job.status};
   }catch(error){job.status=job.status==='sending'&&error.code==='UNKNOWN_OUTCOME'?'unknown':job.status==='sending'&&error.code==='FAILED'?'failed':'cancelled';job.error=error.message;throw error;}
   finally{await this.store.persist();}
  };
  const task=this.sendTail.then(run);this.sendTail=task.catch(()=>{});return task;
 }
 async resetChat(chatKey){
  this.conversation.clear(chatKey);this.replyGate.continuation.clear(chatKey);this.replyGate.groups.delete(chatKey);
  for(const job of this.store.data.inbox)if(job.message?.key===chatKey)this.permissions.close(this.contexts.get(job.id));
  for(const [key,s]of Object.entries(this.store.data.sessions))if(key===chatKey||s.chatKey===chatKey){await this.native.reset(s);delete this.store.data.sessions[key];}
 }
 async rebind(key,fn,keepContext=false){return this.queue(key,async()=>{if(!keepContext)await this.resetChat(key);fn();await this.store.persist();});}
 async stop(){this.stopped=true;this.participation.stop();await this.native.stop();await Promise.allSettled([...this.queues.values()]);}
}
