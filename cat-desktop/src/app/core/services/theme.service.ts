import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ThemePreference } from '../models';
import { SettingsService } from './settings.service';

export type EffectiveTheme = 'light' | 'dark';

/**
 * Applies `data-theme="light|dark"` on <html>. Both windows follow the app theme setting (the cat's menu and
 * companion panel use the same tokens as the main window). 'system' tracks prefers-color-scheme.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly settings = inject(SettingsService);
  private readonly systemDark = signal(false);
  private started = false;

  readonly preference = computed<ThemePreference>(() => this.settings.theme());

  readonly effective = computed<EffectiveTheme>(() => {
    const pref = this.preference();
    if (pref === 'system') return this.systemDark() ? 'dark' : 'light';
    return pref;
  });

  constructor() {
    effect(() => {
      const theme = this.effective();
      const root = this.document.documentElement;
      root.dataset['theme'] = theme;
      root.style.colorScheme = theme;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    if (media) {
      this.systemDark.set(media.matches);
      media.addEventListener('change', (e) => this.systemDark.set(e.matches));
    }
  }
}
