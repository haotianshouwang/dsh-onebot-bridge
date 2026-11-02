// 使用宿主已有的模型与图片附件接口，不另存 API Key 或另建请求端点。
export function createStickerModel({ctx, incoming}) {
  return async ({system, user, image, signal, timeoutMs = 8000}) => {
    const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
    const info = await incoming.modelInfo(ctx);
    if (image && !info.vision) throw Object.assign(Error('当前模型不支持图片分类'), {code:'STICKER_VISION_UNAVAILABLE'});
    const content = [{type:'text',text:user}];
    if (image) {
      const refs = await ctx.attachments.saveImages([{data:image.bytes,mediaType:image.mime,name:'sticker'}]);
      content.push({type:'image',attachment:refs[0]});
    }
    let text = '', finishReason = '';
    for await (const chunk of ctx.llm.stream({provider:info.provider,model:info.model,system,messages:[{role:'user',content}],maxTokens:2048,signal:abort})) {
      abort.throwIfAborted();
      if (chunk.type === 'text-delta') text += chunk.text;
      if (text.length > 6000) throw Error('表情模型结果过长');
      if (chunk.type === 'finish') finishReason = chunk.reason?.kind || '';
    }
    if (finishReason !== 'stop' || !text.trim()) {
      const code = finishReason === 'max-tokens' ? 'STICKER_MODEL_MAX_TOKENS' : 'STICKER_MODEL_INCOMPLETE';
      throw Object.assign(Error('表情模型未完成'), {code});
    }
    return text;
  };
}
