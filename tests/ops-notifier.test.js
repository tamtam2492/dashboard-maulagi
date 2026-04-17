const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNotifierPayload,
  getNotifierConfig,
  shouldNotifySource,
  sendOpsNotification,
} = require('../api/_ops-notifier');

test('getNotifierConfig membaca allowlist source dari env', () => {
  const config = getNotifierConfig({
    TELEGRAM_NOTIFY_URL: 'https://example.com/hook',
    TELEGRAM_NOTIFY_SECRET: 'secret-1',
    TELEGRAM_NOTIFY_SOURCES: 'noncod, ocr , auth',
    TELEGRAM_NOTIFY_SERVICE: 'dashboard-prod',
  });

  assert.equal(config.url, 'https://example.com/hook');
  assert.equal(config.secret, 'secret-1');
  assert.equal(config.service, 'dashboard-prod');
  assert.deepEqual(Array.from(config.sourceAllowlist), ['noncod', 'ocr', 'auth']);
});

test('shouldNotifySource hanya aktif untuk source dalam allowlist', () => {
  const env = {
    TELEGRAM_NOTIFY_URL: 'https://example.com/hook',
    TELEGRAM_NOTIFY_SECRET: 'secret-1',
    TELEGRAM_NOTIFY_SOURCES: 'noncod,auth',
  };

  assert.equal(shouldNotifySource('noncod', env), true);
  assert.equal(shouldNotifySource('auth', env), true);
  assert.equal(shouldNotifySource('ocr', env), false);
});

test('buildNotifierPayload merapikan field utama dan meta', () => {
  const payload = buildNotifierPayload({
    source: 'noncod',
    eventType: 'sync_failed',
    severity: 'critical',
    title: '  Sync gagal  ',
    message: ' Timeout dari provider ',
    meta: {
      periode: '2026-04',
      retried: true,
      nested: { reason: 'timeout' },
    },
  }, {
    TELEGRAM_NOTIFY_SERVICE: 'dashboard-maulagi-prod',
  });

  assert.equal(payload.source, 'noncod');
  assert.equal(payload.title, 'Sync gagal');
  assert.equal(payload.message, 'Timeout dari provider');
  assert.equal(payload.service, 'dashboard-maulagi-prod');
  assert.deepEqual(payload.meta, {
    periode: '2026-04',
    retried: true,
    nested: '{"reason":"timeout"}',
  });
});

test('sendOpsNotification mengirim payload dengan shared secret', async () => {
  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200 };
  };

  const result = await sendOpsNotification({
    source: 'noncod',
    title: 'Sync gagal',
    message: 'Provider timeout',
  }, {
    TELEGRAM_NOTIFY_URL: 'https://example.com/hook',
    TELEGRAM_NOTIFY_SECRET: 'secret-1',
    TELEGRAM_NOTIFY_SERVICE: 'dashboard-prod',
  }, fakeFetch);

  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://example.com/hook');
  assert.equal(captured.options.headers['X-Ops-Secret'], 'secret-1');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.source, 'noncod');
  assert.equal(body.service, 'dashboard-prod');
});