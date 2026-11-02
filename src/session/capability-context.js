// 每轮读取真实注册表与权限，不从聊天历史推断功能是否存在。
export function capabilityContext({actions, permissions, context, now = Date.now()}) {
  const features = [['语音', 'plugin.qq-tts.speak'], ['定时提醒', 'qq.task.create'], ['表情表达', 'plugin.qq-sticker.send'], ['图片表情库检索', 'plugin.qq-sticker.list'], ['联网找图片', 'plugin.qq-web.image-search'], ['网络图片发送', 'plugin.qq-web.image-send'], ['表情收藏', 'plugin.qq-sticker.save']];
  const facts = features.map(([name, id]) => {
    const cap = actions.definitions.get(id);
    if (!cap) return name + '：当前未注册，不能执行。';
    const denied = permissions.decision?.(cap, context);
    return name + '：' + (denied ? '功能已注册，但本轮不可用（' + denied + '）。' : '本轮可用。');
  });
  return '[本轮真实能力状态]\n当前时间：' + new Date(now).toISOString() + '；聊天时间采用 Asia/Shanghai（UTC+08:00）。\n' + facts.join('\n')
    + '\n没有向当前用户开放、停用、调用失败与功能不存在是不同情况。不要把历史回答中的“我不会”当成能力事实。向用户用自然语言说明当前情况，不暴露工具名或内部配置。'
    + '语音本轮可用且用户请求语音时，应实际调用语音能力；失败就按真实结果说明，不凭空说功能不存在。'
    + '用户要求表情包、图库表情或图片表情时，先实际检索已确认的图片表情，再用真实编号发送独立图片消息；不能用 QQ 小黄脸、Unicode Emoji 或口头“发了”替代。用户明确要求 QQ 小表情或贴消息回应时才按对应类型执行。图库是否可用以本轮状态和检索结果为准，不能凭旧回答否认可用能力。'
    + '每个发送工具只证明对应返回结果里的消息已提交/确认，不证明最终另写的一段说明已经发到 QQ。不要先发占位文字“我试试”就当作完成图片请求。需要向 QQ 说明的内容请留给最终回复；相同已发文字不会重复发送。'
    + '主人要求某个时间提醒或稍后发消息时，必须创建带 delaySeconds 或 remindAt 的定时任务；普通计划不算提醒。只有保存成功才能承诺，到点由调度器发送。非主人不能创建主人的提醒。';
}
