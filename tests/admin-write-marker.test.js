const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FALLBACK_MARKER_SCOPES,
  createFallbackMarkerOptions,
  createAdminWriteMarker,
  mergeAdminWriteMarker,
  parseAdminWriteMarker,
} = require('../api/_admin-write-marker');

test('createAdminWriteMarker menormalkan source, scope, periode, dan token', () => {
  const marker = createAdminWriteMarker({
    now: new Date('2026-04-18T10:11:12.000Z'),
    version: 7,
    source: 'Input Admin Pending',
    scopes: ['overview', 'transfer', 'transfer', '', 'admin monitor'],
    periodes: ['2026-04', '2026-04', '', '2026-03'],
  });

  assert.deepEqual(marker, {
    version: 7,
    token: '7:2026-04-18T10:11:12.000Z',
    changed_at: '2026-04-18T10:11:12.000Z',
    window_started_at: '2026-04-18T10:11:12.000Z',
    source: 'input_admin_pending',
    scopes: ['overview', 'transfer', 'admin_monitor'],
    periodes: ['2026-04', '2026-03'],
  });
});

test('parseAdminWriteMarker menolak payload marker yang tidak lengkap', () => {
  assert.equal(parseAdminWriteMarker('{"version":3}'), null);
  assert.equal(parseAdminWriteMarker('bukan-json'), null);
});

test('mergeAdminWriteMarker menggabungkan scope dan periode dalam window compaction', () => {
  const currentMarker = createAdminWriteMarker({
    now: new Date('2026-04-18T10:11:12.000Z'),
    version: 10,
    source: 'transfer_split',
    scopes: ['overview', 'transfer'],
    periodes: ['2026-04'],
  });

  const nextMarker = mergeAdminWriteMarker(currentMarker, {
    source: 'manual_status_put',
    scopes: ['manual_status', 'admin_monitor'],
    periodes: ['2026-04', '2026-05'],
  }, {
    now: new Date('2026-04-18T10:11:40.000Z'),
    windowMs: 60000,
  });

  assert.deepEqual(nextMarker, {
    version: 11,
    token: '11:2026-04-18T10:11:40.000Z',
    changed_at: '2026-04-18T10:11:40.000Z',
    window_started_at: '2026-04-18T10:11:12.000Z',
    source: 'manual_status_put',
    scopes: ['overview', 'transfer', 'manual_status', 'admin_monitor'],
    periodes: ['2026-04', '2026-05'],
  });
});

test('mergeAdminWriteMarker membuka window baru setelah compaction lewat', () => {
  const currentMarker = createAdminWriteMarker({
    now: new Date('2026-04-18T10:11:12.000Z'),
    version: 4,
    source: 'transfer_delete',
    scopes: ['overview', 'transfer'],
    periodes: ['2026-04'],
  });

  const nextMarker = mergeAdminWriteMarker(currentMarker, {
    source: 'cabang_update',
    scopes: ['admin_cabang', 'audit'],
    periodes: [],
  }, {
    now: new Date('2026-04-18T10:12:20.000Z'),
    windowMs: 60000,
  });

  assert.deepEqual(nextMarker, {
    version: 5,
    token: '5:2026-04-18T10:12:20.000Z',
    changed_at: '2026-04-18T10:12:20.000Z',
    window_started_at: '2026-04-18T10:12:20.000Z',
    source: 'cabang_update',
    scopes: ['admin_cabang', 'audit'],
    periodes: [],
  });
});

test('createFallbackMarkerOptions melebarkan scope fallback saat RPC marker belum aktif', () => {
  assert.deepEqual(createFallbackMarkerOptions({
    source: 'transfer_split',
    scopes: ['transfer'],
    periodes: ['2026-04'],
    windowMs: 60000,
  }), {
    source: 'transfer_split',
    scopes: FALLBACK_MARKER_SCOPES.slice(),
    periodes: [],
    windowMs: 60000,
  });
});