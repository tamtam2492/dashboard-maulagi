const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BWS_SECRET_IDS,
  buildBwsSecretMap,
  getExpectedTriggerLambdaName,
  parseJwtPayload,
  validateTriggerUrlMatchesLambda,
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

test('validateSecretValue menolak URL worker NONCOD yang masih placeholder', () => {
  const error = validateSecretValue('NONCOD_PIPELINE_TRIGGER_URL', 'https://your-trigger-url.example.com/');

  assert.match(error, /placeholder/i);
});

test('validateSecretValue menerima URL worker NONCOD https yang valid', () => {
  assert.equal(
    validateSecretValue('NONCOD_PIPELINE_TRIGGER_URL', 'https://worker-id.lambda-url.ap-southeast-1.on.aws/'),
    null,
  );
});

test('getExpectedTriggerLambdaName memetakan key NONCOD ke Lambda yang benar', () => {
  assert.equal(getExpectedTriggerLambdaName('NONCOD_PIPELINE_TRIGGER_URL'), 'noncod-worker-maulagi');
  assert.equal(getExpectedTriggerLambdaName('OCR_PIPELINE_TRIGGER_URL'), 'ocr-worker-maulagi');
});

test('validateTriggerUrlMatchesLambda menolak URL trigger yang tidak cocok dengan Lambda target', () => {
  const error = validateTriggerUrlMatchesLambda(
    'NONCOD_PIPELINE_TRIGGER_URL',
    'https://worker-ocr.lambda-url.ap-southeast-1.on.aws/',
    'https://worker-noncod.lambda-url.ap-southeast-1.on.aws/',
  );

  assert.match(error, /Function URL Lambda noncod-worker-maulagi/i);
});

test('buildBwsSecretMap memprioritaskan secret terbaru per key di atas UUID legacy', () => {
  const oldId = BWS_SECRET_IDS.NONCOD_PIPELINE_TRIGGER_URL;
  const secretMap = buildBwsSecretMap([
    {
      id: oldId,
      key: 'NONCOD_PIPELINE_TRIGGER_URL',
      value: 'https://your-trigger-url.example.com/',
      creationDate: '2026-04-20T01:20:18.445591200Z',
      revisionDate: '2026-04-20T01:20:18.445591200Z',
    },
    {
      id: 'new-secret-id',
      key: 'NONCOD_PIPELINE_TRIGGER_URL',
      value: 'https://worker-id.lambda-url.ap-southeast-1.on.aws/',
      creationDate: '2026-04-20T13:35:55.538900900Z',
      revisionDate: '2026-04-20T13:35:55.538900900Z',
    },
  ]);

  assert.equal(
    secretMap.get('NONCOD_PIPELINE_TRIGGER_URL'),
    'https://worker-id.lambda-url.ap-southeast-1.on.aws/',
  );
});