const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  NONCOD_MATCH_TOLERANCE,
  NONCOD_SPLIT_TOLERANCE,
  allocateSplitPlannedNominals,
  aggregateOngkirByDate,
  buildCabangHoldTransfers,
  filterByPreferredPeriode,
  findPublicInputAllocation,
  findOutstandingMatchingDates,
  findMatchingDates,
  findSequentialAllocationDates,
  findSplitMatchingDates,
  getOutstandingNominalForDate,
  getPreferredSyncPeriodes,
  getRecentPeriodes,
  getSearchByDate,
  resolveNoncodDateMatchFromContext,
  resolveMatch,
} = require('../api/_noncod-match');

describe('NONCOD_MATCH_TOLERANCE', () => {
  it('should be 10000', () => {
    assert.equal(NONCOD_MATCH_TOLERANCE, 10000);
  });
});

describe('getRecentPeriodes', () => {
  it('returns 3 periodes in YYYY-MM format', () => {
    const periodes = getRecentPeriodes();
    assert.equal(periodes.length, 3);
    periodes.forEach(p => assert.match(p, /^\d{4}-\d{2}$/));
  });

  it('periodes are sorted oldest to newest', () => {
    const periodes = getRecentPeriodes();
    assert.ok(periodes[0] <= periodes[1]);
    assert.ok(periodes[1] <= periodes[2]);
  });
});

describe('getPreferredSyncPeriodes', () => {
  it('syncs only the preferred periode when it is part of recent periodes', () => {
    assert.deepEqual(
      getPreferredSyncPeriodes(['2026-02', '2026-03', '2026-04'], '2026-04'),
      ['2026-04'],
    );
  });

  it('falls back to the newest periode when preferred periode is invalid', () => {
    assert.deepEqual(
      getPreferredSyncPeriodes(['2026-02', '2026-03', '2026-04'], 'April 2026'),
      ['2026-04'],
    );
  });
});

describe('aggregateOngkirByDate', () => {
  it('sums ongkir by tanggal_buat for noncod only', () => {
    const rows = [
      { tanggal_buat: '2026-04-10', ongkir: 500000, metode_pembayaran: 'noncod', status_terakhir: 'DELIVERED' },
      { tanggal_buat: '2026-04-10', ongkir: 1000000, metode_pembayaran: 'noncod', status_terakhir: 'DELIVERED' },
      { tanggal_buat: '2026-04-10', ongkir: 200000, metode_pembayaran: 'dfod', status_terakhir: 'DELIVERED' },
      { tanggal_buat: '2026-04-11', ongkir: 300000, metode_pembayaran: 'noncod', status_terakhir: 'IN_TRANSIT' },
    ];
    const result = aggregateOngkirByDate(rows);
    assert.deepEqual(result, {
      '2026-04-10': 1500000,
      '2026-04-11': 300000,
    });
  });

  it('excludes BATAL and VOID but keeps RETUR in workbook parity mode', () => {
    const rows = [
      { tanggal_buat: '2026-04-10', ongkir: 500000, metode_pembayaran: 'noncod', status_terakhir: 'BATAL' },
      { tanggal_buat: '2026-04-10', ongkir: 200000, metode_pembayaran: 'noncod', status_terakhir: 'VOID' },
      { tanggal_buat: '2026-04-10', ongkir: 150000, metode_pembayaran: 'noncod', status_terakhir: 'RETUR' },
      { tanggal_buat: '2026-04-10', ongkir: 300000, metode_pembayaran: 'noncod', status_terakhir: 'DELIVERED' },
    ];
    const result = aggregateOngkirByDate(rows);
    assert.deepEqual(result, { '2026-04-10': 450000 });
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(aggregateOngkirByDate([]), {});
    assert.deepEqual(aggregateOngkirByDate(null), {});
  });

  it('ignores rows with invalid tanggal_buat', () => {
    const rows = [
      { tanggal_buat: '', ongkir: 100000, metode_pembayaran: 'noncod', status_terakhir: 'OK' },
      { tanggal_buat: 'invalid', ongkir: 100000, metode_pembayaran: 'noncod', status_terakhir: 'OK' },
      { tanggal_buat: '2026-04-10', ongkir: 100000, metode_pembayaran: 'noncod', status_terakhir: 'OK' },
    ];
    assert.deepEqual(aggregateOngkirByDate(rows), { '2026-04-10': 100000 });
  });
});

describe('filterByPreferredPeriode', () => {
  it('keeps only dates from the requested periode', () => {
    const result = filterByPreferredPeriode({
      '2026-03-31': 50000,
      '2026-04-04': 174000,
      '2026-04-05': 176000,
      '2026-05-01': 90000,
    }, '2026-04');

    assert.deepEqual(result, {
      '2026-04-04': 174000,
      '2026-04-05': 176000,
    });
  });

  it('returns empty object for invalid periode hint', () => {
    assert.deepEqual(filterByPreferredPeriode({ '2026-04-04': 174000 }, 'April 2026'), {});
  });
});

describe('getSearchByDate', () => {
  it('locks matching scope to the preferred periode when valid', () => {
    const result = getSearchByDate({
      '2026-03-31': 50000,
      '2026-04-04': 174000,
      '2026-04-05': 176000,
    }, '2026-04');

    assert.deepEqual(result, {
      '2026-04-04': 174000,
      '2026-04-05': 176000,
    });
  });

  it('returns empty when preferred periode is valid but absent from the data', () => {
    assert.deepEqual(getSearchByDate({ '2026-03-31': 50000 }, '2026-04'), {});
  });

  it('falls back to all dates when preferred periode is invalid', () => {
    const byDate = {
      '2026-03-31': 50000,
      '2026-04-04': 174000,
    };
    assert.deepEqual(getSearchByDate(byDate, 'April 2026'), byDate);
  });
});

describe('findMatchingDates', () => {
  it('finds exact match', () => {
    const byDate = { '2026-04-10': 1500000, '2026-04-11': 800000 };
    const result = findMatchingDates(byDate, 1500000, 6500);
    assert.equal(result.length, 1);
    assert.equal(result[0].tanggal_buat, '2026-04-10');
    assert.equal(result[0].diff, 0);
  });

  it('finds match within tolerance', () => {
    const byDate = { '2026-04-10': 1500000 };
    const result = findMatchingDates(byDate, 1494000, 6500);
    assert.equal(result.length, 1);
    assert.equal(result[0].diff, 6000);
  });

  it('rejects match beyond tolerance', () => {
    const byDate = { '2026-04-10': 1500000 };
    const result = findMatchingDates(byDate, 1490000, 6500);
    assert.equal(result.length, 0);
  });

  it('sorts by diff asc then date asc (FIFO)', () => {
    const byDate = {
      '2026-04-12': 1500000,
      '2026-04-10': 1502000,
      '2026-04-11': 1500000,
    };
    const result = findMatchingDates(byDate, 1500000, 6500);
    assert.equal(result.length, 3);
    assert.equal(result[0].tanggal_buat, '2026-04-11'); // diff 0, older
    assert.equal(result[1].tanggal_buat, '2026-04-12'); // diff 0, newer
    assert.equal(result[2].tanggal_buat, '2026-04-10'); // diff 2000
  });

  it('includes periode from date', () => {
    const byDate = { '2026-04-10': 1500000 };
    const result = findMatchingDates(byDate, 1500000, 6500);
    assert.equal(result[0].periode, '2026-04');
  });
});

describe('resolveMatch', () => {
  it('picks first candidate without existing transfer', () => {
    const candidates = [
      { tanggal_buat: '2026-04-10', totalOngkir: 1500000, diff: 0 },
      { tanggal_buat: '2026-04-11', totalOngkir: 1500000, diff: 0 },
    ];
    const transfers = [
      { tgl_inputan: '2026-04-10', nominal: 1500000 },
    ];
    const { match, allPaid } = resolveMatch(candidates, transfers);
    assert.equal(match.tanggal_buat, '2026-04-11');
    assert.equal(allPaid, false);
  });

  it('returns allPaid when all candidates have transfers', () => {
    const candidates = [
      { tanggal_buat: '2026-04-10', totalOngkir: 1500000, diff: 0 },
    ];
    const transfers = [
      { tgl_inputan: '2026-04-10', nominal: 1500000 },
    ];
    const { match, allPaid } = resolveMatch(candidates, transfers);
    assert.equal(match, null);
    assert.equal(allPaid, true);
  });

  it('returns match=null, allPaid=false for empty candidates', () => {
    const { match, allPaid } = resolveMatch([], []);
    assert.equal(match, null);
    assert.equal(allPaid, false);
  });

  it('marks existing transfers on each candidate', () => {
    const candidates = [
      { tanggal_buat: '2026-04-10', totalOngkir: 1500000, diff: 0 },
    ];
    const transfers = [
      { tgl_inputan: '2026-04-10', nominal: 1500000, id: 42 },
    ];
    resolveMatch(candidates, transfers);
    assert.equal(candidates[0].hasExistingTransfer, true);
    assert.equal(candidates[0].existingTransfers.length, 1);
    assert.equal(candidates[0].existingTransfers[0].id, 42);
  });

  it('keeps partially paid dates available via remaining nominal', () => {
    const candidates = [
      { tanggal_buat: '2026-04-14', totalOngkir: 101000, diff: 8000 },
    ];
    const transfers = [
      { tgl_inputan: '2026-04-14', nominal: 8000, id: 7 },
    ];
    const { match, allPaid } = resolveMatch(candidates, transfers);
    assert.equal(match.tanggal_buat, '2026-04-14');
    assert.equal(match.remainingNominal, 93000);
    assert.equal(allPaid, false);
  });
});

describe('findOutstandingMatchingDates', () => {
  it('matches remaining nominal on partially paid date', () => {
    const byDate = { '2026-04-14': 101000 };
    const transfers = [
      { tgl_inputan: '2026-04-14', nominal: 8000, id: 7 },
    ];
    const result = findOutstandingMatchingDates(byDate, transfers, 93000, NONCOD_MATCH_TOLERANCE);
    assert.equal(result.length, 1);
    assert.equal(result[0].tanggal_buat, '2026-04-14');
    assert.equal(result[0].remainingNominal, 93000);
    assert.equal(result[0].diff, 0);
  });

  it('finds exact remaining nominal even when full total is far above input', () => {
    const byDate = {
      '2026-04-04': 19000,
      '2026-04-07': 24000,
      '2026-04-14': 437000,
    };
    const transfers = [
      { tgl_inputan: '2026-04-04', nominal: 19000, id: 1 },
      { tgl_inputan: '2026-04-07', nominal: 24000, id: 2 },
      { tgl_inputan: '2026-04-14', nominal: 418000, id: 3 },
    ];
    const result = findOutstandingMatchingDates(byDate, transfers, 19000, NONCOD_MATCH_TOLERANCE);
    assert.equal(result.length, 1);
    assert.equal(result[0].tanggal_buat, '2026-04-14');
    assert.equal(result[0].remainingNominal, 19000);
    assert.equal(result[0].diff, 0);
  });
});

describe('findSplitMatchingDates', () => {
  it('finds FIFO multi-date match using outstanding nominal per tanggal', () => {
    const byDate = {
      '2026-04-13': 162000,
      '2026-04-14': 101000,
    };
    const transfers = [
      { tgl_inputan: '2026-04-14', nominal: 8000, id: 7 },
    ];
    const result = findSplitMatchingDates(byDate, transfers, 255000, NONCOD_SPLIT_TOLERANCE);
    assert.ok(result);
    assert.equal(result.dates.length, 2);
    assert.equal(result.dates[0].tanggal_buat, '2026-04-13');
    assert.equal(result.dates[0].plannedNominal, 162000);
    assert.equal(result.dates[1].tanggal_buat, '2026-04-14');
    assert.equal(result.dates[1].plannedNominal, 93000);
    assert.equal(result.diff, 0);
  });

  it('rejects multi-date match when the combined NONCOD leaves a selisih', () => {
    const byDate = {
      '2026-04-04': 174000,
      '2026-04-05': 176000,
      '2026-04-07': 916000,
      '2026-04-08': 259000,
      '2026-04-09': 147000,
    };
    const result = findSplitMatchingDates(byDate, [], 1624000, NONCOD_SPLIT_TOLERANCE);
    assert.equal(result, null);
  });

  it('rejects multi-date match even when the selisih is still inside the old tolerance', () => {
    const byDate = {
      '2026-04-04': 100000,
      '2026-04-05': 50000,
    };
    const result = findSplitMatchingDates(byDate, [], 149700, NONCOD_SPLIT_TOLERANCE);
    assert.equal(result, null);
  });

  it('allocates small selisih ke tanggal terakhir seperti split admin', () => {
    const result = allocateSplitPlannedNominals([
      { tanggal_buat: '2026-04-04', periode: '2026-04', totalOngkir: 100000, paidNominal: 0, remainingNominal: 100000 },
      { tanggal_buat: '2026-04-05', periode: '2026-04', totalOngkir: 50000, paidNominal: 0, remainingNominal: 50000 },
    ], 149700);
    assert.equal(result.length, 2);
    assert.equal(result[0].plannedNominal, 100000);
    assert.equal(result[1].plannedNominal, 49700);
  });

  it('returns null when no sequential multi-date match exists', () => {
    const byDate = {
      '2026-04-04': 174000,
      '2026-04-07': 916000,
    };
    const result = findSplitMatchingDates(byDate, [], 100000, NONCOD_SPLIT_TOLERANCE);
    assert.equal(result, null);
  });

  it('tidak boleh memulai split dari tanggal yang lebih baru saat tanggal tertua masih outstanding', () => {
    const byDate = {
      '2026-04-11': 112000,
      '2026-04-14': 19000,
      '2026-04-17': 133000,
    };

    const result = findSplitMatchingDates(byDate, [], 152000, NONCOD_SPLIT_TOLERANCE);
    assert.equal(result, null);
  });

  it('plans sequential allocations after selected date and leaves remainder as pending', () => {
    const byDate = {
      '2026-04-10': 40000,
      '2026-04-11': 20000,
      '2026-04-13': 15000,
    };
    const transfers = [
      { tgl_inputan: '2026-04-10', nominal: 40000, id: 1 },
    ];

    assert.equal(getOutstandingNominalForDate(byDate, transfers, '2026-04-10'), 0);
    assert.equal(getOutstandingNominalForDate(byDate, transfers, '2026-04-11'), 20000);

    const plan = findSequentialAllocationDates(byDate, transfers, 50000, '2026-04-10');
    assert.equal(plan.dates.length, 2);
    assert.equal(plan.dates[0].tanggal_buat, '2026-04-11');
    assert.equal(plan.dates[0].plannedNominal, 20000);
    assert.equal(plan.dates[1].tanggal_buat, '2026-04-13');
    assert.equal(plan.dates[1].plannedNominal, 15000);
    assert.equal(plan.allocatedTotal, 35000);
    assert.equal(plan.pendingNominal, 15000);
    assert.equal(plan.lastDate, '2026-04-13');
  });

  it('can resume allocation from the same date when pending waits for updated NONCOD', () => {
    const byDate = {
      '2026-04-11': 50000,
    };
    const transfers = [
      { tgl_inputan: '2026-04-11', nominal: 20000, id: 1 },
    ];

    const plan = findSequentialAllocationDates(byDate, transfers, 30000, '2026-04-11', { includeStartDate: true });
    assert.equal(plan.dates.length, 1);
    assert.equal(plan.dates[0].tanggal_buat, '2026-04-11');
    assert.equal(plan.dates[0].plannedNominal, 30000);
    assert.equal(plan.pendingNominal, 0);
  });
});

describe('buildCabangHoldTransfers', () => {
  it('mengurangi outstanding tertua berikutnya dengan saldo hold cabang', () => {
    const byDate = {
      '2026-04-11': 112000,
      '2026-04-14': 19000,
      '2026-04-17': 133000,
    };
    const transfers = [
      { tgl_inputan: '2026-04-11', nominal: 112000, id: 1 },
      { tgl_inputan: '2026-04-14', nominal: 19000, id: 2 },
    ];
    const holdTransfers = buildCabangHoldTransfers(byDate, transfers, [
      { root_transfer_id: 'root-1', cabang: 'CABANG PANJAITAN', nominal: 19000, created_at: '2026-04-18T01:00:00.000Z' },
    ]);

    assert.equal(holdTransfers.length, 1);
    assert.equal(holdTransfers[0].tgl_inputan, '2026-04-17');
    assert.equal(holdTransfers[0].nominal, 19000);
  });
});

describe('findPublicInputAllocation', () => {
  it('mengalokasikan prefix exact lalu menyisakan hold saat nominal lebih besar', () => {
    const byDate = {
      '2026-04-16': 176000,
      '2026-04-17': 98000,
    };

    const result = findPublicInputAllocation(byDate, [], 300000);
    assert.equal(result.dates.length, 2);
    assert.equal(result.allocatedTotal, 274000);
    assert.equal(result.holdNominal, 26000);
    assert.equal(result.dates[0].plannedNominal, 176000);
    assert.equal(result.dates[1].plannedNominal, 98000);
  });

  it('menolak alokasi bila nominal belum cukup untuk outstanding tertua', () => {
    const byDate = {
      '2026-04-11': 112000,
      '2026-04-14': 19000,
    };

    const result = findPublicInputAllocation(byDate, [], 19000);
    assert.equal(result.dates.length, 0);
    assert.equal(result.allocatedTotal, 0);
    assert.equal(result.firstOutstanding.tanggal_buat, '2026-04-11');
    assert.equal(result.firstOutstanding.remainingNominal, 112000);
  });
});

describe('resolveNoncodDateMatchFromContext', () => {
  it('meresolve exact outstanding match dari context hold cabang', () => {
    const result = resolveNoncodDateMatchFromContext({
      normalizedCabang: 'KENDARI',
      normalizedPreferredPeriode: '2026-04',
      hasPreferredPeriode: true,
      hasData: true,
      searchByDate: {
        '2026-04-14': 101000,
        '2026-04-15': 78000,
      },
      existingTransfers: [
        { tgl_inputan: '2026-04-14', nominal: 8000, id: 7 },
      ],
      message: null,
    }, 93000);

    assert.equal(result.blocked, false);
    assert.equal(result.match.tanggal_buat, '2026-04-14');
    assert.equal(result.match.remainingNominal, 93000);
    assert.equal(result.message, null);
  });

  it('mengembalikan pesan context kosong saat cabang belum punya data NONCOD', () => {
    const result = resolveNoncodDateMatchFromContext({
      normalizedCabang: 'KENDARI',
      normalizedPreferredPeriode: '2026-04',
      hasPreferredPeriode: true,
      hasData: false,
      searchByDate: {},
      existingTransfers: [],
      message: 'Tidak ada data NONCOD untuk KENDARI pada periode 2026-04.',
    }, 93000);

    assert.equal(result.match, null);
    assert.equal(result.blocked, false);
    assert.equal(result.message, 'Tidak ada data NONCOD untuk KENDARI pada periode 2026-04.');
  });

  it('mengalihkan ke hold cabang bila nominal lebih besar dari prefix exact tetapi belum cukup untuk tanggal berikutnya', () => {
    const result = resolveNoncodDateMatchFromContext({
      normalizedCabang: 'KENDARI',
      normalizedPreferredPeriode: '2026-04',
      hasPreferredPeriode: true,
      hasData: true,
      searchByDate: {
        '2026-04-04': 100000,
        '2026-04-05': 50000,
      },
      existingTransfers: [],
      message: null,
    }, 149700);

    assert.ok(result.match);
    assert.equal(result.match.tanggal_buat, '2026-04-04');
    assert.equal(result.hold.nominal, 49700);
    assert.equal(result.splitMatch, undefined);
    assert.equal(result.blocked, false);
  });

  it('mengembalikan hold cabang saat nominal lebih besar dari prefix exact yang valid', () => {
    const result = resolveNoncodDateMatchFromContext({
      normalizedCabang: 'LATAMBAGA',
      normalizedPreferredPeriode: '2026-04',
      hasPreferredPeriode: true,
      hasData: true,
      searchByDate: {
        '2026-04-16': 176000,
        '2026-04-17': 98000,
      },
      existingTransfers: [],
      message: null,
    }, 300000);

    assert.equal(result.match, null);
    assert.ok(result.splitMatch);
    assert.equal(result.splitMatch.total, 274000);
    assert.equal(result.hold.nominal, 26000);
    assert.equal(result.splitMatch.dates.length, 2);
  });

  it('menolak nominal yang lebih kecil dari outstanding tertua walau cocok ke tanggal berikutnya', () => {
    const result = resolveNoncodDateMatchFromContext({
      normalizedCabang: 'PANJAITAN',
      normalizedPreferredPeriode: '2026-04',
      hasPreferredPeriode: true,
      hasData: true,
      searchByDate: {
        '2026-04-11': 112000,
        '2026-04-14': 19000,
        '2026-04-17': 133000,
      },
      existingTransfers: [],
      message: null,
    }, 19000);

    assert.equal(result.match, null);
    assert.equal(result.splitMatch, undefined);
    assert.equal(result.blocked, false);
    assert.match(result.message, /belum cukup untuk outstanding tertua/i);
    assert.match(result.message, /2026-04-11/);
  });
});
