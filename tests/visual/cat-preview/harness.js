/* Cat preview harness – runs inside out/index.html (built by build-preview.mjs). Plain browser JS, no dependencies.
 *
 * Query parameters
 *   mode=single      anim, facing=right|left, t=<0…1 fraction of the clip>, size=small|medium|large, bg, debug=1
 *   mode=sheet       anims=a,b,…  frames=8  variants=right:light,left:dark  size  debug=1
 *   mode=transition  pairs=idle>sit,…  at=<fraction of the from-clip at the switch>  times=0,60,…(ms after the switch)
 *   mode=measure     sets window.__result = { anim: {x,y,width,height} } (union over the clip, facing right)
 *   mode=gallery     items=clip:t[:facing[:theme[:size]]],…  cols=4   one frame per item
 *   mode=strip       anim, frames, size: the frames side by side without gaps (a sprite sheet made from the vector cat)
 *   bg=light|dark|checker|none   theme=<CatTheme id>   attentive=1   size=small|medium|large|<scale factor>
 * All animations are paused and seeked with the Web Animations API (the component itself only uses CSS keyframes).
 * The layer switching mirrors CatSprite.play() in cat-sprite.ts.
 */
(() => {
  const q = new URLSearchParams(location.search);
  const SIZES = { small: [112, 84], medium: [160, 120], large: [224, 168] };
  const BGS = { light: '#eef0f3', dark: '#1d2230', checker: 'checker', none: 'transparent', white: '#fff', blue: '#2b5d9c' };
  const stage = document.getElementById('stage');
  let uid = 0;

  const spec = (clip) => CAT_ANIMATIONS[clip];
  const layerKind = (clip) => (typeof CAT_POSE_LAYER !== 'undefined' ? CAT_POSE_LAYER[clip] : 'stand');

  /** size = small|medium|large or a scale factor (contract §7: round(160×s) × round(120×s), at least 16×12). */
  function boxSize(size) {
    if (SIZES[size]) return SIZES[size];
    const s = Number(size) || 1;
    return [Math.max(16, Math.round(160 * s)), Math.max(12, Math.round(120 * s))];
  }

  function makeCat(size, facing, theme = q.get('theme') ?? 'classic') {
    const host = document.createElement('div');
    host.className = 'cat-host' + (facing === 'left' ? ' left' : '') + (q.get('attentive') === '1' ? ' attentive' : '');
    const [w, h] = boxSize(size);
    host.style.width = w + 'px';
    host.style.height = h + 'px';
    for (const [k, v] of Object.entries(catThemeVars(catTheme(theme)))) host.style.setProperty(k, v);
    host.innerHTML = CAT_SVG.replaceAll('__UID__', 'c' + uid++);
    host.__state = { clip: null, active: null };
    return host;
  }

  /** Mirror of CatSprite.play(): pick the target layer, crossfade, restart one-shots. */
  function play(host, clip) {
    const st = host.__state;
    if (st.clip === clip) return;
    const layers = [...host.querySelectorAll('.layer')];
    const kind = layerKind(clip);
    let target;
    if (kind === 'stand') {
      const stands = layers.filter((l) => l.classList.contains('stand'));
      target = stands.find((l) => l !== st.active && !l.classList.contains('on')) ?? stands.find((l) => l !== st.active);
    } else {
      target = layers.find((l) => l.classList.contains(kind));
    }
    if (target.hasAttribute('data-clip')) {
      target.removeAttribute('data-clip');
      getComputedStyle(target).opacity; // flush so every animation of the new clip starts fresh
    }
    target.style.setProperty('--d', spec(clip).durationMs + 'ms');
    target.setAttribute('data-clip', clip);
    for (const l of layers) l.classList.toggle('on', l === target);
    st.clip = clip;
    st.active = target;
  }

  function animationsOf(host) {
    return host.getAnimations({ subtree: true });
  }

  function seekAll(host, ms) {
    for (const a of animationsOf(host)) {
      a.pause();
      a.currentTime = ms;
    }
  }

  function bgStyle(bg) {
    const v = BGS[bg] ?? bg;
    if (v === 'checker') return 'background: repeating-conic-gradient(#d9dce1 0 25%, #f6f7f9 0 50%) 0 0 / 12px 12px';
    return `background:${v}`;
  }

  /** A framed cell (not mirrored) holding the cat host plus optional debug overlays in screen coordinates. */
  function cell(host, { bg, debug, clip, label }) {
    const wrap = document.createElement('div');
    wrap.className = 'cell';
    wrap.setAttribute('style', bgStyle(bg));
    wrap.appendChild(host);
    if (label) {
      const l = document.createElement('div');
      l.className = 'lbl';
      l.textContent = label;
      wrap.appendChild(l);
    }
    if (debug && clip) {
      const hb = spec(clip).hitBox;
      const box = document.createElement('div');
      box.className = 'hitbox';
      const flipped = host.classList.contains('left');
      const x = flipped ? 1 - hb.x - hb.width : hb.x;
      Object.assign(box.style, { left: x * 100 + '%', top: hb.y * 100 + '%', width: hb.width * 100 + '%', height: hb.height * 100 + '%' });
      wrap.appendChild(box);
    }
    return wrap;
  }

  const who = (el) => {
    const parts = [];
    for (let n = el; n && !n.classList?.contains('layer'); n = n.parentElement) if (n.getAttribute && n.getAttribute('class')) parts.unshift(n.getAttribute('class'));
    return parts.slice(-2).join(' > ') || el.tagName;
  };
  function measureVisible(host) {
    const hr = host.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const src = {};
    const on = host.querySelectorAll('.layer.on path, .layer.on ellipse:not(.shadow), .layer.on circle, .layer.on rect, .layer.on text');
    for (const el of on) {
      if (el.closest('defs, .clock, .shadow, clipPath')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let o = 1;
      for (let n = el; n && n !== host; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
      if (o < 0.05) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      // getBoundingClientRect ignores the stroke: inflate by half the stroke width (in screen px)
      const sw = cs.stroke !== 'none' ? (parseFloat(cs.strokeWidth) || 0) / 2 * (hr.width / 160) : 0;
      const r = { left: b.left - sw, top: b.top - sw, right: b.right + sw, bottom: b.bottom + sw };
      if (r.left < x0) { x0 = r.left; src.x = who(el); }
      if (r.top < y0) { y0 = r.top; src.y = who(el); }
      if (r.right > x1) { x1 = r.right; src.x1 = who(el); }
      if (r.bottom > y1) { y1 = r.bottom; src.y1 = who(el); }
    }
    return { x: (x0 - hr.left) / hr.width, y: (y0 - hr.top) / hr.height, x1: (x1 - hr.left) / hr.width, y1: (y1 - hr.top) / hr.height, src };
  }

  function row(label) {
    const r = document.createElement('div');
    r.className = 'row';
    if (label) {
      const h = document.createElement('div');
      h.className = 'rowlbl';
      h.textContent = label;
      r.appendChild(h);
    }
    stage.appendChild(r);
    return r;
  }

  const size = q.get('size') ?? 'medium';
  const mode = q.get('mode') ?? 'single';
  const debug = q.get('debug') === '1';
  const all = typeof CAT_ANIMATION_NAMES !== 'undefined' ? [...CAT_ANIMATION_NAMES] : Object.keys(CAT_ANIMATIONS);

  if (mode === 'single') {
    const clip = q.get('anim') ?? 'idle';
    const host = makeCat(size, q.get('facing') ?? 'right');
    stage.appendChild(cell(host, { bg: q.get('bg') ?? 'checker', debug, clip }));
    play(host, clip);
    seekAll(host, Number(q.get('t') ?? 0) * spec(clip).durationMs);
  } else if (mode === 'sheet') {
    const anims = (q.get('anims') ?? all.join(',')).split(',');
    const frames = Number(q.get('frames') ?? 8);
    const variants = (q.get('variants') ?? 'right:light,left:dark').split(',');
    for (const clip of anims) {
      for (const v of variants) {
        const [facing, bg] = v.split(':');
        const r = row(`${clip}  ${facing} / ${bg}  (${spec(clip).durationMs} ms${spec(clip).loop ? ', loop' : ''})`);
        for (let i = 0; i < frames; i++) {
          const f = spec(clip).loop ? i / frames : i / (frames - 1);
          const host = makeCat(size, facing);
          r.appendChild(cell(host, { bg, debug, clip, label: f.toFixed(2) }));
          play(host, clip);
          seekAll(host, Math.min(f * spec(clip).durationMs, spec(clip).durationMs - 1));
        }
      }
    }
  } else if (mode === 'gallery') {
    // items=idle:0,walk:0.3,…  one frame each, several per row
    const items = (q.get('items') ?? all.map((a) => a + ':0.3').join(',')).split(',');
    const perRow = Number(q.get('cols') ?? 4);
    let r;
    items.forEach((it, i) => {
      const [clip, f = '0.3', facing = 'right', theme = q.get('theme') ?? 'classic', itemSize = size] = it.split(':');
      if (i % perRow === 0) r = row('');
      const host = makeCat(itemSize, facing, theme);
      r.appendChild(cell(host, { bg: q.get('bg') ?? 'white', debug, clip, label: `${clip} ${f}${theme !== 'classic' ? ' ' + theme : ''}` }));
      play(host, clip);
      seekAll(host, Math.min(Number(f) * spec(clip).durationMs, spec(clip).durationMs - 1));
    });
  } else if (mode === 'strip') {
    // a sprite sheet made from the vector cat: frames side by side, no gaps, transparent (used by component-test.mjs)
    const clip = q.get('anim') ?? 'walk';
    const frames = Number(q.get('frames') ?? 8);
    const r = document.createElement('div');
    r.style.display = 'flex';
    stage.appendChild(r);
    for (let i = 0; i < frames; i++) {
      const f = spec(clip).loop ? i / frames : i / (frames - 1);
      const host = makeCat(size, 'right');
      r.appendChild(host);
      play(host, clip);
      seekAll(host, Math.min(f * spec(clip).durationMs, spec(clip).durationMs - 1));
    }
  } else if (mode === 'transition') {
    const pairs = (q.get('pairs') ?? 'idle>sit,sit>idle,idle>sleep,sleep>idle,walk>idle,idle>walk,idle>dragged,dragged>idle').split(',');
    const at = Number(q.get('at') ?? 0.4);
    const times = (q.get('times') ?? '0,40,80,120,160,200,260,320,400').split(',').map(Number);
    const bg = q.get('bg') ?? 'light';
    for (const pair of pairs) {
      const [from, to] = pair.split('>');
      const r = row(`${from} → ${to}`);
      for (const t of times) {
        const host = makeCat(size, q.get('facing') ?? 'right');
        r.appendChild(cell(host, { bg, label: `+${t}ms` }));
        play(host, from);
        const fromAt = at * spec(from).durationMs;
        seekAll(host, fromAt);
        const before = new Set(animationsOf(host));
        getComputedStyle(host.querySelector('.layer.on')).opacity;
        play(host, to);
        for (const a of animationsOf(host)) {
          a.pause();
          a.currentTime = before.has(a) ? fromAt + t : t;
        }
      }
    }
  } else if (mode === 'measure') {
    const result = {};
    const steps = Number(q.get('steps') ?? 40);
    for (const clip of all) {
      const host = makeCat('medium', 'right');
      stage.appendChild(cell(host, { bg: 'none' }));
      play(host, clip);
      let u = { x: Infinity, y: Infinity, x1: -Infinity, y1: -Infinity };
      const at = {};
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        seekAll(host, Math.min(f * spec(clip).durationMs, spec(clip).durationMs - 1));
        const b = measureVisible(host);
        for (const k of ['x', 'y']) if (b[k] < u[k]) { u[k] = b[k]; at[k] = f.toFixed(2) + ' ' + b.src[k]; }
        for (const k of ['x1', 'y1']) if (b[k] > u[k]) { u[k] = b[k]; at[k] = f.toFixed(2) + ' ' + b.src[k]; }
      }
      const round = (v) => Math.round(v * 1000) / 1000;
      result[clip] = { x: round(u.x), y: round(u.y), width: round(u.x1 - u.x), height: round(u.y1 - u.y), hitBox: spec(clip).hitBox, at };
    }
    window.__result = result;
  }

  const r = stage.getBoundingClientRect();
  window.__size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  window.__cssBytes = CAT_CSS_BYTES;
  window.__ready = true;
})();
