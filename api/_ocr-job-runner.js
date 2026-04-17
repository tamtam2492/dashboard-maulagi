const { requestGroqOcr } = require('./_ocr-runner');
const {
  markOcrJobFailed,
  markOcrJobProcessing,
  markOcrJobSucceeded,
  readOcrJobState,
} = require('./_ocr-job-pipeline');
const { getSupabase } = require('./_supabase');

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
}

async function downloadOcrImageBuffer(supabase, storagePath) {
  const { data, error } = await supabase.storage
    .from('bukti-transfer')
    .createSignedUrl(storagePath, 60);

  if (error || !data?.signedUrl) {
    throw new Error('File OCR tidak ditemukan.');
  }

  const response = await fetch(data.signedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'image/*,*/*',
    },
  });

  if (!response.ok) {
    throw new Error('Gagal mengambil file OCR.');
  }

  return Buffer.from(await response.arrayBuffer());
}

async function processOcrJobById(jobId, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const workerName = String(options.workerName || 'ocr-worker').trim() || 'ocr-worker';
  const supabase = options.supabase || getSupabase();

  const started = await markOcrJobProcessing(supabase, jobId, { worker: workerName });
  if (started.missing) {
    return { ok: false, status: 'missing', error: 'OCR job tidak ditemukan.' };
  }
  if (started.alreadyFinished) {
    return { ok: true, status: started.state.status, state: started.state, skipped: 'finished' };
  }
  if (started.alreadyProcessing) {
    return { ok: true, status: started.state.status, state: started.state, skipped: 'processing' };
  }

  const jobState = started.state;

  try {
    if (!jobState.storagePath) {
      throw new Error('File OCR belum tersimpan.');
    }

    const buffer = await downloadOcrImageBuffer(supabase, jobState.storagePath);
    const imageDataUrl = bufferToDataUrl(buffer, jobState.mimeType || 'image/jpeg');
    const result = await requestGroqOcr(imageDataUrl, env, fetchImpl);

    const finalState = await markOcrJobSucceeded(supabase, jobId, {
      worker: workerName,
      result,
      storagePath: '',
    });

    await supabase.storage.from('bukti-transfer').remove([jobState.storagePath]).catch(() => {});

    return {
      ok: true,
      status: 'succeeded',
      state: finalState,
    };
  } catch (err) {
    const failedState = await markOcrJobFailed(supabase, jobId, {
      worker: workerName,
      error: err && err.message ? err.message : 'OCR worker gagal.',
      storagePath: '',
    });

    if (jobState.storagePath) {
      await supabase.storage.from('bukti-transfer').remove([jobState.storagePath]).catch(() => {});
    }

    return {
      ok: false,
      status: 'failed',
      state: failedState,
      error: failedState.error,
    };
  }
}

async function getOcrJobStatus(jobId, options = {}) {
  const supabase = options.supabase || getSupabase();
  return readOcrJobState(supabase, jobId);
}

module.exports = {
  downloadOcrImageBuffer,
  getOcrJobStatus,
  processOcrJobById,
};