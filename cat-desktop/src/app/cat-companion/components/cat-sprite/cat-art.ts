/**
 * Contract between the cat artwork (CatSprite) and the behaviour code (CatBehaviorService / CatAnimationService).
 * The behaviour code only ever talks in these animation names; the artwork decides how each one looks.
 */

export type CatAnimation =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sit'
  | 'sleep'
  | 'jump'
  | 'stretch'
  | 'look'
  | 'happy'
  | 'surprised'
  | 'dragged'
  | 'yawn'
  | 'land'
  | 'interact';

export const CAT_ANIMATION_NAMES: readonly CatAnimation[] = [
  'idle',
  'walk',
  'run',
  'sit',
  'sleep',
  'jump',
  'stretch',
  'look',
  'happy',
  'surprised',
  'dragged',
  'yawn',
  'land',
  'interact',
];

/** Fractions (0–1) of the cat box. */
export interface CatBoxFraction {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CatAnimationSpec {
  /** Looping clip (walk, idle…) or one-shot clip that ends with CatSprite.finished (jump, stretch, happy, surprised). */
  loop: boolean;
  /** Length of one cycle (loop) or of the whole clip (one-shot) at rate 1, in ms. */
  durationMs: number;
  /**
   * Union of the cat's pixels over the whole clip, as fractions of the box, for the window hit region.
   * Generous rather than tight: anything outside it cannot be clicked.
   */
  hitBox: CatBoxFraction;
  /** walk / run only: distance travelled per cycle in box widths, so that feet do not slide (rate = speed / stride). */
  strideBoxWidths?: number;
}

/**
 * Tuned by the artwork; the behaviour code reads these values and never hard-codes timings of its own.
 *
 * - hitBox values were measured from the rendered artwork over each whole clip (tests/visual/cat-preview,
 *   `render.mjs measure`) plus a margin, and are horizontally symmetric about the box centre, so they are valid for
 *   facing 'left' (mirrored) as well as 'right' without any conversion.
 * - strideBoxWidths come from the gait generator (tests/visual/cat-preview/gen-rig.mjs): at rate 1 the walk covers
 *   0.167 box widths per 520 ms cycle (≈ 51 DIP/s at scale 1), the bounding run 0.41 box widths per 420 ms (≈ 156 DIP/s).
 *   cycles per second = speed / (strideBoxWidths × box width); rate = cycles per second × durationMs / 1000.
 */
export const CAT_ANIMATIONS: Record<CatAnimation, CatAnimationSpec> = {
  idle: { loop: true, durationMs: 4000, hitBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.8 } },
  walk: { loop: true, durationMs: 520, hitBox: { x: 0.1, y: 0.21, width: 0.8, height: 0.79 }, strideBoxWidths: 0.167 },
  run: { loop: true, durationMs: 420, hitBox: { x: 0.03, y: 0.19, width: 0.94, height: 0.81 }, strideBoxWidths: 0.41 },
  sit: { loop: true, durationMs: 4000, hitBox: { x: 0.13, y: 0.05, width: 0.74, height: 0.95 } },
  sleep: { loop: true, durationMs: 3600, hitBox: { x: 0.03, y: 0.3, width: 0.94, height: 0.7 } },
  jump: { loop: false, durationMs: 900, hitBox: { x: 0.02, y: 0, width: 0.96, height: 1 } },
  stretch: { loop: false, durationMs: 2400, hitBox: { x: 0.07, y: 0.18, width: 0.86, height: 0.82 } },
  look: { loop: false, durationMs: 2600, hitBox: { x: 0.1, y: 0.17, width: 0.8, height: 0.83 } },
  happy: { loop: false, durationMs: 1400, hitBox: { x: 0.1, y: 0.14, width: 0.8, height: 0.86 } },
  surprised: { loop: false, durationMs: 1100, hitBox: { x: 0.1, y: 0.11, width: 0.8, height: 0.89 } },
  dragged: { loop: true, durationMs: 1200, hitBox: { x: 0.26, y: 0.06, width: 0.48, height: 0.88 } },
  yawn: { loop: false, durationMs: 1800, hitBox: { x: 0.1, y: 0.16, width: 0.8, height: 0.84 } },
  land: { loop: false, durationMs: 620, hitBox: { x: 0.09, y: 0.12, width: 0.82, height: 0.88 } },
  interact: { loop: false, durationMs: 1700, hitBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.8 } },
};

/**
 * Artwork detail (CatSprite only): which pose layer of the vector cat draws each clip. Clips on the same layer kind
 * ('stand') alternate between two copies of the standing rig so that switching between them can crossfade too.
 */
export type CatPoseLayer = 'stand' | 'sit' | 'sleep' | 'drag';

export const CAT_POSE_LAYER: Record<CatAnimation, CatPoseLayer> = {
  idle: 'stand',
  walk: 'stand',
  run: 'stand',
  sit: 'sit',
  sleep: 'sleep',
  jump: 'stand',
  stretch: 'stand',
  look: 'stand',
  happy: 'stand',
  surprised: 'stand',
  dragged: 'drag',
  yawn: 'stand',
  land: 'stand',
  interact: 'stand',
};
