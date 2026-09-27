import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { DesktopBridgeService } from '../../../core/desktop/desktop-bridge.service';
import { CAT_SCALE_MAX, CAT_SCALE_MIN, CatSettings, MonitorInfo, WindowState, catBoxSize } from '../../../core/models';
import { CatSettingsService } from '../../../core/services/cat-settings.service';
import { CatWindowService } from '../../../core/services/cat-window.service';
import { catTheme } from '../../../cat-companion/components/cat-sprite/cat-themes';
import { Icon } from '../../../shared/components/icon/icon';
import { Toggle } from '../../../shared/components/toggle/toggle';
import { CatPreview } from './cat-preview';
import { CatThemePicker } from './cat-theme-picker';

type CatFlagKey = { [K in keyof CatSettings]: CatSettings[K] extends boolean ? K : never }[keyof CatSettings];

interface CatFlag {
  key: CatFlagKey | 'randomBehaviour';
  label: string;
  hint: string;
}

export interface CatCardNotice {
  text: string;
  error: boolean;
}

/** "Bring cat to this screen": the cat stands on the taskbar line, at least this far (DIPs) from a work-area edge. */
const SCREEN_EDGE_MARGIN = 48;

/**
 * The "Cat Companion" card of the Settings page: enable, live preview, size, theme, behaviour toggles, sliders and
 * window actions. Every change is applied at once (optimistic, CatSettingsService); sliders save debounced, so the
 * desktop cat resizes live while the slider is dragged.
 */
@Component({
  selector: 'app-cat-companion-card',
  imports: [Icon, Toggle, CatPreview, CatThemePicker],
  templateUrl: './cat-companion-card.html',
  styleUrl: './cat-companion-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatCompanionCard {
  private readonly bridge = inject(DesktopBridgeService);
  private readonly catSettings = inject(CatSettingsService);
  protected readonly catWindow = inject(CatWindowService);

  /** Result of an action, shown by the Settings page's toast. */
  readonly notice = output<CatCardNotice>();

  protected readonly cat = this.catSettings.settings;
  protected readonly busy = signal(false);
  protected readonly minPercent = Math.round(CAT_SCALE_MIN * 100);
  protected readonly maxPercent = Math.round(CAT_SCALE_MAX * 100);
  protected readonly scalePercent = computed(() => Math.round(this.cat().scale * 100));
  protected readonly boxLabel = computed(() => {
    const box = catBoxSize(this.cat().scale);
    return `${box.width} × ${box.height} px`;
  });
  protected readonly themeName = computed(() => catTheme(this.cat().theme).name);
  protected readonly randomBehaviour = computed(() => this.cat().randomIdle && this.cat().randomActions);
  protected readonly randomMixed = computed(() => this.cat().randomIdle !== this.cat().randomActions);

  protected readonly flags: readonly CatFlag[] = [
    { key: 'autoWalk', label: 'Auto walk', hint: 'Strolls around the screen on its own.' },
    { key: 'randomBehaviour', label: 'Random behaviour', hint: 'Sits, naps, yawns, stretches and plays between walks.' },
    { key: 'alwaysOnTop', label: 'Always on top', hint: 'Stays above other windows.' },
    { key: 'startWithApp', label: 'Start with application', hint: 'Appears when CatDesktop starts.' },
    { key: 'interaction', label: 'Cat interaction', hint: 'Click, drag and right-click the cat. Off: clicks pass through.' },
    { key: 'clickThroughWhenIdle', label: 'Click-through when idle', hint: 'Clicks reach the window below until the cursor rests on the cat.' },
    { key: 'sound', label: 'Cat sounds', hint: 'An occasional soft meow or purr.' },
  ];
  protected readonly advancedFlags: readonly CatFlag[] = [
    { key: 'randomIdle', label: 'Random idle', hint: 'Sit, look around, yawn and nap between walks.' },
    { key: 'randomActions', label: 'Random actions', hint: 'Stretches, jumps, short runs and happy wiggles.' },
  ];

  protected isOn(key: CatFlag['key']): boolean {
    return key === 'randomBehaviour' ? this.randomBehaviour() : this.cat()[key];
  }

  protected setFlag(key: CatFlag['key'], value: boolean): void {
    const patch: Partial<CatSettings> = key === 'randomBehaviour' ? { randomIdle: value, randomActions: value } : { [key]: value };
    this.save(patch);
  }

  // ---- live sliders (optimistic, debounced save) -------------------------------------------

  protected setScalePercent(raw: string): void {
    const percent = Number(raw);
    if (Number.isFinite(percent)) this.saveSoon({ scale: (Math.round(percent / 5) * 5) / 100 });
  }

  protected setSpeed(raw: string): void {
    const speed = Number(raw);
    if (Number.isFinite(speed)) this.saveSoon({ walkingSpeed: Math.round(speed * 10) / 10 });
  }

  protected setOpacity(raw: string): void {
    const opacity = Number(raw);
    if (Number.isFinite(opacity)) this.saveSoon({ opacity: Math.round(opacity * 100) / 100 });
  }

  protected setTheme(theme: string): void {
    this.save({ theme });
  }

  // ---- window actions -----------------------------------------------------------------------

  protected showCat(): void {
    void this.run(() => this.catWindow.show());
  }

  protected hideCat(): void {
    void this.run(() => this.catWindow.hide());
  }

  protected toggleWalking(): void {
    this.save({ autoWalk: !this.cat().autoWalk });
  }

  /** Move the cat onto the monitor that shows this (main) window, standing on the taskbar line below it. */
  protected async bringCatHere(): Promise<void> {
    await this.run(async () => {
      const [main, monitors] = await Promise.all([this.bridge.invoke('window.getState'), this.catWindow.getMonitors()]);
      const monitor = monitorFor(main, monitors);
      if (!monitor) throw new Error('No screen information is available.');
      const box = catBoxSize(this.cat().scale);
      const scale = monitor.scale > 0 ? monitor.scale : 1;
      const work = monitor.workArea;
      const width = Math.round(box.width * scale);
      const height = Math.round(box.height * scale);
      const margin = Math.round(SCREEN_EDGE_MARGIN * scale);
      const centre = main.x + main.width / 2;
      const x = Math.round(Math.min(work.x + work.width - width - margin, Math.max(work.x + margin, centre - width / 2)));
      const y = work.y + work.height - height;
      await this.catWindow.moveTo({ x, y, monitor: monitor.id });
      if (this.cat().enabled && !this.catWindow.visible()) await this.catWindow.show();
      this.notice.emit({ text: 'The cat is on this screen now.', error: false });
    });
  }

  private save(patch: Partial<CatSettings>): void {
    this.catSettings.save(patch).catch((err) => this.fail(err));
  }

  private saveSoon(patch: Partial<CatSettings>): void {
    this.catSettings.saveSoon(patch).catch((err) => this.fail(err));
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  private fail(err: unknown): void {
    this.notice.emit({ text: (err as Error)?.message ?? String(err), error: true });
  }
}

/** The monitor named by the window state, else the one holding its centre, else the primary one. */
function monitorFor(window: WindowState, monitors: MonitorInfo[]): MonitorInfo | undefined {
  const cx = window.x + window.width / 2;
  const cy = window.y + window.height / 2;
  return (
    monitors.find((m) => m.id === window.monitor) ??
    monitors.find((m) => cx >= m.bounds.x && cx < m.bounds.x + m.bounds.width && cy >= m.bounds.y && cy < m.bounds.y + m.bounds.height) ??
    monitors.find((m) => m.primary) ??
    monitors[0]
  );
}
