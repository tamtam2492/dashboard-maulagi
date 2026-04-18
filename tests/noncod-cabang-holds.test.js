const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NONCOD_CABANG_HOLD_KEY_PREFIX,
  buildCabangHoldKey,
  createCabangHoldRecord,
  normalizeCabangHoldAmount,
  normalizeCabangHoldCabang,
  normalizeCabangHoldTransferId,
  parseCabangHoldValue,
} = require('../api/_noncod-cabang-holds');

test('normalizer hold cabang membersihkan id, cabang, dan nominal', () => {
  assert.equal(normalizeCabangHoldTransferId(' 12345 '), '12345');
  assert.equal(normalizeCabangHoldCabang(' cabang kendari '), 'CABANG KENDARI');
  assert.equal(normalizeCabangHoldAmount('75000.4'), 75000);
  assert.equal(buildCabangHoldKey('12345'), NONCOD_CABANG_HOLD_KEY_PREFIX + '12345');
});

test('createCabangHoldRecord menyimpan metadata hold minimal', () => {
  const record = createCabangHoldRecord({
    root_transfer_id: '55',
    cabang: 'cabang kolaka',
    nominal: 26000,
    reason: 'Kelebihan transfer user',
    transfer_bank: 'bca',
    bukti_url: 'proof.jpg',
    ket: 'input public',
    timestamp: '2026-04-18T08:00:00.000Z',
  });

  assert.equal(record.root_transfer_id, '55');
  assert.equal(record.cabang, 'CABANG KOLAKA');
  assert.equal(record.nominal, 26000);
  assert.equal(record.transfer_bank, 'BCA');
  assert.equal(record.bukti_url, 'proof.jpg');
  assert.equal(record.ket, 'input public');
  assert.equal(record.timestamp, '2026-04-18T08:00:00.000Z');
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseCabangHoldValue mengabaikan payload tidak valid', () => {
  assert.equal(parseCabangHoldValue(''), null);
  assert.equal(parseCabangHoldValue('{oops'), null);
  assert.equal(parseCabangHoldValue(JSON.stringify({
    root_transfer_id: '',
    cabang: 'CABANG BAU BAU',
    nominal: 50000,
  })), null);
});
