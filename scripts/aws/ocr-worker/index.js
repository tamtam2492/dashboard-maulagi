function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  };
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key || '').toLowerCase()] = String(value || '');
  }
  return normalized;
}

function parseBody(event) {
  if (event && typeof event.body === 'string' && event.body.trim()) {
    return JSON.parse(event.body);
  }
  if (event && event.body && typeof event.body === 'object') {
    return event.body;
  }
  return event || {};
}

const path = require('path');

function normalizeModulePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isMissingCandidateModule(err, candidate) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false;
  const message = normalizeModulePath(err.message);
  const normalizedCandidate = normalizeModulePath(candidate);
  return message.includes(normalizedCandidate);
}

function requireWorkerModule(moduleName) {
  const candidates = [
    path.join(__dirname, 'api', moduleName),
    path.join(__dirname, '../../../api', moduleName),
    path.join(process.cwd(), 'api', moduleName),
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (isMissingCandidateModule(err, candidate)) {
        continue;
      }

      const wrappedError = new Error(
        `Gagal memuat module worker OCR ${moduleName}: ${err && err.message ? err.message : 'Unknown error.'}`
      );
      wrappedError.cause = err;
      throw wrappedError;
    }
  }

  throw new Error(
    `Module worker OCR tidak ditemukan: ${moduleName}. Pastikan file api/${moduleName}.js dan dependency runtime ikut di artifact Lambda.`
  );
}

const { processOcrJobById } = requireWorkerModule('_ocr-job-runner');
const { timingSafeSecretEqual } = requireWorkerModule('_ocr-job-pipeline');

exports.handler = async (event) => {
  try {
    const sharedSecret = String(
      process.env.OCR_PIPELINE_TRIGGER_SECRET
      || process.env.OCR_SYNC_SECRET
      || ''
    ).trim();
    const hasHttpEnvelope = !!(event && (event.body !== undefined || event.headers));

    if (hasHttpEnvelope && sharedSecret) {
      const headers = normalizeHeaders(event.headers);
      const inboundSecret = headers['x-ocr-secret'] || '';
      if (!timingSafeSecretEqual(inboundSecret, sharedSecret)) {
        return json(401, { error: 'Unauthorized.' });
      }
    }

    const payload = parseBody(event);
    const jobId = String(payload.jobId || payload.job_id || '').trim();
    if (!jobId) {
      return json(400, { error: 'jobId wajib diisi.' });
    }

    const result = await processOcrJobById(jobId, {
      env: process.env,
      workerName: 'aws-lambda-ocr-worker',
    });

    if (result.status === 'missing') {
      return json(404, { error: result.error || 'OCR job tidak ditemukan.', jobId });
    }

    return json(200, {
      ok: result.ok,
      status: result.status,
      jobId,
      error: result.error || '',
    });
  } catch (err) {
    return json(500, {
      error: err && err.message ? err.message : 'Unexpected Lambda error.',
    });
  }
};