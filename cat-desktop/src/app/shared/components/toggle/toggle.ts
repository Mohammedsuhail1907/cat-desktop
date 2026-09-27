import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

/** Accessible switch. `checked` is a two-way model: `<app-toggle [(checked)]="value" label="…" />`. */
@Component({
  selector: 'app-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      role="switch"
      class="track"
      [attr.aria-checked]="checked()"
      [attr.aria-label]="ariaLabel() || label() || null"
      [disabled]="disabled()"
      (click)="toggle()"
    >
      <span class="thumb"></span>
    </button>
    @if (label()) {
      <span class="label" (click)="toggle()">{{ label() }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      vertical-align: middle;
    }
    :host(.disabled) {
      opacity: 0.55;
    }
    .track {
      position: relative;
      width: 40px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-pill);
      background: var(--surface-3);
      transition:
        background var(--duration-base) var(--ease-out),
        border-color var(--duration-base) var(--ease-out);
    }
    .track[aria-checked='true'] {
      background: var(--accent-gradient);
      border-color: transparent;
    }
    .track:disabled {
      cursor: not-allowed;
    }
    .thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      box-shadow: var(--shadow-sm);
      transition: transform var(--duration-base) var(--ease-spring);
    }
    .track[aria-checked='true'] .thumb {
      transform: translateX(18px);
    }
    .label {
      cursor: pointer;
      color: var(--text);
    }
    :host(.disabled) .label {
      cursor: not-allowed;
    }
  `,
  host: { '[class.disabled]': 'disabled()' },
})
export class Toggle {
  readonly checked = model(false);
  readonly label = input('');
  /** Accessible name when no visible label is rendered. */
  readonly ariaLabel = input('');
  readonly disabled = input(false);

  protected toggle(): void {
    if (this.disabled()) return;
    this.checked.update((v) => !v);
  }
}
