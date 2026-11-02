import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/host/store.js';
import {Permissions,invalidate} from '../src/core/permissions.js';
import {Events} from '../src/core/events.js';
import {Media} from '../src/core/media.js';
import {Actions} from '../src/core/actions.js';
import {Builtins} from '../src/builtins/index.js';
import {Router} from '../src/session/router.js';
import {Extensions} from '../src/extensions/index.js';
import {Market} from '../src/market/index.js';
import {PluginSDK} from '../src/sdk.js';
import {activateGroupMembers} from '../src/builtins/group-members/index.js';
import {satisfies,packagesFor,migrateConfig,validateConfig,validatePackageMetadata} from '../src/core/package-model.js';
import {OneBot} from '../src/onebot/index.js';
process.env.QQBOT_OWNER='10000001';process.env.QQBOT_ALLOWED_USERS='10000001';
const log=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const msg=(extra={})=>({type:'message',id:'1',bot:'10000002',user:'10000001',peer:'10000001',kind:'private',key:'10000002:private:10000001',text:'你好',parts:[],mentions:[],time:Date.now()/1000,...extra});
const notice=(extra={})=>({type:'notice',id:'',bot:'10000002',user:'123456',operator:'10000001',peer:'88888',kind:'group',key:'10000002:group:88888',name:'group_increase',subtype:'approve',time:Math.floor(Date.now()/1000),...extra});
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-phase2-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();store.data.settings.mergeWindowMs=0;store.data.framework.listenGroups=['88888','77777'];
 const permissions=new Permissions(store),events=new Events(store,log),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,log,actions),sent=[],queries=[];
 const bot={status:{bot:'10000002',nickname:'机器人',online:true,version:{app_name:'NapCat'}},request:async(action,params)=>{sent.push({action,params});return {outcome:'confirmed',data:{message_id:100+sent.length}};},call:async(action,params)=>{queries.push({action,params});return {};}};
 const native={revoke:async()=>{},stop:async()=>{},reset:async()=>{}},router=new Router(store,native,extensions,log,{permissions,actions,events,builtins});router.attach(bot);
 const sdk=new PluginSDK({store,permissions,actions,events,media,log,onChange:async reason=>{if(reason?.reason==='quarantine')store.data.revision++;else invalidate(store);},automaticReply:(r,text)=>router.automaticReply(r,text)});
 t.after(()=>sdk.stop());return {store,permissions,events,media,actions,builtins,extensions,bot,sent,queries,router,sdk};
}
const manifest=(id='qq-life',version='1.0.0',extra={})=>({id,name:id,version,hostApiVersion:2,runtime:'declarative',entry:'rules.json',capabilities:['commands'],configSchema:{text:{type:'string',default:'旧回复'}},...extra});
const parsed=m=>({manifest:m,files:{'manifest.json':Buffer.from(JSON.stringify(m)),'rules.json':Buffer.from(JSON.stringify({rules:[{type:'command',match:'/生命周期',reply:m.configVersion===2?'{{config.reply}}':'{{config.text}}'}]}))}});
const nativeManifest=(id,extra={})=>({id,name:id,version:'1.0.0',capabilities:['events','storage','actions'],...extra});
const enable=(x,pack)=>{const p=x.store.data.framework.nativePackages[pack.id];p.enabled=true;p.scope.groups=['88888'];return p;};
test('version ranges include zero-major rules and reject invalid syntax',()=>{
 assert.equal(satisfies('0.3.2','^0.3.0'),true);assert.equal(satisfies('0.4.0','^0.3.0'),false);
 assert.equal(satisfies('0.0.2','^0.0.1'),false);assert.equal(satisfies('1.9.0','^1.2.0'),true);assert.equal(satisfies('1.3.0','~1.2.0'),false);
 assert.equal(satisfies('0.3.0','>=0.3.0'),true);assert.equal(satisfies('0.3.0','|| anything'),false);
});
test('dependencies enforce enabled state, transitive requirements, cycles and protected disable',async t=>{
 const x=await setup(t),p=packagesFor(x.store),a=manifest('qq-a','1.0.0',{dependencies:{'qq-b':'^1.0.0'}}),b=manifest('qq-b','1.0.0',{dependencies:{'qq-c':'^1.0.0'}}),c=manifest('qq-c');
 x.store.data.extensions={'qq-a':{manifest:a,enabled:true},'qq-b':{manifest:b,enabled:true},'qq-c':{manifest:c,enabled:false}};
 assert.match(p.problems(a,{enabled:true}).join(),/qq-c/);assert.throws(()=>p.protect('qq-b'),/qq-a/);
 assert.throws(()=>p.protect('qq-b','2.0.0'),/qq-a/);assert.doesNotThrow(()=>p.protect('qq-b','1.2.0'));
 x.store.data.extensions['qq-c'].manifest.dependencies={'qq-a':'*'};assert.match(p.problems(a,{enabled:true}).join(),/循环/);
});
test('config migration is explicit, lossless and validates limits and settings page field ownership',()=>{
 const old={manifest:manifest(),config:{text:'用户内容'},configVersion:1},next=manifest('qq-life','2.0.0',{configVersion:2,configSchema:{reply:{type:'string',required:true}},configMigrations:[{to:2,rename:{text:'reply'}}]});
 assert.deepEqual(migrateConfig(old,next),{reply:'用户内容'});assert.throws(()=>migrateConfig(old,{...next,configMigrations:[]}),/缺少迁移/);
 assert.throws(()=>validatePackageMetadata({...next,settings:{title:'设置',sections:[{title:'非法',fields:['notOwned']}]}}),/未声明/);
 assert.throws(()=>validateConfig({configSchema:{n:{type:'number',min:1,max:5,integer:true}}},{n:''}),/数值/);
 assert.equal(validateConfig({configSchema:{n:{type:'number',min:-5,max:5}}},{n:-2}).n,-2);
});
test('upgrade preserves config, disables new version, and retains actual code/config for rollback',async t=>{
 const x=await setup(t),market=new Market(x.store,x.extensions,'',log),first=manifest();
 await market.commit(parsed(first),{source:'test',sha256:'first'});let item=x.store.data.extensions[first.id];item.config.text='定制内容';item.enabled=true;await x.extensions.load(first.id);
 const original=structuredClone(item),next=manifest('qq-life','2.0.0',{configVersion:2,configSchema:{reply:{type:'string',required:true}},configMigrations:[{to:2,rename:{text:'reply'}}]});
 await market.commit(parsed(next),{source:'test',sha256:'next'});item=x.store.data.extensions[first.id];assert.equal(item.enabled,false);assert.equal(item.config.reply,'定制内容');assert.equal(item.history[0].generation,original.generation);
 item.enabled=true;await x.extensions.load(first.id);assert.equal(await x.extensions.inbound(msg({text:'/生命周期'})),'定制内容');
 await market.rollback(first.id,original.generation);item=x.store.data.extensions[first.id];assert.equal(item.manifest.version,'1.0.0');assert.equal(item.enabled,false);assert.equal(item.config.text,'定制内容');
 item.enabled=true;await x.extensions.load(first.id);assert.equal(await x.extensions.inbound(msg({text:'/生命周期'})),'定制内容');
});
test('failed upgrade and corrupted rollback cannot destroy the active version',async t=>{
 const x=await setup(t),market=new Market(x.store,x.extensions,'',log),first=manifest();
 await market.commit(parsed(first),{source:'test',sha256:'first'});const item=x.store.data.extensions[first.id];item.enabled=true;await x.extensions.load(first.id);
 await assert.rejects(market.commit(parsed(manifest('qq-life','2.0.0',{configVersion:2})),{source:'test'}),/缺少迁移/);
 assert.equal(x.store.data.extensions[first.id].manifest.version,'1.0.0');assert.equal(await x.extensions.inbound(msg({text:'/生命周期'})),'旧回复');
 await market.commit(parsed(manifest('qq-life','1.1.0')),{source:'test'});
 const old=x.store.data.extensions[first.id].history[0];await writeFile(path.join(x.store.dir,'extensions',first.id,old.runtimeDir,'rules.json'),'{"rules":[]}');
 await assert.rejects(market.rollback(first.id,old.generation),/完整性/);assert.equal(x.store.data.extensions[first.id].manifest.version,'1.1.0');
});
test('same version cannot be replaced with different content and old generations are bounded',async t=>{
 const x=await setup(t),market=new Market(x.store,x.extensions,'',log);
 await market.commit(parsed(manifest()),{source:'test'});await assert.rejects(market.commit(parsed(manifest('qq-life','1.0.0',{description:'changed'})),{source:'test'}),/同一版本/);
 for(let i=1;i<=5;i++)await market.commit(parsed(manifest('qq-life','1.'+i+'.0')),{source:'test'});
 assert.equal(x.store.data.extensions['qq-life'].history.length,3);
});
test('only the faulty native plugin is quarantined and healthy listeners continue',async t=>{
 const x=await setup(t),bad=x.sdk.register(nativeManifest('qq-faulty')),good=x.sdk.register(nativeManifest('qq-good'));enable(x,bad);enable(x,good);let count=0;
 bad.on(['notice'],()=>{throw new Error('测试故障');});good.on(['notice'],()=>count++);
 const generation=x.store.data.framework.generation;
 for(let i=0;i<3;i++)await x.events.receive(notice({time:Math.floor(Date.now()/1000)+i}));
 assert.equal(count,3);assert.equal(x.store.data.framework.nativePackages[bad.id].health.quarantined,true);assert.equal(x.store.data.framework.nativePackages[bad.id].enabled,false);
 assert.equal(x.store.data.framework.nativePackages[good.id].enabled,true);assert.equal(x.store.data.framework.generation,generation);
});
test('timed out native callbacks cannot write later, and user input rejections are not plugin failures',async t=>{
 const x=await setup(t),pack=x.sdk.register(nativeManifest('qq-timeout',{eventTimeoutMs:500})),p=enable(x,pack);
 pack.on(['notice'],async()=>{await sleep(600);await pack.storage.set({late:true});});
 await x.events.receive(notice());await sleep(150);assert.deepEqual(pack.storage.get(),{});assert.equal(p.health.totalErrors,1);
 const input=x.sdk.register(nativeManifest('qq-input')),q=enable(x,input);input.on(['notice'],()=>input.reject('参数不正确'));
 for(let i=0;i<3;i++)await x.events.receive(notice({time:Math.floor(Date.now()/1000)+i}));
 assert.equal(q.health.totalErrors,undefined);assert.equal(q.enabled,true);
});
test('group-member pack is disabled initially and records only selected scope, without conversation content',async t=>{
 const x=await setup(t),pack=activateGroupMembers(x.sdk.facade()),p=x.store.data.framework.nativePackages[pack.id];
 assert.equal(p.enabled,false);await x.events.receive(notice());assert.deepEqual(pack.storage.get(),{});
 enable(x,pack);await x.events.receive(notice());await x.events.receive(notice());await x.events.receive(notice({peer:'77777',key:'10000002:group:77777',user:'99999'}));
 const records=pack.storage.get().records;assert.equal(records.length,1);assert.equal(records[0].u,'123456');assert.equal('text' in records[0],false);assert.equal(x.sent.length,0);
 const data=await x.sdk.pageData(pack.id,{});assert.equal(data.total,1);assert.equal(data.rows[0].operator,'10000001');
 p.config.recordAdminChanges=true;await x.events.receive(notice({name:'group_admin',subtype:'set'}));assert.equal(pack.storage.get().records.length,2);
});
test('member query action is owner-only and underlying package enable does not enable AI use',async t=>{
 const x=await setup(t),pack=activateGroupMembers(x.sdk.facade());enable(x,pack);await x.events.receive(notice());const id='plugin.qq-group-members.recent',c=x.permissions.issue(msg());
 await assert.rejects(x.actions.invoke(id,{groupId:'88888',count:10},c),/尚未启用/);x.store.data.framework.enabledActions.push(id);
 assert.equal((await x.actions.invoke(id,{groupId:'88888',count:10},c)).records.length,1);
 await assert.rejects(x.actions.invoke(id,{groupId:'77777',count:10},c),/范围/);
 x.store.data.framework.listenUsers.push('123456');const other=x.permissions.issue(msg({user:'123456',peer:'123456',key:'10000002:private:123456'}));
 await assert.rejects(x.actions.invoke(id,{groupId:'88888',count:10},other),/仅主人/);
});
test('welcome requires separate event automation permission, deduplicates and never uses owner identity',async t=>{
 const x=await setup(t),pack=activateGroupMembers(x.sdk.facade()),p=enable(x,pack);p.config.welcomeEnabled=true;
 await x.events.receive(notice());assert.equal(x.sent.length,0);
 const duplicate=notice({user:'10000001',time:Math.floor(Date.now()/1000)+1});p.automationGrants=['welcome'];await x.events.receive(duplicate);
 assert.equal(x.sent.length,1);assert.equal(x.sent[0].params.group_id,88888);assert.match(x.sent[0].params.message[0].data.text,/10000001/);
 await x.events.receive(duplicate);assert.equal(x.sent.length,1);
 assert.equal(x.store.data.framework.automaticOutbox[0].authority,'configured-event-rule');assert.equal(x.store.data.framework.automaticOutbox[0].status,'submitted');
});
test('queued automatic reply is cancelled when the package is disabled before dispatch',async t=>{
 const x=await setup(t),pack=activateGroupMembers(x.sdk.facade()),p=enable(x,pack);p.config.welcomeEnabled=true;p.automationGrants=['welcome'];
 let release;x.router.sendTail=new Promise(r=>{release=r;});const incoming=x.events.receive(notice());
 while(!x.store.data.framework.automaticOutbox?.length)await sleep(1);p.enabled=false;release();await incoming;
 assert.equal(x.sent.length,0);assert.equal(x.store.data.framework.automaticOutbox[0].status,'cancelled');
});
test('record retention removes expired records and data outside current authorized groups',async t=>{
 const x=await setup(t),pack=activateGroupMembers(x.sdk.facade()),p=enable(x,pack);
 await pack.storage.set({schema:1,records:[{t:Date.now()-8*86400000,g:'88888'},{t:Date.now(),g:'77777'},{t:Date.now(),g:'88888'}]});p.enabled=false;
 await x.sdk.pruneStorage();assert.equal(pack.storage.get().records.length,1);x.store.data.framework.listenGroups=[];await x.sdk.pruneStorage();assert.equal(pack.storage.get().records.length,0);
});
test('forward messages bind every node to the bot and reject impersonation and unknown segments',async t=>{
 const x=await setup(t),c=x.permissions.issue(msg());x.store.data.framework.enabledActions.push('qq.forward.send');
 await x.actions.invoke('qq.forward.send',{nodes:[{segments:[{type:'text',data:{text:'测试转发'}}]}]},c);
 assert.equal(x.sent[0].action,'send_private_forward_msg');assert.equal(x.sent[0].params.messages[0].data.user_id,c.bot);assert.equal(x.sent[0].params.user_id,c.peer);
 await assert.rejects(x.actions.invoke('qq.forward.send',{nodes:[{user_id:'10000001',segments:[]}]},c),/发送者/);
 await assert.rejects(x.actions.invoke('qq.forward.send',{nodes:[{segments:[{type:'json',data:{data:'{}'}}]}]},c),/消息段/);
});
test('group file browsing only traverses observed folders in the selected authorized group',async t=>{
 const x=await setup(t),c=x.permissions.issue(msg());x.store.data.framework.enabledActions.push('qq.files.list');
 x.bot.call=async(action,params)=>{x.queries.push({action,params});return {files:[{file_id:'f1',file_name:'测试.txt',file_size:4,url:'must-not-expose'}],folders:[{folder_id:'folder1',folder_name:'目录'}]};};
 await assert.rejects(x.actions.invoke('qq.files.list',{groupId:'88888',folderId:'guessed',count:20},c),/不是当前群/);
 const data=await x.actions.invoke('qq.files.list',{groupId:'88888',folderId:'',count:20},c);assert.equal(data.files[0].name,'测试.txt');assert.equal('url' in data.files[0],false);
 await x.actions.invoke('qq.files.list',{groupId:'88888',folderId:'folder1',count:20},c);assert.equal(x.queries[1].params.folder_id,'folder1');
 await assert.rejects(x.actions.invoke('qq.files.list',{groupId:'99999',folderId:'',count:20},c),/范围/);
});
test('poke is bound to caller and enforces cooldown without allowing arbitrary targets',async t=>{
 const x=await setup(t),c=x.permissions.issue(msg());x.store.data.framework.enabledActions.push('qq.poke');
 await x.actions.invoke('qq.poke',{},c);assert.deepEqual(x.sent[0],{action:'friend_poke',params:{user_id:c.peer}});
 await assert.rejects(x.actions.invoke('qq.poke',{},c),/冷却/);await assert.rejects(x.actions.invoke('qq.poke',{user_id:'99999'},c),/参数/);assert.equal(x.sent.length,1);
});
test('announcement and essence reads are scoped and strip raw resources and request details',async t=>{
 const x=await setup(t),c=x.permissions.issue(msg());x.store.data.framework.enabledActions.push('qq.announcements.list','qq.essence.list');
 x.bot.call=async action=>action==='_get_group_notice'?[{notice_id:'n',sender_id:1,message:{text:'公告',image:[{url:'secret'}]},settings:{token:'secret'}}]:[{message_id:1,sender_id:123456,content:[{type:'text',data:{text:'精华'}},{type:'image',data:{file:'C:/secret'}}]}];
 const a=await x.actions.invoke('qq.announcements.list',{groupId:'88888',count:10},c),b=await x.actions.invoke('qq.essence.list',{groupId:'88888',count:10},c);
 assert.equal(a.items[0].text,'公告');assert.equal(b.items[0].content[0].text,'精华');assert.equal(JSON.stringify([a,b]).includes('secret'),false);
 await assert.rejects(x.actions.invoke('qq.announcements.list',{groupId:'99999',count:10},c),/范围/);
});
test('oversized outgoing protocol requests are rejected before transmission or creating a pending echo',async()=>{
 const bot=new OneBot({},'');bot.closed=false;let sent=false;bot.ws={readyState:1,send:()=>{sent=true;}};
 await assert.rejects(bot.request('send_private_msg',{text:'x'.repeat(13*1024*1024)}),e=>e.code==='PAYLOAD_LIMIT');assert.equal(sent,false);assert.equal(bot.pending.size,0);
});

test('invalid plugin settings data contributes to only that package fault isolation',async t=>{
 const x=await setup(t),api=x.sdk.register(nativeManifest('qq-bad-page',{settings:{title:'错误页'}})),p=enable(x,api);
 api.settings({title:'错误页'},()=>({rows:'invalid'}));const generation=x.store.data.framework.generation;
 for(let i=0;i<3;i++)await assert.rejects(x.sdk.pageData(api.id),/数据格式/);
 assert.equal(p.health.quarantined,true);assert.equal(p.enabled,false);assert.equal(x.store.data.framework.generation,generation);
});
test('rollback housekeeping failure restores active version durably',async t=>{
 const x=await setup(t),market=new Market(x.store,x.extensions,'',log);
 await market.commit(parsed(manifest()),{source:'test'});
 await market.commit(parsed(manifest('qq-life','1.1.0')),{source:'test'});
 const item=x.store.data.extensions['qq-life'];item.enabled=true;await x.extensions.load('qq-life');await x.store.persist();
 market.prune=async()=>{throw new Error('模拟版本清理失败');};
 await assert.rejects(market.rollback('qq-life',item.history[0].generation),/清理失败/);
 assert.equal(x.store.data.extensions['qq-life'].manifest.version,'1.1.0');
 assert.equal(await x.extensions.inbound(msg({text:'/生命周期'})),'旧回复');
 const saved=JSON.parse(await readFile(path.join(x.store.dir,'state.json'),'utf8'));assert.equal(saved.extensions['qq-life'].manifest.version,'1.1.0');assert.equal(saved.extensions['qq-life'].enabled,true);
});

test("owner QQ command cannot bypass enabled package dependency protection",async t=>{
 const x=await setup(t);x.store.data.extensions["qq-dependent"]={manifest:manifest("qq-dependent","1.0.0",{dependencies:{persona:"*"}}),enabled:true};
 await assert.rejects(x.router.control(msg({text:"关闭人设"})),/请先停用/);assert.equal(x.store.data.framework.builtins.persona.enabled,true);
});

test('untrusted UI metadata and migration collections must have explicit primitive types',()=>{
 const m=manifest();for(const bad of [{name:{}},{description:{}},{configSchema:{text:{type:'string',title:{}}}},{settings:{title:'设置',sections:[{title:{},fields:[]}]}},{configVersion:2,configMigrations:[{to:2,remove:'text'}]}])assert.throws(()=>validatePackageMetadata({...m,...bad}),/无效|未声明/);
});
test('malformed provider columns are rejected before reaching the settings renderer',async t=>{
 const x=await setup(t),api=x.sdk.register(nativeManifest('qq-column-test',{settings:{title:'测试'}})),p=enable(x,api);
 api.settings({title:'测试'},()=>({columns:[{key:'a',label:{invalid:true}}],rows:[]}));
 await assert.rejects(x.sdk.pageData(api.id),/数据格式/);assert.equal(p.health.totalErrors,1);
});
