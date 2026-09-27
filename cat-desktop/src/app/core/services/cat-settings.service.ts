import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { CatSettings, DEFAULT_CAT_SETTINGS, SETTING_KEYS, catBoxSize, normaliseCatSettings } from '../models';

/** Debounce of {@link CatSettingsService.saveSoon} (slider drags). */
export const CAT_SETTINGS_DEBOUNCE_MS = 150;

/**
 * The persisted Cat Companion settings (contract §5), shared by both windows. The host applies most of them
 * itself (visibility, always-on-top, scale, click-through); the cat UI reads the behaviour flags and the theme.
 *
 * Edits are optimistic: `settings` shows them at once, a failed save rolls them back. Host values that arrive while
 * an edit is still unconfirmed (e.g. the echo of an earlier slider step) are shown with the newer edit on top, so a
 * dragged slider never jumps back.
 */
@Injectable({ providedIn: 'root' })
export class CatSettingsService {
  private readonly bridge = inject(DesktopBridgeService);

  readonly settings = signal<CatSettings>(DEFAULT_CAT_SETTINGS);
  readonly loaded = signal(false);
  /** Cat box in CSS px for the current scale (§7). */
  readonly boxSize = computed(() => catBoxSize(this.settings().scale));

  /** Last value confirmed by the host. */
  private remote: CatSettings = DEFAULT_CAT_SETTINGS;
  /** Local edits the host has not confirmed yet. */
  private local: Partial<CatSettings> = {};
  private localVersion = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiters: { resolve: (s: CatSettings) => void; reject: (e: unknown) => void }[] = [];

  constructor() {
    this.bridge.on('cat.settingsChanged').subscribe((settings) => this.applyRemote(settings));
    // A backup import or a raw settings.set also changes the stored blob.
    this.bridge.on('settings.changed').subscribe(({ key, value }) => {
      if (key === SETTING_KEYS.cat && value && typeof value === 'object') this.applyRemote(value as Partial<CatSettings>);
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  async load(): Promise<CatSettings> {
    this.applyRemote(await this.bridge.invoke('cat.getSettings'));
    this.loaded.set(true);
    return this.settings();
  }

  /** Optimistic save of a partial change, sent at once; rolled back when the host refuses it. */
  save(patch: Partial<CatSettings>): Promise<CatSettings> {
    this.edit(patch);
    return this.flush();
  }

  /**
   * Optimistic change shown at once and saved after {@link CAT_SETTINGS_DEBOUNCE_MS} of quiet (slider drags: the
   * host resizes the desktop cat live without a request per pixel). Resolves when the combined save is done.
   */
  saveSoon(patch: Partial<CatSettings>, delayMs = CAT_SETTINGS_DEBOUNCE_MS): Promise<CatSettings> {
    this.edit(patch);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), delayMs);
    return new Promise<CatSettings>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private edit(patch: Partial<CatSettings>): void {
    this.local = { ...this.local, ...patch };
    this.localVersion++;
    this.settings.set(normaliseCatSettings({ ...this.remote, ...this.local }));
  }

  private async flush(): Promise<CatSettings> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const waiters = this.waiters;
    this.waiters = [];
    const version = this.localVersion;
    try {
      const saved = await this.bridge.invoke('cat.saveSettings', this.settings());
      this.remote = normaliseCatSettings(saved);
      if (version === this.localVersion) this.local = {};
      this.settings.set(normaliseCatSettings({ ...this.remote, ...this.local }));
      waiters.forEach((w) => w.resolve(this.settings()));
      return this.settings();
    } catch (err) {
      // Roll back, unless the user changed something again meanwhile (that newer save decides).
      if (version === this.localVersion) {
        this.local = {};
        this.settings.set(this.remote);
      }
      waiters.forEach((w) => w.reject(err));
      throw err;
    }
  }

  private applyRemote(value: Partial<CatSettings> | null | undefined): void {
    this.remote = normaliseCatSettings(value);
    this.settings.set(normaliseCatSettings({ ...this.remote, ...this.local }));
  }
}

