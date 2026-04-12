const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDateRange,
  filterRekonRows,
  getAggregatedRekonBaseRows,
  getAggregatedShipmentRows,
  getPeriodeDateRange,
  getScopedDates,
} = require('../lib/noncod-aggregation');

test('buildDateRange dan getPeriodeDateRange menghasilkan daftar tanggal stabil', () => {
  assert.deepEqual(buildDateRange('2026-04-09', '2026-04-11'), ['2026-04-09', '2026-04-10', '2026-04-11']);
  assert.deepEqual(getPeriodeDateRange('2026-02').slice(0, 3), ['2026-02-01', '2026-02-02', '2026-02-03']);
  assert.equal(getPeriodeDateRange('2026-02').at(-1), '2026-02-28');
});

test('getScopedDates membatasi tanggal ke periode aktif', () => {
  assert.deepEqual(
    getScopedDates(['2026-04-02', '2026-03-31', '2026-04-02', '2026-04-01'], '2026-04'),
    ['2026-04-01', '2026-04-02']
  );
});

test('getAggregatedRekonBaseRows menggabungkan noncod dan transfer per cabang', () => {
  const rows = getAggregatedRekonBaseRows({
    dates: ['2026-04-09', '2026-04-10'],
    periode: '2026-04',
    ncByDay: {
      '2026-04-09': {
        'CABANG KOLAKA': { ongkir: 289000, resi: 7 },
      },
      '2026-04-10': {
        'CABANG KOLAKA': { ongkir: 696000, resi: 13 },
        'CABANG LASUSUA': { ongkir: 132000, resi: 2 },
      },
    },
    trByCabang: {
      'CABANG KOLAKA': { list: [{ periode: '2026-04', tglRaw: '2026-04-09', nominal: 289000 }] },
      'CABANG LASUSUA': { list: [{ periode: '2026-04', tglRaw: '2026-04-10', nominal: 264000 }] },
    },
  });

  const kolaka = rows.find(row => row.cabang === 'CABANG KOLAKA');
  const lasusua = rows.find(row => row.cabang === 'CABANG LASUSUA');

  assert.deepEqual(kolaka, {
    cabang: 'CABANG KOLAKA',
    resi: 20,
    ongkir: 985000,
    transfer: 289000,
    belum: 696000,
  });
  assert.deepEqual(lasusua, {
    cabang: 'CABANG LASUSUA',
    resi: 2,
    ongkir: 132000,
    transfer: 264000,
    belum: -132000,
  });
});

test('filterRekonRows menghormati query, status, dan filter area', () => {
  const rows = [
    { cabang: 'CABANG KOLAKA', belum: 10 },
    { cabang: 'CABANG LASUSUA', belum: -5 },
    { cabang: '-', belum: 1 },
  ];

  assert.deepEqual(
    filterRekonRows(rows, { query: 'kol', status: 'belum', filterByArea: cabang => cabang !== 'CABANG LASUSUA' }),
    [{ cabang: 'CABANG KOLAKA', belum: 10 }]
  );
  assert.deepEqual(
    filterRekonRows(rows, { status: 'sudah' }),
    [{ cabang: 'CABANG LASUSUA', belum: -5 }]
  );
});

test('getAggregatedShipmentRows menggabungkan resi, ongkir, dan total', () => {
  const rows = getAggregatedShipmentRows({
    dates: ['2026-04-09', '2026-04-10'],
    periode: '2026-04',
    ncByDay: {
      '2026-04-09': {
        'CABANG KOLAKA': { resi: 7, ongkir: 289000, total: 1200000 },
      },
      '2026-04-10': {
        'CABANG KOLAKA': { resi: 13, ongkir: 696000, total: 2400000 },
        'CABANG LASUSUA': { resi: 2, ongkir: 132000, total: 400000 },
      },
    },
  });

  assert.deepEqual(rows.find(row => row.cabang === 'CABANG KOLAKA'), {
    cabang: 'CABANG KOLAKA',
    resi: 20,
    ongkir: 985000,
    total: 3600000,
  });
  assert.deepEqual(rows.find(row => row.cabang === 'CABANG LASUSUA'), {
    cabang: 'CABANG LASUSUA',
    resi: 2,
    ongkir: 132000,
    total: 400000,
  });
});