const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isMissingVercelEnv,
  shouldUseSensitiveFlag,
  summarizeFailure,
} = require('../scripts/local/sync-vercel-env');

test('shouldUseSensitiveFlag hanya aktif di production dan preview', () => {
  assert.equal(shouldUseSensitiveFlag('production'), true);
  assert.equal(shouldUseSensitiveFlag('preview'), true);
  assert.equal(shouldUseSensitiveFlag('development'), false);
});

test('isMissingVercelEnv mengenali kegagalan remove untuk key yang belum ada', () => {
  const result = {
    status: 1,
    stderr: 'Error: Environment Variable was not found.',
    stdout: '',
  };

  assert.equal(isMissingVercelEnv(result), true);
});

test('summarizeFailure memprioritaskan tiga baris error pertama', () => {
  const result = {
    status: 1,
    stderr: 'line one\nline two\nline three\nline four',
    stdout: '',
  };

  assert.equal(summarizeFailure(result), 'line one | line two | line three');
});