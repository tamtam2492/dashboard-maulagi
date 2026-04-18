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
  readStatusOverridesByResi,
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
  assert.equal(record.status_terakhir, 'VOID');
  assert.equal(record.periode, '2026-04');
  assert.equal(record.cabang, 'CABANG KENDARI');
  assert.equal(record.tanggal_buat, '2026-04-10');
  assert.equal(record.metode_pembayaran, 'noncod');
  assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseStatusOverrideValue memigrasikan override BATAL lama menjadi VOID', () => {
  const record = parseStatusOverrideValue(JSON.stringify({ nomor_resi: 'ab-123', status_terakhir: 'BATAL' }));
  assert.equal(record.nomor_resi, 'AB-123');
  assert.equal(record.status_terakhir, 'VOID');
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
    ['RESI-2', { nomor_resi: 'RESI-2', status_terakhir: 'VOID', updated_at: '2026-04-13T10:00:00.000Z' }],
  ]);

  const result = applyStatusOverrides(rows, overrideMap);

  assert.equal(result[0].status_terakhir, 'DELIVERED');
  assert.equal(result[1].status_terakhir, 'VOID');
  assert.equal(result[1].manual_status, true);
  assert.equal(result[1].manual_status_terakhir, 'VOID');
  assert.equal(result[1].manual_status_updated_at, '2026-04-13T10:00:00.000Z');
});

test('readStatusOverridesByResi memakai prefix scan tunggal saat resi periode sangat banyak', async () => {
  let inCalls = 0;
  let likeCalls = 0;

  const supabase = {
    from(table) {
      assert.equal(table, 'settings');
      return {
        select() {
          return this;
        },
        in(field, values) {
          assert.equal(field, 'key');
          assert.ok(Array.isArray(values));
          inCalls += 1;
          return Promise.resolve({ data: [], error: null });
        },
        like(field, pattern) {
          assert.equal(field, 'key');
          assert.match(pattern, /^noncod_status_override_/i);
          likeCalls += 1;
          return this;
        },
        order() {
          return this;
        },
        range() {
          return Promise.resolve({
            data: [
              {
                key: buildStatusOverrideKey('RESI-150'),
                value: JSON.stringify({ nomor_resi: 'RESI-150', status_terakhir: 'VOID' }),
              },
            ],
            error: null,
          });
        },
      };
    },
  };

  const nomorResiList = Array.from({ length: 250 }, (_, index) => 'RESI-' + index);
  const result = await readStatusOverridesByResi(supabase, nomorResiList);

  assert.equal(likeCalls, 1);
  assert.equal(inCalls, 0);
  assert.equal(result.get('RESI-150').status_terakhir, 'VOID');
});
