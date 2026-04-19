const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const buildNoncodSyncWorkerPackage = require('./build-noncod-sync-worker-package');

const projectRoot = path.resolve(__dirname, '..', '..');
const workerDir = path.join(projectRoot, 'tmp', 'aws-noncod-sync-worker-package');
const zipPath = path.join(projectRoot, 'tmp', 'aws-noncod-sync-worker-package.zip');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd || projectRoot,
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} gagal dengan exit code ${result.status}.`);
  }
}

function resolveNpmCommand() {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath],
    };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
  };
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd || projectRoot,
    shell: false,
  });

  if (result.error) return false;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} gagal dengan exit code ${result.status}.`);
  }

  return true;
}

function zipWorkerPackage() {
  fs.rmSync(zipPath, { force: true });

  if (process.platform === 'win32') {
    const zipCommand = `Compress-Archive -Path * -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    if (tryRun('pwsh', ['-NoProfile', '-Command', zipCommand], { cwd: workerDir })) {
      return;
    }

    run('powershell', ['-NoProfile', '-Command', zipCommand], { cwd: workerDir });
    return;
  }

  run('zip', ['-qr', zipPath, '.'], { cwd: workerDir });
}

function main() {
  buildNoncodSyncWorkerPackage();
  const npmCommand = resolveNpmCommand();
  run(npmCommand.command, [...npmCommand.args, 'install', '--omit=dev'], { cwd: workerDir });
  zipWorkerPackage();
  console.log('NONCOD sync worker zip siap di:', zipPath);
}

main();