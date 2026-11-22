// Observe the DSH stream waterfall. A usage sample replaces previous samples within an attempt.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const ERROR_CODES = new Set(['TRANSPORT', 'AUTH', 'RATE_LIMIT', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'MAX_TOKENS', 'ABORTED', 'CANCELLED', 'TIMEOUT', 'FAILED']);
const safeCode = value => ERROR_CODES.has(value) ? value : 'PROVIDER_ERROR';

export function createRuntimeMonitor({ctx, activity, resolveSession = () => null, log = () => {}}) {
  const scopes = new AsyncLocalStorage();
  const active = new Map();
  let stopped = false;
  let writeFailures = 0, lastWriteErrorAt = null;
  const safeRecord = value => {
    if (stopped) return;
    try { activity.record(value); } catch {
      writeFailures++;
      lastWriteErrorAt = Date.now();
      if (writeFailures === 1) log('warn', '活动账本写入失败，本次统计可能缺失');
    }
  };
  const listener = (options, next) => {
    const scope = (options.sessionId ? resolveSession(options.sessionId) : null) || scopes.getStore();
    if (!scope || stopped) return next();
    return (async function* () {
      const at = Date.now(), id = randomUUID();
      const meta = {...scope, id, at, kind: 'model', provider: options.provider, model: options.model, sessionId: options.sessionId || scope.sessionId, purpose: options.purpose || scope.purpose};
      let usage = null, status = 'interrupted', errorCode = '';
      active.set(id, {...meta, startedAt: at});
      safeRecord({...meta, status: 'running'});
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') {
            usage = chunk.usage;
            if (!stopped) active.set(id, {...active.get(id), usage});
            safeRecord({...meta, usage, status: 'running', durationMs: Date.now() - at});
          }
          if (chunk.type === 'finish') {
            status = ['stop', 'tool-calls'].includes(chunk.reason?.kind) ? 'completed' : chunk.reason?.kind === 'aborted' ? 'aborted' : 'failed';
            if (status === 'failed') errorCode = chunk.reason?.kind === 'max-tokens' ? 'MAX_TOKENS' : safeCode(chunk.reason?.failure?.code);
          }
          yield chunk;
        }
      } catch (error) { status = options.signal?.aborted ? 'aborted' : 'failed'; errorCode = safeCode(error?.code); throw error; }
      finally {
        if (options.signal?.aborted) status = 'aborted';
        safeRecord({...meta, usage, status, errorCode, durationMs: Date.now() - at});
        active.delete(id);
      }
    })();
  };
  const dispose = typeof ctx.on === 'function' ? ctx.on('llm/stream', listener) : null;
  return {
    scope: (meta, work) => scopes.run({...scopes.getStore(), ...meta}, work),
    currentScope: () => scopes.getStore(),
    snapshot: () => ({active: [...active.values()].slice(-30), activeCount: active.size, writeFailures, lastWriteErrorAt}),
    record: safeRecord,
    listener,
    stop() {
      for (const row of active.values()) safeRecord({...row, status: 'interrupted', durationMs: Date.now() - row.at});
      active.clear();
      stopped = true;
      dispose?.();
    }
  };
}
