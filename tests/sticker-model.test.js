import test from 'node:test';
import assert from 'node:assert/strict';
import {createStickerModel} from '../src/builtins/sticker/model.js';

test('宿主表情模型使用持久图片附件和正确的流结束协议',async()=>{
 let request;
 const ctx={attachments:{saveImages:async images=>{assert.equal(images[0].mediaType,'image/png');return [{id:'real-attachment'}];}},llm:{async *stream(options){request=options;yield {type:'text-delta',text:'{"isSticker":true}'};yield {type:'finish',reason:{kind:'stop'}};}}};
 const model=createStickerModel({ctx,incoming:{modelInfo:async()=>({provider:'configured',model:'vision',vision:true})}});
 assert.equal(await model({system:'classify',user:'image',image:{bytes:Buffer.from('bytes'),mime:'image/png'}}),'{"isSticker":true}');
 assert.deepEqual(request.messages[0].content[1],{type:'image',attachment:{id:'real-attachment'}});
 assert.equal(request.provider,'configured');
 assert.ok(request.maxTokens >= 1500,'给推理和结构化结果保留足够输出空间');
});
test('纯文字模型不假装看图，模型截断和报错不被当作成功',async()=>{
 const incoming={modelInfo:async()=>({provider:'configured',model:'text',vision:false})};
 const model=createStickerModel({ctx:{},incoming});
 await assert.rejects(model({image:{bytes:Buffer.from('bytes')}}),/不支持图片/);
 const bad=createStickerModel({incoming,ctx:{llm:{async *stream(){yield {type:'text-delta',text:'{}'};yield {type:'finish',reason:{kind:'max-tokens'}};}}}});
 await assert.rejects(bad({user:'choose'}),error=>error.code==='STICKER_MODEL_MAX_TOKENS');
});
