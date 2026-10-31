import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {Builtins} from '../src/builtins/index.js';import {Extensions} from '../src/extensions/index.js';import {Router} from '../src/session/router.js';
const bot='10000002',owner='10000001',other='12345678',group='88888',otherGroup='99999';
const key=bot+':group:'+group,otherKey=bot+':group:'+otherGroup;
const message=(id,extra={})=>({type:'message',bot,user:owner,kind:'group',peer:group,key,id,time:Date.now()/1000,text:'在吗',mentions:[],parts:[],...extra});

async function setup(t,run){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-session-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 Object.assign(store.data.settings,{intentRecognition:false,groupReplyMode:'all',groupEnabled:true,allowedGroups:[group,otherGroup],groupAudience:'all',privateAudience:'all',allowedUsers:[owner,other],mergeWindowMs:0,sendInterval:0});
 Object.assign(store.data.framework,{ownerQQ:owner,listenGroups:[group,otherGroup],listenPrivate:true,listenAllPrivate:true,enabledActions:['core.status']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,()=>{},actions);
 const created=[],retired=[],runs=[],sent=[];
 const native={
  create:async m=>{const s={sessionId:'sess-'+(created.length+1),chatKey:m.key,generation:store.data.framework.generation,safePreset:'qq-framework-restricted-v3'};created.push(s);return s;},
  reset:async s=>{retired.push(s.sessionId);},
  run:async(id,job,prompt,c)=>{runs.push({id,job,c});if(run)return run({id,job,c,runs,created,retired});return '好的';},
  stop:async()=>{},revoke:async()=>{}
 };
 const router=new Router(store,native,extensions,()=>{},{permissions,events,actions,builtins});
 router.attach({status:{bot,online:true},request:async()=>{sent.push(1);return {outcome:'confirmed',data:{message_id:9000+sent.length}};}});
 t.after(()=>media.stop());
 const send=async m=>{await router.receive(m);await Promise.all([...router.queues.values()]);};
 return {store,permissions,router,native,created,retired,runs,sent,send};
}

test('同一群连续多轮复用同一个会话',async t=>{
 const x=await setup(t);
 await x.send(message('1'));await x.send(message('2'));await x.send(message('3'));
 assert.equal(x.runs.length,3);
 assert.equal(new Set(x.runs.map(r=>r.id)).size,1);
 assert.equal(x.created.length,1);
 assert.equal(x.retired.length,0);
 assert.equal(Object.keys(x.store.data.sessions).length,1);
});

test('两个群各自一个会话，互不串用',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 await x.send(message('2',{peer:otherGroup,key:otherKey}));
 assert.equal(x.created.length,2);
 const ids=x.runs.map(r=>r.id);assert.notEqual(ids[0],ids[1]);
 assert.equal(Object.keys(x.store.data.sessions).length,2);
});

test('群聊与私聊使用不同会话，私聊不共享群上下文',async t=>{
 const x=await setup(t);
 await x.send(message('1',{text:'群里说的话'}));
 await x.send(message('2',{kind:'private',peer:owner,user:owner,key:bot+':private:'+owner,text:'私聊'}));
 assert.equal(x.created.length,2);
 assert.notEqual(x.runs[0].id,x.runs[1].id);
});

test('同一群不同成员交替发言共享会话但执行身份每轮重建',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 await x.send(message('2',{user:other,text:'我是另一个人'}));
 assert.equal(x.runs[0].id,x.runs[1].id);
 assert.equal(x.created.length,1);
 assert.equal(x.runs[0].c.actor,owner);
 assert.equal(x.runs[1].c.actor,other);
 assert.notEqual(x.runs[0].c.id,x.runs[1].c.id);
 assert.equal(x.permissions.valid(x.runs[0].c),'执行上下文已失效或到期');
});

test('@ 唤醒会复用同一会话，不额外新建',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 await x.send(message('2',{mentions:[bot],text:'@我 帮我看看'}));
 assert.equal(x.created.length,1);
 assert.equal(x.runs[0].id,x.runs[1].id);
 assert.equal(x.store.data.inbox.at(-1).wakeReason,'mentioned');
});

test('进程重启后沿用旧会话 id，交给 DSH 按 id 恢复',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 const before=Object.keys(x.store.data.sessions)[0];
 x.store.data.sessions[before].boot='previous-boot';
 x.store.data.sessions[before].lastActivity=new Date().toISOString();
 await x.send(message('2'));
 assert.equal(x.created.length,1);
 assert.equal(x.runs[1].id,x.runs[0].id);
 assert.notEqual(x.store.data.sessions[before].boot,'previous-boot');
});

test('空闲超过阈值会退役旧会话并重建',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 const k=Object.keys(x.store.data.sessions)[0];
 x.store.data.sessions[k].lastActivity=new Date(Date.now()-7*3600*1000).toISOString();
 await x.send(message('2'));
 assert.equal(x.created.length,2);
 assert.equal(x.retired.length,1);
 assert.notEqual(x.runs[1].id,x.runs[0].id);
});

test('框架代次变化保留上下文，人设变化才重建会话',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 x.store.data.framework.generation++;
 await x.send(message('2'));
 assert.equal(x.created.length,1,'权限代次变化只撤销旧任务，不应丢弃会话');
 assert.equal(x.retired.length,0);
 assert.equal(x.runs[1].id,x.runs[0].id);
 x.store.data.personas[0].version++;
 await x.send(message('3'));
 assert.equal(x.created.length,2);
 assert.equal(x.retired.length,1);
});

test('会话在 DSH 侧丢失时本轮自动重建一次并正常回复',async t=>{
 let first=true;
 const x=await setup(t,({runs})=>{
  if(first){first=false;throw Object.assign(new Error('session/not-found: session "sess-1" does not exist'),{code:'session/not-found'});}
  return '重建后正常回复';
 });
 await x.send(message('1'));
 assert.equal(x.created.length,2);
 assert.equal(x.retired.length,1);
 assert.equal(x.runs.length,2);
 assert.match(x.store.data.inbox.at(-1).reply,/重建后正常回复/);
});

test('非会话类错误不会触发重建，仍然按失败上报',async t=>{
 const x=await setup(t,()=>{throw new Error('模型没有返回文字回复');});
 await x.send(message('1'));
 assert.equal(x.created.length,1);
 assert.equal(x.retired.length,0);
 assert.equal(x.store.data.inbox.at(-1).status,'failed');
});

test('同一群并发到达的消息串行执行且落在同一会话',async t=>{
 const x=await setup(t);
 await Promise.all([x.router.receive(message('1')),x.router.receive(message('2'))]);
 await Promise.all([...x.router.queues.values()]);
 assert.equal(x.runs.length,2);
 assert.equal(new Set(x.runs.map(r=>r.id)).size,1);
 assert.equal(x.created.length,1);
});

test('新建上下文会清除该聊天的会话映射并退役旧会话',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 await x.router.resetChat(key);
 assert.equal(Object.keys(x.store.data.sessions).length,0);
 assert.equal(x.retired.length,1);
 await x.send(message('2'));
 assert.equal(x.created.length,2);
});
