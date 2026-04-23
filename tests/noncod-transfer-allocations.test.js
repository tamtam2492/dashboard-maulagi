const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTransferAllocationPlan,
  createTransferAllocationRecord,
  splitTransferAllocationRecord,
} = require('../api/_noncod-transfer-allocations');

test('buildTransferAllocationPlan mengikat satu transfer ke banyak resi pada tanggal yang sama', () => {
  const plans = buildTransferAllocationPlan({
    noncodRows: [
      { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', ongkir: 200000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
      { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', ongkir: 274000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
    ],
    existingTransfers: [],
    existingAllocationRows: [],
    plannedRows: [
      { tgl_inputan: '2026-04-20', nominal: 474000 },
    ],
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].allocatedTotal, 474000);
  assert.equal(plans[0].unallocatedNominal, 0);
  assert.deepEqual(plans[0].allocations, [
    { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 200000 },
    { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 274000 },
  ]);
});

test('buildTransferAllocationPlan menghormati transfer lama tanpa registry sebelum mengalokasikan transfer baru', () => {
  const plans = buildTransferAllocationPlan({
    noncodRows: [
      { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', ongkir: 200000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
      { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', ongkir: 274000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
      { nomor_resi: 'RESI-003', tanggal_buat: '2026-04-20', ongkir: 100000, metode_pembayaran: 'noncod', status_terakhir: 'SELESAI' },
    ],
    existingTransfers: [
      { id: 'legacy-1', tgl_inputan: '2026-04-20', nominal: 200000, timestamp: '2026-04-20T01:00:00.000Z' },
    ],
    existingAllocationRows: [],
    plannedRows: [
      { tgl_inputan: '2026-04-20', nominal: 374000 },
    ],
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].allocatedTotal, 374000);
  assert.equal(plans[0].unallocatedNominal, 0);
  assert.deepEqual(plans[0].allocations, [
    { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 274000 },
    { nomor_resi: 'RESI-003', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 100000 },
  ]);
});

test('splitTransferAllocationRecord menjaga satu bukti tetap bisa menempel ke banyak resi setelah split admin', () => {
  const record = createTransferAllocationRecord({
    transfer_id: 'root-1',
    cabang: 'CABANG KENDARI 01',
    transfer_date: '2026-04-20',
    transfer_nominal: 474000,
    source: 'input_public',
    allocations: [
      { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', allocated_nominal: 200000 },
      { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', allocated_nominal: 274000 },
    ],
    created_at: '2026-04-20T02:00:00.000Z',
  });

  const splitRows = splitTransferAllocationRecord(record, [
    { id: 'tr-1', nama_cabang: 'CABANG KENDARI 01', tgl_inputan: '2026-04-19', nominal: 160000, timestamp: '2026-04-20T02:00:00.000Z' },
    { id: 'tr-2', nama_cabang: 'CABANG KENDARI 01', tgl_inputan: '2026-04-20', nominal: 314000, timestamp: '2026-04-20T02:00:00.000Z' },
  ]);

  assert.equal(splitRows.length, 2);
  assert.deepEqual(splitRows[0].allocations, [
    { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 160000 },
  ]);
  assert.deepEqual(splitRows[1].allocations, [
    { nomor_resi: 'RESI-001', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 40000 },
    { nomor_resi: 'RESI-002', tanggal_buat: '2026-04-20', periode: '2026-04', allocated_nominal: 274000 },
  ]);
  assert.equal(splitRows[0].unallocated_nominal, 0);
  assert.equal(splitRows[1].unallocated_nominal, 0);
});