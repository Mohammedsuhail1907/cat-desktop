/**
 * Every tunable of the cat's behaviour in one place. Ranges are [min, max] in ms and are sampled uniformly;
 * transition weights are relative (0 = never). Animation lengths are NOT here: they belong to the artwork
 * (CAT_ANIMATIONS in cat-art.ts) and one-shot states last exactly as long as their clip.
 */

/** The behaviour states of the cat (CatBehaviorService.state). */
export type CatBehaviorState =
  | 'idle'
  | 'walking'
  | 'running'
  | 'sitting'
  | 'sleeping'
  | 'stretching'
  | 'yawning'
  | 'jumping'
  | 'looking'
  | 'dragged'
  | 'interacting';

/** What the state machine can decide to do next. `happy` is a wiggle played while idle. */
export type CatBehaviorChoice = 'idle' | 'walk' | 'run' | 'sit' | 'sleep' | 'look' | 'yawn' | 'stretch' | 'jump' | 'happy';

/** Reactions to a single click; never the same one twice in a row. `meow` only with sound on. */
export type CatClickReaction = 'gaze' | 'jump' | 'happy' | 'interact' | 'meow';

export type MsRange = readonly [number, number];

/** Which settings flag gates a choice (contract §5): autoWalk, randomIdle or randomActions. */
export const CHOICE_GATES: Readonly<Record<CatBehaviorChoice, 'autoWalk' | 'randomIdle' | 'randomActions' | null>> = {
  idle: null,
  walk: 'autoWalk',
  run: 'autoWalk', // …and randomActions
  sit: 'randomIdle',
  sleep: 'randomIdle',
  look: 'randomIdle',
  yawn: 'randomIdle',
  stretch: 'randomActions',
  jump: 'randomActions',
  happy: 'randomActions',
};

export const CAT_BEHAVIOR_CONFIG = {
  /** A normal walk lasts this long (distance = speed × duration, shortened by the room on screen). */
  walkMs: [5_000, 12_000] as MsRange,
  /** Rare short runs. */
  runMs: [1_200, 2_800] as MsRange,
  /** Run speed = walk speed × this. */
  runSpeedFactor: 3,
  /** Each walk's speed = CAT_BASE_WALK_SPEED × settings.walkingSpeed × a random factor in this range. */
  speedJitter: [0.8, 1.2] as const,
  /** Pause / idle between activities. */
  idleMs: [1_000, 4_000] as MsRange,
  /** Idle before the loop starts again after a pause (menu closed, window shown again…). */
  resumeMs: [800, 2_500] as MsRange,
  /** Sitting; sometimes (longSitChance) a long sit instead. */
  sitMs: [2_000, 6_000] as MsRange,
  longSitMs: [6_000, 20_000] as MsRange,
  longSitChance: 0.3,
  /** Naps. */
  sleepMs: [20_000, 90_000] as MsRange,
  /** No nap until the cat has been awake this long (sleep stays occasional). */
  minAwakeBeforeSleepMs: 180_000,
  /** After a drag: sit (or stand) this long, then carry on as usual. */
  afterDragMs: [2_000, 4_000] as MsRange,
  /** Grabbed: this much of the 'surprised' clip, then the dangling 'dragged' loop. */
  grabSurpriseMs: 450,
  /** After landing: chance to sit (else stand idle) before carrying on. */
  afterDragSitChance: 0.6,
  /** A nap is preceded by a yawn this often; waking up is always yawn → stretch (stretch needs randomActions). */
  preSleepYawnChance: 0.7,
  /** Hover: gaze follows the pointer at most this often (only while idle, sitting or looking). */
  hoverGazeIntervalMs: 100,
  /** Gaze toward the click / hover point for this long. */
  gazeHoldMs: 1_600,

  /** Chance to keep walking the way the cat is facing (otherwise it picks a side at random). */
  keepDirectionChance: 0.65,
  /** Turn around when less room than this (in cat-box widths) is left ahead. */
  edgeTurnBoxWidths: 1.5,
  /** Walks shorter than this (DIPs) are not worth it: try the other way, else stay. */
  minWalkDistance: 40,
  /** Keep this many DIPs from the work-area edge. */
  edgeMargin: 4,
  /** Occasionally a slight diagonal: |dy| ≤ maxDiagonal × |dx|. */
  diagonalChance: 0.2,
  maxDiagonal: 0.3,
  /** Extra time after durationMs before a walk is considered over without cat.walkEnded (host safety net). */
  walkEndGraceMs: 1_500,

  /** Next choice, by the state the cat is leaving. Filtered by the settings gates before sampling. */
  transitions: {
    idle: { walk: 5, run: 0.35, sit: 2, look: 1.2, yawn: 0.35, sleep: 0.35, jump: 0.3, happy: 0.3, idle: 0.6 },
    walking: { idle: 4, sit: 1.6, look: 1.4, walk: 1.2, run: 0.25, jump: 0.2, happy: 0.2 },
    running: { idle: 3, sit: 2, look: 1, walk: 0.8 },
    sitting: { idle: 2, walk: 2.5, look: 1.2, yawn: 0.6, sleep: 0.9, stretch: 0.3 },
    sleeping: { stretch: 3, idle: 1 },
    stretching: { walk: 3, idle: 2, sit: 0.6 },
    yawning: { sit: 1.5, idle: 1.5, sleep: 0.6, walk: 1 },
    looking: { idle: 2, walk: 2.5, sit: 1.2, yawn: 0.2, sleep: 0.2 },
    jumping: { idle: 2, walk: 2, sit: 0.8, happy: 0.3 },
    interacting: { idle: 3, walk: 2, sit: 1.2, look: 0.8 },
    dragged: { idle: 2, sit: 2, look: 1 },
  } satisfies Record<CatBehaviorState, Partial<Record<CatBehaviorChoice, number>>>,

  /** Click reactions (weights). `meow` only when sound is on; the previous reaction is never repeated. */
  clickReactions: { gaze: 3, happy: 2, jump: 1.5, interact: 2, meow: 2 } satisfies Record<CatClickReaction, number>,
  /** Chance of a (rate-limited) spontaneous sound when waking up / settling into a long sit. */
  wakeMeowChance: 0.5,
  longSitPurrChance: 0.35,
} as const;

export function randomIn([min, max]: MsRange | readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

/** Weighted random pick; null when every weight is 0. */
export function pickWeighted<K extends string>(weights: Partial<Record<K, number>>): K | null {
  const entries = (Object.entries(weights) as [K, number][]).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}
