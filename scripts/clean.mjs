// Removes every build output of the repository (Angular dist and cache, .NET bin/obj, installer output, visual test
// renders). Installed dependencies stay; pass --all to also remove node_modules (root and cat-desktop), the downloaded
// installer tools and the dev data folder (.dev-data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');

const targets = [
  'cat-desktop/dist',
  'cat-desktop/.angular',
  'Desktop/CatDesktop.Host/bin',
  'Desktop/CatDesktop.Host/obj',
  'Installer/output',
  'tests/visual/cat-preview/out',
];
if (all) targets.push('node_modules', 'cat-desktop/node_modules', 'Installer/tools', 'Installer/redist', '.dev-data');

let failed = 0;
for (const rel of targets) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  try {
    fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    console.log(`[clean] removed ${rel}`);
  } catch (err) {
    failed++;
    console.error(`[clean] could not remove ${rel}: ${err.code ?? err.message} (is CatDesktop or a build still running?)`);
  }
}
if (!all) console.log('[clean] kept node_modules and the installer tools (use "npm run clean -- --all" to remove them too).');
process.exit(failed ? 1 : 0);
