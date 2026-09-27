#!/usr/bin/env node
/**
 * Renders the cat preview (out/index.html, rebuilt from the component files first) with headless Chrome over the
 * Chrome DevTools Protocol and saves transparent PNGs under tests/visual/cat-preview/out/.
 *
 *   node tests/visual/cat-preview/render.mjs sheets [a,b,…]   contact sheets: 8 frames per clip, right/light + left/dark
 *   node tests/visual/cat-preview/render.mjs transitions [p]   crossfade frames for idle>sit, sit>idle, idle>sleep, …
 *   node tests/visual/cat-preview/render.mjs measure           union bounding box per clip vs. CAT_ANIMATIONS.hitBox
 *   node tests/visual/cat-preview/render.mjs shot <name> "<query>" [--scale 3]
 *   node tests/visual/cat-preview/render.mjs all
 *   options: --port   talk CDP over --remote-debugging-port instead of --remote-debugging-pipe
 *            --reduced-motion  emulate prefers-reduced-motion: reduce
 *            DEBUG=1  draw the CAT_ANIMATIONS hit boxes on the contact sheets
 *
 * Plain Node 22 (global fetch + WebSocket), no npm packages. Starts its own headless Chrome with a temporary profile and
 * kills it (whole process tree) and deletes the profile at the end.
 * CDP over --remote-debugging-pipe by default (see cdp.mjs for why).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPreview } from './build-preview.mjs';
import { startChrome } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const ALL = ['idle', 'walk', 'run', 'sit', 'sleep', 'jump', 'stretch', 'look', 'happy', 'surprised', 'dragged', 'yawn', 'land', 'interact'];

// ------------------------------------------------------------------------------------------------ jobs
let nonce = 0;
async function load(cdp, query, metrics = { width: 1600, height: 1200, deviceScaleFactor: 1 }) {
  const n = String(++nonce);
  const url = pathToFileURL(path.join(OUT, 'index.html')).href + '?' + query + '&n=' + n;
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, mobile: false });
  // wait for the load event instead of polling (a burst of Runtime.evaluate calls is what security tools look for)
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const st = await cdp.eval(`new URLSearchParams(location.search).get('n') === '${n}' ? (window.__err ? 'error: ' + window.__err : window.__ready === true ? 'ready' : 'wait') : 'nav'`);
  if (st !== 'ready') throw new Error(`page ${st} (${query})`);
}

async function shot(cdp, name, query, scale = 1) {
  await load(cdp, query);
  const { width, height } = await cdp.eval('window.__size');
  await load(cdp, query, { width, height, deviceScaleFactor: scale }); // reload at the final size so the layout is exact
  // The page is static (every animation is paused), and a capture requested before the first frames are out can wait
  // forever for a new frame. Let two frames pass, then capture; if it still stalls, nudge a repaint and try again.
  let r;
  for (let attempt = 1; !r; attempt++) {
    await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))');
    try {
      r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, 6_000);
    } catch (e) {
      if (attempt >= 5) throw e;
      await cdp.eval(`document.body.style.background = ${attempt % 2 ? "'rgba(0,0,0,0.004)'" : "''"}`);
    }
  }
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`  ${path.relative(process.cwd(), file)}  ${width}x${height}@${scale}`);
  return file;
}

async function main() {
  const argv = process.argv.slice(2);
  const usePort = argv.includes('--port');
  const reduced = argv.includes('--reduced-motion');
  const scaleIdx = argv.indexOf('--scale');
  const scale = scaleIdx >= 0 ? Number(argv[scaleIdx + 1]) : undefined;
  const [job = 'all', ...args] = argv.filter((a, i) => a !== '--port' && a !== '--no-build' && a !== '--reduced-motion' && i !== scaleIdx && (scaleIdx < 0 || i !== scaleIdx + 1));

  if (!argv.includes('--no-build')) {
    const built = buildPreview();
    console.log(`preview built (component css ${built.cssBytes} B)`);
  }
  const { cdp, stop } = await startChrome({ usePort });
  if (reduced) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    if (job === 'shot') {
      await shot(cdp, args[0], args[1] ?? '', scale ?? 3);
    }
    if (job === 'sheets' || job === 'all') {
      const anims = args[0] ? args[0].split(',') : ALL;
      for (const a of anims) {
        await shot(cdp, `sheet-${a}`, `mode=sheet&anims=${a}&frames=8&variants=right:light,left:dark&debug=${process.env.DEBUG ? 1 : 0}`, scale ?? 1.5);
      }
    }
    if (job === 'transitions' || job === 'all') {
      await shot(cdp, 'transitions', `mode=transition${job === 'transitions' && args[0] ? '&pairs=' + args[0] : ''}`, scale ?? 1);
    }
    if (job === 'measure' || job === 'all') {
      await load(cdp, 'mode=measure');
      const res = await cdp.eval('window.__result');
      for (const [k, v] of Object.entries(res)) {
        const hb = v.hitBox;
        const inside = v.x >= hb.x - 1e-3 && v.y >= hb.y - 1e-3 && v.x + v.width <= hb.x + hb.width + 1e-3 && v.y + v.height <= hb.y + hb.height + 1e-3;
        console.log(`${k.padEnd(10)} drawn x ${v.x.toFixed(3)}…${(v.x + v.width).toFixed(3)}  y ${v.y.toFixed(3)}…${(v.y + v.height).toFixed(3)}   hitBox x ${hb.x}…${(hb.x + hb.width).toFixed(3)} y ${hb.y}…${(hb.y + hb.height).toFixed(3)}  ${inside ? 'OK' : 'NOT CONTAINED'}`);
        if (process.env.DETAIL) console.log('           ', JSON.stringify(v.at));
      }
    }
  } finally {
    await stop();
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
