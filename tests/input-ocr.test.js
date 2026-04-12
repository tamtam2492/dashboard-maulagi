const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchBank,
  normalizeBankNameInput,
  parseOcrApiResponse,
} = require('../lib/input-ocr');

test('normalizeBankNameInput menormalkan variasi penulisan bank', () => {
  assert.equal(normalizeBankNameInput('  bri  '), 'BRI');
  assert.equal(normalizeBankNameInput('m-transfer bca'), 'BCA');
  assert.equal(normalizeBankNameInput(''), '');
});

test('matchBank memetakan channel OCR ke nama bank yang dipakai form', () => {
  assert.equal(matchBank('BRImo transfer'), 'BRI');
  assert.equal(matchBank('Livin by Mandiri'), 'MANDIRI');
  assert.equal(matchBank('m-Banking BCA'), 'BCA');
  assert.equal(matchBank('Unknown'), '');
});

test('parseOcrApiResponse membaca body JSON yang valid', () => {
  assert.deepEqual(parseOcrApiResponse(200, '{"channel":"BRI","nominal":132000}'), {
    channel: 'BRI',
    nominal: 132000,
  });
});

test('parseOcrApiResponse memberi pesan timeout yang jelas', () => {
  assert.throws(
    () => parseOcrApiResponse(504, '<html>timeout</html>'),
    /Server timeout/
  );
});

test('parseOcrApiResponse memberi pesan server error untuk body non-JSON', () => {
  assert.throws(
    () => parseOcrApiResponse(502, '<html>bad gateway</html>'),
    /Server error \(502\)/
  );
});