// 表情包自动收藏。
//
// 两条链路：
// 1. `fromResource` —— 联网查资料把图发出去之后，按资源编号顺手收进库（"找回来的自己存下来"）。
// 2. `fromMessage`  —— 聊天里收到图片时，按配置自动收进库（"偷表情包"的自动化）。
//
// 自动收藏是**系统行为**，不走模型工具授权：它只由表情包自己的开关与作用范围决定，
// 不受"这个用户有没有 save 权限"影响。写库失败只记日志，绝不打断消息收发。

export function createStickerAutoSave({stickers, readResource, fetchMessageBytes, scope, log = () => {}}) {
  // 与插件作用范围判定保持一致：先看人（allUsers 或名单），再看聊天类型与群号。
  const allowed = context => {
    const {scope: sc} = scope();
    if (!sc) return false;
    const actorOk = sc.allUsers === true || (sc.users || []).includes(String(context.actor));
    if (!actorOk) return false;
    return context.kind === 'group' ? (sc.groups || []).includes(String(context.peer)) : sc.private === true;
  };

  const remember = async (bytes, context, {name, source}) => {
    if (!bytes?.length) return null;
    const {sticker, deduped} = await stickers.save({bytes, name, source, context});
    return {id: sticker.id, deduped};
  };

  return {
    /** 联网查资料发图成功后调用；resourceId 由 qq-web 返回。 */
    async fromResource(resourceId, context, meta = {}) {
      if (!scope().config?.autoSaveSent) return null;
      if (!allowed(context)) return null;
      try {
        const bytes = await readResource(String(resourceId), context);
        const saved = await remember(bytes, context, {name: meta.name, source: 'auto-sent'});
        if (saved) log('info', '表情自动收藏（发图）', {id: saved.id, deduped: saved.deduped});
        return saved;
      } catch (error) {
        log('warn', '表情自动收藏失败：' + String(error?.message || error).slice(0, 120));
        return null;
      }
    },

    /** 收到带图片的消息时调用；与发图链路互不影响。 */
    async fromMessage(message, context) {
      if (!scope().config?.autoSaveIncoming) return null;
      if (!allowed(context)) return null;
      const images = (message.parts || []).filter(p => p.type === 'image');
      const saved = [];
      for (let index = 0; index < Math.min(images.length, 3); index += 1) {
        try {
          const bytes = await fetchMessageBytes(message, index);
          if (!bytes?.length) continue;
          const row = await remember(bytes, context, {name: message.sender || '群友发的表情', source: 'auto-incoming'});
          if (row) saved.push(row.id);
        } catch (error) {
          log('warn', '表情自动收藏失败：' + String(error?.message || error).slice(0, 120));
        }
      }
      if (saved.length) log('info', '表情自动收藏（收图）', {count: saved.length});
      return saved.length ? saved : null;
    }
  };
}
