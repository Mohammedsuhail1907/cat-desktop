import { Injectable, inject, signal } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { DataInfo, ExportResult, ImportResult } from '../models';

/** Local database information and backup/restore (user-mediated file dialogs in the host). */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly bridge = inject(DesktopBridgeService);

  readonly info = signal<DataInfo | null>(null);
  readonly busy = signal(false);

  async refresh(): Promise<DataInfo> {
    const info = await this.bridge.invoke('data.getInfo');
    this.info.set(info);
    return info;
  }

  async exportBackup(): Promise<ExportResult> {
    this.busy.set(true);
    try {
      return await this.bridge.invoke('data.export');
    } finally {
      this.busy.set(false);
    }
  }

  async importBackup(): Promise<ImportResult> {
    this.busy.set(true);
    try {
      const result = await this.bridge.invoke('data.import');
      if (!result.cancelled) await this.refresh();
      return result;
    } finally {
      this.busy.set(false);
    }
  }

  openDataFolder(): Promise<unknown> {
    return this.bridge.invoke('app.openDataFolder');
  }
}
