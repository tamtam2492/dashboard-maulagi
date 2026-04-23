const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTransferAllocationBackfillRecords,
  groupTransfersByCabang,
  summarizeBackfillRecords,
} = require('../scripts/local/backfill-transfer-allocations');

test('groupTransfersByCabang mengurutkan transfer per cabang berdasarkan timestamp', () => {
  const grouped = groupTransfersByCabang([
    { id: 'b', nama_cabang: 'Cabang A', timestamp: '2026-04-20T02:00:00.000Z' },
    { id: 'a', nama_cabang: 'Cabang A', timestamp: '2026-04-20T01:00:00.000Z' },
    { id: 'c', nama_cabang: 'Cabang B', timestamp: '2026-04-20T03:00:00.000Z' },
  ]);

  assert.deepEqual(grouped.get('CABANG A').map((item) => item.id), ['a', 'b']);
  assert.deepEqual(grouped.get('CABANG B').map((item) => item.id), ['c']);
});

test('buildTransferAllocationBackfillRecords membangun multi-resi berurutan untuk histori transfer lama', () => {
  const proofKeyByTransferId = new Map([['legacy-1', 'proof_signature_hash-1']]);
  const records = buildTransferAllocationBackfillRecords({
    nowIso: '2026-04-22T01:00:00.000Z',
    transfers: [
      {
        id: 'legacy-1',
        nama_cabang: 'Cabang Kendari 01',
        timestamp: '2026-04-20T02:00:00.000Z',
        tgl_inputan: '2026-04-20',
        nominal: 474000,
      },
      {
        id: 'legacy-2',
        nama_cabang: 'Cabang Kendari 01',
        timestamp: '2026-04-21T02:00:00.000Z',
        tgl_inputan: '2026-04-21',
        nominal: 100000,
      },
    ],
    noncodRows: [
      { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', ongkir: 200000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
      { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', ongkir: 274000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
      { nomor_resi: 'RESI-003', tanggal_buat: '2026-04-21', ongkir: 100000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
    ],
    existingAllocationRows: [],
    proofKeyByTransferId,
  });

  assert.equal(records.length, 2);
  assert.equal(records[0].proof_key, 'proof_signature_hash-1');
  assert.deepEqual(records[0].allocations, [
    { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 200000 },
    { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 274000 },
  ]);
  assert.deepEqual(records[1].allocations, [
    { nomor_resi: 'RESI-003', tanggal_buat: '2026-04-21', periode: '2026-04', allocated_nominal: 100000 },
  ]);
  assert.equal(records[0].unallocated_nominal, 0);
  assert.equal(records[1].unallocated_nominal, 0);
});

test('summarizeBackfillRecords menandai record partial dan kosong', () => {
  const summary = summarizeBackfillRecords([
    {
      transfer_id: 'a',
      transfer_nominal: 200000,
      allocated_total: 200000,
      unallocated_nominal: 0,
    },
    {
      transfer_id: 'b',
      transfer_nominal: 300000,
      allocated_total: 100000,
      unallocated_nominal: 200000,
      cabang: 'CABANG A',
      transfer_date: '2026-04-20',
    },
    {
      transfer_id: 'c',
      transfer_nominal: 150000,
      allocated_total: 0,
      unallocated_nominal: 150000,
      cabang: 'CABANG A',
      transfer_date: '2026-04-21',
    },
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.allocated, 1);
  assert.equal(summary.partial, 1);
  assert.equal(summary.unallocated, 1);
  assert.equal(summary.totalAllocatedNominal, 300000);
  assert.equal(summary.totalUnallocatedNominal, 350000);
  assert.equal(summary.issues.length, 2);
});