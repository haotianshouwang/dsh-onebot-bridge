import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {PluginSDK} from '../src/sdk.js';
import {MemoryStore,memoryHash,normalizeMemoryText,keywordScore,normalizeVector,cosine,scoreMemory} from '../src/builtins/memory/store.js';
import {embedTexts,embeddingEndpoint} from '../src/builtins/memory/embedding.js';
import {activateMemory,manifest} from '../src/builtins/memory/index.js';
import {migrateConfig} from '../src/core/package-model.js';

const bot='10000002',owner='10000001',other='12345678',group='88888',key=bot+':group:'+group;
const msg=(extra={})=>({bot,user:owner,kind:'group',peer:group,key,id:'m1',...extra});

// 可预测的假嵌入：同一关键词落在同一维，方便验证“语义去重/语义召回”而不联网。
const anchors={香菜:0,生日:1,猫:2,狗:3,开黑:4};
export function fakeEmbed(text){
 const vector=new Float32Array(16);
 for(const [word,index] of Object.entries(anchors))if(String(text).includes(word))vector[index]=1;
 if(!vector.some(Boolean)){let hash=0;for(const char of String(text))hash=(hash*31+char.codePointAt(0))>>>0;vector[8+hash%8]=1;}
 let sum=0;for(const value of vector)sum+=value*value;
 const length=Math.sqrt(sum)||1;
 for(let i=0;i<vector.length;i++)vector[i]/=length;
 return Promise.resolve({vector,model:'fake-embed',dim:16});
}
const embed=async text=>fakeEmbed(text);

async function setup(t,{rawStore=false,embedFn=embed,grants=[]}={}){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-memory-'));
 const memory=await new MemoryStore(dir).open();
 t.after(async()=>{memory.close();await rm(dir,{recursive:true,force:true});});
 if(rawStore)return {dir,memory};
 const store=await new Store(path.join(dir,'state')).open();
 Object.assign(store.data.framework,{listenGroups:[group],enabledActions:['plugin.qq-memory.remember','plugin.qq-memory.recall','plugin.qq-memory.forget'],grants});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 actions.attach({status:{bot,online:true},request:async()=>({outcome:'confirmed',data:{}})});
 const sdk=new PluginSDK({store,permissions,events,media,actions});
 const api=activateMemory(sdk.facade(),{store:memory,embed:embedFn});
 const item=store.data.framework.nativePackages['qq-memory'];
 item.enabled=true;item.scope={private:true,allUsers:false,users:[owner,other],groups:[group]};
 item.config={...api.getConfig(),embeddingProvider:'openai',autoRecall:true,autoRecallMode:'semantic',autoRecallLimit:6,contextChars:800};
 t.after(()=>sdk.stop());
 return {dir,memory,store,sdk,actions,item,api,
  context:(extra={})=>permissions.issue(msg(extra),'chat'),
  call:(id,args,c)=>actions.invoke('plugin.qq-memory.'+id,args,c)};
}

test('SQLite 记忆库建表、写入与去重哈希',async t=>{
 const {memory}=await setup(t,{rawStore:true});
 const row=memory.insert({scope:'user',owner,text:'  我不吃香菜。 ',tags:['饮食'],kind:'preference',importance:4});
 assert.equal(row.text,'我不吃香菜。');
 assert.equal(row.scope,'user');
 assert.equal(row.tags[0],'饮食');
 assert.equal(memory.count(),1);
 assert.equal(memory.findExact('user',owner,memoryHash('user',owner,'我不吃香菜。')).id,row.id);
 assert.equal(memory.findExact('user',other,memoryHash('user',owner,'我不吃香菜。')),null);
 assert.equal(memory.remove(row.id).id,row.id);
 assert.equal(memory.count(),0);
});

test('关键词与余弦打分能区分相关和不相关内容',()=>{
 assert.ok(keywordScore('我生日是哪天','我的生日是 5 月 3 日')>=0.32);
 assert.ok(keywordScore('你喜欢猫吗','主人喜欢猫')>=0.32);
 assert.equal(keywordScore('天气怎么样','主人喜欢猫'),0);
 const vector=normalizeVector([1,0,0]);
 assert.equal(cosine(vector,vector),1);
 const row={text:'我不吃香菜',importance:3,updated_at:Date.now(),embedding:vector,dim:3,model:'m'};
 assert.ok(scoreMemory(row,{vector,model:'m',query:'香菜'}));
 assert.equal(scoreMemory({...row,text:'我不吃辣',embedding:normalizeVector([0,1,0])},{vector,model:'m',query:'香菜'}),null);
});

test('记忆按用户和群隔离，私聊看不到别的群记忆',async t=>{
 const {memory}=await setup(t,{rawStore:true});
 memory.insert({scope:'user',owner,text:'主人不吃香菜'});
 memory.insert({scope:'user',owner:other,text:'别人喜欢猫'});
 memory.insert({scope:'group',owner:group,text:'本群周五开黑'});
 memory.insert({scope:'group',owner:'99999',text:'另一个群的约定'});
 memory.insert({scope:'global',owner:'',text:'机器人叫大肥鱼'});
 const visible=memory.visible({actor:owner,group}).map(row=>row.text);
 assert.deepEqual(new Set(visible),new Set(['主人不吃香菜','本群周五开黑','机器人叫大肥鱼']));
 const privateView=memory.visible({actor:owner,group:''}).map(row=>row.text);
 assert.ok(!privateView.includes('本群周五开黑'));
 assert.ok(!visible.includes('别人喜欢猫'));
});

test('remember 默认写用户记忆、支持语义去重并限制越权范围',async t=>{
 const x=await setup(t,{grants:[{id:'g1',capability:'plugin.qq-memory.remember',allUsers:false,users:[other],groups:[group],private:false,deny:false,expires:'',perMinute:10}]}),c=x.context();
 const first=await x.call('remember',{text:'我不吃香菜'},c);
 assert.equal(first.ok,true);
 assert.equal(first.scope,'user');
 assert.equal(first.vector,true);
 const row=x.memory.get(first.id);
 assert.equal(row.owner,owner);
 assert.equal(row.model,'fake-embed');
 const repeat=await x.call('remember',{text:'  我不吃香菜  '},c);
 assert.equal(repeat.deduped,'exact');
 assert.equal(x.memory.count(),1);
 const similar=await x.call('remember',{text:'香菜我不吃'},c);
 assert.equal(similar.deduped,'similar');
 assert.equal(x.memory.count(),1);
 await assert.rejects(x.call('remember',{text:'   '},c),/记住的内容/);
 await assert.rejects(x.call('remember',{text:'一'.repeat(501)},c),/文字参数无效/);
 const own=x.context({user:other});
 await assert.rejects(x.call('remember',{text:'本群规矩',scope:'group'},own),/只有主人/);
 await assert.rejects(x.call('remember',{text:'我喜欢狗',scope:'global'},own),/只有主人/);
 const allowed=await x.call('remember',{text:'我喜欢狗',scope:'user'},own);
 assert.equal(allowed.ok,true);
 assert.equal(x.memory.get(allowed.id).owner,other);
 const groupMemory=await x.call('remember',{text:'本群周五开黑',scope:'group'},c);
 assert.equal(x.memory.get(groupMemory.id).owner,group);
});

test('联网学习记忆保留来源、发布时间、可信度和过期时间',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await x.call('remember',{text:'一篇公开资料的结论',tags:['学习'],sourceUrl:'https://example.com/article',sourceTitle:'原始资料',publishedAt:1790000000000,confidence:0.7,expiresAt:1800000000000},c);
 const row=x.memory.get(saved.id);
 assert.equal(row.source,'web');
 assert.equal(row.source_url,'https://example.com/article');
 assert.equal(row.source_title,'原始资料');
 assert.equal(row.published_at,1790000000000);
 assert.equal(row.confidence,0.7);
 assert.equal(row.expires_at,1800000000000);
 const recalled=await x.call('recall',{query:'公开资料'},c);
 assert.equal(recalled.items.find(item=>item.id===saved.id).sourceUrl,'https://example.com/article');
});

test('recall 支持语义检索、记录使用次数并在没命中时明确为空',async t=>{
 const x=await setup(t),c=x.context();
 await x.call('remember',{text:'我不吃香菜'},c);
 await x.call('remember',{text:'我的生日是 5 月 3 日'},c);
 const hit=await x.call('recall',{query:'什么时候过生日'},c);
 assert.equal(hit.ok,true);
 assert.equal(hit.items[0].text,'我的生日是 5 月 3 日');
 assert.ok(hit.items[0].score>0);
 assert.ok(x.memory.get(hit.items[0].id).use_count>=1);
 const none=await x.call('recall',{query:'今天天气如何'},c);
 assert.equal(none.items.length,0);
 assert.match(none.instruction,/没记住/);
 await assert.rejects(x.call('recall',{query:''},c),/检索的内容/);
});

test('嵌入失败时记住和回忆都退化为关键词，不丢数据、不报错',async t=>{
 const x=await setup(t,{embedFn:async()=>{throw new Error('网络不可用');}});
 const c=x.context();
 const record=await x.call('remember',{text:'我不吃香菜'},c);
 assert.equal(record.ok,true);
 assert.equal(record.vector,false);
 assert.match(record.embeddingNote,/关键词/);
 const result=await x.call('recall',{query:'香菜'},c);
 assert.equal(result.items.length,1);
 assert.match(result.items[0].text,/香菜/);
 assert.match(result.embeddingNote,/关键词/);
 const block=await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'香菜'});
 assert.match(block,/我不吃香菜/);
});

test('forget 仅主人可删，删除后不再被检索',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await x.call('remember',{text:'我不吃香菜'},c);
 await assert.rejects(x.call('forget',{id:saved.id},x.context({user:other})),/主人/);
 assert.equal((await x.call('forget',{id:saved.id},c)).ok,true);
 assert.equal(x.memory.get(saved.id),null);
 await assert.rejects(x.call('forget',{id:saved.id},c),/没有找到/);
 const result=await x.call('recall',{query:'香菜'},c);
 assert.equal(result.items.length,0);
});

test('上下文提供器只注入当前聊天可见且相关的记忆，并遵守字数上限',async t=>{
 const x=await setup(t);
 await x.call('remember',{text:'我不吃香菜'},x.context());
 await x.call('remember',{text:'我的生日是 5 月 3 日'},x.context());
 x.memory.insert({scope:'user',owner:other,text:'另一个人的秘密'});
 const block=await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'晚上吃香菜吗'});
 assert.match(block,/^\[长期记忆\]/);
 assert.match(block,/我不吃香菜/);
 assert.match(block,/关于 QQ 10000001/);
 assert.ok(!block.includes('另一个人的秘密'));
 assert.ok(!block.includes('生日'));
 const unrelated=await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'今天天气不错'});
 assert.equal(unrelated,'');
 const privateBlock=await x.sdk.contextFor({key:bot+':private:'+owner,kind:'private',peer:owner,actor:owner,text:'香菜'});
 assert.match(privateBlock,/我不吃香菜/);
});

test('关闭自动回忆或超出插件作用范围时不注入',async t=>{
 const x=await setup(t);
 await x.call('remember',{text:'我不吃香菜'},x.context());
 x.item.config.autoRecall=false;
 assert.equal(await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'香菜'}),'');
 x.item.config.autoRecall=true;
 x.item.scope={private:false,allUsers:false,users:[owner],groups:[]};
 assert.equal(await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'香菜'}),'');
});

test('关键词模式在没有嵌入模型时仍能自动回忆',async t=>{
 const x=await setup(t);
 x.item.config.autoRecallMode='keyword';
 x.item.config.embeddingProvider='off';
 await x.call('remember',{text:'我不吃香菜'},x.context());
 const block=await x.sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'香菜'});
 assert.match(block,/我不吃香菜/);
});

test('设置页返回统计、分页和检索过滤',async t=>{
 const x=await setup(t);
 await x.call('remember',{text:'我不吃香菜'},x.context());
 await x.call('remember',{text:'我喜欢猫'},x.context());
 const page=await x.sdk.pageData('qq-memory',{offset:0});
 assert.equal(page.stats[0].label,'记忆总数');
 assert.equal(page.stats[0].value,2);
 assert.equal(page.rows.length,2);
 assert.ok(page.columns.some(column=>column.key==='time'&&column.format==='datetime'));
 const filtered=await x.sdk.pageData('qq-memory',{offset:0,query:'香菜'});
 assert.equal(filtered.rows.length,1);
});

test('容量与保留天数清理：优先丢弃低重要度和久未使用的记忆',async t=>{
 const {memory}=await setup(t,{rawStore:true});
 const rows=[];
 for(let i=1;i<=5;i++)rows.push(memory.insert({scope:'user',owner,text:'记忆'+i,importance:i}));
 memory.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Date.now()-800*86400000,rows[0].id);
 const removed=memory.prune({days:730,max:3,now:Date.now()});
 assert.ok(removed.includes(rows[0].id));
 assert.equal(memory.count(),3);
 assert.ok(memory.get(rows[0].id)===null);
 assert.ok(memory.get(rows[4].id));
});

test('嵌入客户端发送 OpenAI 兼容请求、校验返回并隐藏密钥',async()=>{
 delete process.env.SILICONFLOW_API_KEY;delete process.env.MEMORY_API_KEY;
 const config={embeddingProvider:'siliconflow',embeddingUrl:'https://api.siliconflow.cn/v1/embeddings',embeddingModel:'BAAI/bge-m3',embeddingKey:'sk-secret'};
 let seen;
 const fetchImpl=async(url,init)=>{seen={url:String(url),init};return new Response(JSON.stringify({data:[{embedding:[3,4,0,0,0,0,0,0]}]}),{status:200,headers:{'content-type':'application/json'}});};
 const result=await embedTexts(['你好'],config,{fetchImpl});
 assert.equal(result.dim,8);
 assert.ok(Math.abs(result.vectors[0][0]-0.6)<1e-6);
 assert.ok(Math.abs(result.vectors[0][1]-0.8)<1e-6);
 assert.equal(seen.init.headers.authorization,'Bearer sk-secret');
 assert.deepEqual(JSON.parse(seen.init.body),{model:'BAAI/bge-m3',input:['你好'],encoding_format:'float'});
 assert.ok(!JSON.stringify(result).includes('sk-secret'));
 const denied=async()=>new Response('{"message":"bad key"}',{status:401,headers:{'content-type':'application/json'}});
 await assert.rejects(embedTexts(['你好'],config,{fetchImpl:denied}),error=>/HTTP 401/.test(error.message)&&!/sk-secret/.test(error.message));
 const broken=async()=>new Response(JSON.stringify({data:[{embedding:[1,2,3]}]}),{status:200,headers:{'content-type':'application/json'}});
 await assert.rejects(embedTexts(['你好'],{...config,embeddingKey:'sk-secret'},{fetchImpl:broken}),/向量无效/);
 await assert.rejects(embedTexts(['你好'],{...config,embeddingKey:''},{fetchImpl:broken}),/密钥/);
 assert.equal(embeddingEndpoint({embeddingProvider:'siliconflow',embeddingUrl:''}),'https://api.siliconflow.cn/v1/embeddings');
 assert.equal(embeddingEndpoint({embeddingProvider:'openai',embeddingUrl:'http://127.0.0.1:11434/v1/embeddings'}),'http://127.0.0.1:11434/v1/embeddings');
});

test('context 能力按声明启用，提供器抛错或超长时不影响回复',async t=>{
 const x=await setup(t);
 const sdk=x.sdk;
 const api=sdk.facade().registerTrustedPackage({id:'qq-ctx-demo',name:'上下文示例',version:'1.0.0',capabilities:['context']});
 const item=x.store.data.framework.nativePackages['qq-ctx-demo'];
 item.enabled=true;item.scope={private:true,allUsers:false,users:[owner],groups:[group]};
 api.registerContextProvider(async input=>'CTX:'+input.text);
 assert.equal(await sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'hi'}),'CTX:hi');
 item.enabled=false;
 assert.equal(await sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'hi'}),'');
 item.enabled=true;
 const plain=sdk.facade().registerTrustedPackage({id:'qq-ctx-no',name:'无能力示例',version:'1.0.0',capabilities:['actions']});
 assert.throws(()=>plain.registerContextProvider(async()=>'x'),/context/);
 const bad=sdk.facade().registerTrustedPackage({id:'qq-ctx-bad',name:'抛错示例',version:'1.0.0',capabilities:['context']});
 const badItem=x.store.data.framework.nativePackages['qq-ctx-bad'];
 badItem.enabled=true;badItem.scope={private:true,allUsers:true,users:[],groups:[group]};
 bad.registerContextProvider(async()=>{throw new Error('坏掉了');});
 const result=await sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'hi'});
 assert.equal(result,'CTX:hi');
 const long=sdk.facade().registerTrustedPackage({id:'qq-ctx-long',name:'超长示例',version:'1.0.0',capabilities:['context']});
 const longItem=x.store.data.framework.nativePackages['qq-ctx-long'];
 longItem.enabled=true;longItem.scope={private:true,allUsers:true,users:[],groups:[group]};
 long.registerContextProvider(async()=>'y'.repeat(5000));
 assert.equal((await sdk.contextFor({key,kind:'group',peer:group,actor:owner,text:'hi'})).length,2000);
});

test('manifest 默认配置能被框架校验',()=>{
 const config=migrateConfig(undefined,manifest);
 assert.equal(config.autoRecall,true);
 assert.equal(config.embeddingProvider,'siliconflow');
 assert.equal(config.maxMemories,2000);
 assert.equal(manifest.capabilities.includes('context'),true);
 assert.equal(manifest.dependencies.framework,'>=0.10.0');
});
