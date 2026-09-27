import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CatFacing } from '../../../core/models';
import { CAT_ANIMATIONS, CAT_POSE_LAYER, CatAnimation } from './cat-art';
import { CatSpriteClip, CatSpriteSkin, loadCatSkin } from './cat-skin';
import { catTheme, catThemeVars } from './cat-themes';

/** Paint servers (gradients, clip paths) of the vector cat; ids are made unique per instance. */
const PAINTS = [
  'body', 'head', 'limb', 'tail', 'iris', 'mask', 'shadow', 'sitBody', 'sleepBody', 'dragBody',
  'clipTorso', 'clipEyeN', 'clipEyeF', 'clipSit', 'clipSleep', 'clipDrag',
] as const;
type PaintName = (typeof PAINTS)[number];

/** Layer crossfade (see .layer in the stylesheet) is over after this; hidden layers then drop their clip. */
const LAYER_SETTLE_MS = 450;
/** The fallback timer for `finished` fires this long after the expected end (animationend normally wins). */
const FINISH_GRACE_MS = 150;
const MIN_RATE = 0.05;
const MAX_RATE = 8;

let nextUid = 0;

interface FinishWatch {
  clip: CatAnimation;
  durationMs: number;
  /** Clip time consumed so far (ms at rate 1), updated whenever the rate or the paused state changes. */
  elapsed: number;
  since: number;
  done: boolean;
}

/**
 * Presentational cat. Fills its host element (a cat box, 4:3) and draws the cat standing on the bottom edge.
 * PUBLIC API – the behaviour code depends on exactly these inputs/outputs:
 *   animation  which clip to play (CAT_ANIMATIONS in cat-art.ts)
 *   facing     'right' = drawn as authored, 'left' = mirrored horizontally (no duplicate assets)
 *   rate       playback rate of looping clips (the walk/run cycle is synced to the movement speed with it)
 *   paused     freeze all animation (window hidden, reduced motion)
 *   gaze       where the cat looks, x/y in -1…1 relative to its head (null = natural)
 *   theme      CatTheme id (cat-themes.ts); unknown ids draw as 'classic'. Switching is instant and live
 *   attentive  the cursor is over the cat: ears perk up, eyes open a little wider, the tail tip twitches
 *   finished   emits the clip name when a one-shot clip (loop=false) has played to its end
 *
 * Rendering: one inline SVG with five pose layers (two standing rigs, sit, sleep, drag). Every movement is a CSS
 * keyframe animation on transform/opacity; this class only sets data-clip / --d on the layers (no per-frame work, no
 * change detection for animation). Switching clips crossfades layers. `rate` is applied with Web Animations
 * playbackRate so a change keeps the current phase. The theme only sets CSS custom properties on the host (the
 * stylesheet derives all shading from them). With a sprite skin (the theme's theme.manifest.json, else
 * assets/cat/cat.manifest.json) the listed clips are played from sprite sheets instead.
 */
@Component({
  selector: 'app-cat-sprite',
  templateUrl: './cat-sprite.html',
  styleUrl: './cat-sprite.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  host: {
    '[attr.data-animation]': 'animation()',
    '[attr.data-theme]': 'resolvedTheme().id',
    '[class.left]': "facing() === 'left'",
    '[class.paused]': 'paused()',
    '[class.attentive]': 'attentive()',
    '[style]': 'themeVars()',
    '[style.--gx]': 'gazeX()',
    '[style.--gy]': 'gazeY()',
  },
})
export class CatSprite {
  readonly animation = input<CatAnimation>('idle');
  readonly facing = input<CatFacing>('right');
  readonly rate = input(1);
  readonly paused = input(false);
  readonly gaze = input<{ x: number; y: number } | null>(null);
  readonly theme = input<string>('classic');
  readonly attentive = input(false);
  readonly finished = output<CatAnimation>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly uid = `cat-sprite-${nextUid++}`;

  protected readonly standSlots = ['a', 'b'] as const;
  protected readonly ids = this.paints((n) => `${this.uid}-${n}`);
  protected readonly paint = this.paints((n) => `url(#${this.uid}-${n})`);

  /** Gaze in the authored (facing right) frame: the mirroring of facing 'left' is undone for x. */
  protected readonly gazeX = computed(() => {
    const g = this.gaze();
    const x = g ? clamp(g.x, -1, 1) : 0;
    return this.facing() === 'left' ? -x : x;
  });
  protected readonly gazeY = computed(() => {
    const g = this.gaze();
    return g ? clamp(g.y, -1, 1) : 0;
  });

  protected readonly resolvedTheme = computed(() => catTheme(this.theme()));
  /** The theme as CSS custom properties on the host; the SVG paint (fills, gradient stops) reads them. */
  protected readonly themeVars = computed(() => catThemeVars(this.resolvedTheme()));

  private readonly skin = signal<CatSpriteSkin | null>(null);
  private skinRequest = 0;
  /**
   * The sprite clip for the current animation (sprite skin only). A fresh object per animation change: the template
   * tracks it by identity, so every play gets a new element and the sheet animation starts from frame 0.
   */
  protected readonly spriteClip = computed<CatSpriteClip | null>(() => {
    const clip = this.skin()?.[this.animation()];
    return clip ? { ...clip } : null;
  });
  protected readonly spritePlays = computed(() => {
    const c = this.spriteClip();
    return c ? [c] : [];
  });

  private active: SVGGElement | null = null;
  private vectorClip: CatAnimation | null = null;
  private watch: FinishWatch | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private finishTimer: ReturnType<typeof setTimeout> | undefined;
  private appliedRate = 1;

  constructor() {
    // the skin can differ per theme (assets/cat/themes/<id>/theme.manifest.json); the newest request wins
    effect(() => {
      const theme = this.resolvedTheme();
      const request = ++this.skinRequest;
      loadCatSkin(theme).then((s) => {
        if (request === this.skinRequest) this.skin.set(s);
      });
    });

    this.host.nativeElement.addEventListener('animationend', this.onAnimationEnd);

    // Clip changes (and a skin that arrives later) – runs after the DOM is up to date.
    afterRenderEffect(() => {
      const clip = this.animation();
      const sprite = this.spriteClip();
      untracked(() => (sprite ? this.playSprite(sprite) : this.playVector(clip)));
    });

    afterRenderEffect(() => {
      const rate = safeRate(this.rate());
      untracked(() => {
        this.accumulate();
        this.appliedRate = rate;
        this.applyRate();
        this.armFinishTimer();
      });
    });

    afterRenderEffect(() => {
      const paused = this.paused();
      untracked(() => {
        if (paused) {
          this.accumulate(true);
          clearTimeout(this.finishTimer);
        } else if (this.watch) {
          this.watch.since = performance.now();
          this.armFinishTimer();
        }
      });
    });

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.settleTimer);
      clearTimeout(this.finishTimer);
      this.host.nativeElement.removeEventListener('animationend', this.onAnimationEnd);
    });
  }

  // ------------------------------------------------------------------------------------------ vector cat

  private playVector(clip: CatAnimation): void {
    const svg = this.host.nativeElement.querySelector<SVGSVGElement>('svg.cat');
    if (!svg) return;
    // already showing this clip (the effect re-ran for another reason): never restart it
    if (clip === this.vectorClip && this.active?.getAttribute('data-clip') === clip) return;
    const layers = Array.from(svg.querySelectorAll<SVGGElement>(':scope > g.layer'));
    const kind = CAT_POSE_LAYER[clip];
    let target: SVGGElement | undefined;
    if (kind === 'stand') {
      // alternate between the two standing rigs so stand → stand switches crossfade as well
      const stands = layers.filter((l) => l.classList.contains('stand'));
      target = stands.find((l) => l !== this.active && !l.classList.contains('on')) ?? stands.find((l) => l !== this.active);
    } else {
      target = layers.find((l) => l.classList.contains(kind));
    }
    if (!target) return;

    const first = this.active === null;
    if (first) svg.classList.add('instant');
    if (target.hasAttribute('data-clip')) {
      // The layer is still fading out with an earlier clip. Drop it and flush styles first: CSS animations that share
      // a name between clips (the clock, the tail wave, …) would otherwise carry on with their old timeline.
      target.removeAttribute('data-clip');
      void getComputedStyle(target).opacity;
    }
    target.style.setProperty('--d', `${CAT_ANIMATIONS[clip].durationMs}ms`);
    target.setAttribute('data-clip', clip);
    for (const layer of layers) layer.classList.toggle('on', layer === target);
    this.active = target;
    this.vectorClip = clip;
    this.applyRate(target);
    this.startWatch(clip, CAT_ANIMATIONS[clip].durationMs, !CAT_ANIMATIONS[clip].loop);

    if (first) {
      requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.remove('instant')));
    }
    // once the crossfade is over, hidden layers drop their clip (their animations stop)
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      for (const layer of layers) {
        if (!layer.classList.contains('on')) layer.removeAttribute('data-clip');
      }
    }, LAYER_SETTLE_MS);
  }

  // ------------------------------------------------------------------------------------------ sprite skin

  private playSprite(clip: CatSpriteClip): void {
    this.applyRate(this.host.nativeElement.querySelector<HTMLElement>('.sheet') ?? undefined);
    this.startWatch(clip.name, clip.durationMs, !clip.loop);
  }

  /** steps() needs at least two steps with jump-none; a one-frame sheet simply never moves. */
  protected sheetSteps(frames: number): string {
    return `steps(${Math.max(2, frames)}, jump-none)`;
  }

  // ------------------------------------------------------------------------------------------ rate

  /** playbackRate keeps the current progress, so changing the rate never restarts or jumps a cycle. */
  private applyRate(root: Element = this.host.nativeElement): void {
    for (const a of root.getAnimations({ subtree: true })) {
      if (a instanceof CSSAnimation && a.playbackRate !== this.appliedRate) a.playbackRate = this.appliedRate;
    }
  }

  // ------------------------------------------------------------------------------------------ finished

  private startWatch(clip: CatAnimation, durationMs: number, oneShot: boolean): void {
    clearTimeout(this.finishTimer);
    this.watch = oneShot ? { clip, durationMs, elapsed: 0, since: performance.now(), done: false } : null;
    this.armFinishTimer();
  }

  /** Adds the clip time played since the last check (at the rate in force until now). */
  private accumulate(pausing = false): void {
    const w = this.watch;
    if (!w || w.done || (this.paused() && !pausing)) return;
    const now = performance.now();
    w.elapsed += (now - w.since) * this.appliedRate;
    w.since = now;
  }

  /** Safety net for `finished` (e.g. animationend lost while the window was hidden); animationend normally wins. */
  private armFinishTimer(): void {
    clearTimeout(this.finishTimer);
    const w = this.watch;
    if (!w || w.done || this.paused()) return;
    w.since = performance.now();
    const remaining = Math.max(0, w.durationMs - w.elapsed) / this.appliedRate;
    this.finishTimer = setTimeout(() => this.complete(w), remaining + FINISH_GRACE_MS);
  }

  private readonly onAnimationEnd = (ev: Event): void => {
    const w = this.watch;
    const target = ev.target;
    if (!w || w.done || !(target instanceof Element)) return;
    if (target.classList.contains('clock')) {
      const layer = target.closest('.layer');
      if (layer === this.active && layer?.getAttribute('data-clip') === w.clip && !this.spriteClip()) this.complete(w);
    } else if (target.classList.contains('sheet') && this.spriteClip()?.name === w.clip) {
      this.complete(w);
    }
  };

  private complete(w: FinishWatch): void {
    if (w !== this.watch || w.done) return;
    w.done = true;
    clearTimeout(this.finishTimer);
    this.finished.emit(w.clip);
  }

  private paints(fn: (name: PaintName) => string): Record<PaintName, string> {
    return Object.fromEntries(PAINTS.map((n) => [n, fn(n)])) as Record<PaintName, string>;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
}

function safeRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? clamp(rate, MIN_RATE, MAX_RATE) : 1;
}
