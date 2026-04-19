const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADMIN_WRITE_MARKER_MAX_PERIODES,
  ADMIN_WRITE_MARKER_MAX_SCOPES,
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

test('mergeAdminWriteMarker membatasi scope dan periode saat burst dalam window yang sama', () => {
  const currentScopes = Array.from({ length: 18 }, (_, index) => `scope_${index + 1}`);
  const currentPeriodes = Array.from({ length: 23 }, (_, index) => {
    const year = 2025 + Math.floor(index / 12);
    const month = String(index % 12 + 1).padStart(2, '0');
    return `${year}-${month}`;
  });

  const currentMarker = createAdminWriteMarker({
    now: new Date('2026-04-18T10:11:12.000Z'),
    version: 8,
    source: 'transfer_bulk',
    scopes: currentScopes,
    periodes: currentPeriodes,
  });

  const nextMarker = mergeAdminWriteMarker(currentMarker, {
    source: 'manual_status_bulk',
    scopes: ['scope_18', 'scope_19', 'scope_20', 'scope_21', 'scope_22', 'scope_23'],
    periodes: ['2026-12', '2027-01', '2027-02'],
  }, {
    now: new Date('2026-04-18T10:11:40.000Z'),
  });

  assert.equal(nextMarker.scopes.length, ADMIN_WRITE_MARKER_MAX_SCOPES);
  assert.equal(nextMarker.periodes.length, ADMIN_WRITE_MARKER_MAX_PERIODES);
  assert.deepEqual(nextMarker.scopes, [
    'scope_1',
    'scope_2',
    'scope_3',
    'scope_4',
    'scope_5',
    'scope_6',
    'scope_7',
    'scope_8',
    'scope_9',
    'scope_10',
    'scope_11',
    'scope_12',
    'scope_13',
    'scope_14',
    'scope_15',
    'scope_16',
    'scope_17',
    'scope_18',
    'scope_19',
    'scope_20',
  ]);
  assert.deepEqual(nextMarker.periodes, [
    '2025-01',
    '2025-02',
    '2025-03',
    '2025-04',
    '2025-05',
    '2025-06',
    '2025-07',
    '2025-08',
    '2025-09',
    '2025-10',
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10',
    '2026-11',
    '2026-12',
  ]);
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