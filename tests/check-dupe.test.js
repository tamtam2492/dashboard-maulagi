const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDupeSummary,
  getInputErrorStatusCode,
  inspectProofRegistryDuplicate,
  normalizeUploadFields,
  shouldLogInputError,
  shouldFallbackToInternalOcrWorker,
} = require('../api/input');

function createProofRegistrySupabaseStub(options = {}) {
  const state = {
    settingsValue: options.settingsValue,
    liveTransferIds: Array.isArray(options.liveTransferIds) ? options.liveTransferIds : [],
    deletedKeys: [],
    upserts: [],
  };

  return {
    state,
    supabase: {
      from(table) {
        if (table === 'settings') {
          return {
            select() {
              return {
                eq(_column, key) {
                  return {
                    maybeSingle: async () => ({
                      data: state.settingsValue === undefined ? null : { value: state.settingsValue, key },
                      error: null,
                    }),
                  };
                },
              };
            },
            delete() {
              return {
                eq: async (_column, key) => {
                  state.deletedKeys.push(key);
                  state.settingsValue = undefined;
                  return { error: null };
                },
              };
            },
            upsert: async (row) => {
              state.upserts.push(row);
              state.settingsValue = row.value;
              return { error: null };
            },
          };
        }

        if (table === 'transfers') {
          return {
            select() {
              return {
                in: async (_column, ids) => ({
                  data: state.liveTransferIds
                    .filter((id) => ids.includes(id))
                    .map((id) => ({ id })),
                  error: null,
                }),
              };
            },
          };
        }

        throw new Error('Unexpected table: ' + table);
      },
    },
  };
}

test('buildDupeSummary memprioritaskan exact duplicate', () => {
  const summary = buildDupeSummary({
    exactDupes: [{ id: 1, nominal: 125000, nama_bank: 'BCA' }],
    branchDayTransfers: [{ id: 1, nominal: 125000, nama_bank: 'BCA' }],
    nominal: 125000,
    scopeName: 'CABANG KENDARI 01',
  });

  assert.equal(summary.tone, 'warn');
  assert.equal(summary.exactMatch, true);
  assert.equal(summary.branchDayCount, 1);
  assert.equal(summary.branchDayTotal, 125000);
  assert.equal(summary.scopeLabel, 'CABANG KENDARI 01');
  assert.match(summary.message, /cabang, tanggal rekap, dan nominal yang sama/i);
});

test('buildDupeSummary memberi info bila cabang sudah punya transfer di hari yang sama', () => {
  const summary = buildDupeSummary({
    exactDupes: [],
    branchDayTransfers: [
      { id: 1, nominal: 100000, nama_bank: 'BCA' },
      { id: 2, nominal: 250000, nama_bank: 'BRI' },
    ],
    nominal: 90000,
    scopeName: 'CABANG KAMBU 01',
  });

  assert.equal(summary.tone, 'info');
  assert.equal(summary.exactMatch, false);
  assert.equal(summary.branchDayCount, 2);
  assert.equal(summary.branchDayTotal, 350000);
  assert.equal(summary.scopeLabel, 'CABANG KAMBU 01');
  assert.match(summary.title, /CABANG KAMBU 01/i);
});

test('buildDupeSummary aman bila belum ada transfer tersimpan', () => {
  const summary = buildDupeSummary({
    exactDupes: [],
    branchDayTransfers: [],
    nominal: 75000,
    scopeName: 'CABANG KENDARI 01',
  });

  assert.equal(summary.tone, 'ok');
  assert.equal(summary.exactMatch, false);
  assert.equal(summary.branchDayCount, 0);
  assert.equal(summary.branchDayTotal, 0);
  assert.match(summary.message, /CABANG KENDARI 01 belum punya transfer tersimpan/i);
});

test('inspectProofRegistryDuplicate menghapus registry orphan dan mengizinkan upload', async () => {
  const proofKey = 'proof_signature_hash-orphan';
  const { supabase, state } = createProofRegistrySupabaseStub({
    settingsValue: JSON.stringify({
      transferId: 'dead-1',
      transferIds: ['dead-1'],
    }),
    liveTransferIds: [],
  });

  const result = await inspectProofRegistryDuplicate(supabase, proofKey);

  assert.equal(result.proofDuplicate, false);
  assert.equal(result.existingProof, null);
  assert.deepEqual(state.deletedKeys, [proofKey]);
  assert.equal(state.upserts.length, 0);
});

test('inspectProofRegistryDuplicate memangkas id stale parsial tetapi tetap blokir', async () => {
  const proofKey = 'proof_signature_hash-partial';
  const { supabase, state } = createProofRegistrySupabaseStub({
    settingsValue: JSON.stringify({
      transferId: 'live-1',
      transferIds: ['live-1', 'stale-1'],
      tglInputan: '2026-04-04',
      tglInputanList: ['2026-04-04', '2026-04-05'],
      splitRows: [
        { tgl_inputan: '2026-04-04', nominal: 120000 },
        { tgl_inputan: '2026-04-05', nominal: 80000 },
      ],
    }),
    liveTransferIds: ['live-1'],
  });

  const result = await inspectProofRegistryDuplicate(supabase, proofKey);
  const savedValue = JSON.parse(state.upserts[0].value);

  assert.equal(result.proofDuplicate, true);
  assert.equal(result.existingProof.transferId, 'live-1');
  assert.deepEqual(result.existingProof.transferIds, ['live-1']);
  assert.deepEqual(state.deletedKeys, []);
  assert.equal(state.upserts.length, 1);
  assert.equal(savedValue.transferId, 'live-1');
  assert.deepEqual(savedValue.transferIds, ['live-1']);
});

test('shouldFallbackToInternalOcrWorker aktif untuk trigger OCR yang tidak sukses', () => {
  assert.equal(shouldFallbackToInternalOcrWorker({ ok: false, status: 502 }), true);
  assert.equal(shouldFallbackToInternalOcrWorker({ skipped: true, reason: 'disabled' }), true);
  assert.equal(shouldFallbackToInternalOcrWorker({ ok: true, status: 200 }), false);
  assert.equal(shouldFallbackToInternalOcrWorker(null), false);
});

test('normalizeUploadFields menerima alias field lama tanpa mengubah field utama', () => {
  assert.deepEqual(normalizeUploadFields({
    cabang: 'Cabang Palopo',
    tanggal: '2026-04-04',
    bank_pengirim: 'BRI',
    nominal: '10000',
  }), {
    cabang: 'Cabang Palopo',
    tanggal: '2026-04-04',
    bank_pengirim: 'BRI',
    nominal: '10000',
    tgl_inputan: '2026-04-04',
    nama_bank: 'BRI',
    nama_cabang: 'Cabang Palopo',
    periode: '',
    context_key: '',
    transfer_datetime: null,
    proof_hash: null,
  });
});

test('getInputErrorStatusCode mengklasifikasikan parse multipart sebagai 400', () => {
  assert.equal(getInputErrorStatusCode(new Error('Unexpected end of form')), 400);
  assert.equal(getInputErrorStatusCode(new Error('Content-Type upload harus multipart/form-data.')), 400);
  assert.equal(getInputErrorStatusCode(new Error('Tanggal NONCOD yang dipilih sudah lunas atau belum tersedia.')), 400);
  assert.equal(getInputErrorStatusCode(new Error('Hal lain dari database')), 500);
});

test('shouldLogInputError hanya true untuk error input 5xx', () => {
  const clientError = new Error('Tanggal NONCOD yang dipilih sudah lunas atau belum tersedia.');
  clientError.clientInputError = true;

  assert.equal(shouldLogInputError(clientError), false);
  assert.equal(shouldLogInputError(new Error('Unexpected end of form')), false);
  assert.equal(shouldLogInputError(new Error('Hal lain dari database')), true);
});