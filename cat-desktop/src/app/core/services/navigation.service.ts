import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';

/**
 * Follows the host's `navigation.navigate { route }` event (sent to the main window when the cat, the tray
 * or a hotkey asks for a page). Created by the app initializer so it listens before the first bridge request –
 * the host flushes events it queued during page load right after that request.
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly bridge = inject(DesktopBridgeService);
  private readonly router = inject(Router);
  /** A route that arrived before the router's initial navigation; that navigation would otherwise supersede it. */
  private pendingRoute: string | null = null;

  constructor() {
    if (this.bridge.isCatWindow) return; // the host only sends this event to the main window

    this.bridge.on('navigation.navigate').subscribe(({ route }) => {
      if (typeof route !== 'string' || route.length === 0) return;
      if (this.router.navigated) this.go(route);
      else this.pendingRoute = route;
    });

    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
      const route = this.pendingRoute;
      this.pendingRoute = null;
      if (route) this.go(route);
    });
  }

  /**
   * Bring the main window to the front on `route` (e.g. `/settings#cat`). Works from either window: the host
   * forwards it to the main window as `navigation.navigate`; in a plain browser the simulator echoes it back here.
   */
  navigate(route: string): Promise<unknown> {
    return this.bridge.invoke('navigation.navigate', { route });
  }

  /**
   * Asking twice for the same place (e.g. "Change Size" while /settings#cat-size is open) still runs a navigation,
   * so the page can scroll to its target again.
   */
  private go(route: string): void {
    void this.router.navigateByUrl(route, { onSameUrlNavigation: 'reload' });
  }
}
