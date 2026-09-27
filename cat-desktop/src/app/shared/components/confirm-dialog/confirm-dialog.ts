import { ChangeDetectionStrategy, Component, ElementRef, signal, viewChild } from '@angular/core';
import { Icon } from '../icon/icon';

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

/**
 * Native <dialog>-based confirmation. Place one in a template and call
 * `await dialog.open('Delete this note?')` – resolves true when confirmed.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <dialog #dialog class="dialog" (cancel)="onCancel($event)" (close)="onClosed()" aria-labelledby="confirm-title">
      <div class="body">
        <div class="glyph" [class.danger]="options().danger">
          <app-icon [name]="options().danger ? 'trash' : 'info'" [size]="22" />
        </div>
        <div class="text">
          <h3 id="confirm-title">{{ options().title }}</h3>
          <p>{{ message() }}</p>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-ghost" (click)="settle(false)">{{ options().cancelLabel }}</button>
        <button type="button" class="btn" [class.btn-danger]="options().danger" [class.btn-primary]="!options().danger" (click)="settle(true)" #confirm>
          {{ options().confirmLabel }}
        </button>
      </div>
    </dialog>
  `,
  styles: `
    .dialog {
      width: min(420px, calc(100vw - 32px));
      padding: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--bg-elevated);
      color: var(--text);
      box-shadow: var(--shadow-lg);
    }
    .dialog::backdrop {
      background: rgba(20, 16, 30, 0.45);
      backdrop-filter: blur(2px);
    }
    .body {
      display: flex;
      gap: 14px;
      padding: 22px 22px 8px;
    }
    .glyph {
      display: grid;
      place-items: center;
      flex: none;
      width: 42px;
      height: 42px;
      border-radius: var(--radius-md);
      background: var(--accent-soft);
      color: var(--accent-2);
    }
    .glyph.danger {
      background: rgba(229, 72, 77, 0.14);
      color: var(--danger);
    }
    h3 {
      font-size: 1.05rem;
      margin-bottom: 4px;
    }
    p {
      color: var(--text-muted);
      white-space: pre-line;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 14px 22px 20px;
    }
  `,
})
export class ConfirmDialog {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly confirmButton = viewChild.required<ElementRef<HTMLButtonElement>>('confirm');
  private resolver: ((value: boolean) => void) | null = null;

  protected readonly message = signal('');
  protected readonly options = signal<Required<ConfirmOptions>>(defaults());

  open(message: string, options: ConfirmOptions = {}): Promise<boolean> {
    // A second call while open settles the first as "cancelled".
    this.resolver?.(false);
    this.message.set(message);
    this.options.set({ ...defaults(), ...options });
    const el = this.dialog().nativeElement;
    if (!el.open) el.showModal();
    this.confirmButton().nativeElement.focus();
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  protected settle(value: boolean): void {
    const resolve = this.resolver;
    this.resolver = null;
    const el = this.dialog().nativeElement;
    if (el.open) el.close();
    resolve?.(value);
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    this.settle(false);
  }

  /** Covers closes not initiated through the buttons (e.g. form-method close). */
  protected onClosed(): void {
    if (this.resolver) this.settle(false);
  }
}

function defaults(): Required<ConfirmOptions> {
  return { title: 'Are you sure?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: false };
}
