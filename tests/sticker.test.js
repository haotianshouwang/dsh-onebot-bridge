import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {PluginSDK} from '../src/sdk.js';import {StickerStore} from '../src/core/stickers.js';import {activateSticker} from '../src/builtins/sticker/index.js';

const bot='10000002',owner='10000001',other='12345678',group='88888',key=bot+':group:'+group;
const message=(extra={})=>({bot,user:owner,kind:'group',peer:group,key,id:'m1',...extra});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

async function setup(t,{search,bytes}={}){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-sticker-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 Object.assign(store.data.framework,{listenGroups:[group],listenPrivate:true,enabledActions:[
  'plugin.qq-sticker.save','plugin.qq-sticker.steal','plugin.qq-sticker.list','plugin.qq-sticker.send','plugin.qq-sticker.explain','plugin.qq-sticker.remove','qq.image.send','qq.media.receive'
 ]});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 actions.attach({status:{bot,online:true},request:async()=>({outcome:'confirmed',data:{}})});
 const invokes=[];
 const originalInvoke=actions.invoke.bind(actions);
 actions.invoke=async (id,args,c,signal)=>{
  if(id.startsWith('plugin.qq-sticker.'))return originalInvoke(id,args,c,signal);
  invokes.push({id,args});
  if(id==='qq.media.receive')return {id:'res-1',mime:'image/png',name:'x'};
  if(id==='qq.image.send')return {outcome:'confirmed'};
  if(id==='plugin.qq-web.search'){
   if(search==='fail')throw new Error('搜索服务不可用');
   return {provider:'Bing RSS',results:[{title:'表情含义',url:'https://example.com/a',snippet:'摘要'}]};
  }
  throw new Error('unexpected invoke '+id);
 };
 const sdk=new PluginSDK({store,permissions,events,media,actions});
 const stickers=await new StickerStore(dir).open();
 const api=activateSticker(sdk.facade(),{stickers,readResource:async()=>bytes||png});
 const item=store.data.framework.nativePackages['qq-sticker'];
 item.enabled=true;item.scope={private:true,allUsers:false,users:[owner],groups:[group]};
 t.after(()=>{media.stop();return sdk.stop();});
 return {store,permissions,actions,stickers,api,invokes,context:(extra={})=>permissions.issue(message(extra),'chat')};
}

const save=async(x,c,extra={})=>x.actions.invoke('plugin.qq-sticker.save',{messageId:'m1',name:'鲸鱼笑',tags:['鲸鱼','得意'],...extra},c);

test('收藏一张表情，并按内容去重',async t=>{
 const x=await setup(t),c=x.context();
 const first=await save(x,c);
 assert.equal(first.ok,true);
 assert.equal(first.deduped,false);
 assert.equal(first.sticker.name,'鲸鱼笑');
 assert.deepEqual(first.sticker.tags,['鲸鱼','得意']);
 assert.equal(x.stickers.stats().count,1);
 const again=await save(x,c,{name:'另一个名字'});
 assert.equal(again.deduped,true);
 assert.equal(x.stickers.stats().count,1,'同一张图不应重复占空间');
});

test('偷别人的表情会记录来源，并能检索到',async t=>{
 const x=await setup(t),c=x.context();
 const stolen=await x.actions.invoke('plugin.qq-sticker.steal',{messageId:'m1',name:'偷来的',tags:['猫']},c);
 assert.equal(stolen.ok,true);
 assert.equal(stolen.sticker.source,'stolen');
 const list=await x.actions.invoke('plugin.qq-sticker.list',{query:'猫'},x.context());
 assert.equal(list.items.length,1);
 assert.equal(list.items[0].name,'偷来的');
 assert.equal(list.total,1);
});

test('发送表情会经过受控资源并记录使用时间',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await save(x,c);
 const sent=await x.actions.invoke('plugin.qq-sticker.send',{id:saved.sticker.id},c);
 assert.equal(sent.ok,true);
 const call=x.invokes.find(i=>i.id==='qq.image.send');
 assert.ok(call,'应通过 qq.image.send 发送');
 assert.ok(call.args.resourceId);
 assert.ok(x.stickers.get(saved.sticker.id).usedAt);
});

test('识别用途会把图片交给模型，并联网查含义',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await save(x,c);
 const explained=await x.actions.invoke('plugin.qq-sticker.explain',{id:saved.sticker.id},c);
 assert.equal(explained.ok,true);
 assert.equal(explained.previews.length,1);
 assert.equal(explained.previews[0].mediaType,'image/png');
 assert.ok(explained.previews[0].base64.length>10,'必须回传图片内容本身');
 assert.equal(explained.meaning.results.length,1);
 const search=x.invokes.find(i=>i.id==='plugin.qq-web.search');
 assert.match(search.args.query,/什么梗|什么场合/);
});

test('搜索不可用时如实报告，不编造含义',async t=>{
 const x=await setup(t,{search:'fail'}),c=x.context();
 const saved=await save(x,c);
 const explained=await x.actions.invoke('plugin.qq-sticker.explain',{id:saved.sticker.id},c);
 assert.equal(explained.ok,true);
 assert.match(explained.meaning.error,/不可用/);
 assert.equal(explained.meaning.results,undefined);
 assert.match(explained.meaning.note,/不要/);
});

test('关闭联网查含义后不再发起搜索',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await save(x,c);
 const item=x.store.data.framework.nativePackages['qq-sticker'];
 item.config={...item.config,meaningEnabled:false};
 const explained=await x.actions.invoke('plugin.qq-sticker.explain',{id:saved.sticker.id},c);
 assert.equal(explained.meaning,null);
 assert.equal(x.invokes.filter(i=>i.id==='plugin.qq-web.search').length,0);
});

test('收藏数量受限，超出当日额度会被拒绝',async t=>{
 const x=await setup(t),c=x.context();
 const item=x.store.data.framework.nativePackages['qq-sticker'];
 item.config={...item.config,savePerDay:1};
 await save(x,c);
 await assert.rejects(save(x,c),/够多了/);
});

test('删除后不能再发送',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await save(x,c);
 await x.actions.invoke('plugin.qq-sticker.remove',{id:saved.sticker.id},x.context());
 await assert.rejects(x.actions.invoke('plugin.qq-sticker.send',{id:saved.sticker.id},x.context()),/没有这个表情/);
 assert.equal(x.stickers.stats().count,0);
});

test('联网搜到并发出后，可以用资源编号收进表情库',async t=>{
 const x=await setup(t),c=x.context();
 const saved=await x.actions.invoke('plugin.qq-sticker.save',{resourceId:'res-from-web',name:'网页图',tags:['梗']},c);
 assert.equal(saved.ok,true);
 assert.equal(saved.sticker.name,'网页图');
 assert.deepEqual(saved.sticker.tags,['梗']);
 assert.equal(x.invokes.some(i=>i.id==='qq.media.receive'),false,'用资源编号时不应再去消息里取图');
});

test('非图片内容会被拒绝收藏',async t=>{
 const x=await setup(t,{bytes:Buffer.from('not an image at all')}),c=x.context();
 await assert.rejects(save(x,c),/只能收藏/);
 assert.equal(x.stickers.stats().count,0);
});
