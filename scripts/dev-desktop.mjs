// Starts the .NET desktop host in development mode: WebView2 loads the Angular dev server instead of the packaged
// build (the host's --dev-url switch; DevTools, context menu and TRACE logging are on in that mode).
//
//   node scripts/dev-desktop.mjs          start the host now (the Angular dev server should be running)
//   node scripts/dev-desktop.mjs --wait   first wait until the dev server answers (used by `npm run dev`)
//
// Environment: CATDESKTOP_DEV_URL (default http://127.0.0.1:4280, the serve address in cat-desktop/angular.json), CATDESKTOP_DATA_DIR (data folder override),
// CATDESKTOP_DEV_WAIT_SECONDS (default 180).
//
// When an installed CatDesktop (not built from this repository) is already running, the single-instance guard would
// hand over to it and the dev host would exit at once. In that case the dev host gets its own data folder
// (<repo>/.dev-data) so both can run side by side; the installed app's data is never touched.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostProject = path.join(root, 'Desktop', 'CatDesktop.Host', 'CatDesktop.Host.csproj');
const devUrl = (process.env.CATDESKTOP_DEV_URL || 'http://127.0.0.1:4280').replace(/\/+$/, '');
const waitSeconds = Number(process.env.CATDESKTOP_DEV_WAIT_SECONDS || 180);
const shouldWait = process.argv.includes('--wait');
const isWindows = process.platform === 'win32';

const log = (message) => console.log(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 'ours' when the dev server serves CatDesktop's index.html, 'foreign' when some other page answers on that address
 * (typically another Angular project that took the port), null when nothing answers yet.
 */
async function probeDevServer() {
  try {
    const res = await fetch(devUrl, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return 'foreign';
    const html = await res.text();
    return /<title>\s*CatDesktop\s*<\/title>/i.test(html) ? 'ours' : 'foreign';
  } catch {
    return null;
  }
}

async function waitForDevServer() {
  const deadline = Date.now() + waitSeconds * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    const state = await probeDevServer();
    if (state) return state;
    if (!announced) {
      log(`Waiting for the Angular dev server at ${devUrl} (first compile can take a minute)…`);
      announced = true;
    }
    await sleep(1_000);
  }
  return null;
}

/** Full paths of running CatDesktop.exe processes (Windows only). */
function runningCatDesktops() {
  if (!isWindows) return [];
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "Get-Process CatDesktop -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
    { encoding: 'utf8', windowsHide: true },
  );
  return (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function killTree(pid) {
  if (!pid) return;
  if (isWindows) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  if (!isWindows) {
    console.error('The CatDesktop host is a Windows application (WinForms + WebView2); run it on Windows.');
    return 1;
  }
  const server = shouldWait ? await waitForDevServer() : await probeDevServer();
  if (server === 'foreign') {
    console.error(
      `Another application answers at ${devUrl} – not CatDesktop's Angular app, so the desktop host would load the wrong UI.\n` +
        'Stop that dev server, or run CatDesktop on another address: set CATDESKTOP_DEV_URL and start the Angular dev server with the same port.',
    );
    return 1;
  }
  if (server === null && shouldWait) {
    console.error(`The Angular dev server did not answer at ${devUrl} within ${waitSeconds} s.`);
    return 1;
  }
  if (server === null) {
    log(`Nothing answers at ${devUrl} yet – the app shows a "dev server not reachable" page until you start it (npm run dev:angular).`);
  }

  const env = { ...process.env };
  if (!env.CATDESKTOP_DATA_DIR) {
    const foreign = runningCatDesktops().filter((p) => !p.toLowerCase().startsWith(root.toLowerCase()));
    if (foreign.length > 0) {
      env.CATDESKTOP_DATA_DIR = path.join(root, '.dev-data');
      log(`An installed CatDesktop is running (${foreign[0]}).`);
      log(`The dev host uses its own data folder so both can run: ${env.CATDESKTOP_DATA_DIR}`);
    }
  }

  log(`Starting the .NET desktop host (WebView2 → ${devUrl})…`);
  const child = spawn(
    'dotnet',
    ['run', '--project', hostProject, '--no-launch-profile', '--', '--dev-url', devUrl],
    { cwd: root, env, stdio: 'inherit', windowsHide: false },
  );
  log(`.NET desktop application started (dotnet run, pid ${child.pid}). Close the app window or press Ctrl+C to stop.`);

  const stop = () => killTree(child.pid);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);
  process.on('exit', stop);

  return await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(err.code === 'ENOENT' ? 'The .NET SDK (dotnet) was not found. Install the .NET 9 SDK.' : String(err));
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      log(`.NET desktop application exited (${signal ?? `code ${code}`}).`);
      resolve(code ?? 0);
    });
  });
}

main().then((code) => process.exit(code));
