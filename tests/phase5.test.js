import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Conversation} from '../src/session/conversation.js';
import {publicText,boundedReply} from '../src/session/output.js';
import {Store,validateSettings} from '../src/host/store.js';
import {migrate} from '../src/host/migrate.js';
import {Permissions} from '../src/core/permissions.js';
import {Actions} from '../src/core/actions.js';
import {Events} from '../src/core/events.js';
import {Media} from '../src/core/media.js';
import {Builtins} from '../src/builtins/index.js';
import {Extensions} from '../src/extensions/index.js';
import {Router} from '../src/session/router.js';
import {IncomingMedia,decodeFile} from '../src/session/incoming.js';
const bot='10000002',owner='10000001',other='12345678',group='88888';
const message=(extra={})=>({type:'message',bot,user:owner,kind:'group',peer:group,key:bot+':group:'+group,id:'101',time:Date.now()/1000,text:'查一下',sender:'主人',mentions:[bot],parts:[],...extra});
async function setup(t){
 process.env.QQBOT_OWNER=owner;const dir=await mkdtemp(path.join(os.tmpdir(),'qq-phase5-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();store.data.settings.mergeWindowMs=0;Object.assign(store.data.settings,{intentRecognition:false,groupEnabled:true,allowedGroups:[group],groupAudience:'all',privateAudience:'all',sendInterval:500,replySplit:'paragraphs'});
 Object.assign(store.data.framework,{ownerQQ:owner,listenGroups:[group],listenAllPrivate:true,enabledActions:['core.status']});
 const permissions=new Permissions(store),events=new Events(store,permissions),media=new Media(store,permissions),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,()=>{});
 const sent=[],runs=[],archived=[],b={token:'private-token-12345',status:{bot,online:true},request:async(a,p)=>{sent.push({a,p});return {outcome:'confirmed',data:{message_id:8000+sent.length}};},call:async()=>({})};
 const native={create:async m=>({sessionId:'s'+(runs.length+1),generation:store.data.framework.generation,chatKey:m.key}),reset:async s=>archived.push(s.sessionId),run:async(id,job,prompt,c)=>{runs.push({id,job:structuredClone(job),prompt,c});return '我接着聊。';},stop:async()=>{},revoke:async()=>{}};
 const router=new Router(store,native,extensions,()=>{},{permissions,events,actions,builtins});router.attach(b);t.after(()=>media.stop());
 return {dir,store,permissions,events,media,actions,builtins,router,native,b,sent,runs,archived};
}
test('quotes hydrate original sender, text and media, without inheriting original identity',async()=>{
 const c=new Conversation({data:{}}),original=message({id:'50',user:other,text:'项目代号是蓝鲸',parts:[{type:'image',data:{file:'image-id'}}]});c.remember(original);
 const incoming={sources:new WeakMap()},m=message({reply:'50',text:'它是什么？'}),r=await c.enrich(m,{request:()=>{throw Error('should use cache');}},incoming);
 assert.equal(r.user,owner);assert.equal(r.quoted[0].user,other);assert.match(r.quoted[0].text,/蓝鲸/);assert.equal(r.parts[0].type,'image');assert.equal(incoming.sources.get(r.parts[0]).messageId,'50');
});
test('remote quote uses get_msg and verifies room; cross-group and unverifiable results fail closed',async()=>{
 for(const returnedGroup of [group,'99999',undefined]){
  const c=new Conversation({data:{}}),calls=[],r=await c.enrich(message({reply:'51'}),{request:async(a,p)=>{calls.push({a,p});return {outcome:'confirmed',data:{message_id:51,message_type:'group',group_id:returnedGroup,sender:{user_id:other,nickname:'群友'},message:[{type:'text',data:{text:'原文测试'}}]}};}});
  assert.equal(calls[0].a,'get_msg');assert.equal(r.quoted.length,returnedGroup===group?1:0);assert.equal(r.quoteMissing,returnedGroup!==group);
 }
});
test('quote chains are bounded and cache never crosses rooms or private chats',async()=>{
 const c=new Conversation({data:{}});c.remember(message({id:'1',reply:'3'}));c.remember(message({id:'2',reply:'1'}));c.remember(message({id:'3',reply:'2'}));
 const r=await c.resolve(message({id:'4',reply:'3'}),{});assert.equal(r.items.length,2);
 assert.equal(c.find(message({key:bot+':group:99999',peer:'99999'}),'1'),null);
 assert.equal(c.find(message({kind:'private',key:bot+':private:'+owner,peer:owner}),'1'),null);
});
test('same-group members share public conversation, private and other-group messages stay separate',()=>{
 const c=new Conversation({data:{}});c.remember(message({id:'1',user:other,text:'我们周末去杭州'}));c.remember(message({id:'2',kind:'private',key:bot+':private:'+owner,peer:owner,text:'私密内容'}));
 c.remember(message({id:'3',key:bot+':group:99999',peer:'99999',text:'另一个群'}));
 const text=c.context(message({id:'4'}));assert.match(text,/杭州/);assert.ok(!text.includes('私密内容'));assert.ok(!text.includes('另一个群'));assert.equal(c.context(message({kind:'private'})),'');
});
test('one group reuses a single session while every turn keeps its own execution identity',async t=>{
 const x=await setup(t);
 await x.router.receive(message({id:'1',text:'周末想去杭州',mentions:[]}));
 assert.equal(x.runs.length,0); // observed but not woken
 await x.router.receive(message({id:'2',text:'你觉得呢？'}));await Promise.all([...x.router.queues.values()]);
 await x.router.receive(message({id:'3',user:other,text:'他刚才说去哪里？'}));await Promise.all([...x.router.queues.values()]);
 assert.equal(x.runs.length,2);assert.equal(x.runs[0].id,x.runs[1].id);assert.equal(Object.keys(x.store.data.sessions).length,1);assert.equal(x.archived.length,0);
 assert.match(x.runs[1].job.message.groupContext,/杭州/);assert.match(x.runs[1].job.message.groupContext,/我接着聊/);assert.equal(x.runs[1].c.actor,other);
 assert.match(x.permissions.decision(x.actions.definitions.get('core.status'),x.runs[1].c),/失效/);
 assert.equal(x.store.data.sessions[Object.keys(x.store.data.sessions)[0]].actor,undefined);
});
test('引用优先于最近附件，原文和当前问题均进入原生输入',async t=>{
 const x=await setup(t),incoming=new IncomingMedia(x.store,x.permissions);incoming.attach(x.b);const prior=message({parts:[{type:'image',data:{file:'old'}}]});incoming.capture(prior);
 const m=message({id:'202',reply:'50',quoted:[{id:'50',user:other,text:'原消息 Q725'}],text:'解释引用',groupContext:'背景 W631'});
 assert.equal(incoming.withRecent(m,{ambient:false}).parts.length,0);
 const c=x.permissions.issue(m),r=await incoming.build(m,{ctx:{},agent:{},context:c});
 const text=r.content.map(b=>b.text||'').join('\n');assert.match(text,/Q725/);assert.match(text,/W631/);assert.match(text,/解释引用/);
});
test('outbound paths and known credentials are hidden, QQ codes remain plain text',()=>{
 const text=publicText('目录 F:\\私人目录\\project，另一个 /home/me/private.txt token=abc [CQ:at,qq=all] SECRET123',{secrets:['SECRET123']});
 assert.ok(!text.includes('F:\\'));assert.ok(!text.includes('/home/me'));assert.ok(!text.includes('SECRET123'));assert.match(text,/\[CQ：at/);
 assert.equal(Array.from(boundedReply('😀'.repeat(500),{replyTotalChars:240})).length,240);
 assert.equal(Array.from(boundedReply('字'.repeat(1000),{replyTotalChars:4000,maxReplyChars:200,replyMaxParts:2})).length,400);
 assert.equal(Array.from(boundedReply('字'.repeat(50),{replyTotalChars:7})).length,7);
});
test('tool sends, delegated plugins and final reply share a turn budget',async t=>{
 const x=await setup(t),m=message(),c=x.permissions.issue(m);x.store.data.settings.replyTotalChars=80;x.store.data.settings.replyMaxParts=2;
 await x.actions.request('send_group_msg',{group_id:Number(group),message:[{type:'text',data:{text:'字'.repeat(50)+' F:\\secret\\data'}}]},c);
 const delegated=x.permissions.delegate(c,'test-package');await x.router.send(m,'文'.repeat(200),{mode:'chat'},delegated);
 assert.equal(x.sent.length,2);assert.ok(x.sent.every(s=>!JSON.stringify(s).includes('secret')));
 assert.ok(x.sent.reduce((n,s)=>n+Array.from(s.p.message.map(p=>p.data.text||'').join('')).length,0)<=80);
 await assert.rejects(x.actions.request('send_group_msg',{group_id:Number(group),message:[]},delegated),/条数/);
 assert.match(x.router.conversation.context({...m,id:'new'}),/字/);
});
test('missing file names decode bounded UTF-8 and gateway file_name is retained',async t=>{
 const x=await setup(t),incoming=new IncomingMedia(x.store,x.permissions);x.b.request=async()=>({outcome:'confirmed',data:{file_name:'新建文本文档.txt',base64:Buffer.from('文件正文 TXT729').toString('base64')}});incoming.attach(x.b);
 const m=message({parts:[{type:'file',data:{file_id:'file-id'}}]}),uploads=[];
 const ctx={llm:{resolveModelInfo:async()=>({inputModalities:['text']})},sessionController:{agents:{selectionFor:()=>({current:{provider:'fixture',model:'fixture'}})}},fileUploads:{upload:async(_a,p)=>{uploads.push(p);return {receiptId:'r1'};}}};
 const r=await incoming.build(m,{ctx,agent:{},context:x.permissions.issue(m)});assert.equal(uploads[0].name,'新建文本文档.txt');assert.match(r.content.map(b=>b.text||'').join(''),/TXT729/);
 assert.equal(decodeFile(Buffer.from('无文件名正文'),'file'),'无文件名正文');assert.equal(decodeFile(Buffer.from([255,0,1]),'file'),null);
});
test('new output settings validate strictly, migration preserves grants and persona',async t=>{
 const x=await setup(t),before=JSON.stringify(x.store.data.personas);x.store.data.framework.featuresVersion=5;x.store.data.sessions.old={sessionId:'old',safePreset:'v2'};
 x.store.data.framework.grants=[{id:'keep-this-grant'}];migrate(x.store.data);assert.equal(JSON.stringify(x.store.data.personas),before);assert.equal(x.store.data.framework.grants[0].id,'keep-this-grant');assert.deepEqual(x.store.data.sessions,{});assert.ok(x.store.data.framework.retiredSessions.some(s=>s.sessionId==='old'));
 for(const field of ['replyTotalChars','replyMaxParts'])for(const value of ['',0,1.5,99999])assert.throws(()=>validateSettings({...x.store.data.settings,[field]:value}));
});

test('preconfigured event replies hide paths and enter only their public group timeline',async t=>{
 const x=await setup(t),event={kind:'group',bot,peer:group,key:bot+':group:'+group,user:other,time:Date.now()/1000,name:'group_increase',id:'9'};
 await x.router.automaticReply({id:'test-event',automationId:'join',event,generation:x.store.data.framework.generation,expires:Date.now()+60000,valid:()=>true},'欢迎 F:\\private\\config，请一起聊天。');
 assert.equal(x.sent.length,1);assert.ok(!x.sent[0].p.message[0].data.text.includes('F:\\'));
 assert.match(x.router.conversation.context(message({id:'new'})),/欢迎/);
});

test('poke normalization retains actor and target in both group and private notices',async()=>{
 const {normalizeEvent}=await import('../src/onebot/index.js');
 for(const group_id of [Number(group),undefined]){
  const e=normalizeEvent({post_type:'notice',notice_type:'notify',sub_type:'poke',self_id:Number(bot),user_id:Number(owner),target_id:Number(bot),group_id,time:Date.now()/1000});
  assert.equal(e.target,bot);assert.equal(e.user,owner);assert.equal(e.kind,group_id?'group':'private');assert.equal(e.peer,group_id?group:owner);
 }
});
const poke=(extra={})=>({type:'notice',name:'notify',subtype:'poke',bot,user:owner,target:bot,kind:'group',peer:group,key:bot+':group:'+group,time:Math.floor(Date.now()/1000),id:'',...extra});
test('poking the bot runs persona chat with zero tool authorization and no fake reply segment',async t=>{
 const x=await setup(t),run=x.native.run;x.native.run=async(...args)=>{assert.equal(args[3].mode,'poke');assert.match(x.permissions.decision(x.actions.definitions.get('core.status'),args[3]),/戳一戳/);return run(...args);};
 assert.equal(await x.router.poke(poke()),true);await Promise.all([...x.router.queues.values()]);
 assert.equal(x.runs.length,1);assert.equal(x.runs[0].job.wakeReason,'poke');assert.match(x.runs[0].job.message.text,/戳一戳/);
 assert.equal(x.sent.length,1);assert.ok(x.sent[0].p.message.every(p=>p.type!=='reply'));
 assert.equal(x.router.replyGate.groups.get(bot+':group:'+group).follow.actor,owner);
});
test('poke pending, actor cooldown and room cooldown suppress repeat bursts',async t=>{
 const x=await setup(t),e=poke();assert.equal(await x.router.poke(e),true);assert.equal(await x.router.poke({...e,user:other}),false);await Promise.all([...x.router.queues.values()]);
 assert.equal(await x.router.poke({...e,time:e.time+1}),false);
 const room=x.router.pokes.get('room|'+e.key);room.at-=11000;assert.equal(await x.router.poke({...e,user:other,time:e.time+1}),true);await Promise.all([...x.router.queues.values()]);assert.equal(x.runs.length,2);
});
test('private pokes respond in the same private chat and stay independent of group cooldown',async t=>{
 const x=await setup(t);await x.router.poke(poke());await Promise.all([...x.router.queues.values()]);
 const e=poke({kind:'private',peer:owner,key:bot+':private:'+owner});assert.equal(await x.router.poke(e),true);await Promise.all([...x.router.queues.values()]);
 assert.equal(x.sent.at(-1).a,'send_private_msg');assert.equal(x.sent.at(-1).p.user_id,Number(owner));
});
test('pokes never respond to other targets, bot echoes, stale events or disabled chat controls',async t=>{
 const x=await setup(t);
 for(const e of [poke({target:other}),poke({user:bot}),poke({time:Date.now()/1000-301}),poke({kind:'private',name:'friend_recall'}),poke({kind:'group',peer:'99999',key:bot+':group:99999'})])assert.equal(await x.router.poke(e),false);
 x.store.data.settings.pokeReplyEnabled=false;assert.equal(await x.router.poke(poke()),false);x.store.data.settings.pokeReplyEnabled=true;
 x.store.data.framework.paused=true;assert.equal(await x.router.poke(poke()),false);x.store.data.framework.paused=false;
 x.store.data.framework.listenNotices=false;assert.equal(await x.router.poke(poke()),false);x.store.data.framework.listenNotices=true;
 x.builtins.configure('ai-chat',false);assert.equal(await x.router.poke(poke()),true);await Promise.all([...x.router.queues.values()]);assert.equal(x.runs.length,0);assert.equal(x.sent.length,1);
});
test('poke replies are one short public message and cooldown settings validate strictly',async t=>{
 const x=await setup(t);x.native.run=async()=>('你好。\\n\\n'.repeat(100)+'F:\\private\\config');await x.router.poke(poke());await Promise.all([...x.router.queues.values()]);
 assert.equal(x.sent.length,1);const text=x.sent[0].p.message.map(p=>p.data.text||'').join('');assert.ok(Array.from(text).length<=80);assert.ok(!text.includes('F:\\'));
 for(const value of ['',0,4,1.5,601])assert.throws(()=>validateSettings({...x.store.data.settings,pokeReplyCooldown:value}),/冷却/);
});

test('quoting a poke reply never tries fetching the synthetic notice ID',async()=>{const c=new Conversation({data:{}});c.sent(message({id:'poke-synthetic'}),1200,'别戳啦');const r=await c.resolve(message({id:'1201',reply:'1200'}),{request:()=>{throw Error('unexpected fetch');}});assert.equal(r.items.length,1);assert.equal(r.missing,false);});

import {ReplyGate} from '../src/session/reply-gate.js';
const followConfig={groupReplyMode:'smart',groupReplyProbability:0,groupReplyCooldown:30,groupAutoLimit:2,botAliases:[],followupEnabled:true};
test('a different group member can directly address the bot without @ during an active conversation',()=>{
 let now=100000;const gate=new ReplyGate({now:()=>now,random:()=>1}),seed=message({text:'你是谁？'}),wake=gate.decide(seed,followConfig);gate.replied(seed,wake,followConfig,'我是小鲸鱼，刚才说到杭州。');
 const r=gate.decide(message({id:'2',user:other,mentions:[],text:'你有鲸鱼娘专武吗？'}),followConfig);assert.equal(r.allow,true);assert.equal(r.reason,'context');assert.equal(r.contextual,true);r.release();
 now+=91000;assert.equal(gate.decide(message({id:'3',user:other,mentions:[],text:'你有鲸鱼娘专武吗？'}),followConfig).allow,false);
});
test('topic continuation works without @ but unrelated chat, at-others, quotes-to-others and media do not wake it',()=>{
 const gate=new ReplyGate({now:()=>100000,random:()=>1}),seed=message({text:'杭州怎么样？'});gate.replied(seed,gate.decide(seed,followConfig),followConfig,'杭州可以逛西湖。');
 const r=gate.decide(message({user:other,mentions:[],text:'西湖晚上好玩吗？'}),followConfig);assert.equal(r.reason,'context');r.release();
 for(const m of [message({user:other,mentions:[],text:'晚饭吃什么？'}),message({user:other,mentions:['12345678'],text:'你有鲸鱼娘专武吗？'}),message({user:other,mentions:[],reply:'unknown',text:'你有鲸鱼娘专武吗？'}),message({user:other,mentions:[],text:'[图片]'})])assert.equal(gate.decide(m,followConfig).allow,false);
});
test('context participation has pending, interval and three-turn caps and never extends its original deadline',()=>{
 let now=100000;const gate=new ReplyGate({now:()=>now,random:()=>1}),seed=message();gate.replied(seed,gate.decide(seed,followConfig),followConfig,'聊聊杭州。');const until=gate.groups.get(seed.key).scene.until;
 const m=message({user:other,mentions:[],text:'那你觉得呢？'});
 for(let i=0;i<3;i++){const r=gate.decide({...m,id:String(i)},followConfig);assert.equal(r.allow,true);assert.equal(gate.decide(m,followConfig).allow,false);r.release();gate.replied(m,r,followConfig,'我接着说。');assert.equal(gate.groups.get(seed.key).scene.until,until);now+=3100;}
 assert.equal(gate.decide(m,followConfig).allow,false);
});
test('disabling follow-up suppresses context participation and all-message mode still admits pure media',()=>{
 const gate=new ReplyGate({random:()=>1}),seed=message();gate.replied(seed,gate.decide(seed,followConfig),followConfig,'你好。');
 assert.equal(gate.decide(message({user:other,mentions:[],text:'你是谁？'}),{...followConfig,followupEnabled:false}).allow,false);
 assert.equal(gate.decide(message({user:other,mentions:[],text:'[图片]'}),{...followConfig,groupReplyMode:'all'}).allow,true);
});
test('router keeps the real actor for non-@ context replies and shares public history',async t=>{
 const x=await setup(t);Object.assign(x.store.data.settings,followConfig);await x.router.receive(message({id:'f1',text:'你好小鲸鱼'}));await Promise.all([...x.router.queues.values()]);
 await x.router.receive(message({id:'f2',user:other,mentions:[],text:'你有鲸鱼娘专武吗？'}));await Promise.all([...x.router.queues.values()]);
 assert.equal(x.runs.length,2);assert.equal(x.runs[1].c.actor,other);assert.equal(x.runs[1].c.mode,'context');assert.equal(x.runs[1].job.wakeReason,'context');assert.match(x.runs[1].job.message.groupContext,/你好小鲸鱼/);assert.equal(x.sent.length,2);
});
test('context replies allow only enabled, scoped safe queries, never owner mutations or inherited authority',async t=>{
 const x=await setup(t),ownerContext=x.permissions.issue(message(),'context'),status=x.actions.definitions.get('core.status');
 assert.equal(x.permissions.decision(status,ownerContext),null);
 for(const id of ['qq.group.name','qq.friends.list','qq.message.send']){x.store.data.framework.enabledActions.push(id);assert.match(x.permissions.decision(x.actions.definitions.get(id),ownerContext),/安全查询/);}
 const userContext=x.permissions.issue(message({user:other}),'context');assert.equal(x.permissions.decision(status,userContext),null);
 x.store.data.framework.grants.push({id:'query',capability:'core.status',users:[other],groups:[group],private:false,expires:'',perMinute:5});assert.equal(x.permissions.decision(status,userContext),null);
});
