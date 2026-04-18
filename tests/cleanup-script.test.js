const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCleanupRunDate,
  getOcrJobCleanupReference,
  getOcrJobCutoffDate,
  getPeriodeCutoff,
  getTransferCutoffDate,
  getVisitorCutoffDate,
  shouldDeleteOcrJobState,
} = require('../api/_cleanup-maintenance');

test('getTransferCutoffDate mempertahankan bulan berjalan dan dua bulan sebelumnya', () => {
  const mayCutoff = getTransferCutoffDate(new Date('2026-05-18T12:00:00.000Z'));
  const aprilCutoff = getTransferCutoffDate(new Date('2026-04-18T12:00:00.000Z'));

  assert.ok(Number.isFinite(Date.parse(mayCutoff)));
  assert.ok(Number.isFinite(Date.parse(aprilCutoff)));
  assert.ok(Date.parse(mayCutoff) < Date.parse('2026-05-01T00:00:00.000Z'));
  assert.ok(Date.parse(aprilCutoff) < Date.parse('2026-04-01T00:00:00.000Z'));
});

test('getPeriodeCutoff mengikuti aturan hapus lintas bulan', () => {
  assert.equal(getPeriodeCutoff(new Date('2026-05-18T12:00:00.000Z')), '2026-03');
  assert.equal(getPeriodeCutoff(new Date('2026-04-18T12:00:00.000Z')), '2026-02');
});

test('getVisitorCutoffDate menghitung cutoff visitor berdasarkan hari retensi', () => {
  assert.equal(getVisitorCutoffDate(new Date('2026-04-18T12:00:00.000Z'), 90), '2026-01-18');
});

test('getCleanupRunDate memakai zona waktu Asia/Makassar untuk penanda harian', () => {
  assert.equal(getCleanupRunDate(new Date('2026-04-18T15:59:59.000Z')), '2026-04-18');
  assert.equal(getCleanupRunDate(new Date('2026-04-18T16:00:00.000Z')), '2026-04-19');
});

test('getOcrJobCleanupReference memprioritaskan finishedAt lalu updatedAt lalu createdAt', () => {
  assert.equal(getOcrJobCleanupReference({ finishedAt: '2026-04-10T00:00:00.000Z', updatedAt: '2026-04-09T00:00:00.000Z' }), '2026-04-10T00:00:00.000Z');
  assert.equal(getOcrJobCleanupReference({ updatedAt: '2026-04-09T00:00:00.000Z', createdAt: '2026-04-08T00:00:00.000Z' }), '2026-04-09T00:00:00.000Z');
  assert.equal(getOcrJobCleanupReference({ createdAt: '2026-04-08T00:00:00.000Z' }), '2026-04-08T00:00:00.000Z');
});

test('shouldDeleteOcrJobState hanya true untuk state yang lebih tua dari cutoff', () => {
  const cutoff = getOcrJobCutoffDate(new Date('2026-04-18T12:00:00.000Z'), 7);

  assert.equal(shouldDeleteOcrJobState({ status: 'succeeded', finishedAt: '2026-04-09T11:59:59.000Z' }, cutoff), true);
  assert.equal(shouldDeleteOcrJobState({ status: 'processing', updatedAt: '2026-04-12T12:00:00.000Z' }, cutoff), false);
  assert.equal(shouldDeleteOcrJobState({ status: 'queued', createdAt: '2026-04-05T00:00:00.000Z' }, cutoff), true);
  assert.equal(shouldDeleteOcrJobState({ status: 'queued' }, cutoff), false);
});