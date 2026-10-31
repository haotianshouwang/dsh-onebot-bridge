// 表情包自动收藏。
//
// 两条链路：
// 1. `fromResource` —— 联网查资料把图发出去之后，按资源编号顺手收进库（"找回来的自己存下来"）。
// 2. `fromMessage`  —— 聊天里收到图片时，按配置自动收进库（"偷表情包"的自动化）。
//
// 自动收藏是**系统行为**，不走模型工具授权：它只由表情包自己的开关与作用范围决定，
// 不受"这个用户有没有 save 权限"影响。写库失败只记日志，绝不打断消息收发。
//
// 概率、冷却、单条上限和排除词都在真正取图之前判定，配置页展示的百分比就是这里使用的百分比。

export function createStickerAutoSave({stickers, readResource, fetchMessageBytes, scope, log = () => {}, random = Math.random, now = () => Date.now()}) {
  const lastAccepted = new Map();

  // 与插件作用范围判定保持一致：先看人（allUsers 或名单），再看聊天类型与群号。
  const allowed = context => {
    const current = scope();
    const sc = current.scope;
    if (current.enabled === false || !sc) return false;
    const actorOk = sc.allUsers === true || (sc.users || []).includes(String(context.actor));
    if (!actorOk) return false;
    return context.kind === 'group' ? (sc.groups || []).includes(String(context.peer)) : sc.private === true;
  };

  const config = () => scope().config || {};

  /**
   * 一次触发只抽一次概率，避免一条消息有多张图时分别抽中不同结果。
   * 冷却只在真正放行后更新；被概率或排除词拦下不会消耗冷却。
   */
  const accept = (context, text = '') => {
    const current = config();
    const probability = Math.max(0, Math.min(100, Number(current.collectProbability ?? 100)));
    if (!Number.isFinite(probability) || probability <= 0) return false;
    if (probability < 100 && random() * 100 >= probability) return false;
    const keywords = Array.isArray(current.excludeKeywords) ? current.excludeKeywords : [];
    const body = String(text || '');
    if (keywords.some(keyword => keyword && body.includes(String(keyword)))) return false;
    const cooldown = Math.max(0, Math.min(3600, Number(current.collectCooldownSec) || 0));
    const key = String(context.key || context.peer || '');
    const acceptedAt = now();
    if (cooldown > 0 && acceptedAt - (lastAccepted.get(key) || 0) < cooldown * 1000) return false;
    lastAccepted.set(key, acceptedAt);
    if (lastAccepted.size > 200) lastAccepted.delete(lastAccepted.keys().next().value);
    return true;
  };

  const remember = async (bytes, context, {name, source}) => {
    if (!bytes?.length) return null;
    const {sticker, deduped} = await stickers.save({bytes, name, source, context, max: config().maxStickers});
    return {id: sticker.id, deduped};
  };

  return {
    /** 联网查资料发图成功后调用；resourceId 由 qq-web 返回。 */
    async fromResource(resourceId, context, meta = {}) {
      if (!config().autoSaveSent) return null;
      if (!allowed(context)) return null;
      if (!accept(context, meta.name || '')) return null;
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
      if (!config().autoSaveIncoming) return null;
      if (!allowed(context)) return null;
      if (!accept(context, message.text || '')) return null;
      const images = (message.parts || []).filter(p => p.type === 'image');
      const limit = Math.max(1, Math.min(10, Number(config().maxPerMessage) || 3));
      const saved = [];
      for (let index = 0; index < Math.min(images.length, limit); index += 1) {
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
