// 自由模式只取消业务节奏，不授予新的身份、动作或聊天范围。
export function freeMode(store) {
  const item = store.data.framework.nativePackages?.['qq-autonomy'];
  return item?.enabled === true && !item.uninstalled && !item.health?.quarantined && item.config?.enabled === true && item.config?.freeMode === true;
}
