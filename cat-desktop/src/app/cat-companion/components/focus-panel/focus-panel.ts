import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FocusTimerService, phaseLabel } from '../../../core/services/focus-timer.service';

const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Compact mirror of the host-side focus timer: ring, remaining time, controls and session dots. */
@Component({
  selector: 'app-focus-panel',
  templateUrl: './focus-panel.html',
  styleUrl: './focus-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FocusPanel {
  protected readonly focus = inject(FocusTimerService);

  protected readonly ringRadius = RING_RADIUS;
  protected readonly ringLength = RING_LENGTH;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly status = computed(() => this.focus.state().status);
  protected readonly isBreak = computed(() => this.focus.phase() !== 'focus');
  protected readonly dashOffset = computed(() => RING_LENGTH * (1 - Math.min(1, Math.max(0, this.focus.progress()))));
  protected readonly dots = computed(() => {
    const total = Math.max(1, this.focus.settings().sessionsBeforeLongBreak);
    const completed = this.focus.state().completedFocusSessions;
    const inCycle = completed > 0 && completed % total === 0 && this.isBreak() ? total : completed % total;
    return Array.from({ length: total }, (_, i) => i < inCycle);
  });
  protected readonly startLabel = computed(() => (this.status() === 'completed' ? `Start ${phaseLabel(this.focus.phase()).toLowerCase()}` : 'Start'));
  protected readonly statusText = computed(() => {
    switch (this.status()) {
      case 'running':
        return this.isBreak() ? 'Enjoy your break' : 'Stay with it';
      case 'paused':
        return 'Paused';
      case 'completed':
        return this.isBreak() ? 'Focus done - break time' : 'Break over';
      default:
        return 'Ready when you are';
    }
  });

  protected start(): void {
    void this.run(() => this.focus.startPhase(this.focus.phase()));
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

  protected skip(): void {
    void this.run(() => this.focus.skip());
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (err) {
      this.error.set((err as Error).message ?? 'Timer command failed.');
    } finally {
      this.busy.set(false);
    }
  }
}
