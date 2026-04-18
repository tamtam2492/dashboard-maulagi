const test = require('node:test');
const assert = require('node:assert/strict');

const { getRekonDateKey, isValidPeriodeParam, planNoncodAutoRefresh } = require('../api/noncod');

test('getRekonDateKey hanya memakai tanggal_buat sesuai report NONCOD', () => {
  assert.equal(getRekonDateKey({
    tanggal_buat: '2026-04-01 07:43:16',
    tanggal_pickup: '2026-04-02 08:11:00',
  }), '2026-04-01');

  assert.equal(getRekonDateKey({
    tanggal_buat: '',
    tanggal_pickup: '2026-04-02 08:11:00',
  }), '');
});

test('isValidPeriodeParam menolak bulan di luar 01-12', () => {
  assert.equal(isValidPeriodeParam('2026-04'), true);
  assert.equal(isValidPeriodeParam('2026-13'), false);
  assert.equal(isValidPeriodeParam('2026-00'), false);
  assert.equal(isValidPeriodeParam('2026-4'), false);
});

test('planNoncodAutoRefresh bootstrap snapshot kosong pertama kali secara inline', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: true },
    syncMeta: null,
    rowCount: 0,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: { status: 'published', pendingPeriodes: [], buildPeriodes: [], lastTriggeredAt: null },
  }), {
    action: 'inline',
    status: 'running',
    reason: 'bootstrap_empty',
  });
});

test('planNoncodAutoRefresh queue background saat snapshot stale dan trigger aktif', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: true },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: { status: 'published', pendingPeriodes: [], buildPeriodes: [], lastTriggeredAt: null },
    now: Date.parse('2026-04-18T01:00:00.000Z'),
  }), {
    action: 'queue',
    status: 'queued',
    reason: 'stale',
  });
});

test('planNoncodAutoRefresh fallback inline saat trigger background tidak aktif', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: false },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: false,
    pipelineState: { status: 'dirty', pendingPeriodes: ['2026-04'], buildPeriodes: [], lastTriggeredAt: null },
  }), {
    action: 'inline',
    status: 'running',
    reason: 'dirty',
  });
});

test('planNoncodAutoRefresh tidak queue ulang jika refresh baru saja dipicu', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: true },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: {
      status: 'dirty',
      pendingPeriodes: ['2026-04'],
      buildPeriodes: [],
      lastTriggeredAt: '2026-04-18T01:00:30.000Z',
    },
    now: Date.parse('2026-04-18T01:01:00.000Z'),
  }), {
    action: 'none',
    status: 'queued',
    reason: 'dirty',
  });
});

test('planNoncodAutoRefresh menandai refresh sedang berjalan saat pipeline build periode aktif', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: false },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: {
      status: 'building',
      pendingPeriodes: [],
      buildPeriodes: ['2026-04'],
      lastTriggeredAt: '2026-04-18T01:00:00.000Z',
    },
  }), {
    action: 'none',
    status: 'running',
    reason: 'dirty',
  });
});