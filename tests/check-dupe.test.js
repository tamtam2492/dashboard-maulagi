const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDupeSummary,
  shouldFallbackToInternalOcrWorker,
} = require('../api/input');

test('buildDupeSummary memprioritaskan exact duplicate', () => {
  const summary = buildDupeSummary({
    exactDupes: [{ id: 1, nominal: 125000, nama_bank: 'BCA' }],
    branchDayTransfers: [{ id: 1, nominal: 125000, nama_bank: 'BCA' }],
    nominal: 125000,
    areaName: 'SULTRA',
  });

  assert.equal(summary.tone, 'warn');
  assert.equal(summary.exactMatch, true);
  assert.equal(summary.branchDayCount, 1);
  assert.equal(summary.branchDayTotal, 125000);
  assert.equal(summary.scopeLabel, 'Area SULTRA');
  assert.match(summary.message, /area, tanggal rekap, dan nominal yang sama/i);
});

test('buildDupeSummary memberi info bila cabang sudah punya transfer di hari yang sama', () => {
  const summary = buildDupeSummary({
    exactDupes: [],
    branchDayTransfers: [
      { id: 1, nominal: 100000, nama_bank: 'BCA' },
      { id: 2, nominal: 250000, nama_bank: 'BRI' },
    ],
    nominal: 90000,
    areaName: 'MKS OUTER',
  });

  assert.equal(summary.tone, 'info');
  assert.equal(summary.exactMatch, false);
  assert.equal(summary.branchDayCount, 2);
  assert.equal(summary.branchDayTotal, 350000);
  assert.equal(summary.scopeLabel, 'Area MKS OUTER');
  assert.match(summary.title, /Area MKS OUTER/i);
});

test('buildDupeSummary aman bila belum ada transfer tersimpan', () => {
  const summary = buildDupeSummary({
    exactDupes: [],
    branchDayTransfers: [],
    nominal: 75000,
    areaName: 'SULTRA',
  });

  assert.equal(summary.tone, 'ok');
  assert.equal(summary.exactMatch, false);
  assert.equal(summary.branchDayCount, 0);
  assert.equal(summary.branchDayTotal, 0);
  assert.match(summary.message, /Area SULTRA belum punya transfer tersimpan/i);
});

test('shouldFallbackToInternalOcrWorker aktif untuk trigger OCR yang tidak sukses', () => {
  assert.equal(shouldFallbackToInternalOcrWorker({ ok: false, status: 502 }), true);
  assert.equal(shouldFallbackToInternalOcrWorker({ skipped: true, reason: 'disabled' }), true);
  assert.equal(shouldFallbackToInternalOcrWorker({ ok: true, status: 200 }), false);
  assert.equal(shouldFallbackToInternalOcrWorker(null), false);
});