// 统一错误分类：把散落的异常收敛为管理台和日志可以聚合的类别。
//
// 只做分类与脱敏，不改变抛出的错误；调用方仍拿原始异常。分类顺序从「最具体」到「兜底」，
// 避免“结果未知”被归类成普通网络错误，或“权限拒绝”被归类成下游失败。
export const ERROR_CLASSES = Object.freeze({
  input: '参数错误',
  permission: '权限拒绝',
  auth: '认证失败',
  network: '网络不可用',
  downstream: '下游拒绝',
  timeout: '请求超时',
  unknown: '结果未知',
  cancelled: '已取消',
  persistence: '持久化失败',
  plugin: '插件异常',
  internal: '内部异常'
});

const FS_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EBUSY', 'ENOENT']);

function sanitize(message) {
  return String(message ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/(access_token|token|cookie|password|secret)=([^&\s]+)/gi, '$1=[已隐藏]')
    .slice(0, 300);
}

export function classifyFailure(error) {
  if (!error) return 'internal';
  const code = String(error.code || '');
  const message = sanitize(error.message ?? error);

  if (code === 'UNKNOWN_OUTCOME') return 'unknown';
  if (code === 'CANCELLED' || code === 'PLUGIN_CANCELLED') return 'cancelled';
  if (code === 'PLUGIN_INPUT') return 'input';
  if (code === 'QUOTA') return 'permission';
  if (code === 'ACCEPTED') return 'downstream';
  if (code.startsWith('PLUGIN_')) return 'plugin';
  if (FS_CODES.has(code) && /(persist|state\.json|tasks\.json|write|rename|磁盘|写入)/i.test(message)) return 'persistence';
  if (FS_CODES.has(code) && /(persist|state\.json|tasks\.json)/i.test(String(error.stack || ''))) return 'persistence';

  if (/仅主人|尚未.*开放|未授权|已撤销|超出.*范围|不在监听|不能下放|额度|冷却|过于频繁|明确拒绝/i.test(message)) return 'permission';
  if (/缺少参数|不支持的参数|参数无效|文字参数|布尔参数|数字参数|数组参数|不能为空|须为|请填写|格式|无效的/i.test(message)) return 'input';
  if (/未登录|登录凭据|凭据不可用|账号验证失败|认证失败|鉴权|401|403/i.test(message)) return 'auth';
  // 同时出现“超时”和“结果未知”时，按结果未知处理：它决定能否自动重试。
  if (/结果未知|已发请求的结果未知|UNKNOWN|断线|连接断开|中断/i.test(message)) return 'unknown';
  if (/超时|timeout|ETIMEDOUT|AbortError/i.test(message)) return 'timeout';
  if (/未连接|网络|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|连接失败|无法连接/i.test(message)) return 'network';
  if (/retcode=|OneBot API 失败|网关|下游|上游拒绝|HTTP 5\d\d/i.test(message)) return 'downstream';
  if (/persist|state\.json|tasks\.json|ENOSPC|磁盘|写入失败/i.test(message)) return 'persistence';
  if (/插件|包已停用|插件处理超时|插件已停用/i.test(message)) return 'plugin';
  return 'internal';
}

export function failureOf(error) {
  const errorClass = classifyFailure(error);
  return {
    errorClass,
    label: ERROR_CLASSES[errorClass] || ERROR_CLASSES.internal,
    code: String(error?.code || '').slice(0, 60),
    message: sanitize(error?.message ?? error)
  };
}

export function classLabel(name) {
  return ERROR_CLASSES[name] || ERROR_CLASSES.internal;
}
