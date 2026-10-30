import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {Builtins} from '../src/builtins/index.js';import {Extensions} from '../src/extensions/index.js';import {Router} from '../src/session/router.js';import {NativeDSH,SAFE_PRESET} from '../src/session/native.js';
const bot='10000002',owner='10000001',other='12345678',group='88888',key=bot+':group:'+group;
const message=(id,extra={})=>({type:'message',bot,user:owner,kind:'group',peer:group,key,id,time:Date.now()/1000,text:'在吗',mentions:[],parts:[],...extra});

async function setup(t,run){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-accept-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 Object.assign(store.data.settings,{intentRecognition:false,groupReplyMode:'all',groupEnabled:true,allowedGroups:[group],groupAudience:'all',allowedUsers:[owner,other],mergeWindowMs:0,sendInterval:0});
 Object.assign(store.data.framework,{ownerQQ:owner,listenGroups:[group],listenPrivate:true,listenAllPrivate:true,enabledActions:['core.status','qq.message.send']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,()=>{},actions);
 const created=[],retired=[],runs=[],sent=[];
 const native={
  create:async m=>{const s={sessionId:'sess-'+(created.length+1),chatKey:m.key,generation:store.data.framework.generation,safePreset:SAFE_PRESET};created.push(s);return s;},
  reset:async s=>{retired.push(s.sessionId);},
  run:async(id,job,prompt,c)=>{runs.push({id,job,c});if(run)return run({id,job,c,runs,created,retired});return '好的';},
  stop:async()=>{},revoke:async()=>{}
 };
 const router=new Router(store,native,extensions,()=>{},{permissions,events,actions,builtins});
 router.attach({status:{bot,online:true},request:async()=>{sent.push(1);return {outcome:'confirmed',data:{message_id:9000+sent.length}};}});
 t.after(()=>media.stop());
 return {store,permissions,events,media,actions,builtins,extensions,router,native,created,retired,runs,sent,
  send:async m=>{await router.receive(m);await Promise.all([...router.queues.values()]);}};
}

test('writer-held 不会被当作会话丢失去重建',async t=>{
 let calls=0;
 const x=await setup(t,()=>{calls++;throw Object.assign(new Error('resume failed for session "sess-1": writer held by another process'),{code:'session/writer-held'});});
 await x.send(message('1'));
 assert.equal(calls,1);
 assert.equal(x.created.length,1);
 assert.equal(x.retired.length,0);
 assert.equal(x.store.data.inbox.at(-1).status,'failed');
 assert.equal(Object.keys(x.store.data.sessions).length,1);
});

test('普通模型请求失败不会重建会话',async t=>{
 const x=await setup(t,()=>{throw Object.assign(new Error('llm request failed: 500'),{code:'PROVIDER_ERROR'});});
 await x.send(message('1'));
 assert.equal(x.created.length,1);
 assert.equal(x.retired.length,0);
});

test('底层工具守卫在会话复用后仍按当前轮身份拒绝越权执行',async t=>{
 const x=await setup(t);
 let guard;
 const ctx={tools:{guard:fn=>{guard=fn;return()=>{};}},agentPresets:{register:async()=>()=>{}}};
 const native=new NativeDSH(ctx,x.store,x.permissions,x.actions,null);
 await native.start();
 t.after(()=>{native.active.clear();return native.stop();});
 assert.equal(typeof guard,'function');
 const cap=x.actions.definitions.get('qq.message.send');
 assert.ok(cap,'qq.message.send 应存在于能力目录');
 native.managed.add('sess-shared');
 const ownerContext=x.permissions.issue(message('1',{user:owner}),'chat');
 const memberContext=x.permissions.issue(message('2',{user:other}),'chat');
 // 第一轮：主人身份，守卫放行
 native.active.set('sess-shared',{tools:new Map([['qqf_qq_message_send',cap]]),context:ownerContext,controller:new AbortController()});
 assert.equal(guard({agent:{id:'sess-shared',ctx:{}},name:'qqf_qq_message_send'}),undefined);
 // 第二轮：同一个会话、普通成员身份，守卫必须拒绝
 native.active.set('sess-shared',{tools:new Map([['qqf_qq_message_send',cap]]),context:memberContext,controller:new AbortController()});
 const denied=guard({agent:{id:'sess-shared',ctx:{}},name:'qqf_qq_message_send'});
 assert.equal(typeof denied,'string');
 assert.match(denied,/未向当前用户开放|仅主人|拒绝|禁止/);
 // 未注册的工具名在任何身份下都被拒绝
 assert.match(guard({agent:{id:'sess-shared',ctx:{}},name:'qqf_not_registered'}),/禁止/);
 x.permissions.close(ownerContext);x.permissions.close(memberContext);
});

test('授权撤销后，同一个会话的下一轮立即拒绝，旧上下文同步失效',async t=>{
 const x=await setup(t);
 const cap=x.actions.definitions.get('qq.message.send');
 x.store.data.framework.grants.push({id:'g1',capability:cap.id,allUsers:false,users:[other],groups:[group],private:false,deny:false,perMinute:5});
 const before=x.permissions.issue(message('1',{user:other}),'chat');
 assert.equal(x.permissions.decision(cap,before),null);
 x.store.data.framework.grants=[];
 x.store.data.framework.generation++;
 const after=x.permissions.issue(message('2',{user:other}),'chat');
 assert.match(x.permissions.decision(cap,after),/未向当前用户开放|仅主人/);
 assert.match(x.permissions.valid(before),/撤销|失效/);
});

test('同一群并发两条消息不会交叉身份或重复发送',async t=>{
 const x=await setup(t);
 await Promise.all([
  x.router.receive(message('1',{user:owner,text:'一'})),
  x.router.receive(message('2',{user:other,text:'二'}))
 ]);
 await Promise.all([...x.router.queues.values()]);
 assert.equal(x.runs.length,2);
 assert.equal(new Set(x.runs.map(r=>r.id)).size,1);
 assert.deepEqual(x.runs.map(r=>r.c.actor).sort(),[owner,other].sort());
 assert.equal(x.sent.length,2);
 assert.equal(new Set(x.store.data.inbox.map(j=>j.id)).size,2);
});
