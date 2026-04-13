const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS_OVERRIDE_KEY_PREFIX,
  applyStatusOverrides,
  buildStatusOverrideKey,
  createStatusOverrideRecord,
  normalizeResi,
  normalizeSearchQuery,
  normalizeStatusOverride,
  parseStatusOverrideValue,
} = require('../api/_noncod-status-overrides');

test('normalizer override membersihkan resi, query, dan status', () => {
  assert.equal(normalizeResi('  abc123  '), 'ABC123');
  assert.equal(normalizeSearchQuery('  abc123  '), 'ABC123');
  assert.equal(normalizeStatusOverride('  batal '), 'BATAL');
  assert.equal(buildStatusOverrideKey('abc123'), STATUS_OVERRIDE_KEY_PREFIX + 'ABC123');
});

test('createStatusOverrideRecord menyimpan metadata minimal untuk fallback', () => {
  const record = createStatusOverrideRecord({
    nomor_resi: 'ab-123',
    status_terakhir: 'batal',
    periode: '2026-04',
    cabang: 'cabang kendari',
    tanggal_buat: '2026-04-10',
    metode_pembayaran: 'NONCOD',
  });

  assert.equal(record.nomor_resi, 'AB-123');
  assert.equal(record.status_terakhir, 'BATAL');
  assert.equal(record.periode, '2026-04');
  assert.equal(record.cabang, 'CABANG KENDARI');
  assert.equal(record.tanggal_buat, '2026-04-10');
  assert.equal(record.metode_pembayaran, 'noncod');
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseStatusOverrideValue mengabaikan payload yang tidak valid', () => {
  assert.equal(parseStatusOverrideValue(''), null);
  assert.equal(parseStatusOverrideValue('{oops'), null);
  assert.equal(parseStatusOverrideValue(JSON.stringify({ nomor_resi: '', status_terakhir: 'BATAL' })), null);
});

test('applyStatusOverrides hanya menimpa status untuk resi yang dioverride', () => {
  const rows = [
    { nomor_resi: 'RESI-1', status_terakhir: 'DELIVERED', cabang: 'A' },
    { nomor_resi: 'RESI-2', status_terakhir: 'DELIVERED', cabang: 'B' },
  ];
  const overrideMap = new Map([
    ['RESI-2', { nomor_resi: 'RESI-2', status_terakhir: 'BATAL', updated_at: '2026-04-13T10:00:00.000Z' }],
  ]);

  const result = applyStatusOverrides(rows, overrideMap);

  assert.equal(result[0].status_terakhir, 'DELIVERED');
  assert.equal(result[1].status_terakhir, 'BATAL');
  assert.equal(result[1].manual_status, true);
  assert.equal(result[1].manual_status_terakhir, 'BATAL');
  assert.equal(result[1].manual_status_updated_at, '2026-04-13T10:00:00.000Z');
});