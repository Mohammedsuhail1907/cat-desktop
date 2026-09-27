import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FocusCompleted, FocusPhase, FocusSettings } from '../../core/models';
import { FocusTimerService, phaseLabel } from '../../core/services/focus-timer.service';
import { Icon } from '../../shared/components/icon/icon';
import { Toggle } from '../../shared/components/toggle/toggle';

const RING_RADIUS = 124;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const CELEBRATION_MS = 8000;

type NumericSetting = 'focusMinutes' | 'shortBreakMinutes' | 'longBreakMinutes' | 'sessionsBeforeLongBreak';

/** Same ranges the host clamps to (FocusSettings.Normalised). */
const LIMITS: Record<NumericSetting, { min: number; max: number; label: string }> = {
  focusMinutes: { min: 1, max: 180, label: 'Focus length' },
  shortBreakMinutes: { min: 1, max: 60, label: 'Short break' },
  longBreakMinutes: { min: 1, max: 120, label: 'Long break' },
  sessionsBeforeLongBreak: { min: 1, max: 12, label: 'Sessions before a long break' },
};

@Component({
  selector: 'app-focus',
  imports: [Icon, Toggle],
  templateUrl: './focus.html',
  styleUrl: './focus.scss',
})
export class Focus {
  private readonly destroyRef = inject(DestroyRef);
  private celebrationTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the user edited the form; host-side settings changes then no longer overwrite it. */
  private formTouched = false;

  protected readonly focus = inject(FocusTimerService);
  protected readonly ringRadius = RING_RADIUS;
  protected readonly ringCircumference = RING_CIRCUMFERENCE;
  protected readonly phases: readonly FocusPhase[] = ['focus', 'shortBreak', 'longBreak'];
  protected readonly limits = LIMITS;

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly celebration = signal<FocusCompleted | null>(null);
  protected readonly form = signal<FocusSettings>(this.focus.settings());
  protected readonly savedFlash = signal(false);

  protected readonly dashOffset = computed(() => RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, this.focus.progress()))));
  protected readonly statusLabel = computed(() => {
    switch (this.focus.state().status) {
      case 'running':
        return 'In progress';
      case 'paused':
        return 'Paused';
      case 'completed':
        return `Ready for ${this.focus.phaseLabel().toLowerCase()}`;
      default:
        return 'Ready';
    }
  });
  protected readonly sessionDots = computed(() => {
    const total = Math.max(1, this.focus.settings().sessionsBeforeLongBreak);
    const done = this.focus.state().completedFocusSessions;
    const filled = done === 0 ? 0 : done % total === 0 ? total : done % total;
    return Array.from({ length: total }, (_, i) => i < filled);
  });
  protected readonly formDirty = computed(() => {
    const a = this.form();
    const b = this.focus.settings();
    return (Object.keys(a) as (keyof FocusSettings)[]).some((k) => a[k] !== b[k]);
  });
  protected readonly formErrors = computed(() => {
    const f = this.form();
    const errors: Partial<Record<NumericSetting, string>> = {};
    for (const key of Object.keys(LIMITS) as NumericSetting[]) {
      const { min, max, label } = LIMITS[key];
      const value = f[key];
      if (!Number.isInteger(value) || value < min || value > max) errors[key] = `${label} must be between ${min} and ${max}.`;
    }
    return errors;
  });
  protected readonly formErrorList = computed(() => Object.values(this.formErrors()));
  protected readonly formValid = computed(() => this.formErrorList().length === 0);

  constructor() {
    void this.focus.refreshStats();

    // Adopt settings arriving from the host unless the user is mid-edit.
    effect(() => {
      const settings = this.focus.settings();
      untracked(() => {
        if (!this.formDirty() || !this.formTouched) this.form.set(settings);
      });
    });

    this.focus.completed$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((done) => {
      this.celebration.set(done);
      if (this.celebrationTimer) clearTimeout(this.celebrationTimer);
      this.celebrationTimer = setTimeout(() => this.celebration.set(null), CELEBRATION_MS);
    });

    this.destroyRef.onDestroy(() => {
      if (this.celebrationTimer) clearTimeout(this.celebrationTimer);
    });
  }

  // ---- timer controls -----------------------------------------------------------------------

  protected start(): void {
    void this.run(() => this.focus.start());
  }

  protected startPhase(phase: FocusPhase): void {
    this.celebration.set(null);
    void this.run(() => this.focus.startPhase(phase));
  }

  protected pause(): void {
    void this.run(() => this.focus.pause());
  }

  protected resume(): void {
    void this.run(() => this.focus.resume());
  }

  protected stop(): void {
    void this.run(() => this.focus.stop());
  }

  protected reset(): void {
    void this.run(() => this.focus.reset());
  }

  protected skip(): void {
    void this.run(() => this.focus.skip());
  }

  protected dismissCelebration(): void {
    this.celebration.set(null);
  }

  protected labelFor(phase: FocusPhase): string {
    return phaseLabel(phase);
  }

  protected minutesFor(phase: FocusPhase): number {
    const s = this.focus.settings();
    return phase === 'focus' ? s.focusMinutes : phase === 'shortBreak' ? s.shortBreakMinutes : s.longBreakMinutes;
  }

  // ---- settings form ------------------------------------------------------------------------

  protected patchNumber(key: NumericSetting, raw: string): void {
    this.formTouched = true;
    const value = raw.trim() === '' ? Number.NaN : Number(raw);
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected patchFlag(key: 'autoStartBreaks' | 'autoStartFocus' | 'notify' | 'sound', value: boolean): void {
    this.formTouched = true;
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected numberValue(key: NumericSetting): string {
    const v = this.form()[key];
    return Number.isNaN(v) ? '' : String(v);
  }

  protected revertForm(): void {
    this.formTouched = false;
    this.form.set(this.focus.settings());
  }

  protected async saveSettings(): Promise<void> {
    if (!this.formValid() || !this.formDirty()) return;
    await this.run(async () => {
      await this.focus.saveSettings(this.form());
      this.formTouched = false;
      this.savedFlash.set(true);
      setTimeout(() => this.savedFlash.set(false), 2000);
    });
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.error.set(null);
    } catch (err) {
      this.error.set((err as Error).message ?? String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
