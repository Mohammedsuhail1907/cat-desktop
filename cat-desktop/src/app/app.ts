import { Location } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { CatOverlay } from './cat-companion/components/cat-overlay/cat-overlay';
import { DesktopBridgeService } from './core/desktop/desktop-bridge.service';
import { CatSettingsService } from './core/services/cat-settings.service';

/** The cat window's own route renders the cat UI itself, so no overlay there. */
const CAT_ROUTE = /^\/cat(?:[/?#]|$)/;

/**
 * Root component. Deliberately minimal: the shell layout (sidebar + pages) and the cat window are routed
 * components, so the same bundle serves both host windows. In a plain browser the cat walks over the shell
 * inside CatOverlay instead of its own window (the BrowserHostSimulator plays the host).
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CatOverlay],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly bridge = inject(DesktopBridgeService);
  protected readonly title = signal('cat-desktop');
  private readonly router = inject(Router);
  private readonly catSettings = inject(CatSettingsService);
  // Location.path() already reflects the hash before the first navigation completes.
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: inject(Location).path() || '/' },
  );

  protected readonly showCatOverlay = computed(
    () => !this.bridge.isHosted && this.catSettings.settings().enabled && !CAT_ROUTE.test(this.url()),
  );
}
