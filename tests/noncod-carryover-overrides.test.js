const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NONCOD_CARRYOVER_OVERRIDE_KEY_PREFIX,
  MAX_NONCOD_CARRYOVER_AMOUNT,
  buildCarryoverOverrideKey,
  createCarryoverOverrideRecord,
  isCarryoverNextDay,
  normalizeCarryoverAmount,
  normalizeCarryoverCabang,
  normalizeCarryoverDate,
  normalizeCarryoverReason,
  normalizeCarryoverTransferId,
  parseCarryoverOverrideValue,
} = require('../api/_noncod-carryover-overrides');

test('normalizer carry-over membersihkan id transfer, cabang, tanggal, dan reason', () => {
  assert.equal(normalizeCarryoverTransferId(' 12345 '), '12345');
  assert.equal(normalizeCarryoverCabang(' cabang kendari '), 'CABANG KENDARI');
  assert.equal(normalizeCarryoverDate('2026-04-10T09:00:00'), '2026-04-10');
  assert.equal(normalizeCarryoverReason('  Selisih   diverifikasi  admin  '), 'Selisih diverifikasi admin');
  assert.equal(normalizeCarryoverAmount('75000.4'), 75000);
  assert.equal(buildCarryoverOverrideKey('12345'), NONCOD_CARRYOVER_OVERRIDE_KEY_PREFIX + '12345');
});

test('isCarryoverNextDay hanya menerima carry-over H+1', () => {
  assert.equal(isCarryoverNextDay('2026-04-10', '2026-04-11'), true);
  assert.equal(isCarryoverNextDay('2026-04-30', '2026-05-01'), true);
  assert.equal(isCarryoverNextDay('2026-04-10', '2026-04-12'), false);
});

test('createCarryoverOverrideRecord membatasi nominal sampai Rp100.000', () => {
  const record = createCarryoverOverrideRecord({
    transfer_id: '55',
    cabang: 'cabang kolaka',
    target_date: '2026-04-10',
    transfer_date: '2026-04-11',
    nominal: 100000,
    reason: 'Selisih H+1 diverifikasi admin',
    transfer_bank: 'bca',
  });

  assert.equal(MAX_NONCOD_CARRYOVER_AMOUNT, 100000);
  assert.equal(record.transfer_id, '55');
  assert.equal(record.cabang, 'CABANG KOLAKA');
  assert.equal(record.target_periode, '2026-04');
  assert.equal(record.transfer_periode, '2026-04');
  assert.equal(record.transfer_bank, 'BCA');
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(createCarryoverOverrideRecord({
    transfer_id: '56',
    cabang: 'CABANG KOLAKA',
    target_date: '2026-04-10',
    transfer_date: '2026-04-11',
    nominal: 100001,
    reason: 'Lewat batas',
  }), null);

  assert.equal(createCarryoverOverrideRecord({
    transfer_id: '57',
    cabang: 'CABANG KOLAKA',
    target_date: '2026-04-10',
    transfer_date: '2026-04-12',
    nominal: 75000,
    reason: 'Bukan H+1',
  }), null);
});

test('parseCarryoverOverrideValue mengabaikan payload tidak valid', () => {
  assert.equal(parseCarryoverOverrideValue(''), null);
  assert.equal(parseCarryoverOverrideValue('{oops'), null);
  assert.equal(parseCarryoverOverrideValue(JSON.stringify({
    transfer_id: '88',
    cabang: 'CABANG BAU BAU',
    target_date: '2026-04-10',
    transfer_date: '2026-04-12',
    nominal: 50000,
    reason: 'Tanggal salah',
  })), null);
});