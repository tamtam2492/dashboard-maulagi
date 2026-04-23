const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractJsonCandidate,
  extractLooseOcrFields,
  parseOcrResponseContent,
  resolveOcrNominal,
  sanitizeLooseJson,
} = require('../api/_ocr-utils');

test('extractJsonCandidate mengambil object dari fenced block', () => {
  const content = '```json\n{"is_receipt": true, "Channel": "BRI"}\n```';
  assert.equal(extractJsonCandidate(content), '{"is_receipt": true, "Channel": "BRI"}');
});

test('sanitizeLooseJson mengubah token Unknown menjadi null', () => {
  const content = '{"is_receipt": true, "Admin": Unknown}';
  assert.equal(sanitizeLooseJson(content), '{"is_receipt": true, "Admin": null}');
});

test('parseOcrResponseContent membaca JSON longgar dengan Unknown', () => {
  const parsed = parseOcrResponseContent('{"is_receipt": true, "Channel": "BRI", "Total_Bayar": 132000, "Admin": Unknown}');
  assert.deepEqual(parsed, {
    isReceipt: true,
    channel: 'BRI',
    totalBayar: 132000,
    jumlahKirimUang: null,
    admin: null,
    adminDibayar: null,
    tanggalTransfer: null,
    waktuTransfer: null,
    transferDatetime: null,
    raw: {
      is_receipt: true,
      Channel: 'BRI',
      Total_Bayar: 132000,
      Jumlah_Kirim_Uang: undefined,
      Admin: null,
      Admin_Dibayar: undefined,
      Tanggal_Transfer: undefined,
      Waktu_Transfer: undefined,
    },
  });
});

test('parseOcrResponseContent fallback ke field-per-line', () => {
  const parsed = parseOcrResponseContent('is_receipt: true\nChannel: BCA\nTotal_Bayar: 40000\nJumlah_Kirim_Uang: 40000\nAdmin: 0\nAdmin_Dibayar: false');
  assert.equal(parsed.isReceipt, true);
  assert.equal(parsed.channel, 'BCA');
  assert.equal(parsed.totalBayar, 40000);
  assert.equal(parsed.jumlahKirimUang, 40000);
  assert.equal(parsed.admin, 0);
  assert.equal(parsed.adminDibayar, false);
});

test('extractLooseOcrFields mengembalikan raw value yang ditemukan', () => {
  const parsed = extractLooseOcrFields('Channel: DANA\nJumlah Kirim Uang: 36000\nAdmin: None');
  assert.deepEqual(parsed, {
    is_receipt: undefined,
    Channel: 'DANA',
    Total_Bayar: undefined,
    Jumlah_Kirim_Uang: '36000',
    Admin: 'None',
    Admin_Dibayar: undefined,
  });
});

test('resolveOcrNominal memprioritaskan jumlah kirim uang saat admin dicoret atau gratis', () => {
  const resolved = resolveOcrNominal({
    totalBayar: 36000,
    jumlahKirimUang: 36000,
    admin: 2500,
    adminDibayar: false,
  });
  assert.deepEqual(resolved, {
    totalBayar: 36000,
    jumlahKirimUang: 36000,
    admin: 2500,
    adminDibayar: false,
    effectiveAdmin: 0,
    nominal: 36000,
  });
});

test('resolveOcrNominal mengurangi total bayar dengan admin bila fee memang dibayar', () => {
  const resolved = resolveOcrNominal({
    totalBayar: 38500,
    jumlahKirimUang: null,
    admin: 2500,
    adminDibayar: true,
  });
  assert.equal(resolved.effectiveAdmin, 2500);
  assert.equal(resolved.nominal, 36000);
});

test('parseOcrResponseContent melempar error bila respons tidak punya field OCR', () => {
  assert.throws(
    () => parseOcrResponseContent('saya tidak tahu gambar ini apa'),
    /Respons OCR kosong|Unexpected token|valid/
  );
});

test('parseOcrResponseContent mem-parse tanggal dan waktu format DD/MM/YYYY HH:MM:SS dari OCR', () => {
  const parsed = parseOcrResponseContent('{"is_receipt": true, "Channel": "BCA", "Total_Bayar": 133000, "Tanggal_Transfer": "19/04/2026 18:36:05", "Waktu_Transfer": null}');
  assert.equal(parsed.tanggalTransfer, '2026-04-19');
  assert.equal(parsed.waktuTransfer, '18:36:05');
  assert.equal(parsed.transferDatetime, '2026-04-19T18:36:05');
});

test('parseOcrResponseContent mem-parse tanggal dan waktu format YYYY-MM-DD HH:MM:SS dari OCR', () => {
  const parsed = parseOcrResponseContent('{"is_receipt": true, "Channel": "BCA", "Total_Bayar": 133000, "Tanggal_Transfer": "2026-04-19 18:36:05", "Waktu_Transfer": "18:36:05"}');
  assert.equal(parsed.tanggalTransfer, '2026-04-19');
  assert.equal(parsed.waktuTransfer, '18:36:05');
  assert.equal(parsed.transferDatetime, '2026-04-19T18:36:05');
});