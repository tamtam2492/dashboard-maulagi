const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseJwtPayload,
  validateSecretValue,
} = require('../scripts/local/sync-bws-runtime');

function toBase64Url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createLegacyJwt(role) {
  return [
    toBase64Url({ alg: 'HS256', typ: 'JWT' }),
    toBase64Url({ iss: 'supabase', role, exp: 4102444800 }),
    'signature',
  ].join('.');
}

test('parseJwtPayload membaca payload JWT legacy Supabase', () => {
  const payload = parseJwtPayload(createLegacyJwt('service_role'));

  assert.deepEqual(payload, {
    iss: 'supabase',
    role: 'service_role',
    exp: 4102444800,
  });
});

test('validateSecretValue menerima service role key format baru', () => {
  assert.equal(validateSecretValue('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_example'), null);
});

test('validateSecretValue menolak service role key yang ternyata anon', () => {
  const error = validateSecretValue('SUPABASE_SERVICE_ROLE_KEY', createLegacyJwt('anon'));

  assert.match(error, /role JWT tidak valid: anon/i);
});

test('validateSecretValue menerima anon key format baru', () => {
  assert.equal(validateSecretValue('SUPABASE_ANON_KEY', 'sb_publishable_example'), null);
});

test('validateSecretValue menolak anon key yang ternyata service_role', () => {
  const error = validateSecretValue('SUPABASE_ANON_KEY', createLegacyJwt('service_role'));

  assert.match(error, /role JWT tidak valid: service_role/i);
});