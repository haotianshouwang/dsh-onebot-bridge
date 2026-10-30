import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {Builtins} from '../src/builtins/index.js';import {Extensions} from '../src/extensions/index.js';import {Router} from '../src/session/router.js';
const bot='10000002',owner='10000001',group='88888',key=bot+':group:'+group;
const message=(id,extra={})=>({type:'message',bot,user:owner,kind:'group',peer:group,key,id,time:Date.now()/1000,text:'这句话不该出现在日志里',mentions:[],parts:[],...extra});

async function setup(t){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-trace-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 Object.assign(store.data.settings,{intentRecognition:false,groupReplyMode:'all',groupEnabled:true,allowedGroups:[group],groupAudience:'all',allowedUsers:[owner],mergeWindowMs:0,sendInterval:0});
 Object.assign(store.data.framework,{ownerQQ:owner,listenGroups:[group],listenPrivate:true,listenAllPrivate:true,enabledActions:['core.status']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,()=>{},actions);
 const created=[];
 const native={create:async m=>{const s={sessionId:'sess-'+(created.length+1),chatKey:m.key,generation:store.data.framework.generation,safePreset:'qq-framework-restricted-v3'};created.push(s);return s;},reset:async()=>{},run:async()=>'好',stop:async()=>{},revoke:async()=>{}};
 const router=new Router(store,native,extensions,(level,msg,detail)=>store.log(level,msg,detail),{permissions,events,actions,builtins});
 router.attach({status:{bot,online:true},request:async()=>({outcome:'confirmed',data:{message_id:1}})});
 t.after(()=>media.stop());
 return {store,router,send:async m=>{await router.receive(m);await Promise.all([...router.queues.values()]);}};
}

const traces=store=>store.data.logs.filter(l=>l.message==='QQ 会话轨迹').map(l=>l.detail||{});

test('同一条消息的会话轨迹共享 job 标识',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 const events=traces(x.store);
 assert.ok(events.length>=3,'应记录收到、命中/新建、交给 Agent');
 const jobs=new Set(events.map(e=>e.job));
 assert.equal(jobs.size,1,'同一条消息的所有轨迹必须共享同一个 job 标识');
 assert.deepEqual(events.map(e=>e.event).filter(e=>['新建会话','交给 Agent','命中会话'].includes(e)),['新建会话','交给 Agent']);
});

test('第二轮命中已有会话，轨迹里 sessionId 保持一致',async t=>{
 const x=await setup(t);
 await x.send(message('1'));
 await x.send(message('2'));
 const events=traces(x.store).filter(e=>e.sessionId);
 const ids=new Set(events.map(e=>e.sessionId));
 assert.equal(ids.size,1,'同一群两轮应只有同一个 sessionId');
 assert.ok(events.some(e=>e.event==='命中会话'),'第二轮应记录命中会话');
 assert.ok(events.some(e=>e.event==='新建会话'),'第一轮应记录新建会话');
});

test('会话轨迹不包含消息正文或昵称',async t=>{
 const x=await setup(t);
 await x.send(message('1',{text:'机密正文 ABC-123'}));
 const dump=JSON.stringify(traces(x.store));
 assert.ok(!dump.includes('机密正文'),'不得写入消息正文');
 assert.ok(!dump.includes('ABC-123'),'不得写入消息正文');
});

test('会话失效重建会留下独立轨迹',async t=>{
 const x=await setup(t);
 let first=true;
 x.router.native.run=async()=>{if(first){first=false;throw Object.assign(new Error('session/not-found'),{code:'session/not-found'});}return '好';};
 await x.send(message('1'));
 const events=traces(x.store).map(e=>e.event);
 assert.ok(events.includes('会话丢失重建'),'应记录丢失后的重建');
 assert.ok(events.includes('重建后交给 Agent'),'应记录重建后使用的会话');
});
