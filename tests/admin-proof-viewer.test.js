const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSideways,
  normalizeRotation,
} = require('../lib/admin-proof-viewer');

test('normalizeRotation menjaga derajat di rentang 0-359', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(-90), 270);
});

test('isSideways mendeteksi rotasi landscape vertikal dengan benar', () => {
  assert.equal(isSideways(90), true);
  assert.equal(isSideways(270), true);
  assert.equal(isSideways(180), false);
  assert.equal(isSideways(0), false);
});