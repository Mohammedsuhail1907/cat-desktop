#!/usr/bin/env node
/**
 * Runtime test of the real CatSprite Angular component (not the static preview): builds component-test/main.ts with
 * the app's own Angular CLI, serves it on 127.0.0.1 and drives it in headless Chrome over CDP.
 *
 *   node tests/visual/cat-preview/component-test.mjs [--no-build]
 *
 * Checks: first clip shown without fade, `finished` timing for one-shots, no `finished` for a clip that was switched
 * away from, `rate` (playbackRate, phase kept on change), `paused`, restart of a one-shot that is still fading out,
 * facing / gaze host bindings, clean-up of hidden layers, and the sprite skin (manifest + sheets rendered from the
 * vector cat, served only from out/). Screenshots: out/component-vector.png, out/component-sprites.png.
 * Exit code = number of failed checks.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPreview } from './build-preview.mjs';
import { startChrome } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../../../cat-desktop');
const OUT = path.join(HERE, 'out');
const SITE = path.join(OUT, 'component-test', 'browser');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  – ' + detail : ''}`);
};

function build() {
  const rel = (p) => path.relative(APP, path.join(HERE, p)).replaceAll('\\', '/');
  const r = spawnSync('npx', ['ng', 'build', '--configuration', 'development',
    '--browser', rel('component-test/main.ts'), '--ts-config', rel('component-test/tsconfig.json'),
    '--index', rel('component-test/index.html'), '--output-path', rel('out/component-test')],
  { cwd: APP, shell: true, encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(r.stdout, r.stderr);
    throw new Error('ng build of the component test failed');
  }
}

function serve(root) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.map': 'application/json' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function open(cdp, url, metrics) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: false, ...metrics });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  for (let i = 0; i < 100; i++) {
    if (await cdp.eval('!!window.catTest')) return;
    await sleep(50);
  }
  throw new Error('test host did not start: ' + url);
}

async function screenshot(cdp, name, width, height) {
  await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, 30_000);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`      ${path.relative(process.cwd(), file)}`);
}

/** Helpers installed into the test page. */
const PAGE_HELPERS = `
  window.T = window.catTest;
  window.set = (k, v) => T.host[k].set(v);
  window.wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.sprite = () => document.querySelector('app-cat-sprite');
  window.activeLayer = () => sprite().querySelector('svg .layer.on');
  window.finishedAfter = async (clip, from, timeout) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const e = T.events.slice(from).find((x) => x.clip === clip);
      if (e) return e.t;
      await wait(5);
    }
    return null;
  };
  true;
`;

async function vectorChecks(cdp) {
  await cdp.eval(PAGE_HELPERS);
  let r = await cdp.eval(`(async () => { await frame(); const l = activeLayer(); return { clip: l?.getAttribute('data-clip'), d: l?.style.getPropertyValue('--d'), op: l && getComputedStyle(l).opacity }; })()`);
  check('initial clip idle is on screen at once (no fade-in)', r.clip === 'idle' && r.d === '4000ms' && r.op === '1', JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    await wait(300); const i = T.events.length; const t0 = performance.now(); set('animation', 'jump');
    const t = await finishedAfter('jump', i, 3000); return t && Math.round(t - t0); })()`);
  check('jump emits finished after ≈ 900 ms', r !== null && r >= 850 && r <= 1250, `${r} ms`);

  r = await cdp.eval(`(async () => {
    set('animation', 'idle'); await wait(400); const i = T.events.length;
    set('animation', 'stretch'); await wait(500); set('animation', 'idle'); await wait(2700);
    return T.events.slice(i).map((e) => e.clip); })()`);
  check('a one-shot switched away from never emits finished', r.length === 0, JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('rate', 2); await wait(400); const i = T.events.length; const t0 = performance.now(); set('animation', 'jump');
    const t = await finishedAfter('jump', i, 3000); set('rate', 1); set('animation', 'idle'); return t && Math.round(t - t0); })()`);
  check('rate 2 halves the one-shot (jump ≈ 450 ms)', r !== null && r >= 400 && r <= 700, `${r} ms`);

  r = await cdp.eval(`(async () => {
    await wait(400); const i = T.events.length; const t0 = performance.now(); set('animation', 'happy');
    await wait(300); set('paused', true); await frame();
    const state = sprite().classList.contains('paused') && activeLayer().querySelector('.clock').getAnimations()[0]?.playState;
    await wait(1000); const early = T.events.length - i; set('paused', false);
    const t = await finishedAfter('happy', i, 4000); return { state, early, total: t && Math.round(t - t0) }; })()`);
  check('paused freezes the clip (no finished while paused, then 1400 ms + pause)', r.state === 'paused' && r.early === 0 && r.total >= 2300 && r.total <= 2800, JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('animation', 'idle'); await wait(400); set('animation', 'walk'); await wait(330); await frame();
    const a = activeLayer().querySelector('.near .hu').getAnimations()[0];
    const p0 = a.effect.getComputedTiming().progress; set('rate', 2.5); await frame();
    const p1 = a.effect.getComputedTiming().progress; const rate = a.playbackRate; const same = activeLayer().querySelector('.near .hu').getAnimations()[0] === a;
    await wait(200); const p2 = a.effect.getComputedTiming().progress; set('rate', 1); await frame();
    return { p0: +p0.toFixed(3), p1: +p1.toFixed(3), p2: +p2.toFixed(3), rate, same }; })()`);
  const jump = Math.abs(r.p1 - r.p0);
  // one or two frames pass at the new rate before the second read (≈ 35 ms × 2.5 of a 520 ms cycle)
  check('changing rate keeps the walk phase (no restart) and speeds it up', r.same && r.rate === 2.5 && Math.min(jump, 1 - jump) < 0.3, JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('animation', 'idle'); await wait(500); const i = T.events.length;
    set('animation', 'jump'); await wait(200); set('animation', 'idle'); await wait(100);
    const t0 = performance.now(); set('animation', 'jump');
    const t = await finishedAfter('jump', i, 3000); await wait(600);
    return { after: t && Math.round(t - t0), count: T.events.slice(i).filter((e) => e.clip === 'jump').length }; })()`);
  check('a one-shot replayed while its layer is still fading restarts from the beginning', r.after >= 850 && r.after <= 1250 && r.count === 1, JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('animation', 'sit'); await wait(900);
    const layers = [...sprite().querySelectorAll('svg > .layer')].map((l) => l.getAttribute('data-clip')).filter(Boolean);
    return layers; })()`);
  check('after the crossfade only the visible layer keeps a clip (hidden layers stop animating)', r.length === 1 && r[0] === 'sit', JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('gaze', { x: 1, y: -0.5 }); set('facing', 'right'); await frame();
    const cs = () => getComputedStyle(sprite());
    const right = { gx: cs().getPropertyValue('--gx').trim(), gy: cs().getPropertyValue('--gy').trim() };
    set('facing', 'left'); await frame(); await wait(250);
    const left = { gx: cs().getPropertyValue('--gx').trim(), cls: sprite().classList.contains('left'), tf: cs().transform };
    set('facing', 'right'); set('gaze', null); await frame();
    return { right, left, reset: cs().getPropertyValue('--gx').trim() }; })()`);
  check('facing left mirrors the host and gaze x is flipped into the authored frame', r.right.gx === '1' && r.right.gy === '-0.5' && r.left.gx === '-1' && r.left.cls && r.left.tf.startsWith('matrix(-1') && r.reset === '0', JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    const out = {};
    for (const clip of ['yawn', 'land', 'interact']) {
      set('animation', 'idle'); await wait(450); const i = T.events.length; const t0 = performance.now(); set('animation', clip);
      const t = await finishedAfter(clip, i, 4000); out[clip] = t && Math.round(t - t0);
    }
    set('animation', 'idle'); return out; })()`);
  check('new one-shots emit finished on time (yawn 1800, land 620, interact 1700 ms)', r.yawn >= 1750 && r.yawn <= 2150 && r.land >= 580 && r.land <= 950 && r.interact >= 1650 && r.interact <= 2050, JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('animation', 'walk'); await wait(500); await frame();
    const layer = activeLayer(); const anim = layer.querySelector('.near .hu').getAnimations()[0]; const p0 = anim.effect.getComputedTiming().progress;
    set('theme', 'black'); await frame();
    const cs = getComputedStyle(sprite());
    const after = { theme: sprite().getAttribute('data-theme'), fur: cs.getPropertyValue('--cat-fur').trim(), eye: cs.getPropertyValue('--cat-eye').trim(),
      stripes: cs.getPropertyValue('--cat-stripes').trim(), sameLayer: activeLayer() === layer, sameAnim: layer.querySelector('.near .hu').getAnimations()[0] === anim,
      state: anim.playState, dp: +(anim.effect.getComputedTiming().progress - p0).toFixed(2) };
    set('theme', 'no-such-theme'); await frame();
    after.unknown = sprite().getAttribute('data-theme');
    set('theme', 'cream'); await frame();
    after.cream = { paw: getComputedStyle(sprite()).getPropertyValue('--cat-paw').trim(), mask: getComputedStyle(sprite()).getPropertyValue('--cat-mask-op').trim() };
    set('theme', 'classic'); await frame();
    after.back = { paw: getComputedStyle(sprite()).getPropertyValue('--cat-paw').trim().slice(0, 9), mask: getComputedStyle(sprite()).getPropertyValue('--cat-mask-op').trim() };
    return after; })()`);
  check('theme switch is live: colours change, the running clip keeps its layer and animations', r.theme === 'black' && r.fur === '#2c2b34' && r.eye === '#f5c33b' && r.stripes === '0' && r.sameLayer && r.sameAnim && r.state === 'running', JSON.stringify(r));
  check('unknown theme ids draw as classic; point colours are set and removed again', r.unknown === 'classic' && r.cream.paw === '#a97f59' && r.cream.mask === '0.85' && r.back.mask === '0' && r.back.paw.startsWith('color-mix'), JSON.stringify({ unknown: r.unknown, cream: r.cream, back: r.back }));

  r = await cdp.eval(`(async () => {
    set('animation', 'idle'); await wait(400); set('attentive', true); await frame(); await wait(400);
    const on = { cls: sprite().classList.contains('attentive'), eyes: getComputedStyle(activeLayer().querySelector('.en .eyew')).scale,
      ear: getComputedStyle(activeLayer().querySelector('.ear-n .earp')).rotate, tip: activeLayer().querySelector('.tip').getAnimations().length };
    set('attentive', false); await frame(); await wait(400);
    const off = { cls: sprite().classList.contains('attentive'), eyes: getComputedStyle(activeLayer().querySelector('.en .eyew')).scale,
      tip: activeLayer().querySelector('.tip').getAnimations().length };
    return { on, off }; })()`);
  check('attentive perks the ears, widens the eyes and twitches the tail tip; off restores', r.on.cls && r.on.eyes === '1.08' && r.on.ear === '5deg' && r.on.tip === 1 && !r.off.cls && r.off.eyes === 'none' && r.off.tip === 0, JSON.stringify(r));

  // main-thread cost of a walking cat (software rendering, no GPU): busy time per second of animation
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  for (const [clip, paused] of [['walk', false], ['idle', false], ['sit', false], ['sleep', false], ['walk', true]]) {
    await cdp.eval(`(async () => { set('facing', 'right'); set('paused', ${paused}); set('animation', '${clip}'); await wait(700); })()`);
    const m0 = await metric();
    await sleep(3000);
    const m1 = await metric();
    const per = (k) => (((m1[k] - m0[k]) / (m1.Timestamp - m0.Timestamp)) * 1000).toFixed(1);
    console.log(`INFO  ${clip}${paused ? ' (paused)' : ''}: main thread per second: task ${per('TaskDuration')} ms, style ${per('RecalcStyleDuration')} ms, layout ${per('LayoutDuration')} ms`);
  }
  await cdp.eval(`set('paused', false)`);
  await cdp.send('Performance.disable');

  // screenshots of a few clips (component, not preview)
  for (const [clip, facing] of [['walk', 'right'], ['sit', 'left']]) {
    await cdp.eval(`(async () => { set('facing', '${facing}'); set('animation', '${clip}'); await wait(700); })()`);
    await screenshot(cdp, `component-vector-${clip}.png`, 160, 120);
  }
}

async function spriteChecks(cdp) {
  await cdp.eval(PAGE_HELPERS);
  let r = await cdp.eval(`(async () => {
    set('animation', 'walk'); await wait(300); await frame();
    const sheet = sprite().querySelector('.sprite .sheet');
    const vec = sprite().querySelector('.vector');
    return { sheet: !!sheet, bg: sheet && getComputedStyle(sheet).backgroundImage, dur: sheet && getComputedStyle(sheet).animationDuration,
      steps: sheet && getComputedStyle(sheet).animationTimingFunction, vectorOff: vec.classList.contains('off'), width: sheet && sheet.style.width }; })()`);
  check('sprite skin: walk plays from walk/walk.png as a steps() strip, vector hidden', r.sheet && /assets\/cat\/walk\/walk\.png/.test(r.bg) && r.dur === '0.52s' && /steps\(8/.test(r.steps) && r.vectorOff && r.width === '800%', JSON.stringify(r));
  await screenshot(cdp, 'component-sprites-walk.png', 160, 120);

  r = await cdp.eval(`(async () => {
    const i = T.events.length; const t0 = performance.now(); set('animation', 'jump');
    const t = await finishedAfter('jump', i, 3000); return t && Math.round(t - t0); })()`);
  check('sprite skin: one-shot sheet emits finished (9 frames @ 10 fps)', r !== null && r >= 850 && r <= 1250, `${r} ms`);

  r = await cdp.eval(`(async () => {
    set('animation', 'sit'); await wait(500); await frame();
    return { sheet: !!sprite().querySelector('.sprite .sheet'), vectorOff: sprite().querySelector('.vector').classList.contains('off'), clip: activeLayer()?.getAttribute('data-clip') }; })()`);
  check('sprite skin: animations missing from the manifest fall back to the vector cat', !r.sheet && !r.vectorOff && r.clip === 'sit', JSON.stringify(r));

  r = await cdp.eval(`(async () => {
    set('animation', 'walk'); set('theme', 'pink'); await wait(400); await frame();
    const bg = getComputedStyle(sprite().querySelector('.sprite .sheet')).backgroundImage;
    set('theme', 'classic'); await wait(400); await frame();
    const bg2 = getComputedStyle(sprite().querySelector('.sprite .sheet')).backgroundImage;
    return { pink: bg, classic: bg2 }; })()`);
  check('per-theme skin: theme.manifest.json of the theme wins, other themes use the global manifest', r.pink.includes('themes/pink/walk.png') && r.classic.includes('assets/cat/walk/walk.png'), JSON.stringify(r));
}

async function renderSheet(cdp, anim, frames, theme = 'classic') {
  const url = pathToFileURL(path.join(OUT, 'index.html')).href + `?mode=strip&anim=${anim}&frames=${frames}&size=medium&theme=${theme}`;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 160 * frames, height: 120, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await cdp.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))');
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 160 * frames, height: 120, scale: 1 } }, 30_000);
  return Buffer.from(r.data, 'base64');
}

async function main() {
  if (!process.argv.includes('--no-build')) build();
  buildPreview();
  const server = await serve(SITE);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const { cdp, stop } = await startChrome();
  const manifest = path.join(SITE, 'assets', 'cat', 'cat.manifest.json');
  const original = fs.readFileSync(manifest, 'utf8');
  try {
    console.log('— vector skin');
    await open(cdp, base, { width: 160, height: 120, deviceScaleFactor: 2 });
    await vectorChecks(cdp);

    console.log('— sprite skin (sheets rendered from the vector cat, written to out/ only)');
    fs.writeFileSync(path.join(SITE, 'assets', 'cat', 'walk', 'walk.png'), await renderSheet(cdp, 'walk', 8));
    fs.writeFileSync(path.join(SITE, 'assets', 'cat', 'jump', 'jump.png'), await renderSheet(cdp, 'jump', 9));
    // a theme-only skin: pink gets its own sheets, every other theme keeps the global manifest
    const pinkDir = path.join(SITE, 'assets', 'cat', 'themes', 'pink');
    fs.writeFileSync(path.join(pinkDir, 'walk.png'), await renderSheet(cdp, 'walk', 8, 'pink'));
    fs.writeFileSync(path.join(pinkDir, 'theme.manifest.json'), JSON.stringify({
      skin: 'sprites', animations: { walk: { sheet: 'walk.png', frames: 8, frameWidth: 160, frameHeight: 120, fps: 10 } },
    }));
    fs.writeFileSync(manifest, JSON.stringify({
      skin: 'sprites',
      themeSkins: ['pink'],
      animations: {
        walk: { sheet: 'walk/walk.png', frames: 8, frameWidth: 160, frameHeight: 120, fps: 10, loop: true },
        jump: { sheet: 'jump/jump.png', frames: 9, frameWidth: 160, frameHeight: 120, fps: 10, loop: false },
      },
    }, null, 2));
    await open(cdp, base, { width: 160, height: 120, deviceScaleFactor: 2 });
    await spriteChecks(cdp);
  } finally {
    fs.writeFileSync(manifest, original);
    for (const f of ['theme.manifest.json', 'walk.png']) fs.rmSync(path.join(SITE, 'assets', 'cat', 'themes', 'pink', f), { force: true });
    await stop();
    server.close();
  }
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures);
}

main().catch((e) => { console.error(e); process.exit(99); });
