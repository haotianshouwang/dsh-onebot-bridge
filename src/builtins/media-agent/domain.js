export const MEDIA_PLATFORMS = Object.freeze(['bilibili', 'douyin']);

export const MEDIA_STATE_VERSION = 2;

export function defaultMediaState() {
  return {
    version: MEDIA_STATE_VERSION,
    runs: [],
    outbound: [],
    messageLock: null,
    platformRecords: {
      bilibili: {lastSuccessAt: null},
      douyin: {lastSuccessAt: null}
    }
  };
}

export function migrateMediaState(value) {
  const fallback = defaultMediaState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const runs = Array.isArray(value.runs)
    ? value.runs.filter(row => row && typeof row === 'object').slice(-200)
    : [];
  const outbound = Array.isArray(value.outbound)
    ? value.outbound.filter(row => row && typeof row === 'object').slice(-200)
    : [];
  const messageLock = value.messageLock && typeof value.messageLock === 'object'
    ? normalizeMessageLock(value.messageLock)
    : null;
  const records = value.platformRecords && typeof value.platformRecords === 'object'
    ? value.platformRecords
    : {};
  return {
    version: MEDIA_STATE_VERSION,
    runs,
    outbound,
    messageLock,
    platformRecords: {
      bilibili: normalizeRecord(records.bilibili),
      douyin: normalizeRecord(records.douyin)
    }
  };
}

function normalizeMessageLock(value) {
  if (typeof value.token !== 'string' || !value.token || !Number.isFinite(Number(value.expiresAt))) return null;
  if (Number(value.expiresAt) <= Date.now()) return null;
  return {token: value.token.slice(0, 80), expiresAt: Number(value.expiresAt)};
}

function normalizeRecord(value) {
  return {
    lastSuccessAt: typeof value?.lastSuccessAt === 'string' ? value.lastSuccessAt : null
  };
}
