import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {zipSync,strToU8} from 'fflate';
import {Store,defaults,validateSettings} from '../src/host/store.js';
import {migrate} from '../src/host/migrate.js';
import {Permissions,validatePolicy,invalidate} from '../src/core/permissions.js';
import {Events} from '../src/core/events.js';
import {Actions} from '../src/core/actions.js';
import {Media,publicIP,safeDownload} from '../src/core/media.js';
import {Builtins} from '../src/builtins/index.js';
import {OneBot,normalize,normalizeEvent,segments,allowed,chunks} from '../src/onebot/index.js';
import {Router} from '../src/session/router.js';
import {TaskStore} from '../src/session/tasks.js';
import {ReminderScheduler} from '../src/session/reminders.js';
import {NativeDSH,SAFE_PRESET} from '../src/session/native.js';
import {Extensions,validateManifest} from '../src/extensions/index.js';
import {Market,unpack} from '../src/market/index.js';
import {validatePersona,resolvePersona,importPersona} from '../src/personas/index.js';
process.env.QQBOT_OWNER='10000001';process.env.QQBOT_ALLOWED_USERS='10000001';
const log=()=>{},delay=ms=>new Promise(r=>setTimeout(r,ms));
const message=(extra={})=>({type:'message',bot:'10000002',user:'10000001',kind:'private',peer:'10000001',key:'10000002:private:10000001',id:'1',time:Date.now()/1000,text:'你好',mentions:[],sender:'测试用户',parts:[],...extra});
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-framework-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open(),permissions=new Permissions(store),events=new Events(store,log),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,log,actions),sent=[];
 t.after(()=>media.stop());const bot={status:{bot:'10000002',online:true,state:'connected',version:{app_name:'NapCat'}},
  async request(action,params){sent.push({action,params});return {outcome:'confirmed',data:{message_id:sent.length}};},
  async call(action,params){sent.push({action,params});return action==='get_group_member_list'?[{user_id:12345,nickname:'成员'}]:{};}};
 actions.attach(bot);
 return {store,permissions,events,media,actions,builtins,extensions,bot,sent};
}

test('主人相对提醒直接落库并由调度器发送，模型不能口头承诺代替创建',async t=>{
 const x=await setup(t),tasks=await new TaskStore(path.join(x.store.dir,'tasks')).open();
 x.actions.installTaskActions(tasks);x.store.data.framework.enabledActions.push('qq.task.create','qq.message.send');
 const router=new Router(x.store,{run:async()=>{throw Error('明确提醒不应交给模型猜测');},stop:async()=>{}},x.extensions,log,x);router.attach(x.bot);
 await router.receive(message({text:'一分钟后给我发个信息'}));await Promise.all([...router.queues.values()]);
 assert.equal(tasks.tasks.length,1);assert.equal(tasks.tasks[0].reminder.peer,'10000001');
 const job=x.store.data.inbox.at(-1);assert.equal(job.status,'done');assert.equal(job.reminderTaskId,tasks.tasks[0].id);assert.match(job.reply,/记好了/);
 const scheduler=new ReminderScheduler({tasks,now:()=>tasks.tasks[0].reminder.dueAt,available:()=>true,guard:()=>'',send:async r=>{
  const msg=message({id:'reminder-test'}),c=x.permissions.issue(msg,'proactive');
  try{return await x.actions.invoke('qq.message.send',{segments:[{type:'text',data:{text:r.text}}]},c);}finally{x.permissions.close(c);}
 }});
 await scheduler.tick();await scheduler.tick();
 assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,2);
 assert.equal(tasks.tasks[0].status,'done');assert.equal(tasks.tasks[0].reminder.state,'submitted');
});

test('提醒动作校验未来日期和时区，只能绑定当前主人当前聊天，重复调用不重复建任务',async t=>{
 const x=await setup(t),tasks=await new TaskStore(path.join(x.store.dir,'tasks')).open();
 x.actions.installTaskActions(tasks);x.store.data.framework.enabledActions.push('qq.task.create');
 const c=x.permissions.issue(message(),'chat');
 await assert.rejects(x.actions.invoke('qq.task.create',{goal:'提醒',remindAt:'2026-11-01T19:00:00'},c),/时区/);
 await assert.rejects(x.actions.invoke('qq.task.create',{goal:'提醒',delaySeconds:60,remindAt:'2026-11-01T19:00:00+08:00'},c),/其中一个/);
 await assert.rejects(x.actions.invoke('qq.task.create',{goal:'提醒',delaySeconds:60,peer:'123456'},c),/不支持的参数/);
 const at=new Date(Date.now()+60000).toISOString();
 const first=await x.actions.invoke('qq.task.create',{goal:'提醒',remindAt:at,reminderText:'喝水'},c);
 const second=await x.actions.invoke('qq.task.create',{goal:'提醒',delaySeconds:60,reminderText:'喝水'},c);
 assert.equal(first.id,second.id);assert.equal(first.reminder.actor,c.actor);assert.equal(first.reminder.sourceMessageId,c.messageId);
 x.store.data.framework.listenUsers.push('123456');
 const other=x.permissions.issue(message({user:'123456',peer:'123456',key:'10000002:private:123456'}),'chat');
 await assert.rejects(x.actions.invoke('qq.task.create',{goal:'提醒',delaySeconds:60},other),/仅主人/);
});

test('自主图片表情单独发送，文字和图片各有回执，配置撤销后不附图',async t=>{
 const x=await setup(t),native={stop:async()=>{}},router=new Router(x.store,native,x.extensions,log,x);router.attach(x.bot);
 let used=0,valid=true;
 router.replySticker=async()=>({part:{type:'image',data:{file:'base64://real'}},valid:()=>valid,sent:async outcome=>{used++;assert.ok(outcome.state);}});
 const msg=message(),c=x.permissions.issue(msg,'chat');
 const job={mode:'chat'};await router.send(msg,'你好',job,c);
 const sends=x.sent.filter(row=>row.action==='send_private_msg');assert.equal(sends.length,2);
 assert.deepEqual(sends[0].params.message.map(part=>part.type),['text']);assert.deepEqual(sends[1].params.message.map(part=>part.type),['image']);assert.equal(used,1);
 assert.equal(job.replyState,'submitted');assert.equal(job.stickerState,'submitted');assert.notEqual(job.replyMessageId,job.stickerMessageId);
 valid=false;const next=message({id:'2'});await router.send(next,'继续',{mode:'chat'},x.permissions.issue(next,'chat'));
 assert.equal(x.sent.filter(row=>row.action==='send_private_msg').at(-1).params.message.some(part=>part.type==='image'),false);assert.equal(used,1);
});

test('按选图结果先发独立图片再发文字，QQ 小表情也不拼进文字末尾',async t=>{
 const x=await setup(t),router=new Router(x.store,{stop:async()=>{}},x.extensions,log,x);router.attach(x.bot);
 x.store.data.settings.sendInterval=0;
 router.replySticker=async()=>({placement:'before',part:{type:'image',data:{file:'base64://real'}},valid:()=>true,sent:async()=>{}});
 const first=message();await router.send(first,'好开心',{mode:'chat'},x.permissions.issue(first,'chat'));
 assert.deepEqual(x.sent.filter(row=>row.action==='send_private_msg').map(row=>row.params.message.map(part=>part.type)),[['image'],['text']]);
 router.replySticker=async()=>({part:{type:'face',data:{id:'13'}},valid:()=>true,sent:async()=>{}});
 const second=message({id:'second'});await router.send(second,'继续',{mode:'chat'},x.permissions.issue(second,'chat'));
 assert.deepEqual(x.sent.filter(row=>row.action==='send_private_msg').slice(-2).map(row=>row.params.message.map(part=>part.type)),[['text'],['face']]);
});

test('工具发过的相同文字不重发，新的最终说明实际发送并保存真实消息记录',async t=>{
 const x=await setup(t),router=new Router(x.store,{stop:async()=>{}},x.extensions,log,x);router.attach(x.bot);
 x.store.data.settings.sendInterval=0;
 const msg=message(),c=x.permissions.issue(msg,'chat');
 await x.actions.request('send_private_msg',{user_id:Number(msg.peer),message:[{type:'text',data:{text:'我试试这个'}}]},c);
 const job={mode:'chat'};
 await router.send(msg,'这是实际的后续说明',job,c);
 assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,2);
 assert.match(job.actualReply,/我试试这个/);
 assert.match(job.actualReply,/实际的后续说明/);
 assert.equal(job.actualMessages.length,2);
 assert.equal(x.actions.unsentText(c,'我试试这个'),'');
});

test('发送结果未知也保留真实尝试记录，不能让最终草稿覆盖或重复发送', async t => {
 const x=await setup(t),msg=message(),context=x.permissions.issue(msg,'chat');
 x.bot.request=async()=>{throw Object.assign(Error('timeout'),{code:'UNKNOWN_OUTCOME'});};
 await assert.rejects(x.actions.request('send_private_msg',{user_id:Number(msg.peer),message:[{type:'text',data:{text:'已经尝试发送的正文'}}]},context),/timeout/);
 assert.deepEqual(x.actions.sentMessages(context),[{state:'unknown',messageId:null,text:'已经尝试发送的正文',types:['text']}]);
 assert.equal(x.actions.unsentText(context,'已经尝试发送的正文'),'');
});

test('分开发图遵守本轮条数；图片结果未知时保留文字且不重发',async t=>{
 const x=await setup(t),router=new Router(x.store,{stop:async()=>{}},x.extensions,log,x);router.attach(x.bot);
 x.store.data.settings.sendInterval=0;x.store.data.settings.replyMaxParts=1;
 let used=0;router.replySticker=async()=>({part:{type:'image',data:{file:'base64://real'}},valid:()=>true,sent:async()=>used++});
 const first=message();await router.send(first,'文字',{mode:'chat'},x.permissions.issue(first,'chat'));
 assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,1);assert.equal(used,0);
 x.store.data.settings.replyMaxParts=2;
 const original=x.bot.request;x.bot.request=async(action,params)=>{
  if(params.message?.some(part=>part.type==='image'))throw Object.assign(Error('timeout'),{code:'UNKNOWN_OUTCOME'});
  return original(action,params);
 };
 const second=message({id:'2'}),job={mode:'chat'};await router.send(second,'文字已保留',job,x.permissions.issue(second,'chat'));
 assert.equal(job.replyState,'submitted');assert.equal(job.stickerState,'unknown');assert.equal(used,1);
 assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,2);
});

test('插件委托身份已经发图后，同一轮不再选图，文字说明仍可按预算发送',async t=>{
 const x=await setup(t),router=new Router(x.store,{stop:async()=>{}},x.extensions,log,x);router.attach(x.bot);
 let selected=0;router.replySticker=async()=>{selected++;return null;};
 const msg=message(),c=x.permissions.issue(msg,'chat'),child=x.permissions.delegate(c,'qq-sticker');
 await x.actions.request('send_private_msg',{user_id:Number(msg.peer),message:[{type:'image',data:{file:'base64://test'}}]},child);
 assert.equal(x.actions.hasMediaSent(c),true);
 await router.send(msg,'找到啦',{mode:'chat'},c);
 assert.equal(selected,0);assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,2);
});

test('QQ 原生表情接收时保留具体编号和已知名称',()=>{
 const msg=normalize({post_type:'message',self_id:10000002,user_id:10000001,message_type:'private',message_id:12,message:[{type:'face',data:{id:13}},{type:'face',data:{id:999}}]});
 assert.match(msg.text,/id=13 呲牙/);assert.match(msg.text,/id=999/);assert.equal(msg.parts[0].type,'face');
});

test('消息贴表情校验当前聊天和真实消息，网关 ACK 只表示已提交',async t=>{
 const x=await setup(t),msg=message({id:'123'}),c=x.permissions.issue(msg,'chat');
 await x.events.receive(msg);
 const result=await x.actions.reactMessage('123','13',c);
 assert.equal(result.state,'submitted');assert.deepEqual(x.sent.at(-1),{action:'set_msg_emoji_like',params:{message_id:123,emoji_id:'13'}});
 await assert.rejects(x.actions.reactMessage('124','13',c),/当前聊天/);
 await assert.rejects(x.actions.reactMessage('123','not-an-id',c),/表情 ID/);
 x.store.data.framework.listenPrivate=true;x.store.data.framework.listenUsers.push('123456');
 const other=x.permissions.issue(message({id:'123',user:'123456',peer:'123456',key:'10000002:private:123456'}),'chat');
 await assert.rejects(x.actions.reactMessage('123','13',other),/当前聊天/);
});

test('自主贴表情不重发图片，失败时保留文字且不自动重试',async t=>{
 const x=await setup(t),router=new Router(x.store,{stop:async()=>{}},x.extensions,log,x);router.attach(x.bot);
 const msg=message({id:'123'});await x.events.receive(msg);
 let attempts=0,recorded=0;
 router.replySticker=async()=>({reaction:{messageId:'123',emojiId:'13'},valid:()=>true,sent:async()=>recorded++});
 x.actions.reactMessage=async()=>{attempts++;throw Error('gateway unavailable');};
 const job={mode:'chat'};await router.send(msg,'真开心',job,x.permissions.issue(msg,'chat'));
 assert.equal(attempts,1);assert.equal(recorded,1);assert.equal(job.reactionState,'failed');
 const sends=x.sent.filter(row=>row.action==='send_private_msg');assert.equal(sends.length,1);assert.equal(sends[0].params.message.some(part=>part.type==='image'),false);
});
const manifest=(id='qq-test')=>({id,name:'测试规则',version:'2.0.0',hostApiVersion:2,runtime:'declarative',entry:'rules.json',capabilities:['commands','actions'],configSchema:{}});
const archive=(m=manifest(),rules={rules:[{type:'command',match:'/测试',reply:'规则回复'}],actions:[{id:'answer',reply:'动作回复'}]})=>zipSync({'manifest.json':strToU8(JSON.stringify(m)),'rules.json':strToU8(JSON.stringify(rules))});
test('settings reject blank, zero, overflow and noninteger ports',()=>{
 const s=defaults().settings;
 for(const value of ['',0,65536,'1e4','3002.5'])assert.throws(()=>validateSettings({...s,reversePort:value}));
 for(const url of ['ws://127.0.0.1:0','ws://127.0.0.1:65536','http://localhost'])assert.throws(()=>validateSettings({...s,url}));
 assert.equal(validateSettings({...s,reversePort:'3002'}).reversePort,3002);
 assert.deepEqual(chunks('😀你好😀',2),['😀你','好😀']);
});
test('migration preserves personas and whitelist, retires privileged sessions and script extensions',async t=>{
 const x=await setup(t),old=structuredClone(x.store.data);old.schema=1;delete old.framework;old.sessions={chat:{sessionId:'legacy'}};old.extensions={'qq-script':{enabled:true}};
 old.inbox=[{status:'running'}];const result=migrate(old);
 assert.equal(result.schema,2);assert.equal(result.framework.ownerQQ,'10000001');assert.equal(result.framework.retiredSessions[0].sessionId,'legacy');
 assert.deepEqual(result.sessions,{});assert.equal(result.inbox[0].status,'cancelled');assert.equal(result.extensions['qq-script'].enabled,false);
 assert.equal(result.personas[0].prompt,x.store.data.personas[0].prompt);
});
test('store backs up schema 1 before migration and never resumes a sending job',async t=>{
 const x=await setup(t),old=structuredClone(x.store.data);old.schema=1;delete old.framework;old.inbox=[{status:'sending'}];
 await writeFile(x.store.file,JSON.stringify(old));const restored=await new Store(x.store.dir).open();
 assert.equal(restored.data.inbox[0].status,'uncertain');assert.equal(JSON.parse(await readFile(path.join(x.store.dir,'state.before-framework-v2.json'))).schema,1);
 await assert.rejects(restored.change(-1,()=>{}),/其他页面/);
});
test('OneBot normalized messages and notices cannot forge a command identity',()=>{
 const raw={post_type:'message',self_id:10000002,user_id:123456,group_id:88888,message_type:'group',message_id:-5,message:'[CQ:at,qq=10000002]你好&#91;x&#93;'};
 assert.equal(normalize(raw).text,'你好[x]');assert.deepEqual(normalize(raw).mentions,['10000002']);
 assert.equal(normalize({...raw,user_id:10000002}),null);
 const notice=normalizeEvent({post_type:'notice',self_id:10000002,user_id:10000001,operator_id:123456,group_id:88888,notice_type:'group_increase'});
 assert.equal(notice.type,'notice');assert.equal(notice.operator,'123456');assert.equal(notice.user,'10000001');
 assert.equal(segments('[CQ:image,file=a&#44;b]')[0].data.file,'a,b');
});
test('listening a group without @ does not trigger AI; notices remain visible',async t=>{
 const x=await setup(t);x.store.data.framework.listenGroups=['88888'];x.store.data.settings.allowedGroups=['88888'];x.store.data.settings.groupEnabled=true;
 const g=message({kind:'group',peer:'88888',key:'10000002:group:88888'});let received=0;
 x.events.subscribe('test',['message','notice'],()=>received++);
 assert.equal(await x.events.receive(g),true);assert.equal(allowed(x.store.data.settings,g),false);
 await x.events.receive({...g,type:'notice',name:'group_increase'});assert.equal(received,2);
 assert.equal(await x.events.receive({...g,peer:'77777'}),false);
});
test('owner control private listener survives private reply/listening switches',async t=>{
 const x=await setup(t);x.store.data.framework.listenPrivate=false;x.store.data.framework.listenUsers=[];
 assert.equal(await x.events.receive(message({text:'机器人状态'})),true);
 assert.equal(x.permissions.valid(x.permissions.issue(message(),'control')),null);
 assert.equal(await x.events.receive(message({user:'123456',peer:'123456',key:'10000002:private:123456'})),false);
});
test('ordinary chat does not grant tools; forged contexts and unknown capabilities fail closed',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.listenUsers.push('123456');
 const user=message({user:'123456',peer:'123456',key:'10000002:private:123456'});
 const c=x.permissions.issue(user);
 await assert.rejects(x.actions.invoke('core.status',{},c),/尚未.*开放/);
 await assert.rejects(x.actions.invoke('core.status',{},{...c,actor:f.ownerQQ}),/无效/);
 for(const id of ['run_code','exec_command','qq.get_credentials','qq.group_kick','raw.action','mcp__foo'])await assert.rejects(x.actions.invoke(id,{},x.permissions.issue(message())),/系统禁止|未知/);
 assert.equal(x.sent.length,0);
});
test('grant is limited to exact actor, group, capability, expiry and deny precedence',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.listenGroups=['88888','77777'];f.enabledActions.push('qq.members.list');
 const g=message({user:'123456',kind:'group',peer:'88888',key:'10000002:group:88888'}),c=x.permissions.issue(g);
 f.grants=[{id:'a',capability:'qq.members.list',users:['123456'],groups:['88888'],private:false,perMinute:5,expires:''}];
 assert.equal(x.permissions.decision(x.actions.definitions.get('qq.members.list'),c),null);
 assert.match(x.permissions.decision(x.actions.definitions.get('core.status'),c),/尚未.*开放/);
 assert.match(x.permissions.decision(x.actions.definitions.get('qq.members.list'),x.permissions.issue({...g,user:'999999'})),/尚未.*开放/);
 assert.match(x.permissions.decision(x.actions.definitions.get('qq.members.list'),x.permissions.issue({...g,peer:'77777',key:'10000002:group:77777'})),/尚未.*开放/);
 f.grants.push({...f.grants[0],id:'deny',deny:true});assert.match(x.permissions.decision(x.actions.definitions.get('qq.members.list'),c),/明确拒绝/);
 f.grants=[{...f.grants[0],expires:'2000-01-01'}];assert.match(x.permissions.decision(x.actions.definitions.get('qq.members.list'),c),/尚未.*开放/);
});
test('owner-only profile operations cannot be delegated; revoked task receipts cannot be reused',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.enabledActions.push('qq.profile.nickname');
 assert.throws(()=>validatePolicy({...f,grants:[{capability:'qq.profile.nickname',users:['123456'],private:true,groups:[]}]},x.actions.catalog()),/不能下放/);
 const c=x.permissions.issue(message());invalidate(x.store);await assert.rejects(x.actions.invoke('qq.profile.nickname',{nickname:'新昵称'},c),/撤销/);assert.equal(x.sent.length,0);
});
test('media references are bound to chat, plugin and purpose; raw paths never pass to gateway',async t=>{
 const x=await setup(t),c=x.permissions.issue(message());x.store.data.framework.enabledActions.push('qq.image.send','qq.profile.avatar');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cLxkAAAAASUVORK5CYII=','base64');
 const r=await x.media.put(bytes,{key:c.key});assert.match((await x.media.resolve(r.id,c)).file,/^base64:\/\//);
 await assert.rejects(x.media.resolve(r.id,{...c,key:'10000002:group:88888'}),/不属于/);
 await assert.rejects(x.media.resolve(r.id,c,'image','other-plugin'),/不属于/);
 await assert.rejects(x.media.put(Buffer.from('not image'),{key:c.key}),/图片/);
 await assert.rejects(x.actions.invoke('qq.profile.avatar',{file:'C:\\secret'},c),/参数/);
 await x.actions.invoke('qq.image.send',{resourceId:r.id},c);assert.match(x.sent[0].params.message[0].data.file,/^base64:\/\//);
});
test('network resource fetch rejects private and reserved targets before connection',async()=>{
 for(const ip of ['127.0.0.1','10.1.1.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicIP(ip),false,ip);
 assert.equal(publicIP('8.8.8.8'),true);assert.equal(publicIP('2606:4700:4700::1111'),true);
 await assert.rejects(safeDownload('https://127.0.0.1/private'),/私网|保留/);await assert.rejects(safeDownload('file:///C:/x'),/HTTPS/);
});
test('message query and recall only accept current observed chat and own send ledger',async t=>{
 const x=await setup(t),c=x.permissions.issue(message());x.store.data.framework.enabledActions.push('qq.message.get','qq.message.recall');
 await assert.rejects(x.actions.invoke('qq.message.get',{id:'23'},c),/当前聊天/);
 await assert.rejects(x.actions.invoke('qq.message.recall',{id:'23'},c),/框架/);
 x.actions.remember(c,23);await x.actions.invoke('qq.message.recall',{id:'23'},c);assert.equal(x.sent[0].action,'delete_msg');
});
test('nickname updates do not include unrelated profile fields and extension calls need declared driver',async t=>{
 const x=await setup(t),c=x.permissions.issue(message());x.store.data.framework.enabledActions.push('qq.profile.nickname');
 await x.actions.invoke('qq.profile.nickname',{nickname:'小鱼'},c);assert.deepEqual(x.sent[0],{action:'set_qq_profile',params:{nickname:'小鱼'}});
 x.bot.status.version={app_name:'other'};await assert.rejects(x.actions.invoke('qq.profile.nickname',{nickname:'小鱼'},c),/未声明/);
});
test('request inbox hides flags; handling request does not grant chat or tool permissions',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.listenUsers.push('123456');f.enabledActions.push('qq.request.decide');
 const request=normalizeEvent({post_type:'request',request_type:'friend',self_id:10000002,user_id:123456,flag:'sensitive-flag'});
 await x.events.receive(request);assert.equal('flag' in x.events.snapshot().requests[0],false);
 const c=x.permissions.issue(message()),result=await x.actions.invoke('qq.request.decide',{requestId:x.events.requests[0].requestId,approve:true,reason:''},c);
 assert.equal(result.state,'submitted');assert.equal(x.events.requests[0].state,'accepted');
 assert.equal(x.sent[0].action,'set_friend_add_request');assert.equal(f.grants.length,0);assert.equal(x.store.data.settings.allowedUsers.includes('123456'),false);
 await assert.rejects(x.actions.invoke('qq.request.decide',{requestId:x.events.requests[0].requestId,approve:true,reason:''},c),/已处理/);
});
test('market rejects JavaScript packages, unsafe paths, undeclared hooks and missing checksums',()=>{
 const m=manifest();assert.throws(()=>validateManifest({...m,hostApiVersion:1,entry:'index.mjs'}),/声明式/);
 assert.throws(()=>unpack(zipSync({'manifest.json':strToU8(JSON.stringify(m)),'rules.json':strToU8('{"rules":[]}'),'index.mjs':strToU8('throw Error()')})),/只能包含/);
 assert.throws(()=>unpack(zipSync({'../escape':strToU8('x')})),/不安全/);
 assert.throws(()=>validateManifest({...m,capabilities:['beforePrompt']}),/权限/);
});
test('declarative install/enable/action authorization/disable/remove are distinct',async t=>{
 const x=await setup(t),market=new Market(x.store,x.extensions,'',log),parsed=unpack(archive());
 await market.commit(parsed,{source:'local',sha256:'test'});
 const item=x.store.data.extensions['qq-test'];assert.equal(item.enabled,false);assert.equal(x.extensions.live.size,0);
 item.enabled=true;await x.extensions.load('qq-test');assert.equal(await x.extensions.inbound(message({text:'/测试'})),'规则回复');
 const c=x.permissions.issue(message());await assert.rejects(x.actions.invoke('plugin.qq-test.answer',{},c),/尚未启用/);
 x.store.data.framework.enabledActions.push('plugin.qq-test.answer');assert.equal((await x.actions.invoke('plugin.qq-test.answer',{},c)).text,'动作回复');
 item.enabled=false;await x.extensions.unload('qq-test');await assert.rejects(x.actions.invoke('plugin.qq-test.answer',{},c),/未知/);
 await market.remove('qq-test');assert.equal(x.store.data.extensions['qq-test'].uninstalled,true);assert.equal(x.extensions.live.has('qq-test'),false);await market.restore('qq-test');assert.equal(x.store.data.extensions['qq-test'].enabled,false);assert.equal(x.store.data.extensions['qq-test'].uninstalled,false);
});
test('ordinary chat and persona are removable without removing core owner task route',async t=>{
 const x=await setup(t),native={run:async()=> '受限回复',create:async msg=>({sessionId:'s',generation:x.store.data.framework.generation,chatKey:msg.key}),reset:async()=>{},revoke:async()=>{},stop:async()=>{}};
 const router=new Router(x.store,native,x.extensions,log,x);router.attach(x.bot);
 x.builtins.remove('ai-chat');x.builtins.remove('persona');assert.equal(x.builtins.persona(message()).id,'core-neutral');
 x.store.data.framework.listenUsers.push('123456');x.store.data.settings.allowedUsers.push('123456');
 await router.receive(message({user:'123456',peer:'123456',key:'10000002:private:123456'}));assert.equal(x.sent.length,0);
 await router.receive(message({id:'2',text:'机器人状态'}));await Promise.all([...router.queues.values()]);assert.match(x.sent[0].params.message[0].data.text,/QQ 在线/);
 await router.receive(message({id:'3',text:'查询当前状态'}));await Promise.all([...router.queues.values()]);assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,2);
 assert.equal(router.isOwner({...message(),type:'notice'}),false);
});
test('group users never inherit owner conversation or tool authorization',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.listenGroups=['88888'];x.store.data.settings.groupEnabled=true;x.store.data.settings.allowedGroups=['88888'];x.store.data.settings.allowedUsers.push('123456');
 const calls=[],native={run:async(s,job,prompt,c)=>{calls.push({s,actor:c.actor,toolReason:x.permissions.decision(x.actions.definitions.get('core.status'),c)});return '回复';},create:async msg=>({sessionId:'s'+calls.length,generation:f.generation,chatKey:msg.key}),reset:async()=>{},revoke:async()=>{},stop:async()=>{}};
 const router=new Router(x.store,native,x.extensions,log,x);router.attach(x.bot);
 for(const [i,user]of ['10000001','123456'].entries()){await router.receive(message({id:String(i+1),kind:'group',peer:'88888',key:'10000002:group:88888',user,mentions:['10000002']}));await Promise.all([...router.queues.values()]);}
 assert.equal(Object.keys(x.store.data.sessions).length,1);assert.equal(calls[0].s,calls[1].s);assert.notEqual(calls[0].actor,calls[1].actor);assert.equal(calls[1].toolReason,null);
});
test('plugin reload keeps the conversation context instead of retiring the session',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.listenGroups=['88888'];x.store.data.settings.groupEnabled=true;x.store.data.settings.allowedGroups=['88888'];
 const created=[],resets=[];
 const native={run:async()=> '回复',create:async msg=>{const session={sessionId:'s'+created.length,generation:f.generation,chatKey:msg.key};created.push(session);return session;},reset:async session=>{resets.push(session.sessionId);},revoke:async()=>{},stop:async()=>{}};
 const router=new Router(x.store,native,x.extensions,log,x);router.attach(x.bot);
 const groupMessage=id=>message({id,kind:'group',peer:'88888',key:'10000002:group:88888',mentions:['10000002'],text:'你好'});
 await router.receive(groupMessage('1'));await Promise.all([...router.queues.values()]);
 invalidate(x.store); // 插件重载或保存设置：只撤销旧授权，不应丢弃上下文
 await router.receive(groupMessage('2'));await Promise.all([...router.queues.values()]);
 assert.equal(created.length,1);
 assert.equal(resets.length,0);
 assert.equal(x.store.data.sessions['10000002:group:88888|shared'].generation,f.generation);
});
test('accepted or unknown gateway sends never trigger automatic replay',async t=>{
 const x=await setup(t),native={run:async()=>'',reset:async()=>{},revoke:async()=>{},stop:async()=>{}},router=new Router(x.store,native,x.extensions,log,x);router.attach(x.bot);
 x.bot.request=async()=>({outcome:'accepted',data:null});
 await router.receive(message({text:'机器人状态'}));await Promise.all([...router.queues.values()]);assert.equal(x.store.data.inbox[0].status,'accepted');
 x.bot.request=async()=>{throw Object.assign(new Error('结果未知'),{code:'UNKNOWN_OUTCOME'});};
 await router.receive(message({id:'2',text:'机器人状态'}));await Promise.all([...router.queues.values()]);assert.equal(x.store.data.inbox[1].status,'uncertain');
 const count=x.store.data.inbox.length;await router.recover();assert.equal(x.store.data.inbox.length,count);
});
async function fakeServer(t){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 t.after(async()=>{for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));});
 server.on('connection',ws=>ws.on('message',b=>{const r=JSON.parse(b),data=r.action==='get_login_info'?{user_id:10000002,nickname:'测试'}:r.action==='get_status'?{online:true}:r.action==='get_version_info'?{app_name:'NapCat'}:{value:r.params.value};
  ws.send(JSON.stringify({echo:r.echo,status:r.action==='async_action'?'async':'ok',retcode:r.action==='async_action'?1:0,data}));
 }));
 return server;
}
test('forward transport correlates echo, binds bot identity and distinguishes accepted',async t=>{
 const server=await fakeServer(t),bot=new OneBot({...defaults().settings,url:'ws://127.0.0.1:'+server.address().port},'token');t.after(()=>bot.stop());
 const ready=once(bot,'ready');await bot.start();await ready;
 assert.equal((await bot.call('echo',{value:3})).value,3);assert.equal((await bot.request('async_action')).outcome,'accepted');await assert.rejects(bot.call('async_action'),e=>e.code==='ACCEPTED');
 let count=0;bot.on('event',()=>count++);const ws=[...server.clients][0];
 ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:99999,user_id:123456,message_id:1,message:'伪造'}));
 ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:10000002,user_id:123456,message_id:2,message:'正确'}));
 await delay(30);assert.equal(count,1);
});
test('reverse transport requires token and supports distinct API/event sockets',async t=>{
 const bot=new OneBot({...defaults().settings,mode:'reverse',reversePort:0},'test-token');t.after(()=>bot.stop());await bot.start();
 const port=bot.server.address().port;
 const api=new WebSocket('ws://127.0.0.1:'+port+'/onebot/v11',{headers:{Authorization:'Bearer test-token','X-Client-Role':'API','X-Self-ID':'10000002'}});
 api.on('message',b=>{const r=JSON.parse(b);api.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data:r.action==='get_login_info'?{user_id:10000002}:r.action==='get_status'?{online:true}:{app_name:'NapCat'}}));});
 await once(bot,'ready');
 const event=new WebSocket('ws://127.0.0.1:'+port+'/onebot/v11',{headers:{Authorization:'Bearer test-token','X-Client-Role':'Event','X-Self-ID':'10000002'}});await once(event,'open');
 const got=once(bot,'event');event.send(JSON.stringify({post_type:'notice',self_id:10000002,group_id:88888,user_id:123456,notice_type:'group_increase'}));assert.equal((await got)[0].name,'group_increase');
 api.terminate();event.terminate();
 const denied=new WebSocket('ws://127.0.0.1:'+port+'/onebot/v11',{headers:{Authorization:'Bearer wrong'}});const [err]=await once(denied,'error');assert.match(err.message,/401/);
});
test('native guard rejects all default, nested, late and context-free tools',async t=>{
 const x=await setup(t);let guard,registered;
 const ctx={tools:{guard:fn=>{guard=fn;return()=>{};}},agentPresets:{register:async d=>{registered=d;return async()=>{};},composedPreset:()=>SAFE_PRESET}};
 const native=new NativeDSH(ctx,x.store,x.permissions,x.actions);await native.start();const agent={id:'a',ctx:{}},c=x.permissions.issue(message());
 for(const name of ['exec_command','read_file','run_code','mcp__late','qqf_core_status'])assert.match(guard({agent,name}),/禁止/);
 const tools=new Map([['qqf_core_status',x.actions.definitions.get('core.status')]]);native.active.set('a',{tools,context:c});
 assert.equal(guard({agent,name:'qqf_core_status'}),undefined);invalidate(x.store);assert.match(guard({agent,name:'qqf_core_status'}),/撤销/);
 assert.equal(registered.plugins.some(p=>/tool-(pwsh|fs|bash|subagent)/.test(p.name)),false);
 native.active.clear();await native.stop();
});
test('single prompt personas preserve stable bindings, and client bundle parses',async()=>{
 const data=defaults(),p=validatePersona({name:'小鱼',prompt:'说话自然一些'});data.personas.push(p);data.bindings.x={personaId:p.id};
 assert.equal(resolvePersona(data,'x','10000002').prompt,p.prompt);assert.equal(importPersona('# 导入\n完整提示词','markdown').prompt,'完整提示词');
 const source=await readFile(new URL('../src/client/client.js',import.meta.url),'utf8');new vm.Script(source);
 assert.match(source,/主人与权限/);assert.match(source,/保存监听范围/);
});

test('revocation during resource preparation prevents the pending write from reaching gateway',async t=>{
 const x=await setup(t),c=x.permissions.issue(message(),'chat');x.store.data.framework.enabledActions.push('qq.profile.avatar');
 let release;x.media.resolve=()=>new Promise(resolve=>{release=resolve;});
 const pending=x.actions.invoke('qq.profile.avatar',{resourceId:'resource'},c);await delay(1);invalidate(x.store);release({file:'base64://AAAA'});
 await assert.rejects(pending,/撤销/);assert.equal(x.sent.length,0);
});
test('private peer and conversation key cannot be forged even by an SDK caller',async t=>{
 const x=await setup(t);assert.throws(()=>x.permissions.issue(message({peer:'99999999',key:'10000002:private:99999999'})),/身份/);
 assert.throws(()=>x.permissions.issue(message({key:'wrong'})),/身份/);
});
test('received media URL is scoped and private-network downloads are refused',async t=>{
 const x=await setup(t),m=message({parts:[{type:'image',data:{url:'https://127.0.0.1/secret',file:'secret'}}]});
 await x.events.receive(m);x.store.data.framework.enabledActions.push('qq.media.receive');const c=x.permissions.issue(m);
 await assert.rejects(x.actions.invoke('qq.media.receive',{messageId:'1',index:0},c),/私网|保留/);
 await assert.rejects(x.actions.invoke('qq.media.receive',{messageId:'2',index:0},c),/当前聊天/);
});
test('image dimensions and IPv6 tunneling ranges are bounded',async t=>{
 const x=await setup(t),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cLxkAAAAASUVORK5CYII=','base64');
 bytes.writeUInt32BE(100000,16);await assert.rejects(x.media.put(bytes,{key:message().key}),/尺寸/);
 for(const ip of ['2002:7f00:1::','2001::1','2001:100::1','3fff::1'])assert.equal(publicIP(ip),false,ip);
});

test('trusted native SDK is disabled by default and retains original actor across plugin actions',async t=>{
 const {PluginSDK}=await import('../src/sdk.js'),x=await setup(t);
 const sdk=new PluginSDK({...x,onChange:async()=>{invalidate(x.store);}});
 const pack=sdk.facade().registerTrustedPackage({id:'qq-native-test',name:'原生测试',version:'1.0.0',capabilities:['events','actions','storage']});
 const cap='plugin.qq-native-test.echo';
 pack.action('echo',{description:'返回原始发起者',parameters:{type:'object',properties:{},additionalProperties:false}},async(args,c)=>({actor:c.actor,plugin:c.plugin}));
 const c=x.permissions.issue(message());x.store.data.framework.enabledActions.push(cap);
 await assert.rejects(x.actions.invoke(cap,{},c),/停用/);
 const item=x.store.data.framework.nativePackages[pack.id];item.enabled=true;
 const result=await x.actions.invoke(cap,{},c);
 // 结果协议会附加 state/verified/evidence/protocol；这里只校验身份语义，再确认附加字段存在。
 assert.deepEqual({actor:result.actor,plugin:result.plugin},{actor:'10000001',plugin:pack.id});
 assert.equal(result.state,'confirmed');
 assert.equal(result.protocol,1);
 x.store.data.framework.listenUsers.push('123456');item.scope.users.push('123456');
 const ordinary=x.permissions.issue(message({user:'123456',peer:'123456',key:'10000002:private:123456'}));
 await assert.rejects(x.actions.invoke(cap,{},ordinary),/尚未.*开放/);
 await pack.storage.set({hello:'world'});assert.deepEqual(pack.storage.get(),{hello:'world'});
 assert.throws(()=>pack.invoke('core.status',{},c),/身份|作用范围/);
 await pack.dispose();await assert.rejects(x.actions.invoke(cap,{},c),/撤销|未知/);
});
test('native notice subscriptions get data without executable owner identity or request flags',async t=>{
 const {PluginSDK}=await import('../src/sdk.js'),x=await setup(t);x.store.data.framework.listenGroups=['88888'];
 const sdk=new PluginSDK({...x,onChange:async()=>{}}),pack=sdk.facade().registerTrustedPackage({id:'qq-notice-test',name:'通知测试',version:'1.0.0',capabilities:['events']});
 const item=x.store.data.framework.nativePackages[pack.id];item.enabled=true;item.scope.groups=['88888'];
 let received;pack.on(['notice','request'],(event,c)=>{received={event,c};});
 await x.events.receive({type:'notice',bot:'10000002',user:'10000001',operator:'123456',kind:'group',peer:'88888',name:'group_increase',time:Date.now()/1000});
 assert.equal(received.c,null);assert.equal(received.event.user,'10000001');
 await x.events.receive({type:'request',bot:'10000002',user:'10000001',kind:'group',peer:'88888',name:'group',flag:'secret'});
 assert.equal('flag' in received.event,false);await pack.dispose();
});

test('request inbox survives restart and unfinished approvals become unknown',async t=>{
 const x=await setup(t);x.store.data.framework.listenUsers.push('123456');
 await x.events.receive(normalizeEvent({post_type:'request',request_type:'friend',self_id:10000002,user_id:123456,flag:'persisted-private-flag'}));
 x.events.requests[0].state='submitting';await x.store.persist();
 const reopened=await new Store(x.store.dir).open(),events=new Events(reopened,log);
 assert.equal(events.requests.length,1);assert.equal(events.requests[0].state,'unknown');assert.equal(events.requests[0].flag,'persisted-private-flag');assert.equal('flag' in events.snapshot().requests[0],false);
});
test('actual bundled declarative market packages have valid editable config',async t=>{
 const x=await setup(t),examples=new URL('../examples/',import.meta.url),{fileURLToPath}=await import('node:url'),market=new Market(x.store,x.extensions,fileURLToPath(examples),log);
 await market.start();const catalog=await market.catalog();assert.equal(catalog.items.length,2);
 await market.install('builtin','qq-help','2.0.0');
 const item=x.store.data.extensions['qq-help'];item.enabled=true;item.config={text:'配置已生效'};await x.extensions.load('qq-help');
 assert.equal(await x.extensions.inbound(message({text:'/帮助'})),'配置已生效');
});

test('expiry and ended execution leases block pending results and background callbacks',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.listenUsers.push('123456');
 f.grants=[{id:'expiry',capability:'core.status',users:['123456'],private:true,groups:[],perMinute:5,expires:new Date(Date.now()+60000).toISOString()}];
 const c=x.permissions.issue(message({user:'123456',peer:'123456',key:'10000002:private:123456'}));
 await x.actions.invoke('core.status',{},c);f.grants[0].expires=new Date(Date.now()-1000).toISOString();assert.match(x.permissions.resultReason(c),/复核失败/);
 x.permissions.close(c);assert.match(x.permissions.valid(c),/失效/);
});
test('native event callback cannot retain a usable execution identity after return',async t=>{
 const {PluginSDK}=await import('../src/sdk.js'),x=await setup(t),sdk=new PluginSDK({...x,onChange:async()=>{}}),pack=sdk.facade().registerTrustedPackage({id:'qq-lease-test',name:'上下文测试',version:'1.0.0',capabilities:['events']});
 x.store.data.framework.nativePackages[pack.id].enabled=true;let saved;
 pack.on(['message'],(event,c)=>{saved=c;assert.equal(x.permissions.valid(c),null);});
 await x.events.receive(message());assert.match(x.permissions.valid(saved),/失效/);assert.throws(()=>pack.invoke('core.status',{},saved),/停用|范围/);await pack.dispose();
});
test('owner pause is not held behind a running model turn and stale reply is cancelled',async t=>{
 const x=await setup(t);let release,entered=false;
 const native={create:async msg=>({sessionId:'pause-test',chatKey:msg.key,generation:x.store.data.framework.generation}),run:async()=>{entered=true;return new Promise(r=>{release=r;});},revoke:async()=>{release?.('迟到回复');},reset:async()=>{},stop:async()=>{}};
 const router=new Router(x.store,native,x.extensions,log,x);router.attach(x.bot);
 await router.receive(message({id:'pending'}));while(!entered)await delay(1);
 await router.receive(message({id:'pause',text:'暂停机器人'}));await Promise.all([...router.queues.values()]);
 assert.equal(x.store.data.framework.paused,true);assert.equal(x.sent.filter(row=>row.action==='send_private_msg').length,1);assert.match(x.sent[0].params.message[0].data.text,/暂停/);
 assert.equal(x.store.data.inbox.find(j=>j.message.id==='pending').status,'cancelled');
});
