const { Readable } = require('stream');
const { requireAdmin } = require('./_auth');
const { rateLimit } = require('./_ratelimit');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { normalizeBankName } = require('./_bank');
const {
  createOcrJob,
  getOcrPipelineTriggerConfig,
  isOcrJobStale,
  isOcrPipelineTriggerEnabled,
  markOcrJobFailed,
  readOcrJobState,
  sendOcrJobTrigger,
  timingSafeSecretEqual,
} = require('./_ocr-job-pipeline');
const { processOcrJobById } = require('./_ocr-job-runner');
const {
  deleteCabangHold,
  upsertCabangHold,
} = require('./_noncod-cabang-holds');
const {
  aggregateOngkirByDate,
  findNoncodDateMatch,
  findSequentialAllocationDates,
  getOutstandingNominalForDate,
  prefetchNoncodMatchContext,
  getRecentPeriodes,
} = require('./_noncod-match');
const {
  applyStatusOverrides,
  readStatusOverridesByResi,
} = require('./_noncod-status-overrides');
const {
  deletePendingAllocation,
  normalizePendingDate,
  upsertPendingAllocation,
} = require('./_noncod-pending-allocations');
const {
  buildProofSignaturePayload,
  formatProofDuplicateMessage,
  parseProofSignatureValue,
} = require('./_proof-signature');
const { publishAdminWriteMarker } = require('./_admin-write-marker');
const {
  markNoncodSyncDirty,
  queueNoncodPipelineTrigger,
} = require('./_noncod-sync-pipeline');
const { getSupabase } = require('./_supabase');
const {
  getPeriodeFromDate,
  isPositiveTransferNominal,
  isValidTransferDate,
  normalizeTransferKet,
  parseTransferNominal,
  roundTransferNominal,
} = require('./_transfer-utils');

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, bucket: 'input-upload' }); // final upload submit per IP
const ocrLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, bucket: 'input-ocr-start' }); // OCR start per IP
const ocrStatusLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, bucket: 'input-ocr-status' }); // OCR polling per IP
const dupeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, bucket: 'input-dupe' }); // dupe/prefetch checks per IP
const MAX_OCR_IMAGE_SIZE = 5 * 1024 * 1024;

// Parse multipart/form-data tanpa dependency eksternal tambahan (pakai busboy)
const Busboy = require('busboy');

let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  vercelWaitUntil = null;
}

function getOcrJobId(req) {
  return String(req.query.job_id || req.query.jobId || req.body?.job_id || req.body?.jobId || '').trim();
}

function isOcrWorkerRequest(req) {
  return String(req.query.worker || '').trim() === '1';
}

function parseBase64ImageDataUrl(image) {
  const match = String(image || '').trim().match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;

  const mimeType = String(match[1] || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  const base64Body = String(match[2] || '').replace(/\s+/g, '');
  const buffer = Buffer.from(base64Body, 'base64');
  if (!buffer.length) return null;

  const extByMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };

  return {
    mimeType,
    buffer,
    ext: extByMime[mimeType] || 'jpg',
  };
}

function authorizeOcrWorkerRequest(req) {
  const expectedSecret = String(
    process.env.OCR_PIPELINE_TRIGGER_SECRET
    || process.env.OCR_SYNC_SECRET
    || process.env.NONCOD_SYNC_SECRET
    || ''
  ).trim();
  if (!expectedSecret) return false;

  const providedSecret = String(req.headers['x-ocr-secret'] || '').trim();
  if (!providedSecret) return false;
  return timingSafeSecretEqual(providedSecret, expectedSecret);
}

function hasExplicitOcrTriggerUrl() {
  return !!String(process.env.OCR_PIPELINE_TRIGGER_URL || '').trim();
}

function getOcrBackgroundScheduleMeta() {
  const triggerConfig = getOcrPipelineTriggerConfig();
  if (hasExplicitOcrTriggerUrl()) {
    return {
      backgroundStrategy: 'external_trigger',
      triggerMode: triggerConfig.mode,
      triggerTarget: triggerConfig.url,
      canFallbackInternally: typeof vercelWaitUntil === 'function',
    };
  }

  if (typeof vercelWaitUntil === 'function') {
    return {
      backgroundStrategy: 'internal_waituntil',
      triggerMode: 'internal',
      triggerTarget: '',
      canFallbackInternally: true,
    };
  }

  return {
    backgroundStrategy: 'unavailable',
    triggerMode: triggerConfig.mode,
    triggerTarget: triggerConfig.url,
    canFallbackInternally: false,
  };
}

function normalizeUploadFields(rawFields = {}) {
  const fields = rawFields && typeof rawFields === 'object' ? rawFields : {};

  return {
    ...fields,
    tgl_inputan: String(fields.tgl_inputan || fields.tanggal || '').trim(),
    nama_bank: String(fields.nama_bank || fields.bank_pengirim || '').trim(),
    nama_cabang: String(fields.nama_cabang || fields.cabang || '').trim(),
    nominal: fields.nominal,
    periode: String(fields.periode || '').trim(),
    context_key: String(fields.context_key || fields.contextKey || '').trim(),
  };
}

function normalizeClientInputErrorMessage(message) {
  const normalized = String(message || '').trim();
  if (/Unexpected end of form/i.test(normalized)) {
    return 'Upload multipart tidak lengkap atau rusak.';
  }
  return normalized || 'Input request tidak valid.';
}

function createClientInputError(message) {
  const error = new Error(normalizeClientInputErrorMessage(message));
  error.clientInputError = true;
  return error;
}

function getMultipartSourceStream(req) {
  if (req && typeof req.pipe === 'function' && typeof req.on === 'function') {
    return req;
  }

  const body = req && Object.prototype.hasOwnProperty.call(req, 'body') ? req.body : null;
  if (Buffer.isBuffer(body)) return Readable.from([body]);
  if (typeof body === 'string') return Readable.from([body]);
  if (body && typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body);

  return Readable.from([]);
}

function getInputErrorStatusCode(err) {
  const message = String(err && err.message || '');
  if (err && err.clientInputError) return 400;

  return /wajib diisi|Nominal harus|Format tanggal|Cabang tidak terdaftar|Tanggal NONCOD|Belum ada data NONCOD|sudah lunas|belum tersedia|bukti transfer|multipart|Format file|File terlalu besar|Unexpected end of form|Content-Type upload/i.test(message)
    ? 400
    : 500;
}

function shouldLogInputError(err) {
  return getInputErrorStatusCode(err) >= 500;
}

function buildInputMarkerScopes(options = {}) {
  const scopes = ['overview', 'noncod', 'transfer', 'audit', 'admin_monitor'];
  if (options.adminPendingUpload || options.pendingPayload) scopes.push('pending_allocation');
  return [...new Set(scopes)];
}

async function failQueuedOcrJob(jobState, message, logMeta = {}) {
  const supabase = getSupabase();

  await markOcrJobFailed(supabase, jobState.jobId, {
    worker: String(logMeta.worker || '').trim(),
    error: message,
    storagePath: '',
  }).catch(() => {});

  if (jobState.storagePath) {
    await supabase.storage.from('bukti-transfer').remove([jobState.storagePath]).catch(() => {});
  }

  logError('ocr', message, {
    method: 'POST',
    action: logMeta.action || 'background_schedule',
    jobId: jobState.jobId,
    status: logMeta.status || 0,
  });
}

function shouldFallbackToInternalOcrWorker(result) {
  if (!result) return false;
  return result.ok !== true;
}

function runInternalOcrBackgroundTask(jobState) {
  return processOcrJobById(jobState.jobId, {
    workerName: 'vercel-waituntil-ocr-worker',
  }).catch(async (err) => {
    await failQueuedOcrJob(jobState, err && err.message ? err.message : 'OCR worker gagal dijalankan di background.', {
      action: 'waituntil_worker',
      worker: 'vercel-waituntil-ocr-worker',
    });
  });
}

function scheduleOcrBackgroundTask(jobState) {
  const scheduleMeta = getOcrBackgroundScheduleMeta();
  const runViaExternalTrigger = scheduleMeta.backgroundStrategy === 'external_trigger';
  const canFallbackInternally = scheduleMeta.canFallbackInternally;
  const task = runViaExternalTrigger
    ? sendOcrJobTrigger({
        jobId: jobState.jobId,
        source: 'input',
      }).then(async (result) => {
        if (result && result.ok) return result;

        if (canFallbackInternally && shouldFallbackToInternalOcrWorker(result)) {
          logError('ocr-trigger', 'OCR external trigger gagal; fallback ke worker internal.', {
            method: 'POST',
            action: 'trigger_fallback',
            jobId: jobState.jobId,
            triggerStatus: result && result.status ? result.status : 0,
            triggerMode: result && result.mode ? result.mode : 'external',
            triggerTarget: result && result.target ? result.target : scheduleMeta.triggerTarget,
            workerStatus: result && result.workerStatus ? result.workerStatus : '',
            reason: result && result.reason ? result.reason : '',
            fallback: 'internal_waituntil',
          });
          return runInternalOcrBackgroundTask(jobState);
        }

        await failQueuedOcrJob(jobState, 'OCR worker gagal dipicu.', {
          action: 'trigger_worker',
          worker: 'ocr-trigger',
          status: result && result.status ? result.status : 0,
        });
        return result;
      }).catch(async (err) => {
        if (canFallbackInternally) {
          logError('ocr-trigger', err && err.message ? err.message : 'OCR external trigger gagal; fallback ke worker internal.', {
            method: 'POST',
            action: 'trigger_fallback',
            jobId: jobState.jobId,
            triggerMode: scheduleMeta.triggerMode,
            triggerTarget: scheduleMeta.triggerTarget,
            fallback: 'internal_waituntil',
          });
          return runInternalOcrBackgroundTask(jobState);
        }

        await failQueuedOcrJob(jobState, err && err.message ? err.message : 'OCR worker gagal dipicu.', {
          action: 'trigger_worker',
          worker: 'ocr-trigger',
        });
      })
    : runInternalOcrBackgroundTask(jobState);

  if (typeof vercelWaitUntil === 'function') {
    vercelWaitUntil(task);
    return true;
  }

  if (!runViaExternalTrigger) {
    return false;
  }

  task.catch(() => {});
  return true;
}

async function handleOcrStatusRoute(req, res) {
  if (await ocrStatusLimiter(req, res)) return;

  try {
    const jobId = getOcrJobId(req);
    if (!jobId) {
      return res.status(400).json({ error: 'job_id wajib diisi.' });
    }

    const supabase = getSupabase();
    let state = await readOcrJobState(supabase, jobId);
    if (!state) {
      return res.status(404).json({ error: 'OCR job tidak ditemukan.' });
    }

    if (isOcrJobStale(state)) {
      const staleStoragePath = state.storagePath;
      state = await markOcrJobFailed(supabase, jobId, {
        worker: state.worker,
        error: 'OCR terlalu lama diproses. Upload ulang bukti transfer.',
        storagePath: '',
      });
      if (staleStoragePath) {
        await supabase.storage.from('bukti-transfer').remove([staleStoragePath]).catch(() => {});
      }
    }

    return res.json({
      jobId: state.jobId,
      status: state.status,
      result: state.result,
      error: state.error || '',
    });
  } catch (err) {
    console.error(err);
    logError('ocr', err.message, { method: 'GET', action: 'status' });
    return res.status(500).json({ error: 'Gagal membaca status OCR.' });
  }
}

function normalizeTransferRow(row) {
  return {
    ...row,
    nama_bank: normalizeBankName(row.nama_bank),
    nominal: Number(row.nominal || 0),
  };
}

function normalizePlanRows(planRows, fallbackDate, fallbackNominal) {
  const rows = Array.isArray(planRows) ? planRows : [];
  const normalized = rows.map((row) => ({
    tgl_inputan: String(row.tgl_inputan || row.tanggal_buat || '').trim(),
    nominal: Number(row.nominal || row.plannedNominal || row.remainingNominal || 0),
  })).filter((row) => row.tgl_inputan && row.nominal > 0);

  if (normalized.length > 0) return normalized;

  const normalizedDate = String(fallbackDate || '').trim();
  const normalizedNominalValue = Number(fallbackNominal || 0);
  if (!normalizedDate || !(normalizedNominalValue > 0)) return [];
  return [{ tgl_inputan: normalizedDate, nominal: normalizedNominalValue }];
}

function buildPlanExactKey(dateText, nominal) {
  return String(dateText || '').trim() + '|' + Number(nominal || 0);
}

function getScopeLabel(areaName, fallback = 'Cabang ini') {
  const normalizedArea = String(areaName || '').trim().toUpperCase();
  return normalizedArea ? 'Area ' + normalizedArea : fallback;
}

async function getAreaScope(supabase, namaCabang) {
  const normalizedCabang = String(namaCabang || '').trim().toUpperCase();
  if (!normalizedCabang) {
    return { areaName: '', cabangNames: [] };
  }

  const { data: cabangRow, error: cabangError } = await supabase
    .from('cabang')
    .select('nama, area')
    .eq('nama', normalizedCabang)
    .maybeSingle();

  if (cabangError) throw cabangError;

  const areaName = String(cabangRow?.area || '').trim().toUpperCase();
  if (!areaName) {
    return { areaName: '', cabangNames: [normalizedCabang] };
  }

  const { data: areaCabangRows, error: areaCabangError } = await supabase
    .from('cabang')
    .select('nama')
    .eq('area', areaName)
    .order('nama', { ascending: true });

  if (areaCabangError) throw areaCabangError;

  const cabangNames = Array.from(new Set((areaCabangRows || [])
    .map((row) => String(row.nama || '').trim().toUpperCase())
    .filter(Boolean)));

  return {
    areaName,
    cabangNames: cabangNames.length > 0 ? cabangNames : [normalizedCabang],
  };
}

function buildDupeSummary({ exactDupes, branchDayTransfers, nominal, areaName }) {
  const normalizedNominal = Number(nominal || 0);
  const branchTransfers = Array.isArray(branchDayTransfers) ? branchDayTransfers : [];
  const dupes = Array.isArray(exactDupes) ? exactDupes : [];
  const branchDayCount = branchTransfers.length;
  const branchDayTotal = branchTransfers.reduce((sum, row) => sum + Number(row.nominal || 0), 0);
  const lastTransfer = branchTransfers[0] || null;
  const scopeLabel = getScopeLabel(areaName);

  if (dupes.length > 0) {
    return {
      tone: 'warn',
      exactMatch: true,
      title: scopeLabel + ' sudah punya nominal yang sama',
      message: 'Ada transfer tersimpan dengan area, tanggal rekap, dan nominal yang sama. Cek ulang agar tidak double upload bukti.',
      branchDayCount,
      branchDayTotal,
      lastTransfer,
      nominalInput: normalizedNominal,
      scopeLabel,
    };
  }

  if (branchDayCount > 0) {
    return {
      tone: 'info',
      exactMatch: false,
      title: scopeLabel + ' sudah punya transfer di tanggal yang sama',
      message: 'Masih bisa disimpan bila ini transfer berbeda, tetapi cek area, tanggal rekap, dan nominal agar tidak tertukar atau dobel.',
      branchDayCount,
      branchDayTotal,
      lastTransfer,
      nominalInput: normalizedNominal,
      scopeLabel,
    };
  }

  return {
    tone: 'ok',
    exactMatch: false,
    title: 'Belum ada transfer tersimpan',
    message: scopeLabel + ' belum punya transfer tersimpan pada tanggal tersebut.',
    branchDayCount,
    branchDayTotal,
    lastTransfer: null,
    nominalInput: normalizedNominal,
    scopeLabel,
  };
}

function isExactMultiNoncodMatch(noncodMatch) {
  return !!(
    noncodMatch
    && noncodMatch.splitMatch
    && Array.isArray(noncodMatch.splitMatch.dates)
    && noncodMatch.splitMatch.dates.length > 1
    && Number(noncodMatch.splitMatch.diff || 0) === 0
  );
}

function buildCabangHoldPayloadFromMatch(noncodMatch) {
  if (!noncodMatch || !noncodMatch.hold) return null;
  const nominal = roundTransferNominal(noncodMatch.hold.nominal);
  if (!(nominal > 0)) return null;

  return {
    nominal,
    reason: String(noncodMatch.hold.reason || '').trim() || 'Kelebihan transfer ditahan sebagai hold cabang.',
  };
}

async function getDuplicateContext(supabase, { nama_cabang, tgl_inputan, nominal, planRows }) {
  const normalizedDate = String(tgl_inputan || '').trim();
  const normalizedNominal = Number(nominal || 0);
  const normalizedPlanRows = normalizePlanRows(planRows, normalizedDate, normalizedNominal);
  const targetDates = Array.from(new Set(normalizedPlanRows.map((row) => row.tgl_inputan)));
  const { areaName, cabangNames } = await getAreaScope(supabase, nama_cabang);

  const branchDayQuery = supabase
    .from('transfers')
    .select('id, timestamp, tgl_inputan, nama_bank, nama_cabang, nominal, periode')
    .in('nama_cabang', cabangNames)
    .in('tgl_inputan', targetDates)
    .order('timestamp', { ascending: false })
    .limit(50);

  const branchDayResult = await branchDayQuery;
  if (branchDayResult.error) throw branchDayResult.error;

  const branchDayTransfers = (branchDayResult.data || []).map(normalizeTransferRow);
  const exactKeys = new Set(normalizedPlanRows.map((row) => buildPlanExactKey(row.tgl_inputan, row.nominal)));
  const dupes = branchDayTransfers.filter((row) => exactKeys.has(buildPlanExactKey(row.tgl_inputan, row.nominal)));
  const summary = buildDupeSummary({
    exactDupes: dupes,
    branchDayTransfers,
    nominal: normalizedNominal,
    areaName,
  });

  return {
    areaName,
    scopeType: 'area',
    matchedCabangNames: cabangNames,
    dupes,
    areaDayTransfers: branchDayTransfers,
    branchDayTransfers,
    areaDayCount: summary.branchDayCount,
    branchDayCount: summary.branchDayCount,
    areaDayTotal: summary.branchDayTotal,
    branchDayTotal: summary.branchDayTotal,
    summary,
  };
}

async function handleDupeRoute(req, res) {
  if (await dupeLimiter(req, res)) return;

  try {
    const normalizedFields = normalizeUploadFields(req.body || {});
    const {
      nama_cabang,
      tgl_inputan,
      nominal,
      periode,
      prefetch,
      context_key: contextKey,
    } = normalizedFields;

    if (!nama_cabang) {
      return res.status(400).json({ error: 'Cabang wajib diisi.' });
    }

    const supabase = getSupabase();

    if (prefetch) {
      const prefetched = await prefetchNoncodMatchContext(supabase, {
        namaCabang: nama_cabang,
        preferredPeriode: periode,
      });
      return res.status(200).json({
        prefetch: true,
        ready: true,
        contextKey: prefetched.contextKey,
        hasData: prefetched.hasData,
        candidateDateCount: prefetched.candidateDateCount,
        message: prefetched.message,
      });
    }

    if (!nominal) {
      return res.status(400).json({ error: 'Field tidak lengkap.' });
    }

    let noncodMatch = null;
    let effectiveDate = tgl_inputan || null;
    let planRows = [];

    if (!effectiveDate) {
      noncodMatch = await findNoncodDateMatch(supabase, {
        namaCabang: nama_cabang,
        nominal,
        preferredPeriode: periode,
        contextKey,
      });
      planRows = buildPlannedRowsFromMatch(noncodMatch, nominal);
      if (planRows.length) {
        effectiveDate = planRows[0].tgl_inputan;
      }
    }

    if (!planRows.length && effectiveDate) {
      planRows = [{ tgl_inputan: effectiveDate, nominal: Number(nominal || 0) }];
    }

    if (!effectiveDate) {
      return res.status(200).json({
        noncodMatch,
        tgl_inputan: null,
        dupes: [],
        areaDayTransfers: [],
        branchDayTransfers: [],
        summary: {
          tone: noncodMatch && noncodMatch.blocked ? 'warn' : 'info',
          exactMatch: false,
          title: noncodMatch && noncodMatch.blocked ? 'Indikasi pembayaran dobel' : 'Tidak ada NONCOD cocok',
          message: noncodMatch ? noncodMatch.message : 'Tanggal tidak tersedia.',
        },
      });
    }

    const result = await getDuplicateContext(supabase, {
      nama_cabang,
      tgl_inputan: effectiveDate,
      nominal,
      planRows,
    });

    return res.status(200).json({ ...result, noncodMatch, tgl_inputan: effectiveDate });
  } catch (err) {
    console.error(err);
    logError('check-dupe', err.message, { method: 'POST' });
    return res.status(500).json({ error: 'Gagal cek duplikat.' });
  }
}

async function handleOcrRoute(req, res) {
  if (await ocrLimiter(req, res)) return;

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Field image (base64) diperlukan.' });
    }

    const parsedImage = parseBase64ImageDataUrl(image);
    if (!parsedImage) {
      return res.status(400).json({ error: 'Format image tidak valid.' });
    }

    if (parsedImage.buffer.length > MAX_OCR_IMAGE_SIZE) {
      return res.status(400).json({ error: 'Gambar terlalu besar. Maksimal 5MB.' });
    }

    if (!isOcrPipelineTriggerEnabled()) {
      return res.status(503).json({ error: 'OCR worker belum dikonfigurasi.' });
    }

    const supabase = getSupabase();
    const tempPath = `ocr-jobs/${Date.now()}_${Math.random().toString(36).slice(2)}.${parsedImage.ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('bukti-transfer')
      .upload(tempPath, parsedImage.buffer, { contentType: parsedImage.mimeType });

    if (uploadErr) throw uploadErr;

    let jobState;
    try {
      jobState = await createOcrJob(supabase, {
        storagePath: tempPath,
        mimeType: parsedImage.mimeType,
        sizeBytes: parsedImage.buffer.length,
        source: 'input',
      });
    } catch (jobErr) {
      await supabase.storage.from('bukti-transfer').remove([tempPath]).catch(() => {});
      throw jobErr;
    }

    const queued = scheduleOcrBackgroundTask(jobState);

    if (!queued) {
      await markOcrJobFailed(supabase, jobState.jobId, {
        error: 'OCR worker belum aktif.',
        storagePath: '',
      }).catch(() => {});
      await supabase.storage.from('bukti-transfer').remove([tempPath]).catch(() => {});
      return res.status(503).json({ error: 'OCR worker belum aktif.' });
    }

    return res.status(202).json({
      accepted: true,
      jobId: jobState.jobId,
      status: jobState.status,
      backgroundStrategy: getOcrBackgroundScheduleMeta().backgroundStrategy,
    });
  } catch (err) {
    console.error(err);
    logError('ocr', err.message, { method: 'POST' });
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
}

async function handleOcrWorkerRoute(req, res) {
  if (!authorizeOcrWorkerRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const jobId = getOcrJobId(req);
    if (!jobId) {
      return res.status(400).json({ error: 'job_id wajib diisi.' });
    }

    const result = await processOcrJobById(jobId, {
      workerName: 'vercel-input-worker',
    });

    if (result.status === 'missing') {
      return res.status(404).json({ error: result.error || 'OCR job tidak ditemukan.' });
    }

    return res.status(200).json({
      ok: result.ok,
      status: result.status,
      error: result.error || '',
      jobId,
    });
  } catch (err) {
    console.error(err);
    logError('ocr', err.message, { method: 'POST', action: 'worker' });
    return res.status(500).json({ error: 'OCR worker gagal memproses job.' });
  }
}

function isAdminPendingUpload(req) {
  const pendingFlag = String(req?.query?.admin_pending || '').trim();
  const legacyFlag = String(req?.query?.admin_carryover || '').trim();
  return pendingFlag === '1' || legacyFlag === '1';
}

async function buildAdminPendingPlan(supabase, fields, normalizedCabang) {
  const targetDate = normalizePendingDate(fields.target_date);
  const normalizedNominal = parseTransferNominal(fields.nominal);
  const roundedNominal = Math.round(normalizedNominal);
  const reason = String(fields.pending_reason || fields.carryover_reason || '').trim();

  if (!targetDate) throw createClientInputError('Tanggal NONCOD wajib diisi.');
  if (!Number.isFinite(normalizedNominal) || !(normalizedNominal > 0)) {
    throw createClientInputError('Nominal harus lebih dari 0.');
  }

  const periodes = [...new Set([...getRecentPeriodes(), getPeriodeFromDate(targetDate)])].filter(Boolean);
  const { data: noncodRows, error: noncodError } = await supabase
    .from('noncod')
    .select('tanggal_buat, ongkir, metode_pembayaran, nomor_resi, status_terakhir')
    .in('periode', periodes)
    .eq('cabang', normalizedCabang);

  if (noncodError) throw noncodError;

  const overrideMap = await readStatusOverridesByResi(supabase, (noncodRows || []).map((row) => row.nomor_resi));
  const effectiveRows = applyStatusOverrides(noncodRows, overrideMap);
  const byDate = aggregateOngkirByDate(effectiveRows);
  if (!Object.keys(byDate).length) {
    throw createClientInputError('Belum ada data NONCOD untuk cabang ini.');
  }

  const allCandidateDates = Object.keys(byDate);
  const { data: existingTransfers, error: transferError } = await supabase
    .from('transfers')
    .select('id, tgl_inputan, nominal')
    .eq('nama_cabang', normalizedCabang)
    .in('tgl_inputan', allCandidateDates);

  if (transferError) throw transferError;

  const currentOutstanding = getOutstandingNominalForDate(byDate, existingTransfers, targetDate);
  if (!(currentOutstanding > 0)) {
    throw createClientInputError('Tanggal NONCOD yang dipilih sudah lunas atau belum tersedia.');
  }

  const currentNominal = Math.min(currentOutstanding, roundedNominal);
  const plannedRows = [{ tgl_inputan: targetDate, nominal: currentNominal }];
  const futurePlan = findSequentialAllocationDates(byDate, existingTransfers, roundedNominal - currentNominal, targetDate);
  if (futurePlan.dates.length) {
    futurePlan.dates.forEach((row) => {
      plannedRows.push({
        tgl_inputan: row.tanggal_buat,
        nominal: row.plannedNominal,
      });
    });
  }

  return {
    plannedRows,
    pending: futurePlan.pendingNominal > 0 ? {
      afterDate: futurePlan.lastDate || targetDate,
      nominal: futurePlan.pendingNominal,
      reason,
    } : null,
    allocation: {
      targetDate,
      requestedNominal: roundedNominal,
    },
  };
}

function buildPlannedRowsFromMatch(noncodMatch, nominal) {
  const normalizedNominal = parseTransferNominal(nominal);
  if (!(normalizedNominal > 0)) return [];

  if (noncodMatch && noncodMatch.match && noncodMatch.match.tanggal_buat) {
    return [{
      tgl_inputan: noncodMatch.match.tanggal_buat,
      nominal: Number(noncodMatch.match.plannedNominal || normalizedNominal),
    }];
  }

  if (isExactMultiNoncodMatch(noncodMatch)) {
    return noncodMatch.splitMatch.dates
      .map((row) => ({
        tgl_inputan: String(row.tanggal_buat || '').trim(),
        nominal: Number(row.plannedNominal || 0),
      }))
      .filter((row) => row.tgl_inputan && row.nominal > 0);
  }

  return [];
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, X-Admin-Token, X-OCR-Secret' })) return;

  if (String(req.query.ocr || '').trim() === '1') {
    if (isOcrWorkerRequest(req)) {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed.' });
      }
      return handleOcrWorkerRoute(req, res);
    }

    if (req.method === 'GET') {
      return handleOcrStatusRoute(req, res);
    }

    if (req.method === 'POST') {
      return handleOcrRoute(req, res);
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (String(req.query.dupe || '').trim() === '1') {
    return handleDupeRoute(req, res);
  }

  const adminPendingUpload = isAdminPendingUpload(req);
  if (adminPendingUpload && !(await requireAdmin(req, res))) return;

  // Rate limit uploads
  if (await uploadLimiter(req, res)) return;

  try {
    const contentType = String(req.headers['content-type'] || '').trim();
    if (!/multipart\/form-data/i.test(contentType)) {
      return res.status(400).json({ error: 'Content-Type upload harus multipart/form-data.' });
    }

    const fields = {};
    let fileBuffer = null;
    let fileName = null;
    let fileMime = null;

    await new Promise((resolve, reject) => {
      const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
      const busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fileSize: MAX_FILE_SIZE,
        },
      });

      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      busboy.on('field', (name, val) => {
        fields[name] = val;
      });

      busboy.on('file', (name, file, info) => {
        const { filename, mimeType } = info;
        fileName = filename;
        fileMime = mimeType;
        const chunks = [];
        let totalSize = 0;

        file.on('limit', () => {
          rejectOnce(createClientInputError('File terlalu besar. Maksimal 5MB.'));
        });
        file.on('data', d => {
          totalSize += d.length;
          if (totalSize > MAX_FILE_SIZE) {
            rejectOnce(createClientInputError('File terlalu besar. Maksimal 5MB.'));
            file.resume();
            return;
          }
          chunks.push(d);
        });
        file.on('error', (error) => {
          rejectOnce(createClientInputError(error && error.message ? error.message : 'Upload multipart tidak valid.'));
        });
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });

      busboy.on('filesLimit', () => {
        rejectOnce(createClientInputError('Upload hanya menerima satu file bukti transfer.'));
      });
      busboy.on('partsLimit', () => {
        rejectOnce(createClientInputError('Upload multipart tidak valid.'));
      });
      busboy.on('finish', resolveOnce);
      busboy.on('error', (error) => {
        rejectOnce(createClientInputError(error && error.message ? error.message : 'Upload multipart tidak valid.'));
      });

      const sourceStream = getMultipartSourceStream(req);
      sourceStream.pipe(busboy);
    });

    const normalizedFields = normalizeUploadFields(fields);

    // Validasi fields
    const { tgl_inputan, nama_bank, nama_cabang, nominal, periode } = normalizedFields;
    if (!nama_bank || !nama_cabang || !nominal) {
      return res.status(400).json({ error: 'Semua field wajib diisi.' });
    }
    if (!isPositiveTransferNominal(nominal)) {
      return res.status(400).json({ error: 'Nominal harus lebih dari 0.' });
    }
    if (tgl_inputan && !isValidTransferDate(tgl_inputan)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
    }

    if (!fileBuffer || !fileName) {
      return res.status(400).json({ error: 'Bukti transfer wajib diupload.' });
    }

    const supabase = getSupabase();
    let buktiUrl = null;
    const normalizedCabang = String(nama_cabang || '').trim().toUpperCase();

    // Validasi nama_cabang terdaftar di tabel cabang
    const { data: cabangData } = await supabase
      .from('cabang')
      .select('id')
      .eq('nama', normalizedCabang)
      .maybeSingle();
    if (!cabangData) {
      return res.status(400).json({ error: 'Cabang tidak terdaftar.' });
    }

    let plannedRows = [];
    let pendingPayload = null;
    let holdPayload = null;
    let adminAllocation = null;
    if (adminPendingUpload) {
      const adminPlan = await buildAdminPendingPlan(supabase, normalizedFields, normalizedCabang);
      plannedRows = adminPlan.plannedRows;
      pendingPayload = adminPlan.pending;
      adminAllocation = adminPlan.allocation;
    } else {
      const noncodMatch = await findNoncodDateMatch(supabase, {
        namaCabang: normalizedCabang,
        nominal: parseTransferNominal(nominal),
        preferredPeriode: periode,
      });
      plannedRows = buildPlannedRowsFromMatch(noncodMatch, nominal);
      holdPayload = buildCabangHoldPayloadFromMatch(noncodMatch);
      if (!plannedRows.length) {
        return res.status(400).json({
          error: noncodMatch && noncodMatch.message ? noncodMatch.message : 'Tidak ada NONCOD yang cocok untuk nominal ini.',
        });
      }
    }

    const invalidPlannedRow = plannedRows.find((row) => !isValidTransferDate(row.tgl_inputan) || !isPositiveTransferNominal(row.nominal));
    if (invalidPlannedRow) {
      throw new Error('Rencana sinkron NONCOD tidak valid.');
    }

    const normalizedPlannedRows = plannedRows.map((row) => ({
      tgl_inputan: String(row.tgl_inputan || '').trim(),
      nominal: roundTransferNominal(row.nominal),
    }));

    const invalidNormalizedRow = normalizedPlannedRows.find((row) => !isValidTransferDate(row.tgl_inputan) || !Number.isFinite(row.nominal) || !(row.nominal > 0));
    if (invalidNormalizedRow) {
      throw new Error('Rencana sinkron NONCOD tidak valid.');
    }

    const primaryDate = normalizedPlannedRows[0].tgl_inputan;

    const proofSignature = buildProofSignaturePayload({
      fileBuffer,
      fileName,
      mimeType: fileMime,
      namaCabang: normalizedCabang,
      tglInputan: primaryDate,
      namaBank: nama_bank,
      nominal,
    });

    if (!proofSignature.signature) {
      return res.status(400).json({ error: 'Bukti transfer tidak valid.' });
    }

    const { data: existingProofSetting, error: existingProofError } = await supabase
      .from('settings')
      .select('value')
      .eq('key', proofSignature.key)
      .maybeSingle();

    if (existingProofError) throw existingProofError;

    if (existingProofSetting && existingProofSetting.value) {
      const existingProof = parseProofSignatureValue(existingProofSetting.value);
      return res.status(409).json({
        error: formatProofDuplicateMessage(existingProof),
      });
    }

    // Upload foto jika ada
    const ext = fileName.split('.').pop().toLowerCase();
    const allowedExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
    const allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedExt.includes(ext) || (fileMime && !allowedMime.includes(fileMime))) {
      return res.status(400).json({ error: 'Format file tidak didukung. Gunakan JPG/PNG.' });
    }
    if (fileBuffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File terlalu besar. Maksimal 5MB.' });
    }
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('bukti-transfer')
      .upload(safeName, fileBuffer, { contentType: fileMime || 'image/jpeg' });

    if (uploadErr) throw uploadErr;

    // Simpan path saja (bukan signed URL yang akan expire)
    buktiUrl = safeName;

    const ketParts = [];
    if (normalizedFields.ket) ketParts.push(String(normalizedFields.ket || '').trim());
    if (adminPendingUpload && adminAllocation) ketParts.push('ADMIN tempel NONCOD mulai ' + adminAllocation.targetDate);
    const normalizedKet = normalizeTransferKet(ketParts.join(' · '));
    const timestamp = new Date().toISOString();
    const insertRows = normalizedPlannedRows.map((row) => ({
      timestamp,
      tgl_inputan: row.tgl_inputan,
      periode: getPeriodeFromDate(row.tgl_inputan),
      nama_bank: normalizeBankName(nama_bank),
      nama_cabang: normalizedCabang,
      nominal: row.nominal,
      ket: normalizedKet,
      bukti_url: buktiUrl,
    }));

    // Insert ke tabel transfers
    const { data, error: insertErr } = await supabase
      .from('transfers')
      .insert(insertRows)
      .select('id, timestamp, tgl_inputan, nominal');

    if (insertErr) {
      if (buktiUrl) {
        await supabase.storage.from('bukti-transfer').remove([buktiUrl]).catch(() => {});
      }
      throw insertErr;
    }

    const insertedRows = Array.isArray(data) ? data : [];

    if (adminPendingUpload && pendingPayload) {
      try {
        const primaryInsert = insertedRows[0];
        if (!primaryInsert || !primaryInsert.id) {
          throw new Error('Transfer admin split gagal dibuat.');
        }

        await upsertPendingAllocation(supabase, {
          root_transfer_id: primaryInsert.id,
          cabang: normalizedCabang,
          after_date: pendingPayload.afterDate,
          nominal: pendingPayload.nominal,
          reason: pendingPayload.reason,
          transfer_bank: normalizeBankName(nama_bank),
          bukti_url: buktiUrl,
          ket: normalizedKet,
          timestamp,
        });
      } catch (pendingError) {
        if (insertedRows.length > 0) {
          const rollbackResult = await supabase
            .from('transfers')
            .delete()
            .in('id', insertedRows.map((row) => row.id));
          if (rollbackResult.error) {
            logError('input', rollbackResult.error.message, {
              method: req.method,
              action: 'rollback_pending_allocation_insert',
              transferIds: insertedRows.map((row) => row.id),
            });
          }
        }
        if (buktiUrl) {
          await supabase.storage.from('bukti-transfer').remove([buktiUrl]).catch(() => {});
        }
        throw pendingError;
      }
    }

    if (!adminPendingUpload && holdPayload) {
      try {
        const primaryInsert = insertedRows[0];
        if (!primaryInsert || !primaryInsert.id) {
          throw new Error('Hold cabang gagal dibuat.');
        }

        await upsertCabangHold(supabase, {
          root_transfer_id: primaryInsert.id,
          cabang: normalizedCabang,
          nominal: holdPayload.nominal,
          reason: holdPayload.reason,
          transfer_bank: normalizeBankName(nama_bank),
          bukti_url: buktiUrl,
          ket: normalizedKet,
          timestamp,
        });
      } catch (holdError) {
        if (insertedRows.length > 0) {
          const rollbackResult = await supabase
            .from('transfers')
            .delete()
            .in('id', insertedRows.map((row) => row.id));
          if (rollbackResult.error) {
            logError('input', rollbackResult.error.message, {
              method: req.method,
              action: 'rollback_hold_insert',
              transferIds: insertedRows.map((row) => row.id),
            });
          }
        }
        if (buktiUrl) {
          await supabase.storage.from('bukti-transfer').remove([buktiUrl]).catch(() => {});
        }
        throw holdError;
      }
    }

    const proofRegistryValue = JSON.stringify({
      signature: proofSignature.signature,
      transferId: insertedRows[0] ? insertedRows[0].id : null,
      transferIds: insertedRows.map((row) => row.id),
      createdAt: insertedRows[0] ? insertedRows[0].timestamp : new Date().toISOString(),
      namaCabang: normalizedCabang,
      tglInputan: primaryDate,
      tglInputanList: normalizedPlannedRows.map((row) => row.tgl_inputan),
      namaBank: normalizeBankName(nama_bank),
      nominal: roundTransferNominal(nominal),
      holdNominal: holdPayload ? holdPayload.nominal : 0,
      fileName,
      mimeType: fileMime || '',
      splitRows: normalizedPlannedRows,
    });

    const { error: proofRegistryError } = await supabase.from('settings').upsert({
      key: proofSignature.key,
      value: proofRegistryValue,
    });

    if (proofRegistryError) {
      if (adminPendingUpload && pendingPayload && insertedRows[0] && insertedRows[0].id) {
        await deletePendingAllocation(supabase, insertedRows[0].id).catch(() => {});
      }
      if (!adminPendingUpload && holdPayload && insertedRows[0] && insertedRows[0].id) {
        await deleteCabangHold(supabase, insertedRows[0].id).catch(() => {});
      }
      if (insertedRows.length > 0) {
        const rollbackResult = await supabase
          .from('transfers')
          .delete()
          .in('id', insertedRows.map((row) => row.id));
        if (rollbackResult.error) {
          logError('input', rollbackResult.error.message, {
            method: req.method,
            action: 'rollback_proof_registry_insert',
            transferIds: insertedRows.map((row) => row.id),
          });
        }
      }
      if (buktiUrl) {
        await supabase.storage.from('bukti-transfer').remove([buktiUrl]).catch(() => {});
      }
      throw proofRegistryError;
    }

    const affectedPeriodes = [...new Set(plannedRows.map((row) => getPeriodeFromDate(row.tgl_inputan)).filter(Boolean))];

    try {
      await publishAdminWriteMarker(supabase, {
        source: adminPendingUpload ? 'input_admin_pending' : 'input',
        scopes: buildInputMarkerScopes({ adminPendingUpload, pendingPayload }),
        periodes: affectedPeriodes,
      });
    } catch (markerError) {
      logError('admin-marker', markerError.message, {
        method: req.method,
        action: 'publish_admin_write_marker_after_input',
        transferIds: insertedRows.map((row) => row.id),
        periodes: affectedPeriodes,
      });
    }

    try {
      await markNoncodSyncDirty(supabase, {
        reason: adminPendingUpload ? 'input_admin_pending' : 'input',
        periodes: affectedPeriodes,
        timestamp,
      });
      queueNoncodPipelineTrigger({
        reason: adminPendingUpload ? 'input_admin_pending' : 'input',
        periodes: affectedPeriodes,
        source: 'input',
      });
    } catch (pipelineError) {
      logError('noncod-sync', pipelineError.message, {
        method: req.method,
        action: 'queue_after_input',
        transferIds: insertedRows.map((row) => row.id),
      });
    }

    return res.status(201).json({
      success: true,
      id: insertedRows[0] ? insertedRows[0].id : null,
      ids: insertedRows.map((row) => row.id),
      inserted: insertRows.length,
      split: insertRows.length > 1,
      holdNominal: holdPayload ? holdPayload.nominal : 0,
      pendingNominal: pendingPayload ? pendingPayload.nominal : 0,
      pendingAfterDate: pendingPayload ? pendingPayload.afterDate : '',
      rows: normalizedPlannedRows,
    });

  } catch (err) {
    const statusCode = getInputErrorStatusCode(err);
    if (shouldLogInputError(err)) {
      console.error(err);
      logError('input', err.message, { method: req.method });
    }
    return res.status(statusCode).json({ error: statusCode === 400 ? err.message : 'Gagal menyimpan data.' });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
module.exports.buildDupeSummary = buildDupeSummary;
module.exports.getDuplicateContext = getDuplicateContext;
module.exports.normalizeTransferRow = normalizeTransferRow;
module.exports.getAreaScope = getAreaScope;
module.exports.getScopeLabel = getScopeLabel;
module.exports.getInputErrorStatusCode = getInputErrorStatusCode;
module.exports.normalizeUploadFields = normalizeUploadFields;
module.exports.shouldLogInputError = shouldLogInputError;
module.exports.shouldFallbackToInternalOcrWorker = shouldFallbackToInternalOcrWorker;
