import { Injectable, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { Empty } from '../desktop/bridge-protocol';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import {
  CatClickThroughRequest,
  CatCommand,
  CatDragEnded,
  CatLayoutMode,
  CatLayoutResult,
  CatScreenInfo,
  CatWalkEnded,
  CatWalkRequest,
  CatWalkResult,
  MonitorInfo,
  Rect,
  WindowState,
} from '../models';

/** At most this many cat.command events are kept while no cat UI listens; older ones are dropped. */
const MAX_PENDING_COMMANDS = 16;

/**
 * The ONLY Angular wrapper around the `cat.*` commands and events (contract §3/§4). Shared by both windows:
 * the main window shows/hides the cat and moves it between screens, the cat window walks, drags and lays it out.
 *
 * Created by the app initializer, so it subscribes before the first bridge request (contract §2). `cat.command`
 * events that arrive before the cat UI subscribed to {@link commands$} are buffered and handed to the first
 * subscriber, then delivery is live.
 */
@Injectable({ providedIn: 'root' })
export class CatWindowService {
  private readonly bridge = inject(DesktopBridgeService);

  /** Whether the cat window is on screen (cat.visibilityChanged / show / hide / toggle). */
  readonly visible = signal(false);
  /** Last known window geometry (cat.positionChanged, moves). Physical px. */
  readonly position = signal<WindowState | null>(null);
  /** Current window layout (cat.setLayout result / cat.layoutChanged); null until known. */
  readonly layout = signal<CatLayoutResult | null>(null);
  /** False while the host keeps the window click-through (cat.interactiveChanged, click-through mode only). */
  readonly interactive = signal(true);
  /** True while the host moves the window with the cursor (cat.dragStateChanged). */
  readonly dragging = signal(false);
  /** Last screen information (cat.getScreenInfo / cat.screenChanged). */
  readonly screen = signal<CatScreenInfo | null>(null);

  readonly walkEnded$: Observable<CatWalkEnded> = this.bridge.on('cat.walkEnded');
  readonly dragEnded$: Observable<CatDragEnded> = this.bridge.on('cat.dragEnded');
  readonly dragState$: Observable<{ dragging: boolean }> = this.bridge.on('cat.dragStateChanged');
  readonly layoutChanged$: Observable<CatLayoutResult> = this.bridge.on('cat.layoutChanged');
  readonly screenChanged$: Observable<CatScreenInfo> = this.bridge.on('cat.screenChanged');

  private readonly pendingCommands: CatCommand[] = [];
  private readonly liveCommands = new Subject<CatCommand>();
  private commandListeners = 0;

  /**
   * Commands pushed to the cat window (hotkeys, tray, main window). Replays the buffered ones to the first
   * subscriber, then delivers live. Subscribe once for the lifetime of the cat UI.
   */
  readonly commands$: Observable<CatCommand> = new Observable<CatCommand>((subscriber) => {
    while (this.pendingCommands.length > 0 && !subscriber.closed) subscriber.next(this.pendingCommands.shift()!);
    this.commandListeners++;
    const live = this.liveCommands.subscribe(subscriber);
    return () => {
      this.commandListeners--;
      live.unsubscribe();
    };
  });

  constructor() {
    this.bridge.on('cat.command').subscribe((command) => {
      if (!command || typeof command.action !== 'string') return;
      if (this.commandListeners > 0) {
        this.liveCommands.next(command);
        return;
      }
      this.pendingCommands.push(command);
      if (this.pendingCommands.length > MAX_PENDING_COMMANDS) this.pendingCommands.shift();
    });
    this.bridge.on('cat.visibilityChanged').subscribe(({ visible }) => this.visible.set(visible === true));
    this.bridge.on('cat.positionChanged').subscribe((state) => this.position.set(state));
    this.bridge.on('cat.interactiveChanged').subscribe(({ interactive }) => this.interactive.set(interactive !== false));
    this.bridge.on('cat.dragStateChanged').subscribe(({ dragging }) => this.dragging.set(dragging === true));
    this.layoutChanged$.subscribe((layout) => this.layout.set(layout));
    this.screenChanged$.subscribe((screen) => this.screen.set(screen));
  }

  /** Initial visibility (called by the app initializer). */
  async load(): Promise<void> {
    await this.isVisible();
  }

  // ---- visibility -------------------------------------------------------------------------

  async show(): Promise<boolean> {
    return this.applyVisible(await this.bridge.invoke('cat.show'));
  }

  async hide(): Promise<boolean> {
    return this.applyVisible(await this.bridge.invoke('cat.hide'));
  }

  async toggle(): Promise<boolean> {
    return this.applyVisible(await this.bridge.invoke('cat.toggle'));
  }

  async isVisible(): Promise<boolean> {
    return this.applyVisible(await this.bridge.invoke('cat.isVisible'));
  }

  // ---- movement ---------------------------------------------------------------------------

  /** Smooth walk by (dx, dy) DIPs at `speed` DIP/s; `cat.walkEnded` follows when it is over. */
  walk(request: CatWalkRequest): Promise<CatWalkResult> {
    return this.bridge.invoke('cat.walk', request);
  }

  stop(): Promise<Empty> {
    return this.bridge.invoke('cat.stop');
  }

  /** Physical px of the window's top-left; clamped and persisted by the host. */
  async moveTo(target: { x: number; y: number; monitor?: string }): Promise<WindowState> {
    return this.applyPosition(await this.bridge.invoke('cat.moveTo', target));
  }

  async moveBy(dx: number, dy: number): Promise<WindowState> {
    return this.applyPosition(await this.bridge.invoke('cat.moveBy', { dx, dy }));
  }

  async savePosition(): Promise<WindowState> {
    return this.applyPosition(await this.bridge.invoke('cat.savePosition'));
  }

  async getPosition(): Promise<WindowState> {
    return this.applyPosition(await this.bridge.invoke('cat.getPosition'));
  }

  async getScreenInfo(): Promise<CatScreenInfo> {
    const info = await this.bridge.invoke('cat.getScreenInfo');
    this.screen.set(info);
    return info;
  }

  getMonitors(): Promise<MonitorInfo[]> {
    return this.bridge.invoke('cat.getMonitors');
  }

  // ---- drag -------------------------------------------------------------------------------

  /**
   * Hand the window to the native cursor. The host moves it until the left button is released (or, with
   * `followUntilClick`, until the next click / Esc / 30 s); `cat.dragEnded` reports the result.
   */
  dragStart(options?: { followUntilClick?: boolean }): Promise<Empty> {
    return options?.followUntilClick ? this.bridge.invoke('cat.dragStart', { followUntilClick: true }) : this.bridge.invoke('cat.dragStart');
  }

  dragEnd(): Promise<{ moved: boolean }> {
    return this.bridge.invoke('cat.dragEnd');
  }

  // ---- window shape -----------------------------------------------------------------------

  async setLayout(mode: CatLayoutMode): Promise<CatLayoutResult> {
    const result = await this.bridge.invoke('cat.setLayout', { mode });
    this.layout.set(result);
    return result;
  }

  setHitRegion(rects: Rect[]): Promise<Empty> {
    return this.bridge.invoke('cat.setHitRegion', { rects });
  }

  setClickThrough(request: CatClickThroughRequest): Promise<Empty> {
    return this.bridge.invoke('cat.setClickThrough', request);
  }

  /** Runtime only; the persisted value is CatSettings.alwaysOnTop. */
  setAlwaysOnTop(enabled: boolean): Promise<Empty> {
    return this.bridge.invoke('cat.setAlwaysOnTop', { enabled });
  }

  // ---- cross-window -----------------------------------------------------------------------

  /** Ask the cat window to perform an action (the host shows the cat first when it is enabled). */
  sendCommand(action: string, payload?: unknown): Promise<Empty> {
    return this.bridge.invoke('cat.sendCommand', payload === undefined ? { action } : { action, payload });
  }

  private applyVisible(result: { visible: boolean }): boolean {
    this.visible.set(result.visible === true);
    return result.visible === true;
  }

  private applyPosition(state: WindowState): WindowState {
    this.position.set(state);
    return state;
  }
}
