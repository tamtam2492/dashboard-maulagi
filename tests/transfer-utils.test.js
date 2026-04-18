const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTransferUpdate,
  getAffectedTransferPeriodes,
  getPeriodeFromDate,
  isPositiveTransferNominal,
  isValidTransferDate,
  normalizeTransferKet,
  parseTransferNominal,
  roundTransferNominal,
} = require('../api/_transfer-utils');

test('getPeriodeFromDate hanya menerima tanggal transfer valid', () => {
  assert.equal(getPeriodeFromDate('2026-04-11'), '2026-04');
  assert.equal(getPeriodeFromDate('2026/04/11'), '');
  assert.equal(getPeriodeFromDate(''), '');
});

test('validator tanggal transfer menolak format yang salah', () => {
  assert.equal(isValidTransferDate('2026-04-11'), true);
  assert.equal(isValidTransferDate('11-04-2026'), false);
  assert.equal(isValidTransferDate('2026-4-11'), false);
});

test('nominal transfer diparse konsisten', () => {
  assert.equal(isPositiveTransferNominal('132000'), true);
  assert.equal(isPositiveTransferNominal('132,000'), true);
  assert.equal(isPositiveTransferNominal('0'), false);
  assert.equal(parseTransferNominal('132,500'), 132500);
  assert.equal(roundTransferNominal('132000.4'), 132000);
});

test('ket transfer dinormalisasi menjadi null bila kosong', () => {
  assert.equal(normalizeTransferKet('  cek tanggal  '), 'cek tanggal');
  assert.equal(normalizeTransferKet('   '), null);
  assert.equal(normalizeTransferKet(undefined), undefined);
});

test('buildTransferUpdate selalu menurunkan periode dari tgl_inputan', () => {
  assert.deepEqual(buildTransferUpdate('2026-04-11', '  split manual '), {
    tgl_inputan: '2026-04-11',
    periode: '2026-04',
    ket: 'split manual',
  });
  assert.deepEqual(buildTransferUpdate('2026-04-11'), {
    tgl_inputan: '2026-04-11',
    periode: '2026-04',
  });
  assert.equal(buildTransferUpdate('11/04/2026', 'x'), null);
});

test('buildTransferUpdate bisa sekaligus membulatkan nominal manual dari admin', () => {
  assert.deepEqual(buildTransferUpdate('2026-04-11', '  koreksi OCR  ', '36000.4'), {
    tgl_inputan: '2026-04-11',
    periode: '2026-04',
    ket: 'koreksi OCR',
    nominal: 36000,
  });
  assert.equal(buildTransferUpdate('2026-04-11', 'x', '0'), null);
});

test('getAffectedTransferPeriodes menggabungkan periode lama dan baru tanpa duplikasi', () => {
  assert.deepEqual(
    getAffectedTransferPeriodes(['2026-04-30', '2026-05-01', '2026-04-11', 'invalid', '']),
    ['2026-04', '2026-05'],
  );
  assert.deepEqual(getAffectedTransferPeriodes('2026-04-11'), ['2026-04']);
});
