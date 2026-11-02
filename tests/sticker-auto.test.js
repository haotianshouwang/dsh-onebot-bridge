import test from 'node:test';import assert from 'node:assert/strict';
import {createStickerAutoSave} from '../src/builtins/sticker/auto.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const groupContext={actor:'10000001',peer:'88888',kind:'group',key:'10000002:group:88888'};

function harness({config={},scope={private:true,allUsers:false,users:['10000001'],groups:['88888']},enabled,readError,fetchError,inspect=async()=>({isSticker:true,name:'聊天表情',emotion:'开心',tags:[],usage:'表达开心'})}={}){
 const saved=[],logs=[];
 const stickers={save:async({bytes,name,tags,source})=>{saved.push({bytes,name,source});return {sticker:{id:'s'+(saved.length),name},deduped:false};}};
 const auto=createStickerAutoSave({
  stickers,
  inspect,
  scope:()=>({enabled,config:{autoSaveSent:false,autoSaveIncoming:false,...config},scope}),
  readResource:async()=>{if(readError)throw new Error(readError);return png;},
  fetchMessageBytes:async()=>{if(fetchError)throw new Error(fetchError);return png;},
  log:(level,message)=>logs.push({level,message})
 });
 return {auto,saved,logs};
}

test('开启发图自动收藏后，联网发图会入库',async()=>{
 const h=harness({config:{autoSaveSent:true}});
 const result=await h.auto.fromResource('res-1',groupContext,{name:'鲸鱼'});
 assert.equal(result.id,'s1');
 assert.equal(h.saved.length,1);
 assert.equal(h.saved[0].source,'auto-sent');
 assert.equal(h.saved[0].name,'聊天表情','优先使用看图得到的名字，不根据资源名字猜图');
});

test('先识图再入库：普通截图、照片和识图失败均不保存',async()=>{
 for(const inspect of [async()=>({isSticker:false}),async()=>null,async()=>{throw Error('vision unavailable');}]){
  const h=harness({config:{autoSaveIncoming:true,autoSaveSent:true},inspect});
  assert.equal(await h.auto.fromMessage({parts:[{type:'image'}]},groupContext),null);
  assert.equal(await h.auto.fromResource('res-1',groupContext),null);
  assert.equal(h.saved.length,0);
 }
});

test('开关关闭时不会自动收藏',async()=>{
 const h=harness({config:{autoSaveSent:false}});
 assert.equal(await h.auto.fromResource('res-1',groupContext),null);
 assert.equal(h.saved.length,0);
});

test('不在作用范围的聊天不会自动收藏',async()=>{
 const h=harness({config:{autoSaveSent:true},scope:{private:true,allUsers:false,users:['10000001'],groups:['99999']}});
 assert.equal(await h.auto.fromResource('res-1',groupContext),null);
 assert.equal(h.saved.length,0);
});

test('读图失败只记警告，不抛出',async()=>{
 const h=harness({config:{autoSaveSent:true},readError:'资源过期'});
 assert.equal(await h.auto.fromResource('res-1',groupContext),null);
 assert.match(h.logs.at(-1).message,/自动收藏失败/);
});

test('开启收图自动收藏后，一条消息最多收 3 张',async()=>{
 const h=harness({config:{autoSaveIncoming:true}});
 const message={sender:'群友',parts:[{type:'image'},{type:'image'},{type:'image'},{type:'image'}]};
 const ids=await h.auto.fromMessage(message,groupContext);
 assert.equal(ids.length,3,'单条消息最多自动收 3 张，避免刷库');
 assert.equal(h.saved.every(row=>row.source==='auto-incoming'),true);
});

test('收图失败不会打断处理',async()=>{
 const h=harness({config:{autoSaveIncoming:true},fetchError:'网关不可用'});
 assert.equal(await h.auto.fromMessage({parts:[{type:'image'}]},groupContext),null);
 assert.match(h.logs.at(-1).message,/自动收藏失败/);
});

test('插件停用后自动收藏旁路立即停止',async()=>{
 const h=harness({config:{autoSaveIncoming:true},enabled:false});
 assert.equal(await h.auto.fromMessage({parts:[{type:'image'}]},groupContext),null);
 assert.equal(h.saved.length,0);
});

test('没有图片的消息不触发收藏',async()=>{
 const h=harness({config:{autoSaveIncoming:true}});
 assert.equal(await h.auto.fromMessage({parts:[{type:'text'}]},groupContext),null);
 assert.equal(h.saved.length,0);
});

test('指定群内收集群友图片，不要求群友拥有主人工具权限',async()=>{
 const h=harness({config:{autoSaveIncoming:true}});
 assert.equal((await h.auto.fromMessage({parts:[{type:'image'}]},{...groupContext,actor:'23456789'})).length,1);
 assert.equal(await h.auto.fromMessage({parts:[{type:'image'}]},{...groupContext,actor:'23456789',kind:'private',peer:'23456789'}),null);
});
