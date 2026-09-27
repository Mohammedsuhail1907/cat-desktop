import {
  CAT_LAYOUT_EXTRA,
  CatAnchor,
  CatFacing,
  CatLayoutMode,
  CatLayoutResult,
  CatScreenInfo,
  CatSettings,
  CatWalkEndReason,
  CatWalkResult,
  MonitorInfo,
  Rect,
  WindowState,
  catBoxSize,
  normaliseCatSettings,
} from '../models';
import { browserCatStage } from './browser-cat-stage';

/** Error with a contract error code (§2); the simulator turns it into an `ok: false` response. */
export class SimulatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the cat simulation needs from the surrounding BrowserHostSimulator. */
export interface CatSimulationHost {
  /** Persisted settings and cat-box position (viewport CSS px). */
  readonly store: { catSettings: CatSettings; catPosition: { x: number; y: number } | null; settings: Record<string, unknown> };
  event(name: string, data: unknown): void;
  persist(): void;
}

interface WalkRun {
  from: { x: number; y: number };
  ux: number;
  uy: number;
  distance: number;
  durationMs: number;
  accelMs: number;
  /** Cruise speed in px/ms. */
  v: number;
  startedAt: number;
  frame: number;
  /** Set by cat.stop: decelerate from here within STOP_MS. */
  stop: { at: number; s: number; v: number } | null;
}

interface DragRun {
  follow: boolean;
  startBox: { x: number; y: number };
  ref: { px: number; py: number; bx: number; by: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const MONITOR_ID = 'BROWSER';
const STOP_MS = 200;
const MAX_ACCEL_MS = 400;
const FOLLOW_TIMEOUT_MS = 30_000;
const DEFAULT_RIGHT_MARGIN = 48;

/**
 * `cat.*` commands of the C# CatWindowService, simulated in the page for a plain browser: the viewport is the only
 * monitor (scale 1, so physical px = CSS px), the "window" is the CatOverlay element (browserCatStage), walks are
 * animated with requestAnimationFrame outside Angular, and drags follow the document's pointer events.
 * Same validation, same events, same error codes as the host.
 */
export class BrowserCatSimulation {
  private visible: boolean;
  /** Top-left of the cat box in viewport px (the persisted position). */
  private box: { x: number; y: number };
  private layout: CatLayoutResult;
  private facing: CatFacing = 'right';
  private walkRun: WalkRun | null = null;
  private dragRun: DragRun | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: CatSimulationHost) {
    const settings = this.settings;
    const size = this.boxSize();
    this.visible = settings.enabled && settings.startWithApp;
    this.box = host.store.catPosition ?? { x: viewportWidth() - size.width - DEFAULT_RIGHT_MARGIN, y: viewportHeight() - size.height };
    this.layout = this.computeLayout('cat');
    this.clampBox();
    this.paint();
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize);
  }

  private get settings(): CatSettings {
    return this.host.store.catSettings;
  }

  execute(command: string, payload: unknown): unknown {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'cat.show':
        return this.setVisible(true);
      case 'cat.hide':
        return this.setVisible(false);
      case 'cat.toggle':
        return this.setVisible(!this.visible);
      case 'cat.isVisible':
        return { visible: this.visible };
      case 'cat.getPosition':
        return this.windowState();
      case 'cat.savePosition':
        this.save();
        return this.windowState();
      case 'cat.moveTo': {
        const x = requireNumber(p, 'x');
        const y = requireNumber(p, 'y');
        if (p['monitor'] !== undefined && typeof p['monitor'] !== 'string') throw new SimulatorError('validation', "'monitor' must be a string.");
        this.box = { x: x + this.layout.box.x, y: y + this.layout.box.y };
        return this.afterMove(true);
      }
      case 'cat.moveBy': {
        const dx = requireNumber(p, 'dx');
        const dy = requireNumber(p, 'dy');
        this.box = { x: this.box.x + dx, y: this.box.y + dy };
        return this.afterMove(true);
      }
      case 'cat.walk':
        return this.walk(p);
      case 'cat.stop':
        this.stopWalk();
        return {};
      case 'cat.getScreenInfo':
        return this.screenInfo();
      case 'cat.getMonitors':
        return [this.monitor()];
      case 'cat.dragStart':
        return this.dragStart(p['followUntilClick'] === true);
      case 'cat.dragEnd':
        return { moved: this.dragRun ? this.endDrag() : false };
      case 'cat.setLayout': {
        const mode = p['mode'];
        if (mode !== 'cat' && mode !== 'menu' && mode !== 'panel') throw new SimulatorError('validation', "'mode' must be 'cat', 'menu' or 'panel'.");
        return this.setLayout(mode);
      }
      case 'cat.setHitRegion': {
        const rects = p['rects'];
        if (!Array.isArray(rects) || rects.length > 16 || !rects.every(isRect)) {
          throw new SimulatorError('validation', "'rects' must be an array of at most 16 rectangles.");
        }
        return {}; // a browser element has no window region
      }
      case 'cat.setClickThrough':
        if (typeof p['enabled'] !== 'boolean') throw new SimulatorError('validation', "'enabled' must be a boolean.");
        if (p['hoverToInteract'] !== undefined && typeof p['hoverToInteract'] !== 'boolean') {
          throw new SimulatorError('validation', "'hoverToInteract' must be a boolean.");
        }
        return {};
      case 'cat.setAlwaysOnTop':
        if (typeof p['enabled'] !== 'boolean') throw new SimulatorError('validation', "'enabled' must be a boolean.");
        return {};
      case 'cat.getSettings':
        return { ...this.settings };
      case 'cat.saveSettings':
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SimulatorError('validation', 'CatSettings object expected.');
        return this.applySettings(payload as Partial<CatSettings>, true);
      case 'cat.sendCommand': {
        const action = p['action'];
        if (typeof action !== 'string' || action.length < 1 || action.length > 64) {
          throw new SimulatorError('validation', "'action' must be a string of 1-64 characters.");
        }
        if (this.settings.enabled) this.setVisible(true);
        const command = p['payload'] === undefined ? { action } : { action, payload: p['payload'] };
        setTimeout(() => this.host.event('cat.command', command));
        return {};
      }
      default:
        throw new SimulatorError('unsupported', `Unknown command '${command}'.`);
    }
  }

  /** settings.set of `cat.settings` (raw store write) behaves like cat.saveSettings. */
  applyStoredSettings(value: unknown): void {
    if (value && typeof value === 'object') this.applySettings(value as Partial<CatSettings>, false);
  }

  // ---- visibility & settings ----------------------------------------------------------------

  private setVisible(visible: boolean): { visible: boolean } {
    const next = visible && this.settings.enabled;
    if (!next) {
      if (this.walkRun) this.endWalk('hidden');
      if (this.dragRun) this.endDrag();
    }
    if (next !== this.visible) {
      this.visible = next;
      this.paint();
      this.host.event('cat.visibilityChanged', { visible: next });
    }
    return { visible: this.visible };
  }

  private applySettings(value: Partial<CatSettings>, emitStoreEvent: boolean): CatSettings {
    const previous = this.settings;
    const next = normaliseCatSettings(value);
    this.host.store.catSettings = next;
    this.host.store.settings['cat.settings'] = next;
    const before = catBoxSize(previous.scale);
    const after = catBoxSize(next.scale);
    if (before.width !== after.width || before.height !== after.height) {
      // Resized at once: the cat's bottom-centre point stays where it was, then the box is clamped (contract §3).
      if (this.walkRun) this.endWalk('layout');
      this.box = { x: this.box.x + (before.width - after.width) / 2, y: this.box.y + before.height - after.height };
      const mode = this.layout.mode;
      this.layout = this.computeLayout(mode, this.layout.anchor);
      this.clampBox();
      if (mode !== 'cat') this.clampWindow();
      this.paint();
      this.save();
      this.host.event('cat.layoutChanged', this.layout);
      this.host.event('cat.positionChanged', this.windowState());
    }
    this.host.persist();
    this.host.event('cat.settingsChanged', next);
    if (emitStoreEvent) this.host.event('settings.changed', { key: 'cat.settings', value: next });
    if (!next.enabled && this.visible) this.setVisible(false);
    else if (next.enabled && !previous.enabled) this.setVisible(true);
    return next;
  }

  // ---- walking ------------------------------------------------------------------------------

  private walk(p: Record<string, unknown>): CatWalkResult {
    const dx = requireNumber(p, 'dx');
    const dy = p['dy'] === undefined ? 0 : requireNumber(p, 'dy');
    const speed = requireNumber(p, 'speed');
    if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000) throw new SimulatorError('validation', "'dx' and 'dy' must be within ±10000.");
    if (speed < 10 || speed > 600) throw new SimulatorError('validation', "'speed' must be between 10 and 600.");
    if (this.dragRun) throw new SimulatorError('denied', 'The cat is being dragged.');
    if (!this.visible) throw new SimulatorError('denied', 'The cat is hidden.');
    if (this.layout.mode !== 'cat') throw new SimulatorError('denied', "The cat only walks in the 'cat' layout.");
    if (this.walkRun) this.endWalk('replaced');

    const room = this.room();
    const cdx = clamp(dx, -room.left, room.right);
    const cdy = clamp(dy, -room.up, room.down);
    const distance = Math.hypot(cdx, cdy);
    if (cdx !== 0) this.facing = cdx < 0 ? 'left' : 'right';
    if (distance < 0.5) {
      // Already touching the edge → blocked; nothing asked for → arrived.
      const reason: CatWalkEndReason = Math.hypot(dx, dy) < 0.5 ? 'arrived' : 'blocked';
      setTimeout(() => this.host.event('cat.walkEnded', { reason, ...this.windowXY() }));
      return { dx: 0, dy: 0, durationMs: 0, accelMs: 0, facing: this.facing };
    }

    // Trapezoid profile: accelerate over accelMs (≤ 400 ms and ≤ 30 %), cruise, decelerate symmetrically.
    const cruiseMs = (distance / speed) * 1000;
    let durationMs = cruiseMs + MAX_ACCEL_MS;
    let accelMs = MAX_ACCEL_MS;
    if (accelMs > durationMs * 0.3) {
      durationMs = cruiseMs / 0.7;
      accelMs = durationMs * 0.3;
    }
    const run: WalkRun = {
      from: { ...this.box },
      ux: cdx / distance,
      uy: cdy / distance,
      distance,
      durationMs,
      accelMs,
      v: distance / (durationMs - accelMs),
      startedAt: performance.now(),
      frame: 0,
      stop: null,
    };
    this.walkRun = run;
    run.frame = requestAnimationFrame(this.walkStep);
    return { dx: round2(cdx), dy: round2(cdy), durationMs: Math.round(durationMs), accelMs: Math.round(accelMs), facing: this.facing };
  }

  private readonly walkStep = (now: number): void => {
    const run = this.walkRun;
    if (!run) return;
    let s: number;
    let done = false;
    if (run.stop) {
      const t = Math.min(STOP_MS, now - run.stop.at);
      s = run.stop.s + run.stop.v * t - (run.stop.v * t * t) / (2 * STOP_MS);
      done = t >= STOP_MS;
    } else {
      const t = now - run.startedAt;
      s = walkDistanceAt(run, t);
      done = t >= run.durationMs;
    }
    s = Math.min(run.distance, Math.max(0, s));
    this.box = { x: run.from.x + run.ux * s, y: run.from.y + run.uy * s };
    this.paint();
    if (done || s >= run.distance) {
      this.endWalk(run.stop ? 'stopped' : 'arrived');
      return;
    }
    run.frame = requestAnimationFrame(this.walkStep);
  };

  private stopWalk(): void {
    const run = this.walkRun;
    if (!run || run.stop) return;
    const now = performance.now();
    const t = now - run.startedAt;
    run.stop = { at: now, s: walkDistanceAt(run, t), v: walkSpeedAt(run, t) };
  }

  private endWalk(reason: CatWalkEndReason): void {
    const run = this.walkRun;
    if (!run) return;
    cancelAnimationFrame(run.frame);
    this.walkRun = null;
    this.box = { x: Math.round(this.box.x), y: Math.round(this.box.y) };
    this.paint();
    this.save();
    const ended = { reason, ...this.windowXY() };
    // Like the host: the event follows whatever response is on its way.
    setTimeout(() => {
      this.host.event('cat.walkEnded', ended);
      this.host.event('cat.positionChanged', this.windowState());
    });
  }

  // ---- dragging -----------------------------------------------------------------------------

  private dragStart(follow: boolean): Record<string, never> {
    if (this.layout.mode !== 'cat') throw new SimulatorError('denied', "The cat can only be dragged in the 'cat' layout.");
    if (!this.visible) throw new SimulatorError('denied', 'The cat is hidden.');
    if (this.dragRun) return {}; // a second dragStart during a drag is ignored
    if (this.walkRun) this.endWalk('dragged');
    this.dragRun = {
      follow,
      startBox: { ...this.box },
      ref: null,
      timer: follow ? setTimeout(() => this.endDrag(), FOLLOW_TIMEOUT_MS) : null,
    };
    document.addEventListener('pointermove', this.onDragMove, true);
    document.addEventListener('keydown', this.onDragKey, true);
    if (follow) {
      document.addEventListener('pointerdown', this.onFollowClick, true);
    } else {
      document.addEventListener('pointerup', this.onDragRelease, true);
      document.addEventListener('pointercancel', this.onDragRelease, true);
    }
    this.host.event('cat.dragStateChanged', { dragging: true });
    return {};
  }

  private readonly onDragMove = (event: PointerEvent): void => {
    const run = this.dragRun;
    if (!run) return;
    if (!run.follow && event.buttons === 0) {
      this.endDrag(); // the button was released before the drag started
      return;
    }
    const size = this.boxSize();
    if (!run.ref) {
      // Hold on to the grab offset; "Move Cat" (follow mode) picks the cat up by its middle instead.
      const start = run.follow ? { x: event.clientX - size.width / 2, y: event.clientY - size.height * 0.6 } : this.box;
      run.ref = { px: event.clientX, py: event.clientY, bx: start.x, by: start.y };
    }
    this.box = { x: run.ref.bx + event.clientX - run.ref.px, y: run.ref.by + event.clientY - run.ref.py };
    this.clampBox();
    this.paint();
  };

  private readonly onDragRelease = (): void => {
    this.endDrag();
  };

  private readonly onFollowClick = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endDrag();
  };

  /** Esc cancels any drag: the cat goes back to where the drag started. */
  private readonly onDragKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.dragRun) return;
    event.preventDefault();
    this.box = { ...this.dragRun.startBox };
    this.endDrag();
  };

  private endDrag(): boolean {
    const run = this.dragRun;
    if (!run) return false;
    this.dragRun = null;
    if (run.timer) clearTimeout(run.timer);
    document.removeEventListener('pointermove', this.onDragMove, true);
    document.removeEventListener('pointerup', this.onDragRelease, true);
    document.removeEventListener('pointercancel', this.onDragRelease, true);
    document.removeEventListener('pointerdown', this.onFollowClick, true);
    document.removeEventListener('keydown', this.onDragKey, true);
    this.box = { x: Math.round(this.box.x), y: Math.round(this.box.y) };
    this.paint();
    this.save();
    const distance = Math.round(Math.hypot(this.box.x - run.startBox.x, this.box.y - run.startBox.y));
    const moved = distance > 0;
    this.host.event('cat.dragStateChanged', { dragging: false });
    this.host.event('cat.dragEnded', { ...this.windowXY(), monitor: MONITOR_ID, moved, distance });
    if (moved) this.host.event('cat.positionChanged', this.windowState());
    return moved;
  }

  // ---- layout -------------------------------------------------------------------------------

  private setLayout(mode: CatLayoutMode): CatLayoutResult {
    if (this.walkRun) this.endWalk('layout');
    this.layout = this.computeLayout(mode);
    this.clampWindow();
    this.clampBox();
    this.paint();
    this.save();
    this.host.event('cat.layoutChanged', this.layout);
    this.host.event('cat.positionChanged', this.windowState());
    return this.layout;
  }

  /** The whole window goes inside the viewport; the cat box moves with it when it has to. */
  private clampWindow(): void {
    const frame = { x: this.box.x - this.layout.box.x, y: this.box.y - this.layout.box.y };
    const clamped = {
      x: clamp(frame.x, 0, Math.max(0, viewportWidth() - this.layout.width)),
      y: clamp(frame.y, 0, Math.max(0, viewportHeight() - this.layout.height)),
    };
    this.box = { x: clamped.x + this.layout.box.x, y: clamped.y + this.layout.box.y };
  }

  /** Window size and anchor for a layout; `keepAnchor` keeps the open side while a menu/panel is resized. */
  private computeLayout(mode: CatLayoutMode, keepAnchor?: CatAnchor): CatLayoutResult {
    const size = this.boxSize();
    const extra = mode === 'cat' ? null : CAT_LAYOUT_EXTRA[mode];
    const width = extra ? Math.max(size.width, extra.minWidth) : size.width;
    const height = extra ? size.height + extra.extraHeight : size.height;
    // The extra area opens toward the side of the screen with more room.
    const vertical = keepAnchor ? keepAnchor.split('-')[0] : this.box.y + size.height / 2 >= viewportHeight() / 2 ? 'bottom' : 'top';
    const horizontal = keepAnchor ? keepAnchor.split('-')[1] : this.box.x + size.width / 2 >= viewportWidth() / 2 ? 'right' : 'left';
    const anchor = `${vertical}-${horizontal}` as CatAnchor;
    const box: Rect = {
      x: horizontal === 'right' ? width - size.width : 0,
      y: vertical === 'bottom' ? height - size.height : 0,
      width: size.width,
      height: size.height,
    };
    return { mode, anchor, width, height, box };
  }

  // ---- geometry helpers ---------------------------------------------------------------------

  private afterMove(isWindowMove = false): WindowState {
    if (this.walkRun) this.endWalk('stopped');
    if (isWindowMove && this.layout.mode !== 'cat') this.clampWindow(); // menu/panel: the whole window stays inside
    this.clampBox();
    this.paint();
    this.save();
    const state = this.windowState();
    this.host.event('cat.positionChanged', state);
    return state;
  }

  private boxSize(): { width: number; height: number } {
    return catBoxSize(this.settings.scale);
  }

  private clampBox(): void {
    const size = this.boxSize();
    this.box = {
      x: clamp(this.box.x, 0, Math.max(0, viewportWidth() - size.width)),
      y: clamp(this.box.y, 0, Math.max(0, viewportHeight() - size.height)),
    };
  }

  private room(): CatScreenInfo['room'] {
    const size = this.boxSize();
    return {
      left: Math.max(0, Math.floor(this.box.x)),
      right: Math.max(0, Math.floor(viewportWidth() - size.width - this.box.x)),
      up: Math.max(0, Math.floor(this.box.y)),
      down: Math.max(0, Math.floor(viewportHeight() - size.height - this.box.y)),
    };
  }

  private windowXY(): { x: number; y: number } {
    return { x: Math.round(this.box.x - this.layout.box.x), y: Math.round(this.box.y - this.layout.box.y) };
  }

  private monitor(): MonitorInfo {
    const rect = { x: 0, y: 0, width: viewportWidth(), height: viewportHeight() };
    return { id: MONITOR_ID, primary: true, bounds: rect, workArea: { ...rect }, scale: 1 };
  }

  private screenInfo(): CatScreenInfo {
    const monitor = this.monitor();
    return { monitor, monitors: [monitor], window: this.windowState(), box: { ...this.layout.box }, room: this.room() };
  }

  private windowState(): WindowState {
    return {
      windowId: 'cat',
      monitor: MONITOR_ID,
      ...this.windowXY(),
      width: this.layout.width,
      height: this.layout.height,
      isMaximized: false,
      isMinimized: false,
      isVisible: this.visible,
      alwaysOnTop: this.settings.alwaysOnTop,
    };
  }

  private paint(): void {
    browserCatStage.update({ ...this.windowXY(), width: this.layout.width, height: this.layout.height, visible: this.visible });
  }

  private save(): void {
    this.host.store.catPosition = { x: Math.round(this.box.x), y: Math.round(this.box.y) };
    this.host.persist();
  }

  private readonly onResize = (): void => {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.walkRun) this.endWalk('stopped');
      this.clampBox();
      this.paint();
      this.host.event('cat.screenChanged', this.screenInfo());
      this.host.event('cat.positionChanged', this.windowState());
    }, 150);
  };
}

/** Distance travelled after t ms on the trapezoid speed profile. */
function walkDistanceAt(run: WalkRun, t: number): number {
  const { accelMs: a, durationMs: T, v, distance } = run;
  if (t <= 0) return 0;
  if (t >= T) return distance;
  if (a <= 0) return v * t;
  if (t < a) return (v * t * t) / (2 * a);
  if (t <= T - a) return (v * a) / 2 + v * (t - a);
  const left = T - t;
  return distance - (v * left * left) / (2 * a);
}

/** Speed in px/ms after t ms. */
function walkSpeedAt(run: WalkRun, t: number): number {
  const { accelMs: a, durationMs: T, v } = run;
  if (t <= 0 || t >= T) return 0;
  if (a <= 0) return v;
  if (t < a) return (v * t) / a;
  if (t <= T - a) return v;
  return (v * (T - t)) / a;
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

function viewportHeight(): number {
  return typeof window === 'undefined' ? 800 : window.innerHeight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function requireNumber(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SimulatorError('validation', `'${key}' must be a number.`);
  return v;
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number));
}
