// 嵌入模型客户端：硅基流动 / 任意 OpenAI 兼容服务（Ollama、LM Studio、vLLM 等）。
//
// 只做一件事：把 1–16 段文字变成归一化向量。没有密钥或服务不可用时由调用方退化为关键词检索，
// 记忆本身不会因为嵌入失败而丢失。
import { normalizeVector } from './store.js';

const MAX_BATCH = 16;
const MAX_TEXT = 8000;
const MAX_BYTES = 8 * 1024 * 1024;

export function embeddingConfigured(config = {}) {
  return ['siliconflow', 'openai'].includes(config.embeddingProvider);
}

export function embeddingKey(config = {}) {
  const explicit = String(config.embeddingKey || '').trim();
  if (explicit) return explicit;
  const envName = config.embeddingProvider === 'siliconflow' ? 'SILICONFLOW_API_KEY' : 'MEMORY_API_KEY';
  return String(process.env[envName] || '').trim();
}

export function embeddingEndpoint(config = {}) {
  const value = String(config.embeddingUrl || '').trim();
  if (value) return value;
  return config.embeddingProvider === 'siliconflow' ? 'https://api.siliconflow.cn/v1/embeddings' : '';
}

export async function embedTexts(texts, config = {}, { signal, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!embeddingConfigured(config)) throw new Error('未启用嵌入模型');
  if (!Array.isArray(texts) || !texts.length || texts.length > MAX_BATCH) throw new Error('嵌入文本数量无效');
  const input = texts.map(text => String(text || '').slice(0, MAX_TEXT));
  const endpoint = embeddingEndpoint(config);
  if (!endpoint) throw new Error('请填写嵌入模型地址');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('嵌入模型地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('嵌入模型地址必须是 http(s) 且不能包含账号密码');

  const provider = config.embeddingProvider;
  const key = embeddingKey(config);
  if (provider === 'siliconflow' && !key) throw new Error('尚未填写嵌入模型密钥：请在设置页填写，或设置环境变量 SILICONFLOW_API_KEY');
  const model = String(config.embeddingModel || 'BAAI/bge-m3').trim();
  if (!model) throw new Error('请填写嵌入模型名称');

  const deadline = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;

  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: composed, headers, body: JSON.stringify({ model, input, encoding_format: 'float' }) });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('嵌入模型请求超时或已取消');
    throw new Error('嵌入模型请求失败：' + String(error?.message || error).replaceAll(key || '\u0000', '[凭据已隐藏]').slice(0, 200));
  }
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).replaceAll(key || '\u0000', '[凭据已隐藏]').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error('嵌入模型请求失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : ''));
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('嵌入模型响应过大');
  const raw = await response.text().catch(() => '');
  if (raw.length > MAX_BYTES) throw new Error('嵌入模型响应过大');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('嵌入模型返回的不是 JSON'); }
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (!rows || rows.length !== input.length) throw new Error('嵌入模型返回数量不符');
  const vectors = [];
  for (const row of rows) {
    const values = Array.isArray(row?.embedding) ? row.embedding : null;
    if (!values || values.length < 8 || values.length > 8192 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('嵌入模型返回的向量无效');
    vectors.push(normalizeVector(values));
  }
  const dim = vectors[0].length;
  if (vectors.some(vector => vector.length !== dim)) throw new Error('嵌入模型返回的向量维度不一致');
  return { vectors, model, dim };
}

export async function embedOne(text, config = {}, options = {}) {
  const { vectors, model, dim } = await embedTexts([text], config, options);
  return { vector: vectors[0], model, dim };
}
