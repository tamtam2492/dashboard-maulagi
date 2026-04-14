const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  NONCOD_MATCH_TOLERANCE,
  NONCOD_SPLIT_TOLERANCE,
  allocateSplitPlannedNominals,
  aggregateOngkirByDate,
  findOutstandingMatchingDates,
  findMatchingDates,
  findSplitMatchingDates,
  getRecentPeriodes,
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

  it('excludes BATAL status', () => {
    const rows = [
      { tanggal_buat: '2026-04-10', ongkir: 500000, metode_pembayaran: 'noncod', status_terakhir: 'BATAL' },
      { tanggal_buat: '2026-04-10', ongkir: 300000, metode_pembayaran: 'noncod', status_terakhir: 'DELIVERED' },
    ];
    const result = aggregateOngkirByDate(rows);
    assert.deepEqual(result, { '2026-04-10': 300000 });
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
      '2026-04-05': 176000,
      '2026-04-07': 916000,
      '2026-04-08': 259000,
      '2026-04-09': 147000,
    };
    const result = findSplitMatchingDates(byDate, [], 1624000, NONCOD_SPLIT_TOLERANCE);
    assert.equal(result, null);
  });
});
