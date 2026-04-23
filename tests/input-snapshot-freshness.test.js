const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getNoncodSnapshotGuardMessage,
  isAutoSyncablePeriode,
  isSyncMetaFresh,
} = require('../api/input');

test('menganggap metadata sync fresh bila masih di dalam jendela freshness', () => {
  const now = Date.parse('2026-04-21T15:00:00.000Z');
  assert.equal(isSyncMetaFresh({ syncedAt: '2026-04-21T14:50:00.000Z' }, now), true);
});

test('menganggap metadata sync stale bila timestamp lama atau kosong', () => {
  const now = Date.parse('2026-04-21T15:00:00.000Z');
  assert.equal(isSyncMetaFresh({ syncedAt: '2026-04-21T14:30:00.000Z' }, now), false);
  assert.equal(isSyncMetaFresh(null, now), false);
});

test('tidak memblokir upload publik saat snapshot periode auto-sync belum fresh', () => {
  const message = getNoncodSnapshotGuardMessage(
    '2026-04',
    { syncedAt: '2026-04-21T14:30:00.000Z' },
    {
      now: Date.parse('2026-04-21T15:00:00.000Z'),
      referenceDate: new Date('2026-04-21T15:00:00.000Z'),
    },
  );

  assert.equal(message, '');
});

test('tidak memblokir upload publik saat snapshot periode auto-sync belum pernah sync', () => {
  const message = getNoncodSnapshotGuardMessage(
    '2026-04',
    null,
    {
      now: Date.parse('2026-04-21T15:00:00.000Z'),
      referenceDate: new Date('2026-04-21T15:00:00.000Z'),
    },
  );

  assert.equal(message, '');
});

test('tidak memblokir periode lama di luar jendela auto-sync', () => {
  assert.equal(isAutoSyncablePeriode('2025-12', new Date('2026-04-21T15:00:00.000Z')), false);
  assert.equal(
    getNoncodSnapshotGuardMessage(
      '2025-12',
      null,
      {
        now: Date.parse('2026-04-21T15:00:00.000Z'),
        referenceDate: new Date('2026-04-21T15:00:00.000Z'),
      },
    ),
    '',
  );
});