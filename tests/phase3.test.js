import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store,validateSettings} from '../src/host/store.js';
import {Permissions,validatePolicy,invalidate} from '../src/core/permissions.js';
import {Events} from '../src/core/events.js';
import {Actions} from '../src/core/actions.js';
import {Media} from '../src/core/media.js';
import {Builtins} from '../src/builtins/index.js';
import {Extensions} from '../src/extensions/index.js';
import {Router,controlCommand} from '../src/session/router.js';
import {splitReply} from '../src/session/split.js';
import {accessReason} from '../src/onebot/index.js';
import {NativeDSH} from '../src/session/native.js';
import {PluginSDK} from '../src/sdk.js';
process.env.QQBOT_OWNER='10000001';process.env.QQBOT_ALLOWED_USERS='10000001';
const owner='10000001',other='12345678',botId='10000002',group='88888',log=()=>{};
const message=(extra={})=>({type:'message',bot:botId,user:owner,kind:'group',peer:group,key:botId+':group:'+group,id:'1',time:Date.now()/1000,text:'查一下这个群的资料',mentions:[botId],parts:[],...extra});
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-phase3-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();store.data.settings.mergeWindowMs=0;Object.assign(store.data.settings,{intentRecognition:false,groupEnabled:true,allowedGroups:[group],privateAudience:'all',groupAudience:'all',sendInterval:0});Object.assign(store.data.framework,{listenPrivate:true,listenAllPrivate:true,listenGroups:[group]});
 const permissions=new Permissions(store),events=new Events(store,log),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,log,actions),sent=[],queries=[],runs=[];
 const bot={status:{bot:botId,online:true,state:'connected',version:{app_name:'NapCat'}},request:async(action,params)=>{sent.push({action,params});return {outcome:'confirmed',data:{message_id:sent.length}};},call:async(action,params)=>{queries.push({action,params});return {group_id:Number(group),group_name:'测试群',member_count:5};}};
 const native={create:async msg=>({sessionId:'s-'+msg.user,chatKey:msg.key,generation:store.data.framework.generation}),reset:async()=>{},revoke:async()=>{},stop:async()=>{},run:async(_id,job,_prompt,c)=>{runs.push({job,c,visible:actions.catalog().filter(x=>!permissions.decision(actions.definitions.get(x.id),c)).map(x=>x.id)});return '测试回复';}};
 const router=new Router(store,native,extensions,log,{permissions,events,media,actions,builtins});router.attach(bot);t.after(()=>media.stop());
 return {store,permissions,events,media,actions,builtins,extensions,bot,sent,queries,runs,native,router};
}
const shared=(capability,extra={})=>({id:'shared-'+capability,capability,allUsers:true,users:[],groups:[group],private:true,expires:'',perMinute:5,...extra});
test('owner tools work inside the current authorized group without private-chat restriction',async t=>{
 const x=await setup(t);x.store.data.framework.enabledActions.push('qq.group.info','qq.group.name');const c=x.permissions.issue(message(),'chat');
 assert.equal(x.permissions.decision(x.actions.definitions.get('qq.group.info'),c),null);
 const info=await x.actions.invoke('qq.group.info',{},c);assert.equal(info.group_name,'测试群');
 await x.actions.invoke('qq.group.name',{name:'新的群名'},c);assert.equal(x.sent[0].params.group_id,Number(group));
 assert.equal(x.sent[0].action,'set_group_name');
 await assert.rejects(x.actions.invoke('qq.group.name',{groupId:'77777',name:'越界'},c),/超出/);
 const stranger=x.permissions.issue(message({user:other}));await assert.rejects(x.actions.invoke('qq.group.name',{name:'越权'},stranger),/仅主人/);
});
test('all-user conversation settings do not grant tools and still require group trigger',async t=>{
 const x=await setup(t),msg=message({user:other});assert.equal(accessReason(x.store.data.settings,msg),null);
 assert.equal(accessReason(x.store.data.settings,{...msg,mentions:[]}),'not-mentioned');
 await x.router.receive(msg);await Promise.all([...x.router.queues.values()]);assert.equal(x.runs.length,1);assert.deepEqual(x.runs[0].visible,['core.status']);
 assert.equal(x.sent.length,1);assert.equal(await x.events.receive(message({kind:'private',peer:other,user:other,key:botId+':private:'+other,id:'2'})),true);
});
test('owner uses registered tools in ordinary conversation without a slash entry',async t=>{
 const x=await setup(t);x.store.data.framework.enabledActions.push('qq.group.info');
 await x.router.receive(message());await Promise.all([...x.router.queues.values()]);
 assert.ok(x.runs[0].visible.includes('qq.group.info'));assert.equal(x.runs[0].job.mode,'chat');
 assert.equal(controlCommand('/bot 帮助'),null);assert.equal(controlCommand('/任务 查状态'),null);
 assert.equal(controlCommand('请帮我查看机器人状态'),'状态');assert.equal(controlCommand('帮我关闭AI聊天'),'停用 ai-chat');
});
test('shared query grants are scoped, expire, respect denies, and cannot share mutating owner actions',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.enabledActions.push('qq.group.info','qq.group.name','qq.message.send');
 const publicRule=shared('qq.group.info');f.grants=validatePolicy({...f,grants:[publicRule]},x.actions.catalog()).grants;
 const c=x.permissions.issue(message({user:other}));assert.equal((await x.actions.invoke('qq.group.info',{},c)).member_count,5);
 await assert.rejects(x.actions.invoke('qq.message.send',{segments:[{type:'text',data:{text:'不允许'}}]},c),/尚未.*开放/);
 for(const cap of ['qq.group.name','qq.message.send'])assert.throws(()=>validatePolicy({...f,grants:[shared(cap)]},x.actions.catalog()),/仅主人|安全查询/);
 f.grants.push({...publicRule,id:'deny',users:[other],allUsers:false,deny:true});assert.match(x.permissions.decision(x.actions.definitions.get('qq.group.info'),c),/明确拒绝/);
 f.grants=[{...publicRule,expires:'2000-01-01'}];assert.match(x.permissions.decision(x.actions.definitions.get('qq.group.info'),c),/尚未.*开放/);
 assert.equal(x.sent.length,0);
});
test('public query quota is per user and never authorizes computer, credentials or raw actions',async t=>{
 const x=await setup(t),f=x.store.data.framework;f.grants=[shared('core.status',{perMinute:1})];
 const first=x.permissions.issue(message({user:other}));await x.actions.invoke('core.status',{},first);await assert.rejects(x.actions.invoke('core.status',{},first),/频繁/);
 const second=x.permissions.issue(message({user:'99999999'}));await x.actions.invoke('core.status',{},second);
 for(const cap of ['exec_command','run_code','mcp__fs','raw.action','qq.get_credentials'])await assert.rejects(x.actions.invoke(cap,{},second),/禁止|未知/);
 await assert.rejects(x.actions.invoke('core.status',{},{...second,actor:owner}),/无效/);
});
test('shared trusted plugin query requires both its audience scope and exact capability grant',async t=>{
 const x=await setup(t),sdk=new PluginSDK({...x,onChange:async()=>{}});t.after(()=>sdk.stop());
 const pack=sdk.register({id:'qq-weather-demo',name:'天气查询接口测试',version:'1.0.0',capabilities:['actions']});
 pack.action('lookup',{description:'查询天气',publicSafe:true,parameters:{type:'object',properties:{},additionalProperties:false}},async()=>({weather:'仅模拟返回'}));
 const p=x.store.data.framework.nativePackages[pack.id];p.enabled=true;p.scope={private:true,users:[owner],groups:[group]};
 const cap='plugin.qq-weather-demo.lookup';x.store.data.framework.enabledActions.push(cap);x.store.data.framework.grants=[shared(cap)];
 const c=x.permissions.issue(message({user:other}));assert.match(x.permissions.decision(x.actions.definitions.get(cap),c),/插件未对/);
 p.scope.allUsers=true;assert.equal((await x.actions.invoke(cap,{},c)).weather,'仅模拟返回');
 p.scope.groups=[];assert.match(x.permissions.decision(x.actions.definitions.get(cap),c),/插件未对/);
 assert.equal(x.sent.length,0);
});
test('turning ordinary chat off stops other users, while owner management remains in the core',async t=>{
 const x=await setup(t);x.builtins.configure('ai-chat',false);
 await x.router.receive(message({user:other}));await Promise.all([...x.router.queues.values()]);assert.equal(x.runs.length,0);assert.equal(x.sent.length,0);
 await x.router.receive(message({id:'2',text:'机器人状态'}));await Promise.all([...x.router.queues.values()]);assert.equal(x.sent.length,1);assert.match(x.sent[0].params.message.at(-1).data.text,/QQ 在线/);
 x.builtins.configure('welcome',false,{groups:[],text:'欢迎'});x.builtins.remove('welcome');assert.equal(x.builtins.enabled('welcome'),false);
});
test('paragraph splitting preserves lists, code fences, Unicode and the configured single-message fallback',()=>{
 const value='第一段😀\n\n第二段\n- 列表一\n- 列表二\n\n'+'~~~js\n\nconst a=1;\n~~~'.replaceAll('~~~','```');
 const pieces=splitReply(value,'paragraphs',200);assert.equal(pieces.length,3);assert.ok(pieces[1].includes('- 列表二'));assert.ok(pieces[2].includes('\n\nconst a=1;'));
 assert.deepEqual(splitReply('甲😀乙','length',2),['甲😀','乙']);assert.deepEqual(splitReply('甲\n\n乙','single',200),['甲\n\n乙']);
 for(const bad of ['unknown',0])assert.throws(()=>validateSettings({...{...xSettings()},replySplit:bad}),/分条/);
 function xSettings(){return {enabled:true,mode:'forward',url:'ws://127.0.0.1:3001',reverseHost:'127.0.0.1',reversePort:3002,reversePath:'/onebot/v11',allowedUsers:[owner],allowedGroups:[],workspacePath:'F:/test',turnTimeout:180,sendInterval:500,maxReplyChars:1500};}
});
test('permission changes between reply parts stop subsequent parts',async t=>{
 const x=await setup(t);x.store.data.settings.replySplit='paragraphs';const msg=message(),c=x.permissions.issue(msg);let count=0;
 x.bot.request=async()=>{count++;invalidate(x.store);return {outcome:'confirmed',data:{message_id:count}};};
 await assert.rejects(x.router.send(msg,'第一段\n\n第二段',{mode:'chat'},c),/撤销/);assert.equal(count,1);
});
test('plugin toggle revocation finishes promptly even when the model cancellation stalls',async()=>{
 const native=new NativeDSH({}, {data:{sessions:{},framework:{retiredSessions:[]}}},{},{});
 const controller=new AbortController();native.active.set('hang',{controller,agent:{cancel:()=>new Promise(()=>{})}});
 const start=Date.now();await native.revoke();assert.equal(controller.signal.aborted,true);assert.ok(Date.now()-start<2300);
});

test('gateway duplicate messages cannot repeatedly resample the random reply chance',async t=>{
 const x=await setup(t);Object.assign(x.store.data.settings,{groupReplyMode:'smart',groupReplyProbability:10});let draws=0;x.router.replyGate.random=()=>{draws++;return 0.99;};
 const m=message({user:other,mentions:[]});await x.router.receive(m);await x.router.receive(m);assert.equal(draws,1);assert.equal(x.runs.length,0);
});
