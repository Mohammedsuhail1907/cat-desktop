/** Desktop Cat Companion – contract §3 cat.*, §5 CatSettings, §7 geometry. */

import { WindowState } from './window.model';

/** Legacy size presets (Pet Book / first cat release), read as a scale – see {@link LEGACY_CAT_SIZE_SCALE}. */
export type LegacyCatSize = 'small' | 'medium' | 'large';
export type CatFacing = 'left' | 'right';
export type CatLayoutMode = 'cat' | 'menu' | 'panel';
export type CatAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface CatSettings {
  enabled: boolean;
  startWithApp: boolean;
  autoWalk: boolean;
  alwaysOnTop: boolean;
  interaction: boolean;
  clickThroughWhenIdle: boolean;
  randomIdle: boolean;
  randomActions: boolean;
  sound: boolean;
  /** Multiplier 0.5–2 of the base walk speed ({@link CAT_BASE_WALK_SPEED}). */
  walkingSpeed: number;
  /** Cat size: 0.1–2 (10 %–200 %) of the reference box {@link CAT_REFERENCE_BOX}. */
  scale: number;
  /** Theme id from CAT_THEMES (cat-companion/components/cat-sprite/cat-themes.ts); unknown ids render as 'classic'. */
  theme: string;
  /** 0.3–1 */
  opacity: number;
}

export const DEFAULT_CAT_SETTINGS: CatSettings = {
  enabled: true,
  startWithApp: true,
  autoWalk: true,
  alwaysOnTop: true,
  interaction: true,
  clickThroughWhenIdle: false,
  randomIdle: true,
  randomActions: true,
  sound: false,
  walkingSpeed: 1,
  scale: 1,
  theme: 'classic',
  opacity: 1,
};

/** Base walking speed in DIP/s at walkingSpeed = 1. */
export const CAT_BASE_WALK_SPEED = 55;

export const CAT_SCALE_MIN = 0.1;
export const CAT_SCALE_MAX = 2;

/** The cat box at scale 1 (CSS px, 4:3) – contract §7. */
export const CAT_REFERENCE_BOX = { width: 160, height: 120 } as const;

/** Cat box for a scale: round(160 × scale) × round(120 × scale), at least 16 × 12 (contract §7). */
export function catBoxSize(scale: number): { width: number; height: number } {
  const s = clampScale(scale);
  return {
    width: Math.max(16, Math.round(CAT_REFERENCE_BOX.width * s)),
    height: Math.max(12, Math.round(CAT_REFERENCE_BOX.height * s)),
  };
}

/** Scale of the legacy size presets (contract §5). */
export const LEGACY_CAT_SIZE_SCALE: Record<LegacyCatSize, number> = { small: 0.7, medium: 1, large: 1.4 };

export const CAT_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function clampScale(scale: number): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  return Math.round(Math.min(CAT_SCALE_MAX, Math.max(CAT_SCALE_MIN, scale)) * 100) / 100;
}

/** Extra area of the non-`cat` layouts – contract §7. */
export const CAT_LAYOUT_EXTRA: Record<Exclude<CatLayoutMode, 'cat'>, { minWidth: number; extraHeight: number }> = {
  menu: { minWidth: 240, extraHeight: 360 },
  panel: { minWidth: 340, extraHeight: 456 },
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorInfo {
  /** Device name, e.g. \\.\DISPLAY1 */
  id: string;
  primary: boolean;
  /** Physical px. */
  bounds: Rect;
  /** Physical px, taskbar excluded. */
  workArea: Rect;
  /** DPI scale (1 = 96 DPI). */
  scale: number;
}

export interface CatRoom {
  left: number;
  right: number;
  up: number;
  down: number;
}

export interface CatScreenInfo {
  monitor: MonitorInfo;
  monitors: MonitorInfo[];
  window: WindowState;
  /** Cat box inside the window, CSS px. */
  box: Rect;
  /** DIPs the cat box can move before touching the work-area edge. */
  room: CatRoom;
}

export interface CatWalkRequest {
  dx: number;
  dy?: number;
  /** DIP/s, 10–600 */
  speed: number;
}

export interface CatWalkResult {
  dx: number;
  dy: number;
  durationMs: number;
  accelMs: number;
  facing: CatFacing;
}

export type CatWalkEndReason = 'arrived' | 'stopped' | 'replaced' | 'dragged' | 'hidden' | 'layout' | 'blocked';

export interface CatWalkEnded {
  reason: CatWalkEndReason;
  x: number;
  y: number;
}

export interface CatDragEnded {
  x: number;
  y: number;
  monitor: string;
  moved: boolean;
  /** DIPs */
  distance: number;
}

export interface CatLayoutResult {
  mode: CatLayoutMode;
  anchor: CatAnchor;
  /** Window size, CSS px. */
  width: number;
  height: number;
  /** Cat box inside the window, CSS px. */
  box: Rect;
}

export type CatCommandAction =
  | 'open-menu'
  | 'open-panel'
  | 'quick-note'
  | 'tasks'
  | 'focus'
  | 'reminders'
  | 'pause-walking'
  | 'start-walking'
  | 'toggle-walking'
  | 'meow';

export interface CatCommand {
  action: CatCommandAction | (string & {});
  payload?: unknown;
}

export interface CatClickThroughRequest {
  enabled: boolean;
  hoverToInteract?: boolean;
}

/** Defaults for missing keys and the ranges of contract §5 (the host normalises the same way). */
export function normaliseCatSettings(value: Partial<CatSettings> | null | undefined): CatSettings {
  const d = DEFAULT_CAT_SETTINGS;
  const s: Partial<CatSettings> = value && typeof value === 'object' ? value : {};
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const num = (v: unknown, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: bool(s.enabled, d.enabled),
    startWithApp: bool(s.startWithApp, d.startWithApp),
    autoWalk: bool(s.autoWalk, d.autoWalk),
    alwaysOnTop: bool(s.alwaysOnTop, d.alwaysOnTop),
    interaction: bool(s.interaction, d.interaction),
    clickThroughWhenIdle: bool(s.clickThroughWhenIdle, d.clickThroughWhenIdle),
    randomIdle: bool(s.randomIdle, d.randomIdle),
    randomActions: bool(s.randomActions, d.randomActions),
    sound: bool(s.sound, d.sound),
    walkingSpeed: num(s.walkingSpeed, 0.5, 2, d.walkingSpeed),
    scale: legacyAwareScale(s),
    theme: typeof s.theme === 'string' && CAT_THEME_ID_PATTERN.test(s.theme) ? s.theme : d.theme,
    opacity: num(s.opacity, 0.3, 1, d.opacity),
  };
}

/** scale, or the legacy size preset of a value stored before scales existed (contract §5). */
function legacyAwareScale(s: Partial<CatSettings> & { size?: unknown }): number {
  if (typeof s.scale === 'number' && Number.isFinite(s.scale)) return clampScale(s.scale);
  const legacy = s.size;
  if (legacy === 'small' || legacy === 'medium' || legacy === 'large') return LEGACY_CAT_SIZE_SCALE[legacy];
  return DEFAULT_CAT_SETTINGS.scale;
}
