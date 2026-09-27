import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

/** Friendly placeholder for empty lists; project buttons/links as content. */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="glyph"><app-icon [name]="icon()" [size]="28" /></div>
    <h3 class="title">{{ title() }}</h3>
    @if (description()) {
      <p class="description">{{ description() }}</p>
    }
    <div class="actions"><ng-content /></div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 8px;
      padding: 36px 20px;
      color: var(--text-muted);
    }
    .glyph {
      display: grid;
      place-items: center;
      width: 60px;
      height: 60px;
      border-radius: var(--radius-lg);
      background: var(--accent-soft);
      color: var(--accent-2);
      margin-bottom: 6px;
    }
    .title {
      font-size: 1.05rem;
      color: var(--text);
    }
    .description {
      max-width: 34ch;
      font-size: 0.92rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      margin-top: 8px;
    }
    .actions:empty {
      display: none;
    }
  `,
})
export class EmptyState {
  readonly icon = input('sparkles');
  readonly title = input.required<string>();
  readonly description = input('');
}
