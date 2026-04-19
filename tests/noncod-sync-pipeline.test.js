const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNoncodPipelineTriggerPayload,
  buildSelfNoncodSyncUrl,
  createDefaultNoncodSyncPipelineState,
  getNoncodPipelineTriggerConfig,
  getNoncodPipelineTriggerMode,
  isNoncodPipelineTriggerEnabled,
  normalizePeriodeList,
  parseNoncodSyncPipelineState,
  sendNoncodPipelineTriggerWithSelfFallback,
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

test('getNoncodPipelineTriggerMode membedakan external, self, dan disabled', () => {
  assert.equal(getNoncodPipelineTriggerMode({ NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger' }), 'external');
  assert.equal(getNoncodPipelineTriggerMode({ VERCEL_URL: 'dashboard-transfer-preview.vercel.app' }), 'self');
  assert.equal(getNoncodPipelineTriggerMode({}), 'disabled');
});

test('buildSelfNoncodSyncUrl membentuk fallback URL worker dari VERCEL_URL', () => {
  assert.equal(
    buildSelfNoncodSyncUrl({ VERCEL_URL: 'dashboard-transfer-preview.vercel.app' }),
    'https://dashboard-transfer-preview.vercel.app/api/noncod-sync',
  );
  assert.equal(buildSelfNoncodSyncUrl({}), '');
});

test('isNoncodPipelineTriggerEnabled aktif jika URL dan secret tersedia', () => {
  assert.equal(isNoncodPipelineTriggerEnabled({
    NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger',
    NONCOD_PIPELINE_TRIGGER_SECRET: 'secret-123',
  }), true);
  assert.equal(isNoncodPipelineTriggerEnabled({
    VERCEL_URL: 'dashboard-transfer-preview.vercel.app',
    NONCOD_SYNC_SECRET: 'secret-123',
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

test('sendNoncodPipelineTriggerWithSelfFallback fallback ke self trigger saat trigger external gagal', async () => {
  const calls = [];
  const result = await sendNoncodPipelineTriggerWithSelfFallback({
    reason: 'snapshot_dirty',
    periodes: ['2026-04'],
    source: 'test',
    force: true,
  }, {
    NONCOD_PIPELINE_TRIGGER_URL: 'https://example.test/trigger',
    NONCOD_PIPELINE_TRIGGER_SECRET: 'trigger-secret',
    NONCOD_SYNC_SECRET: 'endpoint-secret',
    VERCEL_URL: 'dashboard-transfer-preview.vercel.app',
  }, async (url) => {
    calls.push(url);
    if (url === 'https://example.test/trigger') {
      return { ok: false, status: 500 };
    }
    return { ok: true, status: 202 };
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackFrom, 'https://example.test/trigger');
  assert.equal(result.target, 'https://dashboard-transfer-preview.vercel.app/api/noncod-sync');
  assert.deepEqual(calls, [
    'https://example.test/trigger',
    'https://dashboard-transfer-preview.vercel.app/api/noncod-sync',
  ]);
});