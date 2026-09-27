#!/usr/bin/env node
/**
 * Generates the leg / body keyframes of the standing cat rig (CatSprite) with inverse kinematics, so paws stay planted
 * on the floor line while the body moves (no foot sliding in walk / run, no floating paws in crouches and stretches).
 *
 *   node tests/visual/cat-preview/gen-rig.mjs          rewrites the generated block (between the gen-rig marker lines)
 *                                                       in cat-sprite.scss and prints the stride per clip
 *
 * The rig constants below must match the joint positions of the artwork in cat-sprite.html (rest positions of the
 * shoulder, elbow, wrist, hip, knee and ankle, and the sole point of each paw = front of the pads, so heel-lift rotates
 * the paw about its toes). Coordinates are SVG user units of the 160×120 viewBox, facing right, floor at y = 118.
 *
 * Only the rig (translate / rotate about the floor point), the body (translate / rotate about its centre), the head
 * and the six leg joints are generated; faces, ears, tail and squash-and-stretch are animated by hand in the SCSS.
 * CSS interpolates every track linearly between keyframes, so keyframes are placed adaptively: wherever linear
 * interpolation would let a planted paw drift by more than TOL (or the body deviate by more than LOOSE × TOL).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCSS = path.resolve(HERE, '../../../cat-desktop/src/app/cat-companion/components/cat-sprite/cat-sprite.scss');

// ------------------------------------------------------------------------------------------------ rig
const FLOOR = 118;
const M = [80, 88]; // .body pivot
const RIG_O = [80, 118]; // .rig pivot (floor between the paws)
const HEAD_O = [104, 76]; // .head pivot (neck)
const FORE = { top: [99.5, 86.5], mid: [99.8, 99.5], low: [101, 110.5], sole: [106, 118], bend: +1 };
const HIND = { top: [66, 88], mid: [67.5, 99], low: [65, 110.5], sole: [70, 118], bend: -1 };
const FAR = { fore: [-3.5, -1.2], hind: [3.5, -1.2] };
const BOX_W = 160;

// ------------------------------------------------------------------------------------------------ 2D affine helpers
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const tr = (x, y) => [1, 0, 0, 1, x, y];
const rot = (deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
/** CSS: transform-origin O, translate (x,y), rotate r  →  T(O)·T(x,y)·R(r)·T(-O) */
const css = (o, x = 0, y = 0, r = 0) => mul(mul(tr(o[0] + x, o[1] + y), rot(r)), tr(-o[0], -o[1]));
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
const angOf = (m) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const deg = (v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
const norm = (a) => { while (a > 180) a -= 360; while (a <= -180) a += 360; return a; };
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// ------------------------------------------------------------------------------------------------ IK
/** Solve one leg in the frame `parent` for a world target { sole, ang } (ang = world paw angle, 0 = as authored). */
function solveLeg(L, parent, target) {
  const pInv = inv(parent);
  const soleL = apply(pInv, target.sole);
  const angL = target.ang - angOf(parent);
  const lowT = sub(soleL, apply(rot(angL), sub(L.sole, L.low)));
  const L1 = len(sub(L.mid, L.top)), L2 = len(sub(L.low, L.mid));
  const v = sub(lowT, L.top);
  let d = len(v);
  let err = 0;
  if (d > L1 + L2 - 0.01) { err = d - (L1 + L2 - 0.01); d = L1 + L2 - 0.01; }
  if (d < Math.abs(L1 - L2) + 0.01) { err = Math.abs(L1 - L2) + 0.01 - d; d = Math.abs(L1 - L2) + 0.01; }
  const alpha = deg(v);
  const beta = (Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)) * 180) / Math.PI;
  let best = null;
  for (const s of [1, -1]) {
    const ua = alpha + s * beta;
    const mid = [L.top[0] + L1 * Math.cos((ua * Math.PI) / 180), L.top[1] + L1 * Math.sin((ua * Math.PI) / 180)];
    const cross = v[0] * (mid[1] - L.top[1]) - v[1] * (mid[0] - L.top[0]);
    if (Math.sign(cross) === L.bend) best = { ua, mid };
  }
  const low = [L.top[0] + (v[0] / len(v)) * d, L.top[1] + (v[1] / len(v)) * d];
  const a1 = norm(best.ua - deg(sub(L.mid, L.top)));
  const a2 = norm(deg(sub(low, best.mid)) - deg(sub(L.low, L.mid)) - a1);
  const a3 = norm(angL - a1 - a2);
  return { a: [a1, a2, a3], err };
}

const bodyMatrix = (p) => mul(css(RIG_O, p.rig?.x ?? 0, p.rig?.y ?? 0, p.rig?.r ?? 0), css(M, p.body?.x ?? 0, p.body?.y ?? 0, p.body?.r ?? 0));

/** Rest sole position of a near leg in world coordinates for a pose (targets that "stay with the body"). */
const restSole = (p, which) => apply(bodyMatrix(p), (which === 'fore' ? FORE : HIND).sole);

function solvePose(p) {
  const parent = bodyMatrix(p);
  const out = {
    rig: [p.rig?.x ?? 0, p.rig?.y ?? 0, p.rig?.r ?? 0],
    body: [p.body?.x ?? 0, p.body?.y ?? 0, p.body?.r ?? 0],
    head: (p.head ?? 0) - (p.headLevel ?? 0) * ((p.rig?.r ?? 0) + (p.body?.r ?? 0)),
    legs: {},
    err: 0,
  };
  for (const which of ['fore', 'hind']) {
    const t = p[which];
    const target = t.rel ? { sole: [restSole(p, which)[0] + t.rel[0], restSole(p, which)[1] + t.rel[1]], ang: t.ang ?? 0 } : t;
    const r = solveLeg(which === 'fore' ? FORE : HIND, parent, target);
    out.legs[which] = r.a;
    if (r.err > out.err) { out.err = r.err; out.errLeg = which; }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ gaits
/** Paw path of one leg over a cycle: stance (planted, moving back relative to the body) then swing (lift, forward). */
function gaitFoot(phase, { duty, reach, back, lift, x0, liftAng, toeOff }) {
  const ph = ((phase % 1) + 1) % 1;
  if (ph < duty) {
    const s = ph / duty;
    // heel lifts in the last part of the stance (the paw rotates about its toes)
    return { x: x0 + lerp(reach, -back, s), y: FLOOR, ang: s > 0.65 ? toeOff * smooth((s - 0.65) / 0.35) : 0 };
  }
  const s = (ph - duty) / (1 - duty);
  return {
    x: x0 + lerp(-back, reach, smooth(s)),
    y: FLOOR - lift * Math.sin(Math.PI * Math.min(1, s * 1.08)),
    ang: s < 0.5 ? lerp(toeOff, liftAng, smooth(s / 0.5)) : lerp(liftAng, 0, smooth((s - 0.5) / 0.5)),
  };
}

// lateral-sequence walk: near hind 0, near fore 0.25, far hind 0.5, far fore 0.75 (far legs = near legs + half a cycle)
const WALK = { duty: 0.6, reach: 8, back: 8 };
function walkPose(t) {
  const hind = gaitFoot(t, { ...WALK, lift: 4, x0: HIND.sole[0] + 1, liftAng: 30, toeOff: 26 });
  const fore = gaitFoot(t - 0.25, { ...WALK, lift: 5, x0: FORE.sole[0], liftAng: 70, toeOff: 18 });
  const bounce = Math.cos(4 * Math.PI * (t - 0.08)); // two little bounces per cycle
  return {
    body: { y: 2.3 + 1 * bounce, r: 0.6 * Math.sin(2 * Math.PI * (t - 0.1)) },
    head: 1.2 - 1.8 * bounce,
    fore: { sole: [fore.x, fore.y], ang: fore.ang },
    hind: { sole: [hind.x, hind.y], ang: hind.ang },
  };
}
const WALK_STRIDE = (WALK.reach + WALK.back) / WALK.duty; // body travel per cycle = stance excursion / duty

// bounding gallop: hinds land together at 0, fores at 0.5; the far legs lag the near ones slightly
const RUN = { duty: 0.32, reach: 11, back: 10 };
const RUN_FAR = { fore: -0.06, hind: 0.06 };
function runPose(t) {
  const hind = gaitFoot(t, { ...RUN, lift: 7, x0: HIND.sole[0] + 2, liftAng: 40, toeOff: 40 });
  const fore = gaitFoot(t - 0.5, { ...RUN, reach: 10, back: 11, lift: 8, x0: FORE.sole[0] + 1, liftAng: 95, toeOff: 30 });
  const c = (a, ph) => a * Math.cos(2 * Math.PI * (t - ph));
  return {
    body: { y: 2.5 + 3 * Math.cos(4 * Math.PI * (t - 0.14)), r: -c(6, 0.2) },
    headLevel: 0.85,
    head: 2 * Math.cos(4 * Math.PI * (t - 0.2)),
    fore: { sole: [fore.x, fore.y], ang: fore.ang },
    hind: { sole: [hind.x, hind.y], ang: hind.ang },
  };
}
const RUN_STRIDE = (RUN.reach + RUN.back) / RUN.duty;

// ------------------------------------------------------------------------------------------------ one-shot key poses
const STAND = { fore: { sole: FORE.sole, ang: 0 }, hind: { sole: HIND.sole, ang: 0 } };
const planted = (dxF = 0, dxH = 0, angF = 0, angH = 0) => ({ fore: { sole: [FORE.sole[0] + dxF, FLOOR], ang: angF }, hind: { sole: [HIND.sole[0] + dxH, FLOOR], ang: angH } });

/** keys: [time, pose, easing to the next key] */
const ONE_SHOTS = {
  jump: [
    [0, { ...STAND }, 'io'],
    [0.22, { body: { y: 5, r: -4 }, ...planted(), headLevel: 0.6 }, 'i'], // crouch, weight on the hinds
    [0.32, { body: { y: -2, r: -12 }, headLevel: 0.6, fore: { rel: [3, -6], ang: 60 }, hind: { sole: [HIND.sole[0], FLOOR], ang: 40 } }, 'o'],
    [0.42, { rig: { y: -20 }, body: { r: -8 }, headLevel: 0.6, fore: { rel: [4, -9], ang: 75 }, hind: { rel: [-6, -2], ang: 45 } }, 'o'],
    [0.53, { rig: { y: -27 }, body: { r: 0 }, headLevel: 0.6, fore: { rel: [2, -8], ang: 80 }, hind: { rel: [2, -7], ang: 30 } }, 'i'], // apex, tucked
    [0.65, { rig: { y: -12 }, body: { r: 6 }, headLevel: 0.6, fore: { rel: [4, 0], ang: 5 }, hind: { rel: [-1, -4], ang: 20 } }, 'i'],
    [0.74, { body: { y: 2, r: 5 }, headLevel: 0.6, fore: { sole: FORE.sole, ang: 0 }, hind: { rel: [0, -2], ang: 10 } }, 'l'], // fores touch down
    [0.8, { body: { y: 4, r: 1 }, headLevel: 0.6, ...planted() }, 'io'], // hinds touch down, absorb
    [0.88, { body: { y: 3 }, headLevel: 0.3, ...planted() }, 'io'],
    [1, { ...STAND }],
  ],
  stretch: [
    [0, { ...STAND }, 'io'],
    [0.1, { body: { y: 1.5, r: 3 }, ...planted(4, 0), headLevel: 0.5 }, 'io'],
    [0.3, { body: { x: 2, y: 6, r: 17 }, ...planted(17, 0), headLevel: 0.85, head: -4 }, 'io'], // front down, rear up
    [0.66, { body: { x: 2, y: 6, r: 17 }, ...planted(17, 0), headLevel: 0.85, head: -4 }, 'io'],
    [0.86, { body: { y: 1, r: 2 }, ...planted(4, 0), headLevel: 0.5 }, 'io'],
    [1, { ...STAND }],
  ],
  surprised: [
    [0, { ...STAND }, 'o'],
    [0.1, { rig: { x: -3, y: -7 }, body: { y: -2 }, headLevel: 0.3, head: -4, fore: { rel: [1, -3], ang: 20 }, hind: { rel: [-1, -3], ang: 10 } }, 'i'], // startle hop back
    [0.22, { rig: { x: -5 }, body: { y: 0.5 }, headLevel: 0.2, head: 3, ...planted(-4, -6) }, 'io'], // land stiff-legged
    [0.7, { rig: { x: -5 }, body: { y: 0.5 }, headLevel: 0.2, head: 3, ...planted(-4, -6) }, 'io'],
    [1, { ...STAND }],
  ],
  happy: [
    [0, { ...STAND }, 'io'],
    [0.12, { body: { y: 2 }, ...planted() }, 'o'],
    [0.26, { rig: { y: -5 }, body: { y: -1 }, fore: { rel: [0, -1], ang: 12 }, hind: { rel: [0, -1], ang: 8 } }, 'i'],
    [0.38, { body: { y: 2 }, ...planted() }, 'o'],
    [0.52, { rig: { y: -4 }, body: { y: -1 }, fore: { rel: [0, -1], ang: 12 }, hind: { rel: [0, -1], ang: 8 } }, 'i'],
    [0.64, { body: { y: 1.5 }, ...planted() }, 'io'],
    [0.8, { ...planted() }, 'io'],
    [1, { ...STAND }],
  ],
  yawn: [
    [0, { ...STAND }, 'io'],
    [0.22, { body: { x: -0.5, y: 1.5, r: -4 }, ...planted(2, 0), head: -15 }, 'io'], // rear sinks, chest up, head back
    [0.62, { body: { x: -0.5, y: 1.8, r: -4.5 }, ...planted(2, 0), head: -17 }, 'io'],
    [0.84, { body: { y: 0.8 }, ...planted(0.5, 0), head: 2 }, 'io'],
    [1, { ...STAND }],
  ],
  land: [
    [0, { rig: { y: -11 }, body: { y: -1 }, fore: { rel: [1, 1.5], ang: 10 }, hind: { rel: [-1, 1.5], ang: 10 } }, 'i'], // dropped, legs reaching down
    [0.16, { ...planted(1, -1) }, 'o'], // touch down
    [0.34, { body: { y: 6, r: 1 }, ...planted(1, -1), head: 4 }, 'io'], // squash
    [0.58, { body: { y: -0.3 }, ...planted(1, -1), head: -2 }, 'io'], // rebound
    [0.8, { body: { y: 0.6 }, ...planted(0.3, -0.3) }, 'io'],
    [1, { ...STAND }],
  ],
  interact: [
    [0, { ...STAND }, 'io'],
    [0.18, { body: { y: 0.5, r: -1 }, ...planted(), head: 8 }, 'io'], // lean in, tilt the head
    [0.8, { body: { y: 0.5, r: -1 }, ...planted(), head: 9 }, 'io'],
    [1, { ...STAND }],
  ],
};

const EASE = {
  io: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  i: (t) => t * t,
  o: (t) => 1 - (1 - t) * (1 - t),
  l: (t) => t,
};

/** Interpolate two key poses (sole targets interpolated in world space). */
function mixPose(a, b, u) {
  const num = (x, y) => lerp(x ?? 0, y ?? 0, u);
  const grp = (ga = {}, gb = {}) => ({ x: num(ga.x, gb.x), y: num(ga.y, gb.y), r: num(ga.r, gb.r) });
  const out = { rig: grp(a.rig, b.rig), body: grp(a.body, b.body), head: num(a.head, b.head), headLevel: num(a.headLevel, b.headLevel) };
  for (const k of ['fore', 'hind']) {
    const w = (p, pose) => (p.rel ? [restSole(pose, k)[0] + p.rel[0], restSole(pose, k)[1] + p.rel[1]] : p.sole);
    const sa = w(a[k], a), sb = w(b[k], b);
    out[k] = { sole: [lerp(sa[0], sb[0], u), lerp(sa[1], sb[1], u)], ang: lerp(a[k].ang ?? 0, b[k].ang ?? 0, u) };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ adaptive sampling
function fk(p) {
  const body = mul(css(RIG_O, p.rig[0], p.rig[1], p.rig[2]), css(M, p.body[0], p.body[1], p.body[2]));
  const leg = (L, a) => apply(mul(mul(mul(body, css(L.top, 0, 0, a[0])), css(L.mid, 0, 0, a[1])), css(L.low, 0, 0, a[2])), L.sole);
  return [leg(FORE, p.legs.fore), leg(HIND, p.legs.hind), apply(body, FORE.top), apply(body, HIND.top), apply(body, HEAD_O)];
}

function lerpPose(a, b, u) {
  const l3 = (x, y) => x.map((v, i) => lerp(v, y[i], u));
  return { rig: l3(a.rig, b.rig), body: l3(a.body, b.body), head: lerp(a.head, b.head, u), legs: { fore: l3(a.legs.fore, b.legs.fore), hind: l3(a.legs.hind, b.legs.hind) } };
}

/** Planted paws must not drift by more than tol; the body and swinging paws may deviate by up to LOOSE × tol. */
const LOOSE = 3.5;
function interpError(s0, s1, tm, truePose) {
  const a = fk(lerpPose(s0.pose, s1.pose, (tm - s0.t) / (s1.t - s0.t)));
  const b = fk(truePose);
  return Math.max(...a.map((p, i) => {
    const d = Math.hypot(p[0] - b[i][0], p[1] - b[i][1]);
    return i < 2 && b[i][1] >= FLOOR - 0.6 ? d : d / LOOSE;
  }));
}

function adaptive(poseAt, times, tol, maxDepth = 5) {
  const cache = new Map();
  const at = (t) => {
    const k = t.toFixed(6);
    if (!cache.has(k)) cache.set(k, { t, pose: solvePose(poseAt(t)) });
    return cache.get(k);
  };
  const out = [at(times[0])];
  const refine = (s0, s1, depth) => {
    const err = Math.max(...[0.25, 0.5, 0.75].map((f) => { const tm = s0.t + (s1.t - s0.t) * f; return interpError(s0, s1, tm, at(tm).pose); }));
    if (err > tol && depth < maxDepth) {
      const m = at((s0.t + s1.t) / 2);
      refine(s0, m, depth + 1);
      refine(m, s1, depth + 1);
    } else {
      out.push(s1);
    }
  };
  for (let i = 1; i < times.length; i++) refine(at(times[i - 1]), at(times[i]), 0);
  let worst = { err: 0 };
  for (const s of out) if (s.pose.err > worst.err) worst = { err: s.pose.err, t: s.t, leg: s.pose.errLeg };
  return { samples: out, worst };
}

const sampleLoop = (fn, n, tol) => adaptive((t) => fn(t % 1), Array.from({ length: n + 1 }, (_, i) => i / n), tol);

function sampleOneShot(keys, tol) {
  const poseAt = (t) => {
    let k = 0;
    while (k < keys.length - 2 && t >= keys[k + 1][0]) k++;
    const [t0, p0, ease = 'l'] = keys[k];
    const [t1, p1] = keys[k + 1];
    return mixPose(p0, p1, EASE[ease](Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))));
  };
  return adaptive(poseAt, keys.map((k) => k[0]), tol);
}

// ------------------------------------------------------------------------------------------------ CSS output
const f1 = (v) => {
  const s = (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return s === '-0' ? '0' : s.replace(/^(-?)0\./, '$1.');
};
const pct = (t) => (Math.round(t * 1000) / 10).toString() + '%';

/** [id, selector, pose → [tx, ty, r]] */
const TRACKS = [
  ['r', '.rig', (p) => p.rig],
  ['b', '.body', (p) => p.body],
  ['h', '.head', (p) => [0, 0, p.head]],
  ['f0', '.fu', (p) => [0, 0, p.legs.fore[0]]],
  ['f1', '.fl', (p) => [0, 0, p.legs.fore[1]]],
  ['f2', '.fp', (p) => [0, 0, p.legs.fore[2]]],
  ['h0', '.hu', (p) => [0, 0, p.legs.hind[0]]],
  ['h1', '.hl', (p) => [0, 0, p.legs.hind[1]]],
  ['h2', '.hp', (p) => [0, 0, p.legs.hind[2]]],
];

function emitKeyframes(name, samples, decl) {
  const groups = new Map();
  samples.forEach((s, i) => {
    const d = decl[i];
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(pct(s.t));
  });
  return `@keyframes ${name}{${[...groups].map(([d, ts]) => `${ts.join(',')}{${d}}`).join('')}}\n`;
}

/** farDelay: { fore, hind } = fraction of the cycle the far legs are shifted by (they reuse the near keyframes). */
function emitClip(prefix, samples, farDelay) {
  let kf = '';
  const rules = [];
  for (const [id, sel, fn] of TRACKS) {
    const q = /^[fh][0-9]$/.test(id) ? (v) => f1(Math.round(v)) : f1; // leg joints: whole degrees
    const vals = samples.map((s) => fn(s.pose).map((v) => q(v)));
    const useT = vals.some((v) => v[0] !== '0' || v[1] !== '0');
    const useR = vals.some((v) => v[2] !== '0');
    if (!useT && !useR) continue;
    const decl = vals.map((v) => [useT && `translate:${v[0] === '0' ? '0' : v[0] + 'px'} ${v[1] === '0' ? '0' : v[1] + 'px'}`, useR && `rotate:${v[2]}deg`].filter(Boolean).join(';'));
    kf += emitKeyframes(prefix + id, samples, decl);
    rules.push(`  ${sel} { animation-name: ${prefix}${id}; }`);
  }
  // soft contact shadow: follows the cat sideways, shrinks and fades while it is off the ground
  if (samples.some((s) => s.pose.rig[1] < -0.5)) {
    const decl = samples.map((s) => {
      const lift = Math.min(1, Math.max(0, -s.pose.rig[1] / 30));
      const x = f1(s.pose.rig[0] + s.pose.body[0] * 0.6);
      return `translate:${x === '0' ? '0' : x + 'px'} 0;scale:${f1((1 - 0.5 * lift) * 100) / 100};opacity:${f1((1 - 0.6 * lift) * 100) / 100}`;
    });
    kf += emitKeyframes(prefix + 's', samples, decl);
    rules.push(`  .shadow { animation-name: ${prefix}s; }`);
  }
  if (farDelay) {
    for (const [leg, parts] of [['fore', '.fu, .far .fl, .far .fp'], ['hind', '.hu, .far .hl, .far .hp']]) {
      const d = farDelay[leg];
      if (d) rules.push(`  .far ${parts} { animation-delay: calc(var(--d) * ${f1(-(((d % 1) + 1) % 1) * 100) / 100}); }`);
    }
  }
  return { kf, rules };
}

const fmtWorst = (w) => (w.err > 0.05 ? `max IK reach error ${w.err.toFixed(2)} (${w.leg} at t=${w.t.toFixed(3)})` : 'all paws reachable');
const TOL = { walk: 0.45, run: 1.2, oneShot: 1.2 };

function generate() {
  let kf = '';
  let rules = '';
  const report = [];
  const add = (name, prefix, res, farDelay, extra = '') => {
    const e = emitClip(prefix, res.samples, farDelay);
    kf += e.kf;
    rules += `.stand[data-clip='${name}'] {\n${e.rules.join('\n')}\n}\n`;
    report.push(`${name.padEnd(9)} ${String(res.samples.length).padStart(2)} keyframes${extra}, ${fmtWorst(res.worst)}`);
  };
  add('walk', 'w', sampleLoop(walkPose, 8, TOL.walk), { fore: 0.5, hind: 0.5 }, `, stride ${WALK_STRIDE.toFixed(1)} units = ${(WALK_STRIDE / BOX_W).toFixed(3)} box widths`);
  add('run', 'r', sampleLoop(runPose, 8, TOL.run), { fore: -RUN_FAR.fore, hind: -RUN_FAR.hind }, `, stride ${RUN_STRIDE.toFixed(1)} units = ${(RUN_STRIDE / BOX_W).toFixed(3)} box widths`);
  for (const [name, keys] of Object.entries(ONE_SHOTS)) add(name, name.slice(0, 2), sampleOneShot(keys, TOL.oneShot));
  return { css: `${rules}${kf}`, report };
}

const { css: block, report } = generate();
const src = fs.readFileSync(SCSS, 'utf8');
const a = src.search(new RegExp('^// <gen-rig>', 'm'));
const b = src.search(new RegExp('^// </gen-rig>', 'm'));
if (a < 0 || b < 0) throw new Error('gen-rig marker lines not found in cat-sprite.scss');
const head = '// <gen-rig> generated by tests/visual/cat-preview/gen-rig.mjs (inverse kinematics) – do not edit by hand\n';
fs.writeFileSync(SCSS, src.slice(0, a) + head + block + src.slice(b));
console.log(report.join('\n'));
console.log(`generated block: ${Buffer.byteLength(block)} bytes`);
