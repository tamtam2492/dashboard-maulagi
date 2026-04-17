const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOcrJobTriggerPayload,
  buildSelfOcrWorkerUrl,
  createDefaultOcrJobState,
  getOcrPipelineTriggerConfig,
  isOcrJobStale,
  isOcrPipelineTriggerEnabled,
  parseOcrJobState,
  sendOcrJobTrigger,
  timingSafeSecretEqual,
} = require('../api/_ocr-job-pipeline');

test('parseOcrJobState fallback ke state default saat payload rusak', () => {
  assert.deepEqual(parseOcrJobState('{rusak'), createDefaultOcrJobState());
});

test('getOcrPipelineTriggerConfig membaca env trigger OCR', () => {
  const config = getOcrPipelineTriggerConfig({
    OCR_PIPELINE_TRIGGER_URL: 'https://example.test/ocr-trigger',
    OCR_PIPELINE_TRIGGER_SECRET: 'secret-ocr',
    OCR_PIPELINE_SERVICE: 'dashboard-test',
    OCR_PIPELINE_TRIGGER_TIMEOUT_MS: '4200',
  });

  assert.equal(config.url, 'https://example.test/ocr-trigger');
  assert.equal(config.secret, 'secret-ocr');
  assert.equal(config.service, 'dashboard-test');
  assert.equal(config.timeoutMs, 4200);
});

test('buildSelfOcrWorkerUrl membentuk fallback URL worker OCR dari VERCEL_URL', () => {
  assert.equal(
    buildSelfOcrWorkerUrl({ VERCEL_URL: 'dashboard-transfer-preview.vercel.app' }),
    'https://dashboard-transfer-preview.vercel.app/api/input?ocr=1&worker=1',
  );
  assert.equal(buildSelfOcrWorkerUrl({}), '');
});

test('isOcrPipelineTriggerEnabled aktif jika URL dan secret tersedia', () => {
  assert.equal(isOcrPipelineTriggerEnabled({
    OCR_PIPELINE_TRIGGER_URL: 'https://example.test/ocr-trigger',
    OCR_PIPELINE_TRIGGER_SECRET: 'secret-ocr',
  }), true);
  assert.equal(isOcrPipelineTriggerEnabled({
    VERCEL_URL: 'dashboard-transfer-preview.vercel.app',
    OCR_SYNC_SECRET: 'secret-ocr',
  }), true);
  assert.equal(isOcrPipelineTriggerEnabled({
    OCR_PIPELINE_TRIGGER_URL: 'https://example.test/ocr-trigger',
    OCR_PIPELINE_TRIGGER_SECRET: '',
  }), false);
});

test('buildOcrJobTriggerPayload membentuk payload trigger OCR yang stabil', () => {
  const payload = buildOcrJobTriggerPayload({
    jobId: 'job-123',
    source: 'input',
  }, {
    OCR_PIPELINE_SERVICE: 'dashboard-test',
  });

  assert.equal(payload.jobId, 'job-123');
  assert.equal(payload.source, 'input');
  assert.equal(payload.service, 'dashboard-test');
  assert.match(payload.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('sendOcrJobTrigger menganggap response worker failed yang ter-handle sebagai trigger berhasil', async () => {
  const result = await sendOcrJobTrigger({
    jobId: 'job-123',
    source: 'input',
  }, {
    OCR_PIPELINE_TRIGGER_URL: 'https://example.test/ocr-trigger',
    OCR_PIPELINE_TRIGGER_SECRET: 'secret-ocr',
  }, async () => ({
    ok: false,
    status: 500,
    async json() {
      return {
        ok: false,
        status: 'failed',
        error: 'Gambar bukan bukti transfer.',
      };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 500);
  assert.equal(result.workerStatus, 'failed');
  assert.equal(result.error, 'Gambar bukan bukti transfer.');
});

test('sendOcrJobTrigger tetap gagal untuk response trigger yang memang belum menemukan job', async () => {
  const result = await sendOcrJobTrigger({
    jobId: 'job-123',
    source: 'input',
  }, {
    OCR_PIPELINE_TRIGGER_URL: 'https://example.test/ocr-trigger',
    OCR_PIPELINE_TRIGGER_SECRET: 'secret-ocr',
  }, async () => ({
    ok: false,
    status: 404,
    async json() {
      return {
        error: 'OCR job tidak ditemukan.',
      };
    },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.workerStatus, '');
  assert.equal(result.error, 'OCR job tidak ditemukan.');
});

test('isOcrJobStale hanya true untuk job non-final yang terlalu lama', () => {
  const oldQueuedJob = {
    status: 'queued',
    createdAt: '2026-04-17T00:00:00.000Z',
  };
  const finishedJob = {
    status: 'succeeded',
    createdAt: '2026-04-17T00:00:00.000Z',
  };

  assert.equal(isOcrJobStale(oldQueuedJob, Date.parse('2026-04-17T00:03:00.000Z')), true);
  assert.equal(isOcrJobStale(finishedJob, Date.parse('2026-04-17T00:03:00.000Z')), false);
});

test('timingSafeSecretEqual helper OCR hanya true untuk secret yang sama', () => {
  assert.equal(timingSafeSecretEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeSecretEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeSecretEqual('abc123', ''), false);
});