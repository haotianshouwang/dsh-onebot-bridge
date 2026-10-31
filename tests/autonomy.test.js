import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {PluginSDK} from '../src/sdk.js';
import {activateAutonomy,manifest,clockText,dayKey,parseHours,withinHours,AutonomyStore} from '../src/builtins/autonomy/index.js';
import {migrateConfig} from '../src/core/package-model.js';

const bot='10000002',owner='10000001',other='12345678',group='88888',key=bot+':group:'+group;
const msg=(extra={})=>({bot,user:owner,kind:'group',peer:group,key,id:'m1',...extra});

async function setup(t,{at}={}){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-autonomy-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(path.join(dir,'state')).open();
 Object.assign(store.data.framework,{listenGroups:[group],listenPrivate:true,enabledActions:['plugin.qq-autonomy.diary-write','plugin.qq-autonomy.diary-read','plugin.qq-autonomy.run']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 actions.attach({status:{bot,online:true},request:async()=>({outcome:'confirmed',data:{}})});
 const sdk=new PluginSDK({store,permissions,events,media,actions});
 let clock={now:at??Date.now()};
 const calls=[];
 const native={autonomy:async plan=>{calls.push(plan);const tools=(plan.allow||[]).map(capability=>({capability,ok:true,outcome:capability==='plugin.qq-qzone.publish'?'confirmed':null,summary:{id:'tool-1',resultCount:1,textChars:10,itemCount:1,scope:capability==='plugin.qq-memory.remember'?'group':undefined}}));return {text:'做完了，今天有点累。',tools};}};
 const auto=await activateAutonomy(sdk.facade(),{dir:path.join(dir,'auto'),native,persona:()=>'你是测试人设。',online:()=>true,now:()=>clock.now});
 const item=store.data.framework.nativePackages['qq-autonomy'];
 item.enabled=true;item.scope={private:true,allUsers:false,users:[owner],groups:[group]};
 item.config={...auto.api.getConfig(),enabled:true,activeHours:'00:00-23:59',diaryEnabled:true,diaryHour:0,learnEnabled:false,slangEnabled:false,qzonePostEnabled:false,browseEnabled:false,maxRunsPerDay:8};
 t.after(()=>sdk.stop());
 return {dir,store,sdk,actions,item,auto,calls,native,setNow:value=>{clock.now=value;},context:(extra={})=>permissions.issue(msg(extra),'chat')};
}

test('时间工具：解析时段、跨午夜和星期文本',()=>{
 assert.deepEqual(parseHours('09:00-23:30'),[540,1410]);
 assert.deepEqual(parseHours('坏格式'),[540,1410]);
 const morning=new Date(2026,9,31,8,0).getTime();
 const evening=new Date(2026,9,31,21,0).getTime();
 assert.equal(withinHours('09:00-23:30',morning),false);
 assert.equal(withinHours('09:00-23:30',evening),true);
 assert.equal(withinHours('22:00-02:00',new Date(2026,9,31,23,0).getTime()),true);
 assert.equal(withinHours('22:00-02:00',new Date(2026,9,31,12,0).getTime()),false);
 assert.match(clockText(new Date(2026,9,31,21,5).getTime()),/2026-10-31 21:05 星期六 晚上/);
 assert.equal(dayKey(new Date(2026,9,31,0,1).getTime()),'2026-10-31');
});

test('默认停用：不跑活动、不注入时间',async t=>{
 const x=await setup(t,{at:new Date(2026,9,31,22,30).getTime()});
 x.item.config.enabled=false;
 assert.deepEqual(await x.auto.tick(),{ok:false,skipped:'not-due'});
 assert.equal(x.calls.length,0);
 assert.equal(await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'几点了'}),'');
});

test('停用原生包后调度器和时间上下文立即停止',async t=>{
 const x=await setup(t,{at:new Date(2026,9,31,22,30).getTime()});
 x.item.enabled=false;
 assert.deepEqual(await x.auto.tick(),{ok:false,skipped:'disabled'});
 assert.equal(x.calls.length,0);
 assert.equal(await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'几点了'}),'');
});

test('到点写日记：走受限白名单、记录结果并注入时间',async t=>{
 const at=new Date(2026,9,31,22,30).getTime();
 const x=await setup(t,{at});
 const result=await x.auto.tick();
 assert.equal(result.ok,true);
 assert.equal(result.type,'diary');
 assert.equal(x.calls.length,1);
 assert.deepEqual(x.calls[0].allow,['plugin.qq-autonomy.diary-write']);
 assert.match(x.calls[0].system,/日记/);
 assert.match(x.calls[0].system,/2026-10-31 22:30/);
 assert.equal(x.auto.store.count('diary',at),1);
 assert.equal(x.auto.store.state.log[0].ok,true);
 const time=await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'几点了'});
 assert.match(time,/^\[现在\] 2026-10-31 22:30/);
 const page=await x.sdk.pageData('qq-autonomy',{});
 assert.equal(page.rows[0].type,'写日记');
});

test('自主活动没有工具审计时不能记为成功',async t=>{
 const at=new Date(2026,9,31,22,30).getTime();
 const x=await setup(t,{at});
 x.native.autonomy=async()=>({text:'我写完了。',tools:[]});
 const result=await x.auto.tick(at,{force:'diary'});
 assert.equal(result.ok,false);
 assert.match(result.error,/工具调用审计/);
 assert.equal(x.auto.store.count('diary',at),0);
 assert.equal(x.auto.store.state.log[0].ok,false);
 assert.equal(x.auto.store.state.log[0].verified,false);
});

test('自主学习必须有搜索、正文、来源和记忆写入',async t=>{
 const at=new Date(2026,9,31,22,30).getTime();
 const x=await setup(t,{at});
 x.item.config.diaryEnabled=false;x.item.config.slangEnabled=false;x.item.config.learnEnabled=true;
 x.native.autonomy=async()=>({text:'学到了一点。',tools:[
  {capability:'plugin.qq-web.search',ok:true,outcome:null,summary:{resultCount:2}},
  {capability:'plugin.qq-web.read',ok:true,outcome:null,summary:{textChars:120,url:'https://example.com/a'}},
  {capability:'plugin.qq-memory.remember',ok:true,outcome:null,summary:{id:'mem-1',sourceUrl:'https://example.com/a'}}
 ]});
 assert.equal((await x.auto.tick(at,{force:'learn'})).ok,true);
 const missingSource=await setup(t,{at});
 missingSource.item.config.diaryEnabled=false;missingSource.item.config.slangEnabled=false;missingSource.item.config.learnEnabled=true;
 missingSource.native.autonomy=async()=>({text:'学到了。',tools:[
  {capability:'plugin.qq-web.search',ok:true,summary:{resultCount:1}},
  {capability:'plugin.qq-web.read',ok:true,summary:{textChars:50,url:'https://example.com/a'}},
  {capability:'plugin.qq-memory.remember',ok:true,summary:{id:'mem-1'}}
 ]});
 const failed=await missingSource.auto.tick(at,{force:'learn'});
 assert.equal(failed.ok,false);
 assert.match(failed.error,/来源网址/);
});

test('学黑话使用当前群上下文，群记忆才能写入',async t=>{
 const at=new Date(2026,9,31,22,30).getTime();
 const x=await setup(t,{at});
 x.item.config.learnEnabled=false;x.item.config.slangEnabled=true;x.item.config.diaryEnabled=false;
 x.auto.buffer.set(group,Array.from({length:6},(_,i)=>({at:at-60000+i,user:other,text:'群里的新说法'+i})));
 const result=await x.auto.tick(at,{force:'slang'});
 assert.equal(result.ok,true);
 assert.equal(x.calls.at(-1).group,group);
 assert.equal(x.calls.at(-1).audit,true);
});

test('不限制业务次数时仍受每分钟调度和活动开关约束',async t=>{
 const at=new Date(2026,9,31,22,30).getTime();
 const x=await setup(t,{at});
 x.item.config.maxRunsPerDay=1;
 x.item.config.runLimitMode='unlimited';
 x.item.config.diaryEnabled=true;
 x.item.config.slangEnabled=false;x.item.config.learnEnabled=false;x.item.config.qzonePostEnabled=false;x.item.config.browseEnabled=false;
 assert.equal((await x.auto.tick(at,{force:'diary'})).ok,true);
 assert.equal((await x.auto.tick(at+60000,{force:'diary'})).ok,true,'不限制模式不应被旧的每日上限拦截');
 assert.equal(x.calls.length,2);
 x.item.config.runLimitMode='custom';x.item.config.maxRunsPerDay=1;
 const limited=await x.auto.tick(at+120000,{force:'diary'});
 assert.deepEqual(limited,{ok:false,skipped:'daily-limit'});
});

test('每天次数上限与活动开关：不会无限跑，强制运行也守开关',async t=>{
 const at=new Date(2026,9,31,22,30).getTime();
 const x=await setup(t,{at});
 x.item.config.runLimitMode='custom';x.item.config.maxRunsPerDay=1;
 assert.equal((await x.auto.tick()).ok,true);
 assert.deepEqual(await x.auto.tick(),{ok:false,skipped:'not-due'});
 const qzone=await x.auto.tick(at,{force:'qzone'});
 assert.deepEqual(qzone,{ok:false,skipped:'activity-disabled'});
 const browse=await x.auto.tick(at,{force:'browse'});
 assert.deepEqual(browse,{ok:false,skipped:'activity-disabled'});
 assert.equal(x.calls.length,1);
});

test('黑话学习只把群聊缓冲交给模型，并要求写进本群记忆',async t=>{
 const at=new Date(2026,9,31,14,0).getTime();
 const x=await setup(t,{at});
 x.item.config.diaryEnabled=false;x.item.config.slangEnabled=true;x.item.config.slangEveryHours=1;
 x.auto.buffer.set(group,[
  {at:at-3600000,user:'20001',text:'这波直接封神'},
  {at:at-3000000,user:'20002',text:'笑死，什么赛博菩萨'},
  {at:at-1800000,user:'20001',text:'主播太有活了'},
  {at:at-1200000,user:'20003',text:'典中典'},
  {at:at-600000,user:'20002',text:'我先润了'}
 ]);
 const result=await x.auto.tick(at,{force:'slang'});
 assert.equal(result.ok,true);
 assert.equal(x.calls[0].title,'QQ 学群里的黑话');
 assert.match(x.calls[0].system,/赛博菩萨/);
 assert.deepEqual(x.calls[0].allow,['plugin.qq-memory.remember']);
 assert.match(x.calls[0].system,/scope 选 group/);
});

test('翻空间只使用配置的目标，发空间和评论能被单独打开',async t=>{
 const at=new Date(2026,9,31,10,0).getTime();
 const x=await setup(t,{at});
 x.item.config.diaryEnabled=false;x.item.config.learnEnabled=false;x.item.config.slangEnabled=false;
 x.item.config.browseEnabled=true;x.item.config.browseTargets=[other];x.item.config.browseEveryHours=1;
 const plan=await x.auto.tick(at,{force:'browse'});
 assert.equal(plan.ok,true);
 assert.match(x.calls[0].system,new RegExp('QQ '+other));
 assert.deepEqual(x.calls[0].allow,['plugin.qq-qzone.list','plugin.qq-qzone.comment']);
 x.item.config.browseEnabled=false;x.item.config.qzonePostEnabled=true;x.auto.store.state.counts={};
 const post=await x.auto.tick(at,{force:'qzone'});
 assert.equal(post.ok,true);
 assert.deepEqual(x.calls[1].allow,['plugin.qq-qzone.publish']);
});

test('日记写入与读取走插件动作并落盘',async t=>{
 const at=new Date(2026,9,31,20,0).getTime();
 const x=await setup(t,{at}),c=x.context();
 const written=await x.actions.invoke('plugin.qq-autonomy.diary-write',{text:'今天学到一个新词：赛博菩萨。',mood:'好奇'},c);
 assert.equal(written.ok,true);
 const read=await x.actions.invoke('plugin.qq-autonomy.diary-read',{count:3},c);
 assert.equal(read.entries.length,1);
 assert.match(read.entries[0].text,/赛博菩萨/);
 assert.equal(read.entries[0].mood,'好奇');
 const reloaded=await new AutonomyStore(path.join(x.dir,'auto')).open();
 assert.equal((await reloaded.readDiary(5))[0].mood,'好奇');
});

test('历史保留：按数量清理日记/活动，默认不删除',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-retain-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new AutonomyStore(path.join(dir,'auto'));
 await store.open();
 const base=Date.now();
 for(let i=0;i<4;i+=1)await store.writeDiary({text:'日记'+i,now:base+i*1000});
 for(let i=0;i<4;i+=1)await store.addActivity({title:'活动'+i,start:base+i*1000,end:base+i*1000+1000});
 assert.equal(await store.pruneDiary({mode:'none',count:2,days:1}),0);
 assert.equal(await store.pruneActivities({mode:'none',count:2,days:1}),0);
 assert.equal((await store.readDiaryEntries()).length,4);
 assert.equal((await store.readActivities()).length,4);
 assert.equal(await store.pruneDiary({mode:'count',count:2,now:base+5000}),2);
 assert.equal(await store.pruneActivities({mode:'count',count:2,now:base+5000}),2);
 assert.equal((await store.readDiaryEntries()).length,2);
 assert.equal((await store.readActivities()).length,2);
});

test('manifest 默认值：自主时间关闭，空间与评论默认关闭',()=>{
 const config=migrateConfig(undefined,manifest);
 assert.equal(config.enabled,false);
 assert.equal(config.qzonePostEnabled,false);
 assert.equal(config.browseEnabled,false);
 assert.equal(config.commentEnabled,false);
 assert.equal(config.diaryEnabled,true);
 assert.deepEqual(config.browseTargets,[]);
});
