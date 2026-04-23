const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProofSignatureKey,
  buildProofSignaturePayload,
  createProofSignature,
  formatProofDuplicateMessage,
  normalizeProofTransferIds,
  parseProofSignatureValue,
  removeProofTransferIds,
  replaceProofTransferIds,
} = require('../api/_proof-signature');

test('createProofSignature menghasilkan hash sha256 yang stabil', () => {
  const buffer = Buffer.from('contoh-bukti-transfer');
  const signatureA = createProofSignature(buffer);
  const signatureB = createProofSignature(buffer);

  assert.equal(signatureA, signatureB);
  assert.equal(signatureA.length, 64);
  assert.equal(buildProofSignatureKey(signatureA), 'proof_signature_' + signatureA);
});

test('buildProofSignaturePayload menormalkan metadata transfer', () => {
  const payload = buildProofSignaturePayload({
    fileBuffer: Buffer.from('bukti-a'),
    namaCabang: 'cabang panjaitan',
    tglInputan: '2026-04-13',
    namaBank: 'm-banking bca',
    nominal: '262000',
    fileName: 'bukti.png',
    mimeType: 'image/png',
  });

  assert.equal(payload.namaCabang, 'CABANG PANJAITAN');
  assert.equal(payload.tglInputan, '2026-04-13');
  assert.equal(payload.namaBank, 'BCA');
  assert.equal(payload.nominal, 262000);
  assert.equal(payload.fileName, 'bukti.png');
  assert.equal(payload.mimeType, 'image/png');
  assert.equal(payload.key, 'proof_signature_' + payload.signature);
});

test('parseProofSignatureValue dan formatProofDuplicateMessage membaca registry bukti', () => {
  const raw = JSON.stringify({
    namaCabang: 'CABANG BENU BENUA',
    tglInputan: '2026-04-13',
    nominal: 262000,
  });
  const parsed = parseProofSignatureValue(raw);

  assert.deepEqual(parsed, {
    namaCabang: 'CABANG BENU BENUA',
    tglInputan: '2026-04-13',
    nominal: 262000,
  });
  assert.match(formatProofDuplicateMessage(parsed), /CABANG BENU BENUA/i);
  assert.match(formatProofDuplicateMessage(parsed), /13\/04\/2026/i);
  assert.match(formatProofDuplicateMessage(parsed), /Rp 262.000/i);
});

test('normalizeProofTransferIds menggabungkan transferId dan transferIds tanpa duplikasi', () => {
  assert.deepEqual(normalizeProofTransferIds({
    transferId: 'id-1',
    transferIds: ['id-2', 'id-1', 'id-3', ''],
  }), ['id-1', 'id-2', 'id-3']);
});

test('removeProofTransferIds menghapus transfer orphan dan mengosongkan record jika semua id hilang', () => {
  assert.equal(removeProofTransferIds({ transferId: 'id-1', transferIds: ['id-1'] }, ['id-1']), null);

  assert.deepEqual(removeProofTransferIds({
    transferId: 'id-1',
    transferIds: ['id-1', 'id-2', 'id-3'],
  }, ['id-1', 'id-3']), {
    transferId: 'id-2',
    transferIds: ['id-2'],
  });
});

test('replaceProofTransferIds memindahkan registry ke hasil split baru', () => {
  const next = replaceProofTransferIds({
    transferId: 'old-id',
    transferIds: ['old-id'],
    tglInputan: '2026-04-14',
    tglInputanList: ['2026-04-14'],
    splitRows: [{ tgl_inputan: '2026-04-14', nominal: 1624000 }],
  }, 'old-id', [
    { id: 'new-id-1', tgl_inputan: '2026-04-04', nominal: 174000 },
    { id: 'new-id-2', tgl_inputan: '2026-04-05', nominal: 176000 },
  ]);

  assert.deepEqual(next, {
    transferId: 'new-id-1',
    transferIds: ['new-id-1', 'new-id-2'],
    tglInputan: '2026-04-04',
    tglInputanList: ['2026-04-04', '2026-04-05'],
    splitRows: [
      { tgl_inputan: '2026-04-04', nominal: 174000 },
      { tgl_inputan: '2026-04-05', nominal: 176000 },
    ],
  });
});