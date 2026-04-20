const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSupabaseKeyIssue,
  parseSupabaseJwtPayload,
} = require('../api/_supabase');

function toBase64Url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createLegacyJwt(role, iss = 'supabase') {
  return [
    toBase64Url({ alg: 'HS256', typ: 'JWT' }),
    toBase64Url({ iss, role, exp: 4102444800 }),
    'signature',
  ].join('.');
}

test('parseSupabaseJwtPayload membaca payload JWT legacy Supabase', () => {
  assert.deepEqual(parseSupabaseJwtPayload(createLegacyJwt('service_role')), {
    iss: 'supabase',
    role: 'service_role',
    exp: 4102444800,
  });
});

test('getSupabaseKeyIssue menerima service role key format baru', () => {
  assert.equal(getSupabaseKeyIssue('sb_secret_example'), null);
});

test('getSupabaseKeyIssue menerima JWT legacy service_role', () => {
  assert.equal(getSupabaseKeyIssue(createLegacyJwt('service_role')), null);
});

test('getSupabaseKeyIssue menolak JWT anon untuk backend', () => {
  const issue = getSupabaseKeyIssue(createLegacyJwt('anon'));

  assert.match(issue, /role anon/i);
});

test('getSupabaseKeyIssue menolak issuer JWT yang bukan supabase', () => {
  const issue = getSupabaseKeyIssue(createLegacyJwt('service_role', 'other'));

  assert.match(issue, /issuer JWT tidak valid/i);
});