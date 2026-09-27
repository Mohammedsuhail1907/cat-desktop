// Builds what the end-to-end suite needs and runs it:
//   1. Angular production build (cat-desktop/dist)
//   2. Debug build of the host into Desktop/CatDesktop.Host/bin/e2e (the DevTools Protocol hook is Debug-only;
//      bin/Debug is left alone because a running dev instance may lock it)
//   3. node tests/e2e/bridge-smoke.mjs --exe <that build> [extra arguments, e.g. --long]
// Usage: npm run test:e2e [-- --long]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'Desktop', 'CatDesktop.Host', 'bin', 'e2e');
const isWindows = process.platform === 'win32';

function step(label, command, args) {
  console.log(`\n[e2e] ${label}`);
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: isWindows && command === 'npm' });
  if (r.error || r.status !== 0) {
    console.error(`[e2e] ${label} failed.`);
    process.exit(r.status || 1);
  }
}

step('Angular production build', 'npm', ['--prefix', 'cat-desktop', 'run', 'build']);
step('Host Debug build', 'dotnet', ['build', path.join('Desktop', 'CatDesktop.Host', 'CatDesktop.Host.csproj'), '-c', 'Debug', '-o', out, '-nologo', '-v', 'q']);
const suite = spawnSync(process.execPath, [path.join('tests', 'e2e', 'bridge-smoke.mjs'), '--exe', path.join(out, 'CatDesktop.exe'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(suite.status ?? 1);
