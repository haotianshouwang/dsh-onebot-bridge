import test from 'node:test';
import assert from 'node:assert/strict';
import {createStickerIntelligence} from '../src/builtins/sticker/intelligence.js';

const context = {actor: '12345', kind: 'group', peer: '88888', key: '99999:group:88888'};
function setup(extra = {}) {
  const annotated = [], used = [], calls = [];
  const rows = [{id: 'one', name: '笑猫', emotion: '开心', tags: ['猫'], usage: '开心时', annotatedAt: 1, isSticker: true}];
  const state = {enabled: true, config: {autoClassify: true, autoSend: true, sendProbability: 100, sendCooldownSec: 0}, scope: {allUsers: true, users: [], private: true, groups: ['88888']}};
  const stickers = {list: () => rows, get: id => rows.find(r => r.id === id), read: async id => ({row: rows.find(r => r.id === id), bytes: Buffer.from('image')}), annotate: async (id, value) => annotated.push({id, ...value}), touch: async id => used.push(id)};
  const service = createStickerIntelligence({stickers, scope: () => state, model: async options => {calls.push(options); return options.image ? JSON.stringify({name:'笑猫', emotion:'开心', tags:['猫'], usage:'开心时', isSticker:true}) : '{"id":"one"}';}, ...extra});
  return {service, state, rows, annotated, used, calls};
}
test('自动收藏后根据真实图片结果补充分类，不根据发送者昵称猜图', async () => {
  const x = setup(); await x.service.describe({id:'one', mime:'image/png'}, Buffer.from('image'), context);
  assert.equal(x.annotated[0].emotion, '开心'); assert.equal(x.annotated[0].isSticker, true);
  assert.ok(x.calls[0].image.bytes.length);
});
test('模型分类失败保留原图，不伪造分类', async () => {
  const x = setup({model: async () => 'not json'});
  await x.service.describe({id:'one', mime:'image/png'}, Buffer.from('image'), context);
  assert.equal(x.annotated.length, 0);
});
test('按对话挑选一张表情，选择本身不标记发送，收到提交回执后记录使用', async () => {
  const x = setup(); const result = await x.service.choose({message:{...context, user:context.actor, text:'真开心'}, text:'好耶'});
  assert.equal(result.part.type, 'image'); assert.equal(x.used.length, 0);
  await result.sent({state:'submitted'}); assert.deepEqual(x.used, ['one']);
  assert.equal(await x.service.choose({message:{...context,user:context.actor},text:'继续'}), null);
});

test('配图判断接收真实心情状态，也允许模型决定不用表情', async () => {
  const emotion = {global: {mood: '疲倦', intensity: 0.4}, local: {mood: '平静', intensity: 0}};
  const x = setup({model: async options => {
    assert.deepEqual(JSON.parse(options.user).emotion, emotion);
    return '{"id":null}';
  }});
  const result = await x.service.choose({message: {...context, user: context.actor, text: '早点休息'}, text: '好，我也有点困了', emotion});
  assert.equal(result, null);
  assert.equal(x.used.length, 0);
});

test('模型根据真实消息预算决定保留文字分条，不能为配图机械合并所有文字', async () => {
  const delivery={maxMessages:2,textParts:['第一件事已经确认。','第二件事仍需核实。'],imageMessageCost:1};
  const x=setup({model:async options=>{
    assert.deepEqual(JSON.parse(options.user).delivery,delivery);
    return '{"id":null}';
  }});
  assert.equal(await x.service.choose({message:{...context,user:context.actor},text:delivery.textParts.join('\n'),delivery}),null);
});
test('拒绝陌生编号、未分类图片和识别为普通照片的图片', async () => {
  const x = setup({model: async () => '{"id":"invented"}'});
  assert.equal(await x.service.choose({message:{...context,user:context.actor},text:'好耶'}), null);
  const y = setup(); y.rows[0].isSticker = false;
  assert.equal(await y.service.choose({message:{...context,user:context.actor},text:'好耶'}), null);
});

test('看图回复不把收到的图片作为配图候选，仍可选择原生 QQ 表情',async()=>{
 const x=setup({model:async options=>{assert.equal(JSON.parse(options.user).candidates.some(row=>row.id==='one'),false);return '{"id":"face:13"}';}});
 x.state.config.expressionMode='mixed';
 const result=await x.service.choose({message:{...context,user:context.actor,id:'123',parts:[{type:'image'}]},text:'笑得好开心'});
 assert.deepEqual(result.part,{type:'face',data:{id:'13'}});
 await result.sent({state:'submitted'});assert.equal(x.used.length,0);
});

test('贴表情仅针对当前真实消息，模型不能指定别的消息编号',async()=>{
 const x=setup({model:async()=>'{"id":"reaction:13","messageId":"other"}'});
 x.state.config.expressionMode='mixed';
 const result=await x.service.choose({message:{...context,user:context.actor,id:'123'},text:'好耶'});
 assert.deepEqual(result.reaction,{messageId:'123',emojiId:'13'});
 const y=setup({model:async()=>'{"id":"reaction:9999"}'});
 assert.equal(await y.service.choose({message:{...context,user:context.actor,id:'123'},text:'好耶'}),null);
});

test('默认仅选择已确认的图片表情，拒绝 QQ 小表情替代，并提供当前聊天上下文和发送顺序',async()=>{
 const history=[{user:'12345',text:'这次赢啦'}];
 const x=setup({model:async options=>{
  const input=JSON.parse(options.user);
  assert.equal(input.candidates.some(row=>row.id.startsWith('face:')||row.id.startsWith('reaction:')),false);
  assert.deepEqual(input.history,history);
  return '{"id":"one","placement":"before","reason":"用开心的图先回应赢了的消息"}';
 }});
 const selected=await x.service.choose({message:{...context,user:context.actor},text:'好耶',history});
 assert.equal(selected.part.type,'image');
 assert.equal(selected.placement,'before');
 const y=setup({model:async()=>'{"id":"face:13"}'});
 assert.equal(await y.service.choose({message:{...context,user:context.actor},text:'好耶'}),null);
});
test('范围外和停用时不调用模型；选择后撤销配置立即失效', async () => {
  const x = setup(); x.state.scope.groups = [];
  assert.equal(await x.service.choose({message:{...context,user:context.actor},text:'好耶'}), null); assert.equal(x.calls.length,0);
  x.state.scope.groups = ['88888']; const result = await x.service.choose({message:{...context,user:context.actor},text:'好耶'});
  x.state.enabled = false; assert.equal(result.valid(),false);
});
test('停止时取消后台识别，禁止迟到的模型结果写入', async () => {
  let finish;
  const x = setup({model: () => new Promise(resolve => {finish=resolve;})});
  const pending=x.service.describe({id:'one',mime:'image/png'},Buffer.from('image'),context);
  await Promise.resolve();
  x.service.stop(); finish('{"name":"笑猫","emotion":"开心","tags":[],"usage":"开心时","isSticker":true}');
  await pending; assert.equal(x.annotated.length,0);
});
