import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CatFacing, CatWalkResult, Rect } from '../../core/models';
import { CatSettingsService } from '../../core/services/cat-settings.service';
import { CatWindowService } from '../../core/services/cat-window.service';
import { CAT_ANIMATIONS, CatAnimation } from '../components/cat-sprite/cat-art';

export interface CatGaze {
  x: number;
  y: number;
}

/** Hit-region updates are debounced by this much (animation, facing and layout often change together). */
const HIT_REGION_DEBOUNCE_MS = 120;
/** A one-shot clip that never reports `finished` is considered over after its length plus this. */
const ONE_SHOT_GRACE_MS = 450;
/** Fraction of the cruise speed used for the coarse rate steps while accelerating (reversed while braking). */
const RAMP_STEPS = [1 / 6, 1 / 2, 5 / 6] as const;
/** Approximate head position in the cat box (fractions, facing right) for the gaze direction. */
const HEAD = { x: 0.72, y: 0.4 } as const;
/** Every clip stays on screen at least this long, so CatSprite's layer crossfades always complete. */
export const MIN_CLIP_MS = 300;

interface PendingClip {
  animation: CatAnimation;
  resolve: (completed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Turns behaviour into what CatSprite shows: animation, facing, playback rate (walk/run synced to the real
 * movement so the feet do not slide), gaze and pause. It also owns the window hit region.
 *
 * Nothing here runs per frame: signals change when the behaviour changes (every few seconds) plus a few coarse
 * rate steps during a walk's acceleration and braking. Movement itself is done by the host.
 */
@Injectable()
export class CatAnimationService {
  private readonly document = inject(DOCUMENT);
  private readonly catWindow = inject(CatWindowService);
  private readonly catSettings = inject(CatSettingsService);

  readonly animation = signal<CatAnimation>('idle');
  readonly facing = signal<CatFacing>(Math.random() < 0.5 ? 'left' : 'right');
  readonly rate = signal(1);
  /** Gaze held by a click reaction (wins over the hover gaze). */
  private readonly reactionGaze = signal<CatGaze | null>(null);
  /** Gaze following the pointer while it hovers the cat. */
  private readonly hoverGaze = signal<CatGaze | null>(null);
  /** Screen-space gaze for CatSprite (x < 0 = toward the left of the screen, y < 0 = up); null = natural. */
  readonly gaze = computed(() => this.reactionGaze() ?? this.hoverGaze());
  /** Ears perked, eyes wide (CatSprite `attentive`): while the pointer hovers a resting cat or during a look-at-me reaction. */
  readonly hoverAttentive = signal(false);
  readonly reactionAttentive = signal(false);
  readonly attentive = computed(() => this.hoverAttentive() || this.reactionAttentive());
  /** The page is hidden (minimised/hidden window or background tab). */
  readonly documentHidden = signal(this.document.hidden === true);
  private readonly reducedMotion = signal(false);
  /** Freeze the sprite while nobody can see it (or the user asked for reduced motion). */
  readonly paused = computed(() => !this.catWindow.visible() || this.documentHidden() || this.reducedMotion());

  /** Elements the hit region is measured from (registered by CatCompanionWindow). */
  private host: HTMLElement | null = null;
  private catBox: HTMLElement | null = null;
  readonly surface = signal<HTMLElement | null>(null);
  /** Bumped when the menu/panel card changes size. */
  private readonly surfaceTick = signal(0);

  private pending: PendingClip | null = null;
  private rampTimers: ReturnType<typeof setTimeout>[] = [];
  /** When the current clip started (performance.now), for the MIN_CLIP_MS dwell. */
  private clipSince = 0;
  private clipTimer: ReturnType<typeof setTimeout> | null = null;
  private gazeTimer: ReturnType<typeof setTimeout> | null = null;
  private regionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRegionKey = '';
  private lastRegionLayout: unknown = undefined;
  private surfaceObserver: ResizeObserver | null = null;

  constructor() {
    const onVisibility = (): void => this.documentHidden.set(this.document.hidden === true);
    this.document.addEventListener('visibilitychange', onVisibility);
    const motion = this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = (e: MediaQueryListEvent): void => this.reducedMotion.set(e.matches);
    if (motion) {
      this.reducedMotion.set(motion.matches);
      motion.addEventListener('change', onMotion);
    }

    // Hit region: whenever the drawn shape or the window layout changes (debounced, sent only when different).
    effect(() => {
      this.animation();
      this.facing();
      this.catSettings.boxSize();
      this.catWindow.layout();
      this.surface();
      this.surfaceTick();
      untracked(() => this.scheduleHitRegion());
    });
    // Observe the menu/panel card while it exists.
    effect(() => {
      const el = this.surface();
      untracked(() => {
        this.surfaceObserver?.disconnect();
        this.surfaceObserver = null;
        if (el && typeof ResizeObserver !== 'undefined') {
          this.surfaceObserver = new ResizeObserver(() => this.surfaceTick.update((n) => n + 1));
          this.surfaceObserver.observe(el);
        }
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibility);
      motion?.removeEventListener('change', onMotion);
      this.clearRamp();
      this.settle(false);
      if (this.clipTimer) clearTimeout(this.clipTimer);
      if (this.gazeTimer) clearTimeout(this.gazeTimer);
      if (this.regionTimer) clearTimeout(this.regionTimer);
      this.surfaceObserver?.disconnect();
    });
  }

  /** Called once by the window component after its first render. */
  attach(host: HTMLElement, catBox: HTMLElement): void {
    this.host = host;
    this.catBox = catBox;
    this.lastRegionKey = '';
    this.scheduleHitRegion();
  }

  // ---- clips ------------------------------------------------------------------------------

  /** Switch to a looping clip (idle, sit, sleep, dragged…) at normal speed. Interrupts a one-shot clip. */
  loop(animation: CatAnimation): void {
    this.clearRamp();
    this.settle(false);
    this.setClip(animation, 1);
  }

  /**
   * Walk/run cycle for a walk the host accepted. The playback rate follows the host's speed profile in a few
   * coarse steps: accelerate over accelMs, cruise, brake over the last accelMs.
   */
  walk(kind: 'walk' | 'run', result: CatWalkResult): void {
    this.clearRamp();
    this.settle(false);
    this.facing.set(result.facing);
    const distance = Math.hypot(result.dx, result.dy);
    const cruiseMs = Math.max(1, result.durationMs - result.accelMs);
    const speed = distance / (cruiseMs / 1000); // DIP/s while cruising
    const rateFor = (fraction: number): number => this.strideRate(kind, speed * fraction);
    const a = result.accelMs;
    if (a < 90) {
      this.setClip(kind, rateFor(1));
      return;
    }
    // The ramp starts when the clip is really on screen (after the minimum dwell of the previous clip).
    const delay = this.setClip(kind, rateFor(RAMP_STEPS[0]));
    const T = result.durationMs;
    const at = (ms: number, fraction: number): void => this.at(Math.max(delay, ms), () => this.rate.set(rateFor(fraction)));
    at(a / 3, RAMP_STEPS[1]);
    at((2 * a) / 3, RAMP_STEPS[2]);
    at(a, 1);
    at(T - a, RAMP_STEPS[2]);
    at(T - (2 * a) / 3, RAMP_STEPS[1]);
    at(T - a / 3, RAMP_STEPS[0]);
  }

  /**
   * Play a one-shot clip (jump, stretch, look, happy, surprised, yawn, land, interact) at rate 1. Resolves true when
   * CatSprite reports it finished (or after a safety timeout), false when something else interrupted it.
   */
  play(animation: CatAnimation): Promise<boolean> {
    this.clearRamp();
    this.settle(false);
    // The same one-shot twice in a row would not restart: go through idle first.
    if (this.animation() === animation && !CAT_ANIMATIONS[animation].loop) this.setClip('idle', 1);
    const delay = this.setClip(animation, 1);
    const spec = CAT_ANIMATIONS[animation];
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(true, animation), delay + spec.durationMs + ONE_SHOT_GRACE_MS);
      this.pending = { animation, resolve, timer };
    });
  }

  /**
   * CatSprite (finished) output. A report that comes implausibly early (well before the clip could have played,
   * e.g. a stray animationend of a layer that is being reused) is ignored; the safety timer still ends the clip.
   */
  onFinished(animation: CatAnimation): void {
    if (animation !== this.animation()) return;
    if (performance.now() - this.clipSince < CAT_ANIMATIONS[animation].durationMs * 0.6) return;
    this.settle(true, animation);
  }

  face(facing: CatFacing): void {
    this.facing.set(facing);
  }

  /** Look toward a point (CSS px relative to the cat box, e.g. where the user clicked) for a moment. */
  lookAt(point: { x: number; y: number }, holdMs: number): void {
    this.reactionGaze.set(this.gazeFor(point));
    if (this.gazeTimer) clearTimeout(this.gazeTimer);
    this.gazeTimer = setTimeout(() => {
      this.gazeTimer = null;
      this.reactionGaze.set(null);
    }, holdMs);
  }

  /** Hover: follow the pointer (null when it left or the cat is busy). Only changes the signal when it moved. */
  followPointer(point: { x: number; y: number } | null): void {
    const next = point ? this.gazeFor(point) : null;
    const current = this.hoverGaze();
    if (next && current && next.x === current.x && next.y === current.y) return;
    this.hoverGaze.set(next);
  }

  // ---- internals --------------------------------------------------------------------------

  /**
   * Show `animation` at `rate` (rate first, so a one-shot never starts at a walk's speed). A clip that has been on
   * screen for less than MIN_CLIP_MS is kept until then; the newest request wins. Returns the delay in ms.
   */
  private setClip(animation: CatAnimation, rate: number): number {
    if (this.clipTimer) clearTimeout(this.clipTimer);
    this.clipTimer = null;
    const wait = animation === this.animation() ? 0 : this.clipSince + MIN_CLIP_MS - performance.now();
    if (wait <= 0) {
      this.commitClip(animation, rate);
      return 0;
    }
    this.clipTimer = setTimeout(() => {
      this.clipTimer = null;
      this.commitClip(animation, rate);
    }, wait);
    return wait;
  }

  private commitClip(animation: CatAnimation, rate: number): void {
    if (animation !== this.animation()) this.clipSince = performance.now();
    this.rate.set(rate);
    this.animation.set(animation);
  }

  /** Screen-space gaze from the head toward a point in the cat box; CatSprite undoes its own mirroring. */
  private gazeFor(point: { x: number; y: number }): CatGaze {
    const size = this.catSettings.boxSize();
    const headX = (this.facing() === 'left' ? 1 - HEAD.x : HEAD.x) * size.width;
    const headY = HEAD.y * size.height;
    const clamp = (v: number): number => Math.max(-1, Math.min(1, Math.round(v * 10) / 10)) || 0;
    return { x: clamp((point.x - headX) / (size.width / 2)), y: clamp((point.y - headY) / (size.height / 2)) };
  }

  /** rate = (speed × cycle length) / (stride × box width): one cycle covers exactly one stride. */
  private strideRate(kind: 'walk' | 'run', speed: number): number {
    const spec = CAT_ANIMATIONS[kind];
    const stride = (spec.strideBoxWidths ?? 0.4) * this.catSettings.boxSize().width;
    const rate = (speed * (spec.durationMs / 1000)) / stride;
    return Math.round(Math.min(8, Math.max(0.15, rate)) * 100) / 100;
  }

  private at(ms: number, fn: () => void): void {
    this.rampTimers.push(setTimeout(fn, Math.max(0, ms)));
  }

  private clearRamp(): void {
    for (const t of this.rampTimers) clearTimeout(t);
    this.rampTimers = [];
  }

  private settle(completed: boolean, animation?: CatAnimation): void {
    const pending = this.pending;
    if (!pending || (animation && pending.animation !== animation)) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(completed);
  }

  // ---- hit region -------------------------------------------------------------------------

  private scheduleHitRegion(): void {
    if (this.regionTimer) clearTimeout(this.regionTimer);
    this.regionTimer = setTimeout(() => {
      this.regionTimer = null;
      this.sendHitRegion();
    }, HIT_REGION_DEBOUNCE_MS);
  }

  /**
   * Only these rectangles receive the mouse: the cat's pixels for the current clip (CAT_ANIMATIONS hitBox,
   * mirrored when facing left) and, with the menu or the panel open, its card. The host resets the region on
   * every layout change, so a new layout always resends.
   */
  private sendHitRegion(): void {
    const host = this.host;
    const catBox = this.catBox;
    if (!host || !catBox) return;
    const box = layoutRect(catBox, host);
    if (box.width <= 0 || box.height <= 0) return;
    const hit = CAT_ANIMATIONS[this.animation()].hitBox;
    const fx = this.facing() === 'left' ? 1 - hit.x - hit.width : hit.x;
    const rects: Rect[] = [toRect(box.x + fx * box.width, box.y + hit.y * box.height, hit.width * box.width, hit.height * box.height)];
    const layout = this.catWindow.layout();
    const surface = this.surface();
    if (layout && layout.mode !== 'cat' && surface) {
      const card = layoutRect(surface, host);
      if (card.width > 0 && card.height > 0) rects.push(toRect(card.x, card.y, card.width, card.height));
    }
    const key = JSON.stringify(rects);
    if (key === this.lastRegionKey && layout === this.lastRegionLayout) return;
    this.lastRegionKey = key;
    this.lastRegionLayout = layout;
    this.catWindow.setHitRegion(rects).catch((err) => {
      this.lastRegionKey = '';
      console.warn('[cat] setHitRegion failed', err);
    });
  }
}

/**
 * Layout-box position of `el` relative to `host` (CSS px). Unlike getBoundingClientRect it ignores transforms,
 * so the pop-in animation of the menu/panel card does not shrink the measured rectangle.
 */
function layoutRect(el: HTMLElement, host: HTMLElement): Rect {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== host) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== host) {
    const a = el.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height };
  }
  return { x, y, width: el.offsetWidth, height: el.offsetHeight };
}

function toRect(x: number, y: number, width: number, height: number): Rect {
  const left = Math.floor(x);
  const top = Math.floor(y);
  return { x: left, y: top, width: Math.ceil(x + width) - left, height: Math.ceil(y + height) - top };
}
