const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const frontendFiles = [
  'admin.html',
  'dashboard.html',
  'index.html',
  'input.html',
  'noncod.html',
  'rekap.html',
  'lib/admin-page.js',
  'lib/dashboard-page.js',
  'lib/index-page.js',
  'lib/input-page.js',
  'lib/noncod-page.js',
  'lib/rekap-page.js',
];

const inlineHandlerPattern = /on(?:click|change|input|keydown|keyup|load|submit|focus|blur|error)\s*=\s*["']/i;

test('frontend files tidak menyisipkan inline handler yang bentrok dengan CSP ketat', () => {
  frontendFiles.forEach((relativeFile) => {
    const absoluteFile = path.join(projectRoot, relativeFile);
    const content = fs.readFileSync(absoluteFile, 'utf8');
    assert.equal(
      inlineHandlerPattern.test(content),
      false,
      relativeFile + ' masih mengandung inline handler yang tidak kompatibel dengan CSP.',
    );
  });
});
