/**
 * sync-bws-runtime.js
 * Sinkronkan secret dari Bitwarden Secrets Manager ke Vercel dan AWS Lambda.
 * Script hanya mencetak nama key dan status, tidak pernah mencetak nilai secret.
 */
const { spawnSync } = require('child_process');
const { runVercelEnvAdd, summarizeFailure } = require('./sync-vercel-env');

const DEFAULT_REGION = 'ap-southeast-1';
const ALLOWED_SOURCES = new Set(['bws', 'env']);
const ALLOWED_TARGETS = new Set(['all', 'vercel', 'lambda']);
const BWS_SECRET_IDS = {
  SUPABASE_URL: '1a8d0336-fa41-46e5-91ca-b432000eb26d',
  SUPABASE_ANON_KEY: 'c213e47b-fa78-4a36-8f71-b432000f2925',
  SUPABASE_SERVICE_ROLE_KEY: '3d95a97d-84fb-4f3a-bdc0-b43200104224',
  MAUKIRIM_WA: '69c46ab9-e399-4e09-9cc5-b43200108efe',
  MAUKIRIM_PASS: 'cb3e2a68-d04a-4930-a4c7-b4320010a5b1',
  GROQ_API_KEY: 'e533b576-a2cd-4833-b96d-b4320010ef6a',
  OCR_SYNC_SECRET: 'aa75be6b-205a-427f-8688-b432001156f7',
  TELEGRAM_NOTIFY_URL: 'b0cd6cd6-b667-4ed4-a161-b4320011fc77',
  TELEGRAM_NOTIFY_SECRET: '6e134f3d-ebe4-4a7a-8478-b43200122b1d',
  TELEGRAM_NOTIFY_SOURCES: '5b71f343-10b4-4524-ba2d-b43200123fb9',
  TELEGRAM_NOTIFY_SERVICE: '418c70a7-89f6-420b-b1cf-b432001262ee',
  UPSTASH_REDIS_REST_URL: '5ba6978e-a333-48f1-88f0-b43200129065',
  UPSTASH_REDIS_REST_TOKEN: 'dcb5eca9-159e-44e0-a270-b432001511a0',
  NONCOD_SYNC_SECRET: '8f0521c1-742c-4d6e-860c-b4320015f1c9',
  NONCOD_PIPELINE_TRIGGER_URL: '318ea5db-b500-4c12-8e31-b43200160e9e',
  NONCOD_PIPELINE_TRIGGER_SECRET: '67d5d81c-165d-4f22-9a75-b432001635ea',
  CRON_SECRET: 'f471c580-b6cb-4b3a-bdd0-b43200167478',
  TELEGRAM_CHAT_ID: '6e80db67-28ad-4d31-ba42-b432001783bf',
  TELEGRAM_BOT_TOKEN: '2441900d-a461-45c7-a517-b4320017ac08',
};
const OPTIONAL_SECRET_KEYS = new Set([
  'OCR_PIPELINE_TRIGGER_URL',
  'OCR_PIPELINE_TRIGGER_SECRET',
  'TELEGRAM_MESSAGE_THREAD_ID',
]);
const SUPABASE_SECRET_PREFIXES = {
  SUPABASE_ANON_KEY: 'sb_publishable_',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_',
};
const UNWRAP_QUOTED_KEYS = new Set([
  'SUPABASE_URL',
  'TELEGRAM_NOTIFY_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'OCR_PIPELINE_TRIGGER_URL',
  'NONCOD_PIPELINE_TRIGGER_URL',
]);
const SECRET_KEY_ALIASES = {
  SUPABASE_SERVICE_ROLE_KEY: ['SUPABASE_SEKRVICE_ROLE_KEY'],
};

const SYNC_PLAN = {
  vercel: [
    { key: 'SUPABASE_URL', environments: ['production', 'preview', 'development'] },
    { key: 'SUPABASE_ANON_KEY', environments: ['production', 'preview', 'development'] },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', environments: ['production', 'preview', 'development'] },
    { key: 'MAUKIRIM_WA', environments: ['production', 'preview', 'development'] },
    { key: 'MAUKIRIM_PASS', environments: ['production', 'preview', 'development'] },
    { key: 'GROQ_API_KEY', environments: ['production', 'preview', 'development'] },
    { key: 'OCR_SYNC_SECRET', environments: ['production', 'preview', 'development'] },
    { key: 'OCR_PIPELINE_TRIGGER_URL', environments: ['production', 'preview', 'development'] },
    { key: 'OCR_PIPELINE_TRIGGER_SECRET', environments: ['production', 'preview', 'development'] },
    { key: 'NONCOD_SYNC_SECRET', environments: ['production', 'preview', 'development'] },
    { key: 'NONCOD_PIPELINE_TRIGGER_URL', environments: ['production', 'preview', 'development'] },
    { key: 'NONCOD_PIPELINE_TRIGGER_SECRET', environments: ['production', 'preview', 'development'] },
    { key: 'TELEGRAM_NOTIFY_URL', environments: ['production', 'preview', 'development'] },
    { key: 'TELEGRAM_NOTIFY_SECRET', environments: ['production', 'preview', 'development'] },
    { key: 'TELEGRAM_NOTIFY_SOURCES', environments: ['production', 'preview', 'development'] },
    { key: 'TELEGRAM_NOTIFY_SERVICE', environments: ['production', 'preview', 'development'] },
    { key: 'UPSTASH_REDIS_REST_URL', environments: ['production', 'preview', 'development'] },
    { key: 'UPSTASH_REDIS_REST_TOKEN', environments: ['production', 'preview', 'development'] },
    { key: 'CRON_SECRET', environments: ['production'] },
  ],
  lambda: [
    {
      functionName: 'telegram-notifier',
      keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_NOTIFY_SECRET', 'TELEGRAM_MESSAGE_THREAD_ID'],
    },
    {
      functionName: 'ocr-worker-maulagi',
      keys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY', 'OCR_PIPELINE_TRIGGER_SECRET'],
    },
    {
      functionName: 'noncod-worker-maulagi',
      keys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MAUKIRIM_WA', 'MAUKIRIM_PASS', 'NONCOD_PIPELINE_TRIGGER_SECRET'],
    },
  ],
};

function printUsage() {
  console.log('Usage: node scripts/local/sync-bws-runtime.js [--project-id <id>] [--source bws|env] [--target all|vercel|lambda] [--function <name>] [--region <aws-region>] [--dry-run] [--verify-only]');
  console.log('');
  console.log('Contoh:');
  console.log('  npm run local:sync-bws-runtime -- --project-id <bws-project-id> --dry-run');
  console.log('  npm run local:sync-bws-runtime -- --source env --verify-only');
  console.log('  npm run local:sync-bws-runtime -- --project-id <bws-project-id> --target vercel');
  console.log('  npm run local:sync-bws-runtime -- --project-id <bws-project-id> --target lambda --function telegram-notifier');
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    functionName: '',
    projectId: process.env.BWS_PROJECT_ID || '',
    region: process.env.AWS_REGION || DEFAULT_REGION,
    source: (process.env.SYNC_SECRET_SOURCE || 'bws').trim().toLowerCase(),
    target: 'all',
    verifyOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-id') {
      options.projectId = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--target') {
      options.target = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg === '--source') {
      options.source = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg === '--function') {
      options.functionName = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--region') {
      options.region = String(argv[index + 1] || '').trim() || DEFAULT_REGION;
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--verify-only') {
      options.verifyOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Argumen tidak dikenali: ${arg}`);
  }

  if (!ALLOWED_SOURCES.has(options.source)) {
    throw new Error(`Source tidak valid: ${options.source}`);
  }
  if (!ALLOWED_TARGETS.has(options.target)) {
    throw new Error(`Target tidak valid: ${options.target}`);
  }

  if (options.verifyOnly) {
    options.dryRun = true;
  }

  return options;
}

function runCommand(command, args, input = '') {
  return spawnSync(command, args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function listBwsSecrets(projectId) {
  const args = ['secret', 'list', '--output', 'json'];
  if (projectId) args.push(projectId);
  const result = runCommand('bws', args);
  if (result.status !== 0) {
    throw new Error(`BWS gagal: ${summarizeFailure(result)}`);
  }

  const parsed = JSON.parse(String(result.stdout || '[]'));
  const itemsById = new Map();
  for (const item of parsed) {
    const id = String(item && item.id || '').trim();
    if (!id) continue;
    itemsById.set(id, item);
  }

  const map = new Map();
  for (const [key, id] of Object.entries(BWS_SECRET_IDS)) {
    const item = itemsById.get(id);
    if (!item) continue;
    map.set(key, String(item && item.value || ''));
  }

  for (const item of parsed) {
    const key = String(item && item.key || '').trim();
    if (!key) continue;
    if (map.has(key)) continue;
    map.set(key, String(item && item.value || ''));
  }
  return map;
}

function getPlannedSecretKeys() {
  const keys = new Set();

  for (const item of SYNC_PLAN.vercel) {
    keys.add(item.key);
  }
  for (const target of SYNC_PLAN.lambda) {
    for (const key of target.keys) {
      keys.add(key);
    }
  }
  for (const aliases of Object.values(SECRET_KEY_ALIASES)) {
    for (const alias of aliases) {
      keys.add(alias);
    }
  }

  return [...keys];
}

function listEnvSecrets(env = process.env) {
  const map = new Map();
  for (const key of getPlannedSecretKeys()) {
    if (env[key] === undefined) continue;
    map.set(key, String(env[key] || ''));
  }
  return map;
}

function loadSecretMap(options, env = process.env) {
  if (options.source === 'env') {
    return listEnvSecrets(env);
  }
  return listBwsSecrets(options.projectId);
}

function unwrapQuotedValue(value) {
  const text = String(value || '');
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return text.slice(1, -1);
  }
  return text;
}

function normalizeSecretValue(key, value) {
  let normalized = String(value || '').trim();
  if (UNWRAP_QUOTED_KEYS.has(String(key || '').trim())) {
    normalized = unwrapQuotedValue(normalized).trim();
  }
  return normalized;
}

function isOptionalSecret(key) {
  return OPTIONAL_SECRET_KEYS.has(String(key || '').trim());
}

function getSecretValue(secretMap, key) {
  if (secretMap.has(key)) return normalizeSecretValue(key, secretMap.get(key));

  const aliases = SECRET_KEY_ALIASES[key] || [];
  for (const alias of aliases) {
    if (secretMap.has(alias)) return normalizeSecretValue(key, secretMap.get(alias));
  }

  return null;
}

function safeBase64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(safeBase64UrlDecode(parts[1] || ''));
  } catch {
    return null;
  }
}

function validateSupabaseAnonKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'missing';
  if (normalized.startsWith(SUPABASE_SECRET_PREFIXES.SUPABASE_ANON_KEY)) return null;

  const payload = parseJwtPayload(normalized);
  if (!payload) {
    return 'format tidak cocok untuk anon key; harapkan sb_publishable_* atau JWT legacy dengan role anon';
  }

  if (String(payload.iss || '').trim() && String(payload.iss || '').trim() !== 'supabase') {
    return `issuer JWT tidak valid: ${payload.iss}`;
  }
  if (String(payload.role || '').trim() !== 'anon') {
    return `role JWT tidak valid: ${payload.role || 'unknown'} (harapkan anon)`;
  }

  return null;
}

function validateSupabaseServiceRoleKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'missing';
  if (normalized.startsWith(SUPABASE_SECRET_PREFIXES.SUPABASE_SERVICE_ROLE_KEY)) return null;

  const payload = parseJwtPayload(normalized);
  if (!payload) {
    return 'format tidak cocok untuk service role key; harapkan sb_secret_* atau JWT legacy dengan role service_role';
  }

  if (String(payload.iss || '').trim() && String(payload.iss || '').trim() !== 'supabase') {
    return `issuer JWT tidak valid: ${payload.iss}`;
  }
  if (String(payload.role || '').trim() !== 'service_role') {
    return `role JWT tidak valid: ${payload.role || 'unknown'} (harapkan service_role)`;
  }

  return null;
}

function validateSecretValue(key, value) {
  if (key === 'SUPABASE_ANON_KEY') {
    return validateSupabaseAnonKey(value);
  }
  if (key === 'SUPABASE_SERVICE_ROLE_KEY') {
    return validateSupabaseServiceRoleKey(value);
  }
  return null;
}

function hasSemanticValidator(key) {
  return key === 'SUPABASE_ANON_KEY' || key === 'SUPABASE_SERVICE_ROLE_KEY';
}

function getLambdaTargets(options) {
  const targets = options.functionName
    ? SYNC_PLAN.lambda.filter((item) => item.functionName === options.functionName)
    : SYNC_PLAN.lambda;

  if (!targets.length) {
    throw new Error(`Function Lambda tidak ditemukan di plan: ${options.functionName}`);
  }

  return targets;
}

function getTargetSecretKeys(options) {
  const keys = new Set();

  if (options.target === 'all' || options.target === 'vercel') {
    for (const item of SYNC_PLAN.vercel) {
      keys.add(item.key);
    }
  }

  if (options.target === 'all' || options.target === 'lambda') {
    for (const target of getLambdaTargets(options)) {
      for (const key of target.keys) {
        keys.add(key);
      }
    }
  }

  return [...keys];
}

function verifySecretSemantics(secretMap, options) {
  console.log('\n[Verify: Secret semantics]');
  let failureCount = 0;

  for (const key of getTargetSecretKeys(options)) {
    if (!hasSemanticValidator(key)) continue;

    const value = getSecretValue(secretMap, key);
    if (value === null) {
      console.log(`- skip ${key}: belum ada, dicek di verifikasi availability`);
      continue;
    }

    const validationError = validateSecretValue(key, value);
    if (!validationError) {
      console.log(`- ok ${key}`);
      continue;
    }

    failureCount += 1;
    console.log(`- fail ${key}: ${validationError}`);
  }

  return failureCount;
}

function verifyVercel(secretMap) {
  console.log('\n[Verify: Vercel]');
  let failureCount = 0;
  const seenKeys = new Set();

  for (const item of SYNC_PLAN.vercel) {
    if (seenKeys.has(item.key)) continue;
    seenKeys.add(item.key);

    if (getSecretValue(secretMap, item.key) !== null) {
      console.log(`- ok ${item.key}`);
      continue;
    }

    if (isOptionalSecret(item.key)) {
      console.log(`- skip ${item.key}: optional dan belum ada`);
      continue;
    }

    failureCount += 1;
    console.log(`- fail ${item.key}: missing`);
  }

  return failureCount;
}

function verifyLambda(secretMap, options) {
  console.log('\n[Verify: Lambda]');
  let failureCount = 0;
  const targets = getLambdaTargets(options);

  for (const target of targets) {
    for (const key of target.keys) {
      if (getSecretValue(secretMap, key) !== null) {
        console.log(`- ok ${target.functionName}: ${key}`);
        continue;
      }

      if (isOptionalSecret(key)) {
        console.log(`- skip ${target.functionName}: ${key} optional dan belum ada`);
        continue;
      }

      failureCount += 1;
      console.log(`- fail ${target.functionName}: ${key} missing`);
    }
  }

  return failureCount;
}

function verifyRuntime(secretMap, options) {
  let failureCount = 0;
  if (options.target === 'all' || options.target === 'vercel') {
    failureCount += verifyVercel(secretMap);
  }
  if (options.target === 'all' || options.target === 'lambda') {
    failureCount += verifyLambda(secretMap, options);
  }
  failureCount += verifySecretSemantics(secretMap, options);
  return failureCount;
}

function syncVercel(secretMap, options) {
  console.log('\n[Vercel]');
  let failureCount = 0;

  for (const item of SYNC_PLAN.vercel) {
    const value = getSecretValue(secretMap, item.key);
    if (value === null) {
      console.log(`- skip ${item.key}: missing in BWS`);
      continue;
    }

    for (const environment of item.environments) {
      if (options.dryRun) {
        console.log(`- dry-run ${item.key} -> ${environment}`);
        continue;
      }

      const result = runVercelEnvAdd(item.key, value, environment);
      if (result.status === 0) {
        console.log(`- ok ${item.key} -> ${environment}`);
        continue;
      }

      failureCount += 1;
      console.log(`- fail ${item.key} -> ${environment}: ${summarizeFailure(result)}`);
    }
  }

  return failureCount;
}

function getLambdaVariables(functionName, region) {
  const result = runCommand('aws', [
    'lambda',
    'get-function-configuration',
    '--region',
    region,
    '--function-name',
    functionName,
    '--query',
    'Environment.Variables',
    '--output',
    'json',
  ]);

  if (result.status !== 0) {
    throw new Error(summarizeFailure(result));
  }

  const raw = String(result.stdout || '').trim();
  if (!raw || raw === 'null') return {};
  return JSON.parse(raw);
}

function isLambdaNotFoundError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('resourcenotfoundexception')
    || text.includes('function not found')
    || text.includes('function does not exist');
}

function updateLambdaVariables(functionName, region, variables) {
  return runCommand('aws', [
    'lambda',
    'update-function-configuration',
    '--region',
    region,
    '--function-name',
    functionName,
    '--environment',
    JSON.stringify({ Variables: variables }),
    '--output',
    'json',
  ]);
}

function syncLambda(secretMap, options) {
  console.log('\n[Lambda]');
  let failureCount = 0;
  const targets = getLambdaTargets(options);

  for (const target of targets) {
    const presentKeys = target.keys.filter((key) => getSecretValue(secretMap, key) !== null);
    const missingKeys = target.keys.filter((key) => getSecretValue(secretMap, key) === null);

    if (options.dryRun) {
      for (const key of presentKeys) {
        console.log(`- dry-run ${target.functionName}: ${key}`);
      }
      for (const key of missingKeys) {
        console.log(`- skip ${target.functionName}: ${key} missing in BWS`);
      }
      continue;
    }

    let currentVariables;
    try {
      currentVariables = getLambdaVariables(target.functionName, options.region);
    } catch (error) {
      if (isLambdaNotFoundError(error.message)) {
        console.log(`- skip ${target.functionName}: function belum ada`);
        continue;
      }

      failureCount += 1;
      console.log(`- fail ${target.functionName}: ${error.message}`);
      continue;
    }

    const mergedVariables = { ...currentVariables };
    for (const key of presentKeys) {
      mergedVariables[key] = getSecretValue(secretMap, key);
    }

    const result = updateLambdaVariables(target.functionName, options.region, mergedVariables);
    if (result.status === 0) {
      console.log(`- ok ${target.functionName}: ${presentKeys.length} key updated`);
    } else if (isLambdaNotFoundError(summarizeFailure(result))) {
      console.log(`- skip ${target.functionName}: function belum ada`);
    } else {
      failureCount += 1;
      console.log(`- fail ${target.functionName}: ${summarizeFailure(result)}`);
    }

    for (const key of missingKeys) {
      console.log(`- skip ${target.functionName}: ${key} missing in BWS`);
    }
  }

  return failureCount;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const secretMap = loadSecretMap(options);

  console.log(`Mode      : ${options.verifyOnly ? 'VERIFY' : (options.dryRun ? 'DRY-RUN' : 'LIVE')}`);
  console.log(`Source    : ${options.source}`);
  console.log(`Target    : ${options.target}`);
  if (options.source === 'bws') {
    console.log(`BWS scope : ${options.projectId || 'all accessible projects'}`);
  }
  console.log(`AWS region: ${options.region}`);
  console.log(`Secret key: ${secretMap.size}`);

  if (options.verifyOnly) {
    const failureCount = verifyRuntime(secretMap, options);
    if (failureCount > 0) {
      process.exitCode = 1;
      console.log(`\nVerifikasi gagal dengan ${failureCount} masalah secret wajib/semantik.`);
      return;
    }

    console.log('\nVerifikasi selesai tanpa mencetak nilai secret.');
    return;
  }

  const semanticFailureCount = verifySecretSemantics(secretMap, options);
  if (semanticFailureCount > 0) {
    process.exitCode = 1;
    console.log(`\nSinkronisasi dibatalkan karena ${semanticFailureCount} secret tidak lolos validasi semantik.`);
    return;
  }

  let failureCount = 0;
  if (options.target === 'all' || options.target === 'vercel') {
    failureCount += syncVercel(secretMap, options);
  }
  if (options.target === 'all' || options.target === 'lambda') {
    failureCount += syncLambda(secretMap, options);
  }

  if (failureCount > 0) {
    process.exitCode = 1;
    console.log(`\nSelesai dengan ${failureCount} kegagalan.`);
    return;
  }

  console.log('\nSelesai tanpa mencetak nilai secret.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  BWS_SECRET_IDS,
  getLambdaTargets,
  isLambdaNotFoundError,
  isOptionalSecret,
  listEnvSecrets,
  listBwsSecrets,
  loadSecretMap,
  normalizeSecretValue,
  parseJwtPayload,
  parseArgs,
  SECRET_KEY_ALIASES,
  syncLambda,
  syncVercel,
  SYNC_PLAN,
  validateSecretValue,
  verifySecretSemantics,
  verifyLambda,
  verifyRuntime,
  verifyVercel,
};