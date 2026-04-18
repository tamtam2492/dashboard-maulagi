const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 15000;
const OCR_JOB_PREFIX = 'ocr_job:';
const OCR_JOB_STALE_MS = 2 * 60 * 1000;

function normalizeText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeStatus(status) {
  return ['queued', 'processing', 'succeeded', 'failed'].includes(status) ? status : 'queued';
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return {
    channel: normalizeText(result.channel || 'Unknown', 120) || 'Unknown',
    total_bayar: Number.isFinite(Number(result.total_bayar)) ? Number(result.total_bayar) : null,
    jumlah_kirim_uang: Number.isFinite(Number(result.jumlah_kirim_uang)) ? Number(result.jumlah_kirim_uang) : null,
    admin: Number.isFinite(Number(result.admin)) ? Number(result.admin) : null,
    admin_dibayar: result.admin_dibayar === null || result.admin_dibayar === undefined
      ? null
      : !!result.admin_dibayar,
    nominal: Number.isFinite(Number(result.nominal)) ? Number(result.nominal) : null,
  };
}

function createOcrJobId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function buildOcrJobKey(jobId) {
  return OCR_JOB_PREFIX + normalizeText(jobId, 120);
}

function createDefaultOcrJobState(overrides = {}) {
  return {
    jobId: normalizeText(overrides.jobId, 120),
    status: normalizeStatus(overrides.status),
    storagePath: normalizeText(overrides.storagePath, 200),
    mimeType: normalizeText(overrides.mimeType, 120),
    source: normalizeText(overrides.source || 'input', 80) || 'input',
    createdAt: normalizeText(overrides.createdAt, 40) || null,
    updatedAt: normalizeText(overrides.updatedAt, 40) || null,
    startedAt: normalizeText(overrides.startedAt, 40) || null,
    finishedAt: normalizeText(overrides.finishedAt, 40) || null,
    requestedAt: normalizeText(overrides.requestedAt, 40) || null,
    lastTriggeredAt: normalizeText(overrides.lastTriggeredAt, 40) || null,
    error: normalizeText(overrides.error, 500),
    sizeBytes: Math.max(0, Number(overrides.sizeBytes) || 0),
    attempts: Math.max(0, Number(overrides.attempts) || 0),
    worker: normalizeText(overrides.worker, 120),
    result: normalizeResult(overrides.result),
  };
}

function parseOcrJobState(value) {
  if (!value) return createDefaultOcrJobState();

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return createDefaultOcrJobState(parsed || {});
  } catch {
    return createDefaultOcrJobState();
  }
}

function buildSelfOcrWorkerUrl(env = process.env) {
  const explicitUrl = normalizeText(env.OCR_PIPELINE_TRIGGER_URL, 500);
  if (explicitUrl) return explicitUrl;

  const vercelUrl = normalizeText(env.VERCEL_URL, 300)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  if (!vercelUrl) return '';
  return `https://${vercelUrl}/api/input?ocr=1&worker=1`;
}

function getOcrPipelineTriggerMode(env = process.env) {
  const explicitUrl = normalizeText(env.OCR_PIPELINE_TRIGGER_URL, 500);
  if (explicitUrl) return 'external';
  return buildSelfOcrWorkerUrl(env) ? 'self' : 'disabled';
}

function getOcrPipelineTriggerConfig(env = process.env) {
  const url = buildSelfOcrWorkerUrl(env);
  return {
    url,
    mode: getOcrPipelineTriggerMode(env),
    secret: normalizeText(env.OCR_PIPELINE_TRIGGER_SECRET, 500)
      || normalizeText(env.OCR_SYNC_SECRET, 500)
      || normalizeText(env.NONCOD_SYNC_SECRET, 500),
    service: normalizeText(env.OCR_PIPELINE_SERVICE, 120) || 'dashboard-maulagi',
    timeoutMs: Number(env.OCR_PIPELINE_TRIGGER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

function isOcrPipelineTriggerEnabled(env = process.env) {
  const config = getOcrPipelineTriggerConfig(env);
  return !!(config.url && config.secret);
}

function buildOcrJobTriggerPayload(options = {}, env = process.env) {
  const config = getOcrPipelineTriggerConfig(env);
  return {
    jobId: normalizeText(options.jobId, 120),
    source: normalizeText(options.source || 'input', 80) || 'input',
    requestedAt: new Date().toISOString(),
    service: config.service,
  };
}

async function sendOcrJobTrigger(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  const config = getOcrPipelineTriggerConfig(env);
  if (!config.url || !config.secret) return { skipped: true, reason: 'disabled', mode: config.mode, target: config.url || '' };
  if (typeof fetchImpl !== 'function') return { skipped: true, reason: 'fetch_unavailable', mode: config.mode, target: config.url };

  const payload = buildOcrJobTriggerPayload(options, env);
  if (!payload.jobId) return { skipped: true, reason: 'missing_job_id', mode: config.mode, target: config.url };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OCR-Secret': config.secret,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });

    let responseBody = null;
    try {
      if (response && typeof response.clone === 'function') {
        responseBody = await response.clone().json();
      } else if (response && typeof response.json === 'function') {
        responseBody = await response.json();
      }
    } catch {
      responseBody = null;
    }

    const workerStatus = normalizeText(responseBody && responseBody.status, 40);
    const handledByWorker = ['processing', 'succeeded', 'failed'].includes(workerStatus);

    return {
      skipped: false,
      ok: response.ok || handledByWorker,
      status: response.status,
      workerStatus,
      error: normalizeText(responseBody && responseBody.error, 500),
      mode: config.mode,
      target: config.url,
    };
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
      throw new Error('OCR worker timeout setelah ' + String(config.timeoutMs) + 'ms.');
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function queueOcrJobTrigger(options = {}, env = process.env, fetchImpl = globalThis.fetch) {
  if (!isOcrPipelineTriggerEnabled(env)) return false;
  sendOcrJobTrigger(options, env, fetchImpl).catch(() => {});
  return true;
}

function timingSafeSecretEqual(left, right) {
  const normalizedLeft = Buffer.from(normalizeText(left, 500));
  const normalizedRight = Buffer.from(normalizeText(right, 500));
  if (!normalizedLeft.length || !normalizedRight.length) return false;
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return crypto.timingSafeEqual(normalizedLeft, normalizedRight);
}

async function readOcrJobState(supabase, jobId) {
  const normalizedJobId = normalizeText(jobId, 120);
  if (!normalizedJobId) return null;

  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', buildOcrJobKey(normalizedJobId))
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.value) return null;
  return parseOcrJobState(data.value);
}

async function writeOcrJobState(supabase, jobId, state) {
  const normalizedJobId = normalizeText(jobId, 120);
  if (!normalizedJobId) throw new Error('OCR job id wajib diisi.');

  const nextState = createDefaultOcrJobState({
    ...state,
    jobId: normalizedJobId,
    updatedAt: new Date().toISOString(),
  });

  const { error } = await supabase.from('settings').upsert({
    key: buildOcrJobKey(normalizedJobId),
    value: JSON.stringify(nextState),
  });

  if (error) throw error;
  return nextState;
}

async function createOcrJob(supabase, options = {}) {
  const jobId = normalizeText(options.jobId, 120) || createOcrJobId();
  return writeOcrJobState(supabase, jobId, {
    jobId,
    status: 'queued',
    storagePath: normalizeText(options.storagePath, 200),
    mimeType: normalizeText(options.mimeType, 120),
    source: normalizeText(options.source || 'input', 80) || 'input',
    sizeBytes: Math.max(0, Number(options.sizeBytes) || 0),
    attempts: 0,
    createdAt: new Date().toISOString(),
    requestedAt: new Date().toISOString(),
    lastTriggeredAt: new Date().toISOString(),
    error: '',
    worker: '',
    result: null,
  });
}

async function markOcrJobProcessing(supabase, jobId, options = {}) {
  const currentState = await readOcrJobState(supabase, jobId);
  if (!currentState) {
    return { missing: true, state: null };
  }

  if (currentState.status === 'succeeded' || currentState.status === 'failed') {
    return { missing: false, alreadyFinished: true, state: currentState };
  }

  if (currentState.status === 'processing') {
    return { missing: false, alreadyProcessing: true, state: currentState };
  }

  const nextState = await writeOcrJobState(supabase, jobId, {
    ...currentState,
    status: 'processing',
    attempts: currentState.attempts + 1,
    startedAt: currentState.startedAt || new Date().toISOString(),
    worker: normalizeText(options.worker, 120),
    error: '',
  });

  return { missing: false, alreadyFinished: false, alreadyProcessing: false, state: nextState };
}

async function markOcrJobSucceeded(supabase, jobId, options = {}) {
  const currentState = (await readOcrJobState(supabase, jobId)) || createDefaultOcrJobState({ jobId });
  return writeOcrJobState(supabase, jobId, {
    ...currentState,
    status: 'succeeded',
    finishedAt: new Date().toISOString(),
    error: '',
    worker: normalizeText(options.worker || currentState.worker, 120),
    result: normalizeResult(options.result),
    storagePath: normalizeText(options.storagePath || '', 200),
  });
}

async function markOcrJobFailed(supabase, jobId, options = {}) {
  const currentState = (await readOcrJobState(supabase, jobId)) || createDefaultOcrJobState({ jobId });
  return writeOcrJobState(supabase, jobId, {
    ...currentState,
    status: 'failed',
    finishedAt: new Date().toISOString(),
    error: normalizeText(options.error, 500),
    worker: normalizeText(options.worker || currentState.worker, 120),
    storagePath: normalizeText(options.storagePath || currentState.storagePath || '', 200),
  });
}

function isOcrJobStale(state, now = Date.now()) {
  const currentState = parseOcrJobState(state);
  if (!currentState.createdAt) return false;
  if (currentState.status === 'succeeded' || currentState.status === 'failed') return false;
  const createdAtMs = Date.parse(currentState.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return now - createdAtMs > OCR_JOB_STALE_MS;
}

module.exports = {
  OCR_JOB_PREFIX,
  OCR_JOB_STALE_MS,
  buildOcrJobKey,
  buildOcrJobTriggerPayload,
  buildSelfOcrWorkerUrl,
  createDefaultOcrJobState,
  createOcrJob,
  createOcrJobId,
  getOcrPipelineTriggerConfig,
  getOcrPipelineTriggerMode,
  isOcrJobStale,
  isOcrPipelineTriggerEnabled,
  markOcrJobFailed,
  markOcrJobProcessing,
  markOcrJobSucceeded,
  parseOcrJobState,
  queueOcrJobTrigger,
  readOcrJobState,
  sendOcrJobTrigger,
  timingSafeSecretEqual,
  writeOcrJobState,
};