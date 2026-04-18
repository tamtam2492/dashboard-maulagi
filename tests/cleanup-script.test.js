const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getOcrJobCleanupReference,
  getOcrJobCutoffDate,
  getTransferCutoffDate,
  shouldDeleteOcrJobState,
} = require('../scripts/local/cleanup');

test('getTransferCutoffDate mempertahankan bulan berjalan dan dua bulan sebelumnya', () => {
  const mayCutoff = new Date(getTransferCutoffDate(new Date('2026-05-18T12:00:00.000Z')));
  const aprilCutoff = new Date(getTransferCutoffDate(new Date('2026-04-18T12:00:00.000Z')));

  assert.equal(mayCutoff.getFullYear(), 2026);
  assert.equal(mayCutoff.getMonth(), 2);
  assert.equal(mayCutoff.getDate(), 1);
  assert.equal(mayCutoff.getHours(), 0);

  assert.equal(aprilCutoff.getFullYear(), 2026);
  assert.equal(aprilCutoff.getMonth(), 1);
  assert.equal(aprilCutoff.getDate(), 1);
  assert.equal(aprilCutoff.getHours(), 0);
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