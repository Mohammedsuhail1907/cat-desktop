#!/usr/bin/env node
/**
 * Builds tests/visual/cat-preview/out/index.html: a standalone page (no Angular) that contains exactly the SVG markup and
 * the CSS of the CatSprite component, generated from the component files so the preview can never drift from them.
 *
 *   node tests/visual/cat-preview/build-preview.mjs
 *
 * What it does with the component sources:
 *   cat-sprite.html  the vector <svg class="cat"> is taken as is; the few Angular constructs it uses are expanded
 *                    statically: <ng-template #x> + <ng-container *ngTemplateOutlet="x" />, the stand-slot @for,
 *                    [attr.data-slot]="slot" and the per-instance paint ids ([attr.id]="ids.x", [attr.fill]="paint.x",
 *                    [attr.clip-path]="paint.x", [attr.href]="refs.x"). Anything else Angular-ish is an error.
 *   cat-sprite.scss  compiled with the app's own sass; :host becomes .cat-host.
 *   cat-art.ts,      transpiled with the app's own esbuild (CAT_ANIMATIONS, CAT_POSE_LAYER, CAT_THEMES,
 *   cat-themes.ts    catThemeVars …), so the preview applies themes exactly like the component.
 * The page logic lives in harness.js (seeking, contact sheets, transitions, hit-box overlay, measuring).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const APP = path.join(REPO, 'cat-desktop');
const SPRITE_DIR = path.join(APP, 'src', 'app', 'cat-companion', 'components', 'cat-sprite');
const OUT = path.join(HERE, 'out');

const requireApp = createRequire(path.join(APP, 'package.json'));
const sass = requireApp('sass');
const esbuild = requireApp('esbuild');

export function buildPreview() {
  const html = fs.readFileSync(path.join(SPRITE_DIR, 'cat-sprite.html'), 'utf8');
  const scss = fs.readFileSync(path.join(SPRITE_DIR, 'cat-sprite.scss'), 'utf8');
  const artTs = fs.readFileSync(path.join(SPRITE_DIR, 'cat-art.ts'), 'utf8');
  const themesTs = fs.readFileSync(path.join(SPRITE_DIR, 'cat-themes.ts'), 'utf8');

  const svg = expandSvg(extractVectorSvg(html));
  const css = hostToClass(sass.compileString(scss, { style: 'expanded', loadPaths: [SPRITE_DIR] }).css);
  const toJs = (ts) => esbuild.transformSync(ts, { loader: 'ts', format: 'esm', target: 'es2022' }).code
    .replace(/^export\s+/gm, '');
  const artJs = toJs(artTs) + '\n' + toJs(themesTs);
  const harness = fs.readFileSync(path.join(HERE, 'harness.js'), 'utf8');

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cat preview</title>
<style>
${css}
</style>
<style>
${fs.readFileSync(path.join(HERE, 'harness.css'), 'utf8')}
</style>
</head>
<body>
<div id="stage"></div>
<script>
window.addEventListener('error', (e) => { window.__err = String(e.message || e); });
</script>
<script>
${artJs}
const CAT_SVG = ${JSON.stringify(svg)};
const CAT_CSS_BYTES = ${Buffer.byteLength(css)};
${harness}
</script>
</body>
</html>
`;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'index.html');
  fs.writeFileSync(file, page);
  return { file, cssBytes: Buffer.byteLength(css), svgBytes: Buffer.byteLength(svg) };
}

/** The vector cat is the first <svg class="cat" …> … </svg> of the template. */
function extractVectorSvg(html) {
  const start = html.search(/<svg\b[^>]*class="cat"/);
  if (start < 0) throw new Error('cat-sprite.html: <svg class="cat"> not found');
  const end = html.indexOf('</svg>', start);
  if (end < 0) throw new Error('cat-sprite.html: </svg> not found');
  return html.slice(start, end + '</svg>'.length);
}

function expandSvg(svg) {
  // 1. ng-templates: collect and remove, then inline every outlet.
  const templates = new Map();
  svg = svg.replace(/<ng-template #([\w-]+)>([\s\S]*?)<\/ng-template>/g, (_, name, body) => {
    templates.set(name, body);
    return '';
  });
  svg = svg.replace(/<ng-container \*ngTemplateOutlet="([\w-]+)"\s*(?:\/>|><\/ng-container>)/g, (_, name) => {
    if (!templates.has(name)) throw new Error(`unknown ng-template #${name}`);
    return templates.get(name);
  });

  // 2. @for (slot of standSlots; track slot) { … } → one copy per slot.
  svg = expandFor(svg, 'standSlots', ['a', 'b']);

  // 3. per-instance paint ids.
  svg = svg
    .replace(/\[attr\.id\]="ids\.(\w+)"/g, 'id="__UID__-$1"')
    .replace(/\[attr\.href\]="refs\.(\w+)"/g, 'href="#__UID__-$1"')
    .replace(/\[attr\.([\w-]+)\]="paint\.(\w+)"/g, '$1="url(#__UID__-$2)"');

  // 4. strip comments, collapse whitespace between tags.
  svg = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim();

  const leftover = svg.match(/\[[\w.-]+\]=|\([\w.-]+\)=|\*ng\w+|@(?:for|if|switch)\b|\{\{/);
  if (leftover) throw new Error(`unexpanded Angular syntax in the vector svg: '${leftover[0]}'`);
  return svg;
}

function expandFor(svg, list, values) {
  const head = new RegExp(`@for \\(slot of ${list}; track slot\\) \\{`);
  const m = head.exec(svg);
  if (!m) return svg;
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < svg.length && depth > 0; i++) {
    if (svg[i] === '{') depth++;
    else if (svg[i] === '}') depth--;
  }
  const body = svg.slice(m.index + m[0].length, i - 1);
  const copies = values.map((v) => body.replace(/\[attr\.data-slot\]="slot"/g, `data-slot="${v}"`)).join('');
  return expandFor(svg.slice(0, m.index) + copies + svg.slice(i), list, values);
}

/** :host → .cat-host, :host(.x) → .cat-host.x */
function hostToClass(css) {
  return css.replace(/:host\(([^)]*)\)/g, '.cat-host$1').replace(/:host\b/g, '.cat-host');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildPreview();
  console.log(`wrote ${path.relative(REPO, r.file)}  (css ${r.cssBytes} B, svg ${r.svgBytes} B)`);
}
