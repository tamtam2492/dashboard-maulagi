const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractJsonCandidate,
  extractLooseOcrFields,
  parseOcrResponseContent,
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
    admin: null,
    raw: {
      is_receipt: true,
      Channel: 'BRI',
      Total_Bayar: 132000,
      Admin: null,
    },
  });
});

test('parseOcrResponseContent fallback ke field-per-line', () => {
  const parsed = parseOcrResponseContent('is_receipt: true\nChannel: BCA\nTotal_Bayar: 40000\nAdmin: 0');
  assert.equal(parsed.isReceipt, true);
  assert.equal(parsed.channel, 'BCA');
  assert.equal(parsed.totalBayar, 40000);
  assert.equal(parsed.admin, 0);
});

test('extractLooseOcrFields mengembalikan raw value yang ditemukan', () => {
  const parsed = extractLooseOcrFields('Channel: DANA\nAdmin: None');
  assert.deepEqual(parsed, {
    is_receipt: undefined,
    Channel: 'DANA',
    Total_Bayar: undefined,
    Admin: 'None',
  });
});

test('parseOcrResponseContent melempar error bila respons tidak punya field OCR', () => {
  assert.throws(
    () => parseOcrResponseContent('saya tidak tahu gambar ini apa'),
    /Respons OCR kosong|Unexpected token|valid/
  );
});