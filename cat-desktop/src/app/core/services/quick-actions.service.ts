import { Injectable, computed, inject, signal } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { QuickAction } from '../models';

/** The configurable quick actions of the cat's companion panel (contract §3 actions.*). */
@Injectable({ providedIn: 'root' })
export class QuickActionsService {
  private readonly bridge = inject(DesktopBridgeService);

  readonly actions = signal<QuickAction[]>([]);
  readonly loaded = signal(false);
  readonly enabledActions = computed(() =>
    this.actions()
      .filter((a) => a.enabled)
      .sort((a, b) => a.order - b.order),
  );

  constructor() {
    this.bridge.on('actions.changed').subscribe(() => {
      this.load().catch((err) => console.warn('[actions] reload failed', err));
    });
  }

  async load(): Promise<QuickAction[]> {
    const actions = await this.bridge.invoke('actions.list');
    this.actions.set(actions);
    this.loaded.set(true);
    return actions;
  }

  /** Full replace; `order` follows the array order. Optimistic with rollback. */
  async save(actions: QuickAction[]): Promise<QuickAction[]> {
    const previous = this.actions();
    const normalised = actions.map((a, i) => ({ ...a, order: i }));
    this.actions.set(normalised);
    try {
      const saved = await this.bridge.invoke('actions.save', { actions: normalised });
      this.actions.set(saved);
      return saved;
    } catch (err) {
      if (this.actions() === normalised) this.actions.set(previous);
      throw err;
    }
  }

  async reset(): Promise<QuickAction[]> {
    const actions = await this.bridge.invoke('actions.reset');
    this.actions.set(actions);
    return actions;
  }
}
