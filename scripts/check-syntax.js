const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function collectJsFiles(dirPath, recursive = true) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      files.push(...collectJsFiles(fullPath, true));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

function unique(items) {
  return [...new Set(items)];
}

const filesToCheck = unique([
  ...collectJsFiles(path.join(rootDir, 'api')),
  ...collectJsFiles(path.join(rootDir, 'lib')),
  ...collectJsFiles(path.join(rootDir, 'scripts')),
  ...collectJsFiles(path.join(rootDir, 'tests')),
  ...collectJsFiles(rootDir, false),
]).sort();

if (!filesToCheck.length) {
  console.log('Tidak ada file .js yang diperiksa.');
  process.exit(0);
}

const failures = [];

for (const filePath of filesToCheck) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  if (result.status === 0) continue;

  failures.push({
    file: path.relative(rootDir, filePath),
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
  });
}

if (failures.length) {
  console.error('Syntax check gagal:\n');
  for (const failure of failures) {
    console.error(`- ${failure.file}`);
    if (failure.output) console.error(failure.output + '\n');
  }
  process.exit(1);
}

console.log(`Syntax OK: ${filesToCheck.length} file.`);