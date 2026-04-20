/**
 * sync-vercel-env.js
 * Sinkronkan key tertentu dari file .env lokal ke Vercel tanpa mencetak nilai secret.
 *
 * Contoh:
 *   node scripts/local/sync-vercel-env.js --file .env.local --environment production
 *   node scripts/local/sync-vercel-env.js --file .env.production.notifier --environment production --keys TELEGRAM_NOTIFY_URL,TELEGRAM_NOTIFY_SECRET
 *   node scripts/local/sync-vercel-env.js --file .env.local --environment production,preview,development --dry-run
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const ALLOWED_ENVIRONMENTS = new Set(['production', 'preview', 'development']);

function printUsage() {
  console.log('Usage: node scripts/local/sync-vercel-env.js --file <path> --environment <production|preview|development[,..]> [--keys KEY1,KEY2] [--dry-run]');
  console.log('');
  console.log('Script ini hanya mencetak nama key dan status, tidak pernah mencetak nilai secret.');
}

function parseArgs(argv) {
  const options = {
    file: '',
    environments: [],
    keys: [],
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--file') {
      options.file = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--environment' || arg === '--env') {
      options.environments = String(argv[index + 1] || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === '--keys') {
      options.keys = String(argv[index + 1] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Argumen tidak dikenali: ${arg}`);
  }

  if (!options.file) {
    throw new Error('Parameter --file wajib diisi.');
  }
  if (!options.environments.length) {
    throw new Error('Parameter --environment wajib diisi.');
  }
  for (const environment of options.environments) {
    if (!ALLOWED_ENVIRONMENTS.has(environment)) {
      throw new Error(`Environment tidak valid: ${environment}`);
    }
  }

  return options;
}

function resolveEnvFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File tidak ditemukan: ${resolved}`);
  }
  return resolved;
}

function loadEnvEntries(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = dotenv.parse(raw);
  return Object.entries(parsed).filter(([key, value]) => key && value !== undefined);
}

function filterEntries(entries, keys) {
  if (!keys.length) return entries;
  const selectedKeys = new Set(keys);
  return entries.filter(([key]) => selectedKeys.has(key));
}

function getVercelCommand() {
  return process.platform === 'win32' ? 'vercel.cmd' : 'vercel';
}

function getVercelSpawn(commandArgs) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'vercel', ...commandArgs],
    };
  }

  return {
    command: getVercelCommand(),
    args: commandArgs,
  };
}

function shouldUseSensitiveFlag(environment) {
  return String(environment || '').trim().toLowerCase() !== 'development';
}

function runVercelEnvRemove(key, environment) {
  const invocation = getVercelSpawn(['env', 'rm', key, environment, '--yes']);
  return spawnSync(
    invocation.command,
    invocation.args,
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
}

function isMissingVercelEnv(result) {
  const summary = summarizeFailure(result).toLowerCase();
  return summary.includes('not found')
    || summary.includes('does not exist')
    || summary.includes('could not find')
    || summary.includes('no existing environment variable');
}

function runVercelEnvAdd(key, value, environment) {
  const removeResult = runVercelEnvRemove(key, environment);
  if (removeResult.status !== 0 && !isMissingVercelEnv(removeResult)) {
    return removeResult;
  }

  const args = ['env', 'add', key, environment, '--force', '--yes'];
  if (shouldUseSensitiveFlag(environment)) {
    args.push('--sensitive');
  }

  const invocation = getVercelSpawn(args);
  return spawnSync(
    invocation.command,
    invocation.args,
    {
      input: String(value || ''),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
}

function summarizeFailure(result) {
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  return (stderr || stdout || `Exit code ${result.status || 1}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolvedFile = resolveEnvFile(options.file);
  const entries = filterEntries(loadEnvEntries(resolvedFile), options.keys);

  if (!entries.length) {
    throw new Error('Tidak ada key yang cocok untuk disinkronkan.');
  }

  console.log(`File        : ${path.basename(resolvedFile)}`);
  console.log(`Mode        : ${options.dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Environment : ${options.environments.join(', ')}`);
  console.log(`Total key   : ${entries.length}`);

  let failureCount = 0;

  for (const environment of options.environments) {
    console.log(`\n[${environment}]`);
    for (const [key, value] of entries) {
      if (options.dryRun) {
        console.log(`- dry-run ${key}`);
        continue;
      }

      const result = runVercelEnvAdd(key, value, environment);
      if (result.status === 0) {
        console.log(`- ok ${key}`);
        continue;
      }

      failureCount += 1;
      console.log(`- fail ${key}: ${summarizeFailure(result)}`);
    }
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
  filterEntries,
  getVercelCommand,
  getVercelSpawn,
  isMissingVercelEnv,
  loadEnvEntries,
  parseArgs,
  resolveEnvFile,
  runVercelEnvAdd,
  runVercelEnvRemove,
  shouldUseSensitiveFlag,
  summarizeFailure,
};