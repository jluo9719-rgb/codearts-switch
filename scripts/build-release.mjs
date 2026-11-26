import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = (process.argv[2] || 'desktop').toLowerCase();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'gateway');
const switchDistDir = path.join(gatewayDir, 'internal', 'server', 'switch_dist');
const tauriDir = path.join(root, 'src-tauri');
const isWin = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  const needsShell = isWin && (cmd === 'npm' || cmd === 'npx');
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: needsShell,
    ...opts,
  });
  if (res.error) {
    console.error(`[ERROR] Failed to execute "${cmd}": ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[ERROR] Command "${cmd} ${args.join(' ')}" exited with code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

function checkCmd(cmd, hint) {
  const needsShell = isWin && (cmd === 'npm' || cmd === 'npx');
  const res = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: needsShell });
  if (res.status !== 0) {
    const alt = spawnSync(cmd, ['version'], { stdio: 'ignore', shell: needsShell });
    if (alt.status !== 0) {
      console.error(`[ERROR] Missing required tool "${cmd}". ${hint}`);
      process.exit(1);
    }
  }
}

function copyDistToGateway() {
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    console.log('\n[1/4] Installing npm dependencies...');
    run('npm', ['install'], { cwd: root });
  }
  console.log('\n[1/4] Building React frontend console...');
  run('npm', ['run', 'build'], { cwd: root });

  fs.mkdirSync(switchDistDir, { recursive: true });
  for (const entry of fs.readdirSync(switchDistDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(switchDistDir, entry), { recursive: true, force: true });
  }
  fs.cpSync(path.join(root, 'dist'), switchDistDir, { recursive: true });
  fs.rmSync(path.join(switchDistDir, 'assets', 'aistudio'), { recursive: true, force: true });
}

checkCmd('go', 'Please install Go 1.24+ from https://go.dev/dl/');

if (mode === 'gateway') {
  console.log('=== CodeArts Switch: Single-File Go Gateway Build ===');
  copyDistToGateway();

  const outFile = path.join(root, 'dist-bin', isWin ? 'codearts-switch.exe' : 'codearts-switch');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  console.log(`\n[2/2] Compiling Go gateway -> ${outFile}`);
  run(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w -X main.version=1.0.0', '-o', outFile, '.'],
    {
      cwd: gatewayDir,
      env: { ...process.env, CGO_ENABLED: '0' },
    }
  );

  const mb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
  console.log(`\nDone (${mb} MB): ${outFile}`);
  console.log('Run it and open http://127.0.0.1:10087/');
} else if (mode === 'desktop') {
  console.log('=== CodeArts Switch: Tauri v2 Desktop Client Build ===');
  checkCmd('cargo', 'Please install Rust from https://rustup.rs/ and reopen your terminal.');
  copyDistToGateway();

  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const triple = isWin
    ? `${arch}-pc-windows-msvc`
    : process.platform === 'darwin'
      ? `${arch}-apple-darwin`
      : `${arch}-unknown-linux-gnu`;
  const ext = isWin ? '.exe' : '';
  const sidecarOut = path.join(tauriDir, 'binaries', `codearts-gateway-${triple}${ext}`);
  fs.mkdirSync(path.dirname(sidecarOut), { recursive: true });

  console.log(`\n[2/4] Compiling Go gateway sidecar -> ${sidecarOut}`);
  const ldflags = isWin
    ? '-s -w -H=windowsgui -X main.version=1.0.0'
    : '-s -w -X main.version=1.0.0';
  run('go', ['build', '-trimpath', `-ldflags=${ldflags}`, '-o', sidecarOut, '.'], {
    cwd: gatewayDir,
    env: { ...process.env, CGO_ENABLED: '0' },
  });

  const mb = (fs.statSync(sidecarOut).size / (1024 * 1024)).toFixed(2);
  console.log(`Go sidecar compiled (${mb} MB).`);

  console.log('\n[3/4] Running Tauri v2 desktop bundler (NSIS + MSI)...');
  run('npx', ['--yes', '@tauri-apps/cli@2', 'build'], { cwd: root });

  console.log('\n[4/4] Desktop build complete! Installers are in src-tauri/target/release/bundle/');
} else {
  console.error('Usage: node scripts/build-release.mjs <desktop|gateway>');
  process.exit(1);
}
