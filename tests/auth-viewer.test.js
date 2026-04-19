const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyViewerCabangAccess } = require('../api/auth');

function createViewerSupabase(rows) {
  const items = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
  return {
    from(table) {
      assert.equal(table, 'cabang');
      return {
        select() {
          return {
            eq(column, value) {
              assert.equal(column, 'no_wa');
              return {
                async maybeSingle() {
                  const match = items.find((row) => row.no_wa === value) || null;
                  return { data: match ? { ...match } : null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

test('verifyViewerCabangAccess mengembalikan cabang saat login Maukirim valid', async () => {
  const supabase = createViewerSupabase([{ id: 7, nama: 'KENDARI', no_wa: '08123456789' }]);
  const calls = [];

  const cabang = await verifyViewerCabangAccess(supabase, '08123 456789', 'secret-pass', {
    async loginFn(wa, password) {
      calls.push({ wa, password });
    },
  });

  assert.deepEqual(cabang, { id: 7, nama: 'KENDARI', no_wa: '08123456789' });
  assert.deepEqual(calls, [{ wa: '08123456789', password: 'secret-pass' }]);
});

test('verifyViewerCabangAccess mengembalikan null bila WA belum tersinkron', async () => {
  const supabase = createViewerSupabase([{ id: 7, nama: 'KENDARI', no_wa: '08123456789' }]);
  let called = false;

  const cabang = await verifyViewerCabangAccess(supabase, '0899999999', 'secret-pass', {
    async loginFn() {
      called = true;
    },
  });

  assert.equal(cabang, null);
  assert.equal(called, false);
});

test('verifyViewerCabangAccess meneruskan error login Maukirim', async () => {
  const supabase = createViewerSupabase([{ id: 7, nama: 'KENDARI', no_wa: '08123456789' }]);
  const error = new Error('Login gagal.');
  error.code = 'MAUKIRIM_AUTH_FAILED';

  await assert.rejects(
    () => verifyViewerCabangAccess(supabase, '08123456789', 'bad-pass', {
      async loginFn() {
        throw error;
      },
    }),
    (err) => err === error,
  );
});