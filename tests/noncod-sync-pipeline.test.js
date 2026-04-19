const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNoncodPipelineTriggerPayload,
  createDefaultNoncodSyncPipelineState,
  getNoncodPipelineTriggerConfig,
  getNoncodPipelineTriggerMode,
  isNoncodPipelineTriggerEnabled,
  normalizePeriodeList,
  parseNoncodSyncPipelineState,
  sendNoncodPipelineTrigger,
  timingSafeSecretEqual,
} = require('../api/_noncod-sync-pipeline');

test('normalizePeriodeList merapikan, menghapus duplikat, dan menyortir periode valid', () => {
  assert.deepEqual(normalizePeriodeList(['2026-04', '2026-04', 'salah', '2026-03']), ['2026-03', '2026-04']);
});

test('parseNoncodSyncPipelineState fallback ke state default saat payload rusak', () => {
  assert.deepEqual(parseNoncodSyncPipelineState('{rusak'), createDefaultNoncodSyncPipelineState());
});

test('getNoncodPipelineTriggerConfig membaca env trigger pipeline', () => {
  const config = getNoncodPipelineTriggerConfig({
    NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger',
    NONCOD_PIPELINE_TRIGGER_SECRET: 'secret-123',
    NONCOD_PIPELINE_SERVICE: 'dashboard-test',
    NONCOD_PIPELINE_TRIGGER_TIMEOUT_MS: '4100',
  });

  assert.equal(config.url, 'https://example.test/trigger');
  assert.equal(config.mode, 'external');
  assert.equal(config.secret, 'secret-123');
  assert.equal(config.service, 'dashboard-test');
  assert.equal(config.timeoutMs, 4100);
});

test('getNoncodPipelineTriggerMode membedakan external dan disabled', () => {
  assert.equal(getNoncodPipelineTriggerMode({ NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger' }), 'external');
  assert.equal(getNoncodPipelineTriggerMode({}), 'disabled');
});

test('isNoncodPipelineTriggerEnabled aktif jika URL dan secret tersedia', () => {
  assert.equal(isNoncodPipelineTriggerEnabled({
    NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger',
    NONCOD_PIPELINE_TRIGGER_SECRET: 'secret-123',
  }), true);
  assert.equal(isNoncodPipelineTriggerEnabled({
    NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger',
    NONCOD_PIPELINE_TRIGGER_SECRET: '',
  }), false);
});

test('buildNoncodPipelineTriggerPayload membentuk payload trigger background yang stabil', () => {
  const payload = buildNoncodPipelineTriggerPayload({
    reason: 'input',
    periodes: ['2026-04', '2026-04', '2026-03'],
    source: 'input',
    force: false,
  }, {
    NONCOD_PIPELINE_SERVICE: 'dashboard-test',
  });

  assert.equal(payload.reason, 'input');
  assert.deepEqual(payload.periodes, ['2026-03', '2026-04']);
  assert.equal(payload.source, 'input');
  assert.equal(payload.force, false);
  assert.equal(payload.service, 'dashboard-test');
  assert.match(payload.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('timingSafeSecretEqual hanya true untuk secret yang sama', () => {
  assert.equal(timingSafeSecretEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeSecretEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeSecretEqual('abc123', ''), false);
});

test('sendNoncodPipelineTrigger mengirim request ke Lambda worker external', async () => {
  const calls = [];
  const result = await sendNoncodPipelineTrigger({
    reason: 'snapshot_dirty',
    periodes: ['2026-04'],
    source: 'test',
    force: true,
  }, {
    NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger',
    NONCOD_PIPELINE_TRIGGER_SECRET: 'trigger-secret',
  }, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 202 };
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.target, 'https://example.test/trigger');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/trigger');
  assert.equal(calls[0].options.headers['X-Sync-Secret'], 'trigger-secret');
});