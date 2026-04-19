const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCabangSyncName,
  normalizeViewerWa,
  syncCabangViewerFromSenders,
} = require('../api/_cabang-viewer-sync');

function createCabangSupabase(rows, options = {}) {
  const items = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
  const updateErrors = options.updateErrors || {};
  const updates = [];

  return {
    updates,
    rows: items,
    from(table) {
      assert.equal(table, 'cabang');
      return {
        select() {
          const execute = async (ids = null) => {
            const selected = ids
              ? items.filter((row) => ids.includes(row.id))
              : items;
            return { data: selected.map((row) => ({ ...row })), error: null };
          };

          return {
            in(column, ids) {
              assert.equal(column, 'id');
              return execute(ids);
            },
            then(resolve, reject) {
              return execute().then(resolve, reject);
            },
          };
        },
        update(data) {
          return {
            async eq(column, id) {
              assert.equal(column, 'id');
              if (updateErrors[id]) {
                return { error: updateErrors[id] };
              }
              const row = items.find((item) => item.id === id);
              if (row) Object.assign(row, data);
              updates.push({ id, data: { ...data } });
              return { data: row ? { ...row } : null, error: null };
            },
          };
        },
      };
    },
  };
}

test('normalizer viewer sync membersihkan nama cabang dan nomor WA', () => {
  assert.equal(normalizeCabangSyncName('  Cabang   Kendari  '), 'CABANG KENDARI');
  assert.equal(normalizeViewerWa(' 0812 345 6789 '), '08123456789');
});

test('syncCabangViewerFromSenders hanya update cabang yang nomornya berubah', async () => {
  const supabase = createCabangSupabase([
    { id: 1, nama: 'CABANG KENDARI', no_wa: null },
    { id: 2, nama: 'CABANG BAUBAU', no_wa: '0811111111' },
    { id: 3, nama: 'CABANG WAKATOBI', no_wa: '0822222222' },
  ]);

  const result = await syncCabangViewerFromSenders(supabase, [
    { name: 'Cabang Kendari', wa: '08123456789' },
    { name: 'Cabang Baubau', wa: '0811111111' },
  ]);

  assert.deepEqual(result, {
    updated: 1,
    matched: 2,
    skipped: 2,
    total_maukirim: 2,
    total_cabang: 3,
  });
  assert.deepEqual(supabase.updates, [{ id: 1, data: { no_wa: '08123456789' } }]);
});

test('syncCabangViewerFromSenders mendukung sync terarah per cabang', async () => {
  const supabase = createCabangSupabase([
    { id: 1, nama: 'CABANG KENDARI', no_wa: null },
    { id: 2, nama: 'CABANG BAUBAU', no_wa: null },
  ]);

  const result = await syncCabangViewerFromSenders(
    supabase,
    [{ name: 'Cabang Baubau', wa: '0819999999' }],
    { cabangIds: [2] },
  );

  assert.equal(result.updated, 1);
  assert.deepEqual(supabase.updates, [{ id: 2, data: { no_wa: '0819999999' } }]);
});

test('syncCabangViewerFromSenders melempar error saat update DB gagal', async () => {
  const dbError = new Error('duplicate key value violates unique constraint');
  const supabase = createCabangSupabase(
    [{ id: 1, nama: 'CABANG KENDARI', no_wa: null }],
    { updateErrors: { 1: dbError } },
  );

  await assert.rejects(
    () => syncCabangViewerFromSenders(supabase, [{ name: 'Cabang Kendari', wa: '08123456789' }]),
    (err) => err === dbError,
  );
});