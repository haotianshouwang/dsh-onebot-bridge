// 统一执行结果协议（protocol 1）。
//
// 背景：OneBot 的 status=ok/retcode=0 只代表网关受理了这条 API，不代表目标操作已经生效。
// 本模块定义 8 个状态、合法转换和归一化函数；现有 outcome 字段保持不变，新增 state 作为
// 真实语义，调用方按需迁移，避免一次性改坏管理台、插件与测试。
//
// 语义：
//   requested  已提出请求（参数已通过校验，尚未授权）
//   authorized 权限与范围检查通过（执行身份有效）
//   submitted  请求已提交给下游（例如 WS 已写出、HTTP 已返回 2xx）
//   accepted   下游明确受理（OneBot status=async，或空间接口返回 code=0 但没有回读）
//   confirmed  已按该能力的验证契约拿到成功证据（回读、message_id 对账等）
//   failed     有明确失败证据（下游拒绝、参数/权限错误、连接未建立）
//   unknown    证据不足（超时、断线、结果无法判定）；不得自动重试
//   cancelled  操作被取消（用户撤销、权限失效、插件停用）
export const RESULT_PROTOCOL = 1;

export const RESULT_STATES = Object.freeze([
  'requested', 'authorized', 'submitted', 'accepted', 'confirmed', 'failed', 'unknown', 'cancelled'
]);

const TRANSITIONS = Object.freeze({
  requested: ['authorized', 'submitted', 'failed', 'cancelled'],
  authorized: ['submitted', 'accepted', 'failed', 'cancelled'],
  submitted: ['accepted', 'confirmed', 'failed', 'unknown'],
  accepted: ['confirmed', 'unknown', 'failed'],
  confirmed: [],
  failed: [],
  unknown: ['confirmed', 'failed'],
  cancelled: []
});

const LABELS = Object.freeze({
  requested: '已请求', authorized: '已授权', submitted: '已提交', accepted: '下游已受理',
  confirmed: '已验证', failed: '失败', unknown: '结果未知', cancelled: '已取消'
});

// 给模型看的一句话约束：非 confirmed 状态不得被描述成「已经完成」。
const NOTES = Object.freeze({
  submitted: '网关已提交，尚未收到对端回执；不要声称对方已经收到或读到。',
  accepted: '下游已受理，尚未确认生效；不要声称已经完成。',
  unknown: '结果未知；不要声称成功，也不要自动重试。',
  failed: '已失败；不要声称成功。',
  cancelled: '已取消；不要声称已经执行。'
});

// 旧字段值到协议状态的映射。只用于读旧结果，不写回 outcome。
const LEGACY = Object.freeze({
  ok: 'confirmed', success: 'confirmed', succeeded: 'confirmed',
  duplicate: 'accepted', skipped: 'cancelled', 'not-sent': 'cancelled', canceled: 'cancelled',
  timeout: 'unknown', pending: 'submitted'
});

export function isResultState(value) {
  return RESULT_STATES.includes(value);
}

export function isTerminal(state) {
  return state === 'confirmed' || state === 'failed' || state === 'cancelled';
}

export function canTransition(from, to) {
  return isResultState(from) && isResultState(to) && (TRANSITIONS[from] || []).includes(to);
}

export function stateLabel(state) {
  return LABELS[state] || String(state || '');
}

export function stateNote(state) {
  return NOTES[state] || '';
}

export function classifyError(error) {
  if (!error) return 'failed';
  if (isResultState(error.state)) return error.state;
  const code = String(error.code || '');
  if (code === 'UNKNOWN_OUTCOME') return 'unknown';
  if (code === 'CANCELLED' || code === 'PLUGIN_CANCELLED') return 'cancelled';
  if (code === 'ACCEPTED') return 'accepted';
  return 'failed';
}

// 把一个历史结果（outcome/ok/error）映射为协议状态。
// 注意：这里只做分类，不改变 outcome；能力级契约由 normalizeResult 应用。
export function classify(raw) {
  if (raw == null) return 'unknown';
  if (typeof raw !== 'object') return 'unknown';
  if (isResultState(raw.state)) return raw.state;
  const legacy = String(raw.outcome ?? '').toLowerCase();
  if (isResultState(legacy)) return legacy;
  if (LEGACY[legacy]) return LEGACY[legacy];
  if (raw.code === 'UNKNOWN_OUTCOME') return 'unknown';
  if (raw.code === 'CANCELLED' || raw.code === 'PLUGIN_CANCELLED') return 'cancelled';
  if (raw.ok === false) return 'failed';
  if (raw.error) return 'failed';
  // 动作正常返回但没有显式 outcome：按现有语义视为该能力报告成功，
  // 具体是否算 confirmed 仍由 capability 契约决定。
  return 'confirmed';
}

function readbackOk(contract, raw) {
  if (typeof contract?.readback !== 'function') return false;
  try {
    return contract.readback(raw) === true;
  } catch {
    return false;
  }
}

function applyContract(state, raw, contract) {
  if (!contract) return state;
  if (contract.messageReceipt && raw?.messageStored === true && raw?.data?.message_id != null) return 'confirmed';
  if (contract.verify === 'readback') {
    if (readbackOk(contract, raw)) return 'confirmed';
    // 有回读能力但没读到匹配结果：已提交/已受理都不能算成功。
    if (state === 'confirmed' || state === 'submitted' || state === 'accepted') return 'unknown';
  }
  if (state === 'confirmed' && contract.ack === 'accepted') return 'accepted';
  if (state === 'confirmed' && contract.ack === 'submitted') return 'submitted';
  return state;
}

function evidenceOf(contract, raw) {
  if (typeof contract?.evidence !== 'function') return {};
  try {
    const value = contract.evidence(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// 归一化：返回新对象，保留原字段（含 outcome），新增 state/verified/evidence/protocol。
// raw 已被归一化时仍重新应用契约，允许动作在拿到回读后再升级状态。
export function normalizeResult(raw, {capability = '', contract = null} = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : raw == null ? {} : {value: raw};
  const base = {...source};
  let state = raw == null ? 'unknown' : classify(source);
  if (contract) state = applyContract(state, source, contract);
  const evidence = evidenceOf(contract, source);
  if (base?.data && typeof base.data === 'object' && base.data.message_id != null && evidence.messageId == null) {
    evidence.messageId = String(base.data.message_id);
  }
  if (base?.id != null && evidence.id == null) evidence.id = String(base.id).slice(0, 200);
  if (base?.retcode != null && evidence.retcode == null) evidence.retcode = Number(base.retcode);
  const result = {
    ...base,
    state,
    verified: state === 'confirmed',
    evidence,
    protocol: RESULT_PROTOCOL,
    finishedAt: new Date().toISOString()
  };
  if (capability) result.capability = String(capability).slice(0, 100);
  if (result.note == null || result.note === '') {
    const note = stateNote(state);
    if (note) result.note = note;
  }
  return result;
}

// 供内部调用方读取状态：新结果看 state，旧结果回退 outcome。
export function stateOf(result) {
  if (result && isResultState(result.state)) return result.state;
  return classify(result);
}
