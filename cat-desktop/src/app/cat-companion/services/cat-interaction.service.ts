import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DesktopBridgeService } from '../../core/desktop/desktop-bridge.service';
import { CatClickThroughRequest, CatLayoutMode } from '../../core/models';
import { CatSettingsService } from '../../core/services/cat-settings.service';
import { CatWindowService } from '../../core/services/cat-window.service';
import { CatAnimationService } from './cat-animation.service';
import { CAT_BEHAVIOR_CONFIG, CatBehaviorState } from './cat-behavior.config';
import { CatBehaviorService } from './cat-behavior.service';
import { CatSoundService } from './cat-sound.service';

/** What the companion panel shows below its quick-action strip. */
export type CompanionTab = 'home' | 'quick-note' | 'tasks' | 'focus' | 'reminders';

/** Pointer travel (screen px) with the button held that turns a press into a drag. */
const DRAG_THRESHOLD_PX = 4;
/** A press shorter than this without a drag is a click… */
const CLICK_MAX_MS = 300;
/** …and a second click within this time makes it a double click (the single-click reaction waits for it). */
const DOUBLE_CLICK_MS = 300;
/** Ignore a window blur right after the menu opened (activation and resizing settle). */
const BLUR_GRACE_MS = 400;
/** cat.dragStateChanged(false) without a cat.dragEnded: finish the drag after this. */
const DRAG_END_FALLBACK_MS = 600;
/** The cat follows the hovering pointer only while resting. */
const HOVER_STATES: ReadonlySet<CatBehaviorState> = new Set(['idle', 'sitting', 'looking']);

interface PointerSession {
  id: number;
  screenX: number;
  screenY: number;
  at: number;
  dragging: boolean;
}

/**
 * Mouse and keyboard on the cat, and the window layout that goes with it:
 *  - press + move > 4 px → cat.dragStart; the HOST moves the window with the native cursor until release
 *    (nothing is moved here); cat.dragEnded → a reaction, a sit, then normal behaviour.
 *  - click (< 300 ms, no drag, no second click) → a random reaction; double click → companion panel;
 *    right click → context menu. Esc, a click outside or losing focus closes them.
 *  - settings.interaction = false → all pointer input on the cat is ignored.
 *  - while a menu/panel is open the window is never click-through; closing hands control back to the
 *    settings-driven mode.
 */
@Injectable()
export class CatInteractionService {
  private readonly document = inject(DOCUMENT);
  private readonly bridge = inject(DesktopBridgeService);
  private readonly catWindow = inject(CatWindowService);
  private readonly catSettings = inject(CatSettingsService);
  private readonly behavior = inject(CatBehaviorService);
  private readonly anim = inject(CatAnimationService);
  private readonly sound = inject(CatSoundService);

  /** The layout the UI asked for last; the one on screen is {@link mode}. */
  readonly requestedMode = signal<CatLayoutMode>('cat');
  /** The layout the host applied (what is rendered). */
  readonly mode = computed<CatLayoutMode>(() => this.catWindow.layout()?.mode ?? 'cat');
  readonly panelTab = signal<CompanionTab>('home');
  /** The pointer is over the cat box. */
  readonly hovering = signal(false);

  private catBox: HTMLElement | null = null;
  private pointer: PointerSession | null = null;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastClickAt = 0;
  private openedAt = 0;
  private layoutChain: Promise<void> = Promise.resolve();
  private layoutRequests = 0;
  private dragFallback: ReturnType<typeof setTimeout> | null = null;
  private hoverPoint: { x: number; y: number } | null = null;
  private hoverAt = 0;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.catWindow.dragEnded$.pipe(takeUntilDestroyed(destroyRef)).subscribe((ended) => {
      this.clearDragFallback();
      void this.behavior.dragFinished(ended.moved);
    });
    this.catWindow.dragState$.pipe(takeUntilDestroyed(destroyRef)).subscribe(({ dragging }) => {
      this.clearDragFallback();
      if (dragging) {
        if (this.behavior.state() !== 'dragged') this.behavior.dragStarted(); // e.g. a drag started by the host
        return;
      }
      this.dragFallback = setTimeout(() => {
        this.dragFallback = null;
        if (this.behavior.state() === 'dragged') void this.behavior.dragFinished(false);
      }, DRAG_END_FALLBACK_MS);
    });
    // A layout the host changed on its own (not requested here): follow it.
    this.catWindow.layoutChanged$.pipe(takeUntilDestroyed(destroyRef)).subscribe((layout) => {
      if (this.layoutRequests > 0 || layout.mode === this.requestedMode()) return;
      this.requestedMode.set(layout.mode);
      if (layout.mode === 'cat') this.afterClosed();
      else this.behavior.menuOpened();
    });
    // Hover: ears up and eyes on the pointer while the cat rests; dropped as soon as it gets busy.
    effect(() => {
      const engaged = this.hovering() && HOVER_STATES.has(this.behavior.state()) && this.requestedMode() === 'cat';
      untracked(() => {
        this.anim.hoverAttentive.set(engaged);
        this.anim.followPointer(engaged ? this.hoverPoint : null);
      });
    });
    destroyRef.onDestroy(() => this.detach());
  }

  /** Wire the pointer and keyboard handlers (called once by CatCompanionWindow after render). */
  attach(catBox: HTMLElement): void {
    this.detach();
    this.catBox = catBox;
    catBox.addEventListener('pointerdown', this.onPointerDown);
    catBox.addEventListener('pointermove', this.onPointerMove);
    catBox.addEventListener('pointerup', this.onPointerUp);
    catBox.addEventListener('pointercancel', this.onPointerCancel);
    catBox.addEventListener('pointerenter', this.onPointerEnter);
    catBox.addEventListener('pointerleave', this.onPointerLeave);
    catBox.addEventListener('contextmenu', this.onContextMenu);
    catBox.addEventListener('keydown', this.onCatKeyDown);
    this.document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    this.document.addEventListener('keydown', this.onDocumentKeyDown);
    if (this.bridge.isHosted) this.document.defaultView?.addEventListener('blur', this.onWindowBlur);
  }

  // ---- layout -----------------------------------------------------------------------------

  openMenu(): Promise<void> {
    return this.requestLayout('menu');
  }

  openPanel(tab: CompanionTab = 'home'): Promise<void> {
    this.panelTab.set(tab);
    return this.requestLayout('panel');
  }

  close(): Promise<void> {
    return this.requestLayout('cat');
  }

  /**
   * Resize the window for the menu/panel (or back to the cat). Requests are serialised; a request superseded by
   * a newer one is skipped. In the host the menu renders once the window has its new size (cat.layoutChanged /
   * the setLayout result update CatWindowService.layout).
   */
  requestLayout(mode: CatLayoutMode): Promise<void> {
    this.requestedMode.set(mode);
    if (mode !== 'cat') {
      this.cancelPendingClick();
      this.openedAt = performance.now();
      this.behavior.menuOpened();
    }
    this.layoutRequests++;
    const run = async (): Promise<void> => {
      try {
        if (this.requestedMode() !== mode) return;
        try {
          await this.catWindow.setLayout(mode);
        } catch (err) {
          console.warn(`[cat] setLayout '${mode}' failed`, err);
          if (mode !== 'cat' && this.requestedMode() === mode) {
            this.requestedMode.set('cat');
            this.behavior.menuClosed();
          }
          return;
        }
        if (this.requestedMode() !== mode) return;
        if (mode === 'cat') {
          this.afterClosed();
        } else {
          await this.catWindow.setClickThrough({ enabled: false }).catch((err) => console.warn('[cat] setClickThrough failed', err));
          // Keyboard navigation and "click outside closes" need the (normally inactive) cat window focused.
          if (this.bridge.isHosted) this.bridge.invoke('window.focus').catch(() => undefined);
        }
      } finally {
        this.layoutRequests--;
      }
    };
    this.layoutChain = this.layoutChain.then(run, run);
    return this.layoutChain;
  }

  /** The settings-driven click-through mode (contract §5), handed back when a menu/panel closes. */
  clickThroughFromSettings(): CatClickThroughRequest {
    const s = this.catSettings.settings();
    if (!s.interaction) return { enabled: true, hoverToInteract: false };
    if (s.clickThroughWhenIdle) return { enabled: true, hoverToInteract: true };
    return { enabled: false };
  }

  private afterClosed(): void {
    this.catWindow.setClickThrough(this.clickThroughFromSettings()).catch((err) => console.warn('[cat] setClickThrough failed', err));
    this.behavior.menuClosed();
  }

  // ---- drag -------------------------------------------------------------------------------

  /** "Move Cat": close the menu, then the cat follows the cursor until the next click (host: or Esc / 30 s). */
  async moveCat(): Promise<void> {
    await this.close();
    await this.startDrag(true);
  }

  private async startDrag(followUntilClick: boolean): Promise<void> {
    this.cancelPendingClick();
    this.behavior.dragStarted();
    try {
      await this.catWindow.dragStart(followUntilClick ? { followUntilClick: true } : undefined);
    } catch (err) {
      console.warn('[cat] dragStart failed', err);
      this.behavior.dragAborted();
    }
  }

  private clearDragFallback(): void {
    if (this.dragFallback) clearTimeout(this.dragFallback);
    this.dragFallback = null;
  }

  // ---- pointer ----------------------------------------------------------------------------

  private get interactive(): boolean {
    return this.catSettings.settings().interaction;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.sound.unlock();
    if (event.button !== 0 || !this.interactive || !this.catBox) return;
    if (this.requestedMode() !== 'cat') {
      void this.close(); // a click on the cat folds an open menu/panel away
      return;
    }
    this.pointer = { id: event.pointerId, screenX: event.screenX, screenY: event.screenY, at: performance.now(), dragging: false };
    try {
      this.catBox.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best effort (synthetic events) */
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const p = this.pointer;
    if (!p) {
      this.trackHover(event);
      return;
    }
    if (p.dragging || event.pointerId !== p.id) return;
    // Screen coordinates: in the host the window itself moves under the cursor once the drag runs.
    if (Math.hypot(event.screenX - p.screenX, event.screenY - p.screenY) <= DRAG_THRESHOLD_PX) return;
    p.dragging = true;
    this.releaseCapture(p.id);
    void this.startDrag(false);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const p = this.pointer;
    if (!p || event.pointerId !== p.id) return;
    this.pointer = null;
    this.releaseCapture(p.id);
    if (p.dragging || performance.now() - p.at > CLICK_MAX_MS) return; // the host ends drags on release itself
    this.registerClick(this.pointInBox(event));
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.pointer?.id === event.pointerId) this.pointer = null;
  };

  /** Hover: the resting cat perks up and follows the pointer with its eyes (see the constructor effect). */
  private readonly onPointerEnter = (event: PointerEvent): void => {
    if (!this.interactive) return;
    this.hoverPoint = this.pointInBox(event);
    this.hoverAt = performance.now();
    this.hovering.set(true);
  };

  private readonly onPointerLeave = (): void => {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverPoint = null;
    this.hovering.set(false);
  };

  /** pointermove while hovering, throttled to ~10 Hz (leading and trailing), only while the cat rests. */
  private trackHover(event: PointerEvent): void {
    if (!this.interactive) return;
    this.hoverPoint = this.pointInBox(event);
    if (!this.hovering()) this.hovering.set(true);
    if (this.hoverTimer) return;
    const wait = this.hoverAt + CAT_BEHAVIOR_CONFIG.hoverGazeIntervalMs - performance.now();
    const apply = (): void => {
      this.hoverTimer = null;
      this.hoverAt = performance.now();
      if (this.hovering() && HOVER_STATES.has(this.behavior.state()) && this.requestedMode() === 'cat') this.anim.followPointer(this.hoverPoint);
    };
    if (wait <= 0) apply();
    else this.hoverTimer = setTimeout(apply, wait);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    this.sound.unlock();
    if (!this.interactive) return;
    void (this.requestedMode() === 'menu' ? this.close() : this.openMenu());
  };

  private readonly onCatKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void this.openPanel('home');
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      void this.openMenu();
    }
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.requestedMode() === 'cat') return;
    const target = event.target as Element | null;
    if (target?.closest?.('[data-cat-hit]')) return;
    void this.close();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.requestedMode() === 'cat' || event.defaultPrevented) return;
    event.preventDefault();
    void this.close();
  };

  private readonly onWindowBlur = (): void => {
    if (this.requestedMode() === 'cat' || performance.now() - this.openedAt < BLUR_GRACE_MS) return;
    void this.close();
  };

  private registerClick(point: { x: number; y: number }): void {
    const now = performance.now();
    if (this.clickTimer && now - this.lastClickAt <= DOUBLE_CLICK_MS) {
      this.cancelPendingClick();
      void this.openPanel('home');
      return;
    }
    this.lastClickAt = now;
    this.cancelPendingClick();
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      void this.behavior.reactToClick(point);
    }, DOUBLE_CLICK_MS);
  }

  private cancelPendingClick(): void {
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }

  private pointInBox(event: MouseEvent): { x: number; y: number } {
    const rect = this.catBox?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  }

  private releaseCapture(pointerId: number): void {
    try {
      if (this.catBox?.hasPointerCapture(pointerId)) this.catBox.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  }

  private detach(): void {
    const box = this.catBox;
    if (box) {
      box.removeEventListener('pointerdown', this.onPointerDown);
      box.removeEventListener('pointermove', this.onPointerMove);
      box.removeEventListener('pointerup', this.onPointerUp);
      box.removeEventListener('pointercancel', this.onPointerCancel);
      box.removeEventListener('pointerenter', this.onPointerEnter);
      box.removeEventListener('pointerleave', this.onPointerLeave);
      box.removeEventListener('contextmenu', this.onContextMenu);
      box.removeEventListener('keydown', this.onCatKeyDown);
      this.document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
      this.document.removeEventListener('keydown', this.onDocumentKeyDown);
      this.document.defaultView?.removeEventListener('blur', this.onWindowBlur);
    }
    this.catBox = null;
    this.pointer = null;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.cancelPendingClick();
    this.clearDragFallback();
  }
}
