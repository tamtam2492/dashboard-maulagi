const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NONCOD_PENDING_ALLOCATION_KEY_PREFIX,
  buildPendingAllocationKey,
  createPendingAllocationRecord,
  normalizePendingAmount,
  normalizePendingCabang,
  normalizePendingDate,
  normalizePendingTransferId,
  parsePendingAllocationValue,
} = require('../api/_noncod-pending-allocations');

test('normalizer pending allocation membersihkan id, cabang, tanggal, dan nominal', () => {
  assert.equal(normalizePendingTransferId(' 12345 '), '12345');
  assert.equal(normalizePendingCabang(' cabang kendari '), 'CABANG KENDARI');
  assert.equal(normalizePendingDate('2026-04-10T09:00:00'), '2026-04-10');
  assert.equal(normalizePendingAmount('75000.4'), 75000);
  assert.equal(buildPendingAllocationKey('12345'), NONCOD_PENDING_ALLOCATION_KEY_PREFIX + '12345');
});

test('createPendingAllocationRecord menyimpan metadata pending minimal', () => {
  const record = createPendingAllocationRecord({
    root_transfer_id: '55',
    cabang: 'cabang kolaka',
    after_date: '2026-04-10',
    nominal: 100000,
    reason: 'Menunggu update NONCOD',
    transfer_bank: 'bca',
    bukti_url: 'proof.jpg',
    ket: 'split admin',
    timestamp: '2026-04-10T08:00:00.000Z',
  });

  assert.equal(record.root_transfer_id, '55');
  assert.equal(record.cabang, 'CABANG KOLAKA');
  assert.equal(record.after_periode, '2026-04');
  assert.equal(record.transfer_bank, 'BCA');
  assert.equal(record.bukti_url, 'proof.jpg');
  assert.equal(record.ket, 'split admin');
  assert.equal(record.timestamp, '2026-04-10T08:00:00.000Z');
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  const largeRecord = createPendingAllocationRecord({
    root_transfer_id: '56',
    cabang: 'CABANG KOLAKA',
    after_date: '2026-04-10',
    nominal: 387000,
    reason: 'Sisa 49 ribu pending',
    bukti_url: 'proof.jpg',
  });

  assert.equal(largeRecord.root_transfer_id, '56');
  assert.equal(largeRecord.cabang, 'CABANG KOLAKA');
  assert.equal(largeRecord.after_date, '2026-04-10');
  assert.equal(largeRecord.after_periode, '2026-04');
  assert.equal(largeRecord.nominal, 387000);
  assert.equal(largeRecord.reason, 'Sisa 49 ribu pending');
  assert.equal(largeRecord.ket, '');
  assert.equal(largeRecord.transfer_bank, '');
  assert.equal(largeRecord.bukti_url, 'proof.jpg');
  assert.match(largeRecord.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(largeRecord.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(largeRecord.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('parsePendingAllocationValue mengabaikan payload tidak valid', () => {
  assert.equal(parsePendingAllocationValue(''), null);
  assert.equal(parsePendingAllocationValue('{oops'), null);
  assert.equal(parsePendingAllocationValue(JSON.stringify({
    root_transfer_id: '',
    cabang: 'CABANG BAU BAU',
    after_date: '2026-04-10',
    nominal: 50000,
    bukti_url: 'proof.jpg',
  })), null);
});