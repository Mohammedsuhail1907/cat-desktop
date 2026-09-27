import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';
import { DesktopBridgeService } from './core/desktop/desktop-bridge.service';
import { CatSettingsService } from './core/services/cat-settings.service';
import { CatWindowService } from './core/services/cat-window.service';
import { FocusTimerService } from './core/services/focus-timer.service';
import { HotkeysService } from './core/services/hotkeys.service';
import { NavigationService } from './core/services/navigation.service';
import { NotesService } from './core/services/notes.service';
import { QuickActionsService } from './core/services/quick-actions.service';
import { SettingsService } from './core/services/settings.service';
import { TasksService } from './core/services/tasks.service';
import { ThemeService } from './core/services/theme.service';

/**
 * Loads persisted state from the desktop host before the first route renders.
 * Failures are logged, never fatal – the UI must still come up offline / in a browser.
 *
 * Every service that listens to host events is injected (= constructed, = subscribed) BEFORE the first bridge
 * request: the host queues events while a page loads and flushes them right after the document's first message.
 */
function initializeDesktopState(): () => Promise<void> {
  return async () => {
    const bridge = inject(DesktopBridgeService);
    const settings = inject(SettingsService);
    const catSettings = inject(CatSettingsService);
    // Also buffers cat.command events until the cat UI subscribes (contract §2).
    const catWindow = inject(CatWindowService);
    const quickActions = inject(QuickActionsService);
    const focus = inject(FocusTimerService);
    const hotkeys = inject(HotkeysService);
    const theme = inject(ThemeService);
    // Event listeners only (their state loads on demand): navigation.navigate, notes.changed, tasks.changed.
    inject(NavigationService);
    inject(NotesService);
    inject(TasksService);

    theme.start();
    const results = await Promise.allSettled([
      bridge.loadInfo(),
      settings.load(),
      catSettings.load(),
      catWindow.load(),
      quickActions.load(),
      focus.load(),
      hotkeys.load(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') console.warn('[catdesktop] initialisation step failed', r.reason);
    }
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withHashLocation()),
    provideAppInitializer(initializeDesktopState()),
  ],
};
