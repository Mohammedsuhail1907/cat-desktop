import { Injectable, computed, inject, signal } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { AppSettings, DEFAULT_APP_SETTINGS, SETTING_KEYS, ThemePreference } from '../models';

/**
 * Generic key → value settings store mirrored from the host (SQLite `settings` table).
 * Feature-specific blobs (cat, focus, hotkeys) have their own services; this one owns
 * app-level preferences and the raw store.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly bridge = inject(DesktopBridgeService);
  private readonly store = signal<Record<string, unknown>>({});

  readonly loaded = signal(false);
  readonly all = this.store.asReadonly();

  readonly theme = computed<ThemePreference>(() => (this.store()[SETTING_KEYS.theme] as ThemePreference | undefined) ?? DEFAULT_APP_SETTINGS.theme);
  readonly closeToTray = computed(() => this.store()[SETTING_KEYS.closeToTray] === true);
  readonly startWithWindows = computed(() => this.store()[SETTING_KEYS.startWithWindows] === true);
  readonly appSettings = computed<AppSettings>(() => ({
    theme: this.theme(),
    closeToTray: this.closeToTray(),
    startWithWindows: this.startWithWindows(),
  }));

  constructor() {
    this.bridge.on('settings.changed').subscribe(({ key, value }) => {
      this.store.update((s) => ({ ...s, [key]: value }));
    });
  }

  async load(): Promise<void> {
    const all = await this.bridge.invoke('settings.getAll');
    this.store.set(all ?? {});
    this.loaded.set(true);
  }

  get<T>(key: string, fallback: T): T {
    const value = this.store()[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    const before = this.store();
    const next = { ...before, [key]: value };
    this.store.set(next); // optimistic
    try {
      await this.bridge.invoke('settings.set', { key, value });
    } catch (err) {
      this.rollback(key, before, next);
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    const before = this.store();
    const next = { ...before };
    delete next[key];
    this.store.set(next); // optimistic
    try {
      await this.bridge.invoke('settings.remove', { key });
    } catch (err) {
      this.rollback(key, before, next);
      throw err;
    }
  }

  setTheme(theme: ThemePreference): Promise<void> {
    return this.set(SETTING_KEYS.theme, theme);
  }

  setCloseToTray(enabled: boolean): Promise<void> {
    return this.set(SETTING_KEYS.closeToTray, enabled);
  }

  setStartWithWindows(enabled: boolean): Promise<void> {
    return this.set(SETTING_KEYS.startWithWindows, enabled);
  }

  /** Undo a failed optimistic write of `key`, unless a newer value (e.g. a settings.changed event) replaced it. */
  private rollback(key: string, before: Record<string, unknown>, written: Record<string, unknown>): void {
    const current = this.store();
    if (current[key] !== written[key] || (key in current) !== (key in written)) return;
    const restored = { ...current };
    if (key in before) restored[key] = before[key];
    else delete restored[key];
    this.store.set(restored);
  }
}
