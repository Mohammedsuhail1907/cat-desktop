// Installs the Angular project's dependencies (cat-desktop/) and restores the .NET host, so that one `npm install` in
// the repository root prepares everything. Runs as the root package's postinstall; `npm run install:all -- --force`
// reinstalls cleanly with `npm ci`.
//
// The Angular project keeps its own package.json and package-lock.json (build.ps1 and the installer build rely on
// them), so this deliberately does not use npm workspaces.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const angularDir = path.join(root, 'cat-desktop');
const hostProject = path.join(root, 'Desktop', 'CatDesktop.Host', 'CatDesktop.Host.csproj');
const force = process.argv.includes('--force');
const isWindows = process.platform === 'win32';

function run(label, command, args, cwd) {
  console.log(`[install] ${label}: ${command} ${args.join(' ')}`);
  // npm is a .cmd shim on Windows and needs a shell; dotnet is a real executable (and paths may contain spaces).
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: isWindows && command === 'npm' });
  if (result.error) return { ok: false, missing: result.error.code === 'ENOENT' };
  return { ok: result.status === 0, status: result.status };
}

if (process.env.CATDESKTOP_SKIP_POSTINSTALL === '1') {
  console.log('[install] CATDESKTOP_SKIP_POSTINSTALL=1 – skipping the Angular install and the .NET restore.');
  process.exit(0);
}

// 1. Angular dependencies (from cat-desktop/package-lock.json).
const hasModules = fs.existsSync(path.join(angularDir, 'node_modules', '@angular', 'core'));
const npmArgs = force || !hasModules ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
const angular = run('Angular dependencies', 'npm', npmArgs, angularDir);
if (!angular.ok) {
  console.error('[install] Installing the Angular dependencies failed. Run "npm ci" inside cat-desktop/ to see the full error.');
  process.exit(angular.status || 1);
}

// 2. .NET restore (optional here – `dotnet run` / `dotnet build` restore on their own).
const dotnet = run('.NET host packages', 'dotnet', ['restore', hostProject, '--nologo', '-v', 'q'], root);
if (!dotnet.ok) {
  console.warn(
    dotnet.missing
      ? '[install] The .NET SDK was not found (dotnet). Install the .NET 9 SDK to run the desktop host; the Angular part is ready.'
      : '[install] "dotnet restore" failed; the desktop host will retry on its first build.',
  );
}
console.log('[install] Done. Start everything with: npm run dev');
