const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const apiDir = path.join(projectRoot, 'api');
const outputDir = path.join(projectRoot, 'tmp', 'aws-noncod-sync-worker-package');

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyRelativeFile(sourceRelativePath, destinationRelativePath) {
  const sourcePath = path.join(projectRoot, sourceRelativePath);
  const destinationPath = path.join(outputDir, destinationRelativePath);
  ensureDirectory(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyApiRuntimeFiles() {
  const apiFiles = fs.readdirSync(apiDir)
    .filter((name) => name.endsWith('.js') && (name.startsWith('_') || name === 'noncod.js'));

  apiFiles.forEach((name) => {
    copyRelativeFile(path.join('api', name), path.join('api', name));
  });
}

function writeWorkerPackageJson(rootPackageJson) {
  const workerPackageJson = {
    name: 'dashboard-maulagi-noncod-sync-worker',
    private: true,
    version: rootPackageJson.version || '1.0.0',
    description: 'Standalone AWS Lambda NONCOD sync worker for Dashboard Maulagi',
    main: 'index.js',
    type: 'commonjs',
    engines: {
      node: '>=18',
    },
    dependencies: {
      '@supabase/supabase-js': rootPackageJson.dependencies['@supabase/supabase-js'],
      'exceljs': rootPackageJson.dependencies.exceljs,
    },
  };

  fs.writeFileSync(
    path.join(outputDir, 'package.json'),
    JSON.stringify(workerPackageJson, null, 2) + '\n',
    'utf8'
  );
}

function writeWorkerReadme() {
  const content = [
    '# NONCOD Sync Worker Package',
    '',
    'Artifact ini disiapkan untuk deploy AWS Lambda worker sync NONCOD terpisah.',
    '',
    '## Langkah',
    '',
    '1. Jalankan `npm install --omit=dev` di folder ini.',
    '2. Zip seluruh isi folder ini.',
    '3. Upload zip ke AWS Lambda Node.js.',
    '4. Set handler ke `index.handler`.',
    '5. Isi env Lambda: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MAUKIRIM_WA`, `MAUKIRIM_PASS`, `NONCOD_PIPELINE_TRIGGER_SECRET`.',
    '6. Arahkan `NONCOD_PIPELINE_TRIGGER_URL` di Vercel ke Function URL Lambda ini.',
    '',
    '## Catatan',
    '',
    '- Worker ini menjalankan sync MauKirim langsung ke Supabase.',
    '- Vercel tidak lagi menjadi executor sync background utama.',
    '- Jika worker ingin mengirim error ke notifier Telegram, isi env notifier yang sama seperti backend utama.',
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'README.md'), content + '\n', 'utf8');
}

function writeWorkerEntryPoint() {
  const content = "module.exports = require('./scripts/aws/noncod-sync-trigger/index.js');\n";
  fs.writeFileSync(path.join(outputDir, 'index.js'), content, 'utf8');
}

function main() {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  );

  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDirectory(outputDir);

  copyRelativeFile('scripts/aws/noncod-sync-trigger/index.js', 'scripts/aws/noncod-sync-trigger/index.js');
  copyApiRuntimeFiles();
  writeWorkerEntryPoint();
  writeWorkerPackageJson(rootPackageJson);
  writeWorkerReadme();

  console.log('NONCOD sync worker package siap di:', outputDir);
}

if (require.main === module) {
  main();
}

module.exports = main;