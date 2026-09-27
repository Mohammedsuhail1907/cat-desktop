import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import {
  DEFAULT_FOCUS_SETTINGS,
  FocusCompleted,
  FocusPhase,
  FocusSettings,
  FocusStartRequest,
  FocusState,
  FocusStats,
  IDLE_FOCUS_STATE,
  SETTING_KEYS,
} from '../models';

/**
 * Mirror of the host-side focus timer. The timer itself runs in C# so every window and the tray
 * see identical state; this service only issues commands and reflects `focus.tick` events.
 */
@Injectable({ providedIn: 'root' })
export class FocusTimerService {
  private readonly bridge = inject(DesktopBridgeService);
  private readonly completedSubject = new Subject<FocusCompleted>();

  readonly state = signal<FocusState>(IDLE_FOCUS_STATE);
  readonly settings = signal<FocusSettings>(DEFAULT_FOCUS_SETTINGS);
  readonly stats = signal<FocusStats>({ todayFocusSessions: 0, todayFocusMinutes: 0, totalFocusSessions: 0, totalFocusMinutes: 0 });
  readonly loaded = signal(false);

  readonly completed$: Observable<FocusCompleted> = this.completedSubject.asObservable();

  readonly isRunning = computed(() => this.state().status === 'running');
  readonly isPaused = computed(() => this.state().status === 'paused');
  readonly isIdle = computed(() => this.state().status === 'idle' || this.state().status === 'completed');
  readonly isActive = computed(() => this.isRunning() || this.isPaused());
  readonly phase = computed(() => this.state().phase);
  readonly progress = computed(() => {
    const s = this.state();
    return s.totalSeconds > 0 ? 1 - s.remainingSeconds / s.totalSeconds : 0;
  });
  readonly remainingLabel = computed(() => formatSeconds(this.state().remainingSeconds));
  readonly phaseLabel = computed(() => phaseLabel(this.state().phase));

  constructor() {
    this.bridge.on('focus.tick').subscribe((state) => this.state.set(state));
    this.bridge.on('focus.completed').subscribe((done) => {
      this.completedSubject.next(done);
      void this.refreshStats();
    });
    // Saved in another window or restored by a backup import (the host broadcasts the normalised object).
    this.bridge.on('settings.changed').subscribe(({ key, value }) => {
      if (key === SETTING_KEYS.focus) this.settings.set({ ...DEFAULT_FOCUS_SETTINGS, ...((value as Partial<FocusSettings> | null) ?? {}) });
    });
  }

  async load(): Promise<void> {
    const [state, settings] = await Promise.all([this.bridge.invoke('focus.getState'), this.bridge.invoke('focus.getSettings')]);
    this.state.set(state);
    this.settings.set(settings);
    this.loaded.set(true);
    void this.refreshStats();
  }

  async refreshStats(): Promise<void> {
    try {
      this.stats.set(await this.bridge.invoke('focus.getStats'));
    } catch {
      /* stats are decorative */
    }
  }

  async start(request?: FocusStartRequest): Promise<FocusState> {
    return this.apply(await this.bridge.invoke('focus.start', request ?? {}));
  }

  async startPhase(phase: FocusPhase): Promise<FocusState> {
    return this.start({ phase });
  }

  async pause(): Promise<FocusState> {
    return this.apply(await this.bridge.invoke('focus.pause'));
  }

  async resume(): Promise<FocusState> {
    return this.apply(await this.bridge.invoke('focus.resume'));
  }

  async stop(): Promise<FocusState> {
    return this.apply(await this.bridge.invoke('focus.stop'));
  }

  async reset(): Promise<FocusState> {
    return this.apply(await this.bridge.invoke('focus.reset'));
  }

  async skip(): Promise<FocusState> {
    return this.apply(await this.bridge.invoke('focus.skip'));
  }

  /** Convenience for a single button: idle → start, running → pause, paused → resume. */
  async toggle(): Promise<FocusState> {
    const status = this.state().status;
    if (status === 'running') return this.pause();
    if (status === 'paused') return this.resume();
    return this.start();
  }

  async saveSettings(settings: FocusSettings): Promise<FocusSettings> {
    const saved = await this.bridge.invoke('focus.saveSettings', settings);
    this.settings.set(saved);
    return saved;
  }

  private apply(state: FocusState): FocusState {
    this.state.set(state);
    return state;
  }
}

export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}

export function phaseLabel(phase: FocusPhase): string {
  switch (phase) {
    case 'shortBreak':
      return 'Short break';
    case 'longBreak':
      return 'Long break';
    default:
      return 'Focus';
  }
}
