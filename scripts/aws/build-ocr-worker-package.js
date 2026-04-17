const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const outputDir = path.join(projectRoot, 'tmp', 'aws-ocr-worker-package');

const filesToCopy = [
  ['scripts/aws/ocr-worker/index.js', 'index.js'],
  ['api/_ocr-job-runner.js', 'api/_ocr-job-runner.js'],
  ['api/_ocr-runner.js', 'api/_ocr-runner.js'],
  ['api/_ocr-job-pipeline.js', 'api/_ocr-job-pipeline.js'],
  ['api/_ocr-utils.js', 'api/_ocr-utils.js'],
  ['api/_logger.js', 'api/_logger.js'],
  ['api/_ops-notifier.js', 'api/_ops-notifier.js'],
  ['api/_supabase.js', 'api/_supabase.js'],
];

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyRelativeFile(sourceRelativePath, destinationRelativePath) {
  const sourcePath = path.join(projectRoot, sourceRelativePath);
  const destinationPath = path.join(outputDir, destinationRelativePath);
  ensureDirectory(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function writeWorkerPackageJson(rootPackageJson) {
  const workerPackageJson = {
    name: 'dashboard-maulagi-ocr-worker',
    private: true,
    version: rootPackageJson.version || '1.0.0',
    description: 'Standalone AWS Lambda OCR worker for Dashboard Maulagi',
    main: 'index.js',
    type: 'commonjs',
    engines: {
      node: '>=18',
    },
    dependencies: {
      '@supabase/supabase-js': rootPackageJson.dependencies['@supabase/supabase-js'],
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
    '# OCR Worker Package',
    '',
    'Artifact ini disiapkan untuk deploy AWS Lambda OCR worker terpisah.',
    '',
    '## Langkah',
    '',
    '1. Jalankan `npm install --omit=dev` di folder ini.',
    '2. Zip seluruh isi folder ini.',
    '3. Upload zip ke AWS Lambda Node.js.',
    '4. Set handler ke `index.handler`.',
    '5. Isi env Lambda: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, `OCR_PIPELINE_TRIGGER_SECRET`.',
    '6. Arahkan `OCR_PIPELINE_TRIGGER_URL` di Vercel ke Function URL Lambda.',
    '',
    '## Catatan',
    '',
    '- Package ini sengaja hanya membawa modul yang dipakai worker OCR.',
    '- Logger tetap dibawa agar jalur error worker konsisten dengan repo utama.',
    '- Upload zip artifact penuh, bukan hanya copy `index.js` ke editor AWS Lambda.',
    '- Jika Lambda Test menampilkan `Module worker OCR tidak ditemukan`, cek folder `api/` dan `node_modules/` di root artifact.',
    '- Jika notifier Telegram tidak diaktifkan di Lambda, helper notifier akan diam tanpa error.',
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'README.md'), content + '\n', 'utf8');
}

function main() {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  );

  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDirectory(outputDir);

  filesToCopy.forEach(([sourceRelativePath, destinationRelativePath]) => {
    copyRelativeFile(sourceRelativePath, destinationRelativePath);
  });

  writeWorkerPackageJson(rootPackageJson);
  writeWorkerReadme();

  console.log('OCR worker package siap di:', outputDir);
}

if (require.main === module) {
  main();
}

module.exports = main;