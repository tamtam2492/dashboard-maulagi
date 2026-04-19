const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 2500;
const NONCOD_SYNC_PIPELINE_STATE_KEY = 'noncod_sync_pipeline_state';
const PERIODE_RE = /^\d{4}-\d{2}$/;

function normalizeText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizePeriodeList(periodes) {
  return [...new Set((Array.isArray(periodes) ? periodes : [periodes])
    .map((periode) => normalizeText(periode, 7))
    .filter((periode) => PERIODE_RE.test(periode)))]
    .sort();
}

function mergePeriodeLists(...lists) {
  return normalizePeriodeList(lists.flat());
}

function timingSafeSecretEqual(left, right) {
  const normalizedLeft = Buffer.from(normalizeText(left, 500));
  const normalizedRight = Buffer.from(normalizeText(right, 500));
  if (!normalizedLeft.length || !normalizedRight.length) return false;
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return crypto.timingSafeEqual(normalizedLeft, normalizedRight);
}

function createDefaultNoncodSyncPipelineState() {
  return {
    status: 'idle',
    dirty: false,
    version: 0,
    pendingPeriodes: [],
    activePeriodes: [],
    buildPeriodes: [],
    lastReason: '',
    lastInputAt: null,
    lastTriggeredAt: null,
    buildStartedAt: null,
    lastPublishedAt: null,
    lastError: '',
    updatedAt: null,
  };
}

function parseNoncodSyncPipelineState(value) {
  if (!value) return createDefaultNoncodSyncPipelineState();

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const fallback = createDefaultNoncodSyncPipelineState();
    return {
      status: ['idle', 'dirty', 'building', 'published', 'failed'].includes(parsed && parsed.status)
        ? parsed.status
        : fallback.status,
      dirty: !!(parsed && parsed.dirty),
      version: Math.max(0, Number(parsed && parsed.version) || 0),
      pendingPeriodes: normalizePeriodeList(parsed && parsed.pendingPeriodes),
      activePeriodes: normalizePeriodeList(parsed && parsed.activePeriodes),
      buildPeriodes: normalizePeriodeList(parsed && parsed.buildPeriodes),
      lastReason: normalizeText(parsed && parsed.lastReason, 80),
      lastInputAt: normalizeText(parsed && parsed.lastInputAt, 40) || null,
      lastTriggeredAt: normalizeText(parsed && parsed.lastTriggeredAt, 40) || null,
      buildStartedAt: normalizeText(parsed && parsed.buildStartedAt, 40) || null,
      lastPublishedAt: normalizeText(parsed && parsed.lastPublishedAt, 40) || null,
      lastError: normalizeText(parsed && parsed.lastError, 500),
      updatedAt: normalizeText(parsed && parsed.updatedAt, 40) || null,
    };
  } catch {
    return createDefaultNoncodSyncPipelineState();
  }
}

function buildSelfNoncodSyncUrl(env = process.env) {
  const explicitUrl = normalizeText(env.NONCOD_PIPELINE_TRIGGER_URL, 500);
  if (explicitUrl) return explicitUrl;

  const vercelUrl = normalizeText(env.VERCEL_URL, 300)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!vercelUrl) return '';

  return `https://${vercelUrl}/api/noncod-sync`;
}

function getNoncodPipelineTriggerMode(env = process.env) {
  const explicitUrl = normalizeText(env.NONCOD_PIPELINE_TRIGGER_URL, 500);
  if (explicitUrl) return 'external';
  return buildSelfNoncodSyncUrl(env) ? 'self' : 'disabled';
}

function getNoncodPipelineTriggerConfig(env = process.env) {
  const url = buildSelfNoncodSyncUrl(env);
  return {
    url,
    mode: getNoncodPipelineTriggerMode(env),
    secret: normalizeText(env.NONCOD_PIPELINE_TRIGGER_SECRET, 500)
      || normalizeText(env.NONCOD_SYNC_SECRET, 500),
    service: normalizeText(env.NONCOD_PIPELINE_SERVICE, 120) || 'dashboard-maulagi',
    timeoutMs: Number(env.NONCOD_PIPELINE_TRIGGER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

function isNoncodPipelineTriggerEnabled(env = process.env) {
  const config = getNoncodPipelineTriggerConfig(env);
  return !!(config.url && config.secret);
}

function buildNoncodPipelineTriggerPayload(options = {}, env = process.env) {
  const config = getNoncodPipelineTriggerConfig(env);
  return {
    reason: normalizeText(options.reason || 'background_sync', 80) || 'background_sync',
    periodes: normalizePeriodeList(options.periodes),
    source: normalizeText(options.source || 'api', 80) || 'api',
    force: options.force !== false,
    service: config.service,
    requestedAt: new Date().toISOString(),
  };
}

async function sendNoncodPipelineTrigger(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  const config = getNoncodPipelineTriggerConfig(env);
  if (!config.url || !config.secret) return { skipped: true, reason: 'disabled', mode: config.mode, target: config.url || '' };
  if (typeof fetchImpl !== 'function') return { skipped: true, reason: 'fetch_unavailable', mode: config.mode, target: config.url };

  const payload = buildNoncodPipelineTriggerPayload(options, env);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Secret': config.secret,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });

    return {
      skipped: false,
      ok: response.ok,
      status: response.status,
      mode: config.mode,
      target: config.url,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildNoncodPipelineTriggerFailureResult(error, env = process.env) {
  const config = getNoncodPipelineTriggerConfig(env);
  return {
    skipped: false,
    ok: false,
    status: 0,
    mode: config.mode,
    target: config.url,
    error: normalizeText(error && error.message ? error.message : error, 500) || 'trigger_failed',
  };
}

function buildNoncodSelfTriggerEnv(env = process.env) {
  const selfUrl = buildSelfNoncodSyncUrl({
    ...env,
    NONCOD_PIPELINE_TRIGGER_URL: '',
  });
  const selfSecret = normalizeText(env.NONCOD_SYNC_SECRET, 500);
  if (!selfUrl || !selfSecret) return null;
  return {
    ...env,
    NONCOD_PIPELINE_TRIGGER_URL: selfUrl,
    NONCOD_PIPELINE_TRIGGER_SECRET: selfSecret,
  };
}

async function sendNoncodPipelineTriggerWithSelfFallback(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  let primaryResult;
  try {
    primaryResult = await sendNoncodPipelineTrigger(options, env, fetchImpl);
  } catch (error) {
    primaryResult = buildNoncodPipelineTriggerFailureResult(error, env);
  }

  if (primaryResult.ok || primaryResult.skipped) return primaryResult;

  const fallbackEnv = buildNoncodSelfTriggerEnv(env);
  if (!fallbackEnv) return primaryResult;

  const fallbackConfig = getNoncodPipelineTriggerConfig(fallbackEnv);
  if (!fallbackConfig.url || fallbackConfig.url === primaryResult.target) return primaryResult;

  let fallbackResult;
  try {
    fallbackResult = await sendNoncodPipelineTrigger(options, fallbackEnv, fetchImpl);
  } catch (error) {
    fallbackResult = buildNoncodPipelineTriggerFailureResult(error, fallbackEnv);
  }

  return {
    ...fallbackResult,
    fallbackUsed: true,
    fallbackFrom: primaryResult.target || '',
  };
}

function queueNoncodPipelineTrigger(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  if (!isNoncodPipelineTriggerEnabled(env)) return false;
  sendNoncodPipelineTriggerWithSelfFallback(options, env, fetchImpl).catch(() => {});
  return true;
}

async function readNoncodSyncPipelineState(supabase) {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', NONCOD_SYNC_PIPELINE_STATE_KEY)
    .maybeSingle();
  return parseNoncodSyncPipelineState(data && data.value);
}

async function writeNoncodSyncPipelineState(supabase, state) {
  const normalizedState = parseNoncodSyncPipelineState({
    ...createDefaultNoncodSyncPipelineState(),
    ...(state || {}),
    updatedAt: new Date().toISOString(),
  });

  await supabase.from('settings').upsert({
    key: NONCOD_SYNC_PIPELINE_STATE_KEY,
    value: JSON.stringify(normalizedState),
  });

  return normalizedState;
}

async function markNoncodSyncDirty(supabase, options = {}) {
  const currentState = await readNoncodSyncPipelineState(supabase);
  return writeNoncodSyncPipelineState(supabase, {
    ...currentState,
    status: currentState.status === 'building' ? 'building' : 'dirty',
    dirty: true,
    pendingPeriodes: mergePeriodeLists(currentState.pendingPeriodes, options.periodes),
    lastReason: normalizeText(options.reason || currentState.lastReason || 'write', 80),
    lastInputAt: options.timestamp || new Date().toISOString(),
    lastError: currentState.status === 'failed' ? currentState.lastError : '',
  });
}

async function markNoncodSyncQueued(supabase, options = {}) {
  const currentState = await readNoncodSyncPipelineState(supabase);
  return writeNoncodSyncPipelineState(supabase, {
    ...currentState,
    status: currentState.status === 'building' ? 'building' : 'dirty',
    dirty: true,
    pendingPeriodes: mergePeriodeLists(currentState.pendingPeriodes, options.periodes),
    lastReason: normalizeText(options.reason || currentState.lastReason || 'background_sync', 80),
    lastTriggeredAt: options.timestamp || new Date().toISOString(),
  });
}

async function markNoncodSyncBuilding(supabase, options = {}) {
  const currentState = await readNoncodSyncPipelineState(supabase);
  if (currentState.status === 'building') {
    return { alreadyBuilding: true, state: currentState };
  }

  const buildPeriodes = mergePeriodeLists(options.periodes, currentState.pendingPeriodes);
  const nextState = await writeNoncodSyncPipelineState(supabase, {
    ...currentState,
    status: 'building',
    dirty: false,
    buildPeriodes,
    pendingPeriodes: [],
    buildStartedAt: new Date().toISOString(),
    lastTriggeredAt: new Date().toISOString(),
    lastReason: normalizeText(options.reason || currentState.lastReason || 'background_sync', 80),
    lastError: '',
  });

  return { alreadyBuilding: false, state: nextState };
}

async function markNoncodSyncPublished(supabase, options = {}) {
  const currentState = await readNoncodSyncPipelineState(supabase);
  return writeNoncodSyncPipelineState(supabase, {
    ...currentState,
    status: currentState.dirty ? 'dirty' : 'published',
    version: currentState.version + 1,
    activePeriodes: mergePeriodeLists(options.periodes, currentState.buildPeriodes),
    buildPeriodes: [],
    buildStartedAt: null,
    lastPublishedAt: new Date().toISOString(),
    lastReason: normalizeText(options.reason || currentState.lastReason || 'publish', 80),
    lastError: '',
  });
}

async function markNoncodSyncFailed(supabase, options = {}) {
  const currentState = await readNoncodSyncPipelineState(supabase);
  return writeNoncodSyncPipelineState(supabase, {
    ...currentState,
    status: 'failed',
    dirty: true,
    pendingPeriodes: mergePeriodeLists(currentState.pendingPeriodes, currentState.buildPeriodes, options.periodes),
    buildPeriodes: [],
    buildStartedAt: null,
    lastReason: normalizeText(options.reason || currentState.lastReason || 'background_sync', 80),
    lastError: normalizeText(options.error, 500),
  });
}

module.exports = {
  NONCOD_SYNC_PIPELINE_STATE_KEY,
  buildSelfNoncodSyncUrl,
  buildNoncodPipelineTriggerPayload,
  createDefaultNoncodSyncPipelineState,
  getNoncodPipelineTriggerConfig,
  getNoncodPipelineTriggerMode,
  isNoncodPipelineTriggerEnabled,
  markNoncodSyncBuilding,
  markNoncodSyncDirty,
  markNoncodSyncQueued,
  markNoncodSyncFailed,
  markNoncodSyncPublished,
  mergePeriodeLists,
  normalizePeriodeList,
  parseNoncodSyncPipelineState,
  queueNoncodPipelineTrigger,
  readNoncodSyncPipelineState,
  sendNoncodPipelineTrigger,
  sendNoncodPipelineTriggerWithSelfFallback,
  timingSafeSecretEqual,
  writeNoncodSyncPipelineState,
};