// Use the selected DSH model directly. Platform OpenIDs never enter OneBot permissions,
// owner sessions, personal memory, tools, or a shared conversation history.
export function officialReply({llm, modelInfo}) {
  return async ({text, signal}) => {
    const abort = AbortSignal.any([signal, AbortSignal.timeout(30000)].filter(Boolean));
    abort.throwIfAborted();
    const {provider, model} = await modelInfo() || {};
    abort.throwIfAborted();
    if (!provider || !model) throw new Error('未配置官方机器人回复使用的 DSH 模型');
    const request = {provider, model, signal: abort, maxTokens: 1536, tools: [],
      system: '你是 QQ 官方机器人的聊天助手。仅根据当前消息用纯文本回复，不代替用户执行任何操作。',
      messages: [{role: 'user', content: [{type: 'text', text: String(text).slice(0, 12000)}]}]};
    let result = '', finished = false;
    for await (const part of llm.stream(request)) {
      abort.throwIfAborted();
      if (part.type === 'text-delta') result += part.text;
      if (result.length > 12000) throw new Error('官方机器人模型回复过长');
      if (part.type === 'finish') finished = part.reason?.kind === 'stop';
    }
    if (!finished || !result.trim()) throw new Error('官方机器人模型回复未完成');
    return result.trim();
  };
}
