const test = require('node:test');
const assert = require('node:assert/strict');

const { getRekonDateKey } = require('../api/noncod');

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