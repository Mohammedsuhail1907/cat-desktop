import { Injectable, inject } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';

/** Native Windows notifications (tray balloon/toast) through the host. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly bridge = inject(DesktopBridgeService);

  async notify(title: string, body: string, silent = false): Promise<void> {
    try {
      await this.bridge.invoke('app.showNotification', { title, body, silent });
    } catch {
      /* notifications are best-effort */
    }
  }

  openExternal(url: string): Promise<unknown> {
    return this.bridge.invoke('app.openExternal', { url });
  }
}
