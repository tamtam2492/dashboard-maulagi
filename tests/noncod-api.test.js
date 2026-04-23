const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyCabangHoldAdjustments,
  buildSyncInfo,
  buildCabangHoldAdjustmentTransfers,
  canAutoSyncMaukirim,
  compareNoncodSyncContent,
  getRekonDateKey,
  isValidPeriodeParam,
  planNoncodAutoRefresh,
} = require('../api/noncod');

function createSupabaseStub({ transfers = [], settings = [] } = {}) {
  return {
    from(table) {
      const filters = {};
      const builder = {
        select() {
          return builder;
        },
        in(column, values) {
          filters[column] = Array.isArray(values) ? values.slice() : [];
          return builder;
        },
        like() {
          return builder;
        },
        order() {
          return builder;
        },
        range(from, to) {
          if (table === 'settings') {
            return Promise.resolve({
              data: settings.slice(from, to + 1),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
        then(resolve, reject) {
          if (table === 'transfers') {
            const data = transfers.filter((row) => {
              const cabangFilter = !filters.nama_cabang || filters.nama_cabang.includes(row.nama_cabang);
              const tanggalFilter = !filters.tgl_inputan || filters.tgl_inputan.includes(row.tgl_inputan);
              return cabangFilter && tanggalFilter;
            });
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

test('getRekonDateKey hanya memakai tanggal_buat sesuai report NONCOD', () => {
  assert.equal(getRekonDateKey({
    tanggal_buat: '2026-04-01 07:43:16',
    tanggal_pickup: '2026-04-02 08:11:00',
  }), '2026-04-01');

  assert.equal(getRekonDateKey({
    tanggal_buat: '',
    tanggal_pickup: '2026-04-02 08:11:00',
  }), '');
});

test('isValidPeriodeParam menolak bulan di luar 01-12', () => {
  assert.equal(isValidPeriodeParam('2026-04'), true);
  assert.equal(isValidPeriodeParam('2026-13'), false);
  assert.equal(isValidPeriodeParam('2026-00'), false);
  assert.equal(isValidPeriodeParam('2026-4'), false);
});

test('mode NONCOD manual mematikan auto sync MauKirim meskipun env tersedia', () => {
  const previousWa = process.env.MAUKIRIM_WA;
  const previousPass = process.env.MAUKIRIM_PASS;
  process.env.MAUKIRIM_WA = '08123456789';
  process.env.MAUKIRIM_PASS = 'secret';

  try {
    assert.equal(canAutoSyncMaukirim(), false);
    assert.equal(buildSyncInfo('2026-04', null).manualMode, true);
    assert.equal(buildSyncInfo('2026-04', null).enabled, false);
  } finally {
    process.env.MAUKIRIM_WA = previousWa;
    process.env.MAUKIRIM_PASS = previousPass;
  }
});

test('planNoncodAutoRefresh bootstrap snapshot kosong pertama kali secara inline', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: true },
    syncMeta: null,
    rowCount: 0,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: { status: 'published', pendingPeriodes: [], buildPeriodes: [], lastTriggeredAt: null },
  }), {
    action: 'scheduled',
    status: 'queued',
    reason: 'bootstrap_empty',
  });
});

test('planNoncodAutoRefresh menandai scheduled saat snapshot stale dan worker aktif', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: true },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: { status: 'published', pendingPeriodes: [], buildPeriodes: [], lastTriggeredAt: null },
    now: Date.parse('2026-04-18T01:00:00.000Z'),
  }), {
    action: 'scheduled',
    status: 'queued',
    reason: 'stale',
  });
});

test('planNoncodAutoRefresh menandai blocked saat trigger background tidak aktif', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: false },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: false,
    pipelineState: { status: 'dirty', pendingPeriodes: ['2026-04'], buildPeriodes: [], lastTriggeredAt: null },
  }), {
    action: 'none',
    status: 'blocked',
    reason: 'dirty',
  });
});

test('planNoncodAutoRefresh tidak queue ulang jika refresh baru saja dipicu', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: true },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: {
      status: 'dirty',
      pendingPeriodes: ['2026-04'],
      buildPeriodes: [],
      lastTriggeredAt: '2026-04-18T01:00:30.000Z',
    },
    now: Date.parse('2026-04-18T01:01:00.000Z'),
  }), {
    action: 'scheduled',
    status: 'queued',
    reason: 'dirty',
  });
});

test('planNoncodAutoRefresh menandai refresh sedang berjalan saat pipeline build periode aktif', () => {
  assert.deepEqual(planNoncodAutoRefresh({
    periode: '2026-04',
    syncInfo: { enabled: true, eligible: true, stale: false },
    syncMeta: { syncedAt: '2026-04-18T00:00:00.000Z' },
    rowCount: 12,
    forceSync: false,
    backgroundTriggerEnabled: true,
    pipelineState: {
      status: 'building',
      pendingPeriodes: [],
      buildPeriodes: ['2026-04'],
      lastTriggeredAt: '2026-04-18T01:00:00.000Z',
    },
  }), {
    action: 'none',
    status: 'running',
    reason: 'dirty',
  });
});

test('compareNoncodSyncContent mendeteksi snapshot identik dari hash sebelumnya', () => {
  const rows = [{
    periode: '2026-04',
    tanggal_buat: '2026-04-21',
    nomor_resi: 'RESI-001',
    ongkir: 26000,
    total_pengiriman: 26000,
    metode_pembayaran: 'noncod',
    cabang: 'CABANG SELAYAR',
  }];

  const first = compareNoncodSyncContent(rows, null);
  const second = compareNoncodSyncContent(rows, { contentHash: first.contentHash });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.contentHash, first.contentHash);
});

test('compareNoncodSyncContent sensitif terhadap perubahan field sinkron', () => {
  const baseRows = [{
    periode: '2026-04',
    tanggal_buat: '2026-04-21',
    nomor_resi: 'RESI-001',
    ongkir: 26000,
    total_pengiriman: 26000,
    metode_pembayaran: 'noncod',
    cabang: 'CABANG SELAYAR',
  }];

  const base = compareNoncodSyncContent(baseRows, null);
  const changed = compareNoncodSyncContent([
    {
      ...baseRows[0],
      ongkir: 27000,
    },
  ], { contentHash: base.contentHash });

  assert.equal(changed.changed, true);
  assert.notEqual(changed.contentHash, base.contentHash);
});

test('buildCabangHoldAdjustmentTransfers meneruskan hold cabang ke tanggal outstanding berikutnya', async () => {
  const supabase = createSupabaseStub({
    transfers: [{
      id: 'dab062dd-8dbb-4a39-81a3-c1ef2497fd77',
      tgl_inputan: '2026-04-21',
      nominal: 431000,
      nama_bank: 'BRI',
      nama_cabang: 'CABANG POMALAA',
      timestamp: '2026-04-22T02:29:16.272Z',
    }],
    settings: [{
      key: 'noncod_cabang_hold_dab062dd-8dbb-4a39-81a3-c1ef2497fd77',
      value: JSON.stringify({
        root_transfer_id: 'dab062dd-8dbb-4a39-81a3-c1ef2497fd77',
        cabang: 'CABANG POMALAA',
        nominal: 19000,
        reason: 'Kelebihan transfer akan ditahan sebagai hold cabang.',
        ket: '',
        transfer_bank: 'BRI',
        bukti_url: 'proof.jpeg',
        timestamp: '2026-04-22T02:29:16.272Z',
        created_at: '2026-04-22T02:29:16.543Z',
        updated_at: '2026-04-22T02:29:16.543Z',
      }),
    }],
  });

  const holdTransfers = await buildCabangHoldAdjustmentTransfers(supabase, [
    {
      tanggal_buat: '2026-04-21',
      ongkir: 412000,
      metode_pembayaran: 'noncod',
      status_terakhir: 'DELIVERED',
      cabang: 'CABANG POMALAA',
    },
    {
      tanggal_buat: '2026-04-22',
      ongkir: 205000,
      metode_pembayaran: 'noncod',
      status_terakhir: 'DELIVERED',
      cabang: 'CABANG POMALAA',
    },
  ]);

  assert.equal(holdTransfers.length, 1);
  assert.equal(holdTransfers[0].tgl_inputan, '2026-04-22');
  assert.equal(holdTransfers[0].nominal, 19000);
  assert.equal(holdTransfers[0].nama_cabang, 'CABANG POMALAA');
});

test('applyCabangHoldAdjustments mengurangi summary NONCOD pada hari carryover', () => {
  const byDay = {
    '2026-04-21': {
      'CABANG POMALAA': { ongkir: 412000, total: 412000, resi: 3 },
    },
    '2026-04-22': {
      'CABANG POMALAA': { ongkir: 205000, total: 205000, resi: 5 },
    },
  };
  const byCabang = {
    'CABANG POMALAA': { ongkir: 617000, total: 617000, resi: 8 },
  };
  const summary = {
    noncod: { grandOngkir: 617000, grandTotal: 617000 },
    all: { grandOngkir: 617000, grandTotal: 617000 },
  };
  const monthSummary = {
    noncod: { grandOngkir: 617000, grandTotal: 617000 },
    all: { grandOngkir: 617000, grandTotal: 617000 },
  };

  const totals = applyCabangHoldAdjustments({
    holdTransfers: [{
      id: 'hold:dab062dd-8dbb-4a39-81a3-c1ef2497fd77:2026-04-22',
      tgl_inputan: '2026-04-22',
      nominal: 19000,
      nama_bank: 'BRI',
      nama_cabang: 'CABANG POMALAA',
      timestamp: '2026-04-22T02:29:16.272Z',
      hold_source: true,
      hold_source_id: 'dab062dd-8dbb-4a39-81a3-c1ef2497fd77',
    }],
    byCabang,
    byDay,
    summary,
    monthSummary,
    periode: '2026-04',
    mode: 'noncod',
    grandOngkir: 617000,
    grandTotal: 617000,
  });

  assert.equal(byDay['2026-04-22']['CABANG POMALAA'].ongkir, 186000);
  assert.equal(byCabang['CABANG POMALAA'].ongkir, 598000);
  assert.equal(summary.noncod.grandOngkir, 598000);
  assert.equal(monthSummary.noncod.grandOngkir, 598000);
  assert.deepEqual(totals, { grandOngkir: 598000, grandTotal: 598000 });
});