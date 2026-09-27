import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { CatSprite } from '../../../cat-companion/components/cat-sprite/cat-sprite';
import { CAT_THEMES, CatTheme, catTheme } from '../../../cat-companion/components/cat-sprite/cat-themes';
import { Icon } from '../../../shared/components/icon/icon';

/**
 * Theme selector: a radio group of cards, each drawing the real cat (CatSprite) in that theme. Only the selected
 * and the hovered card animate (idle); the others show a still frame. Arrow keys / Home / End move and select.
 */
@Component({
  selector: 'app-cat-theme-picker',
  imports: [CatSprite, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'radiogroup', '[attr.aria-label]': 'label()', '(keydown)': 'onKeydown($event)' },
  template: `
    @for (t of themes; track t.id; let i = $index) {
      <button
        type="button"
        role="radio"
        class="theme"
        [attr.data-theme]="t.id"
        [attr.aria-checked]="t.id === selectedId()"
        [attr.tabindex]="t.id === selectedId() ? 0 : -1"
        [title]="t.name"
        (click)="pick(t)"
        (pointerenter)="hovered.set(t.id)"
        (pointerleave)="hovered.set(null)"
      >
        <span class="swatch" [style.--swatch]="t.primaryColor">
          <app-cat-sprite [theme]="t.id" animation="idle" [paused]="t.id !== selectedId() && t.id !== hovered()" />
        </span>
        <span class="name">{{ t.name }}</span>
        @if (t.id === selectedId()) {
          <span class="check" aria-hidden="true"><app-icon name="check" [size]="12" /></span>
        }
      </button>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
      gap: 8px;
    }
    .theme {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 8px 6px 7px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--text);
      transition:
        border-color var(--duration-fast) var(--ease-out),
        background var(--duration-fast) var(--ease-out),
        transform var(--duration-fast) var(--ease-out);
    }
    .theme:hover {
      background: var(--surface-2);
      transform: translateY(-1px);
    }
    .theme[aria-checked='true'] {
      border-color: var(--accent);
      background: var(--accent-soft);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .swatch {
      display: block;
      width: 72px;
      height: 54px;
      border-radius: 10px;
      background: radial-gradient(90% 80% at 50% 100%, color-mix(in srgb, var(--swatch) 22%, transparent), transparent 75%);
    }
    app-cat-sprite {
      display: block;
      width: 100%;
      height: 100%;
    }
    .name {
      font-size: 0.8rem;
      font-weight: 600;
    }
    .check {
      position: absolute;
      top: 6px;
      right: 6px;
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--accent-gradient);
      color: var(--accent-contrast);
    }
  `,
})
export class CatThemePicker {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** CatSettings.theme; unknown ids show as the default theme. */
  readonly value = input('classic');
  readonly label = input('Cat theme');
  readonly valueChange = output<string>();

  protected readonly themes: readonly CatTheme[] = CAT_THEMES;
  protected readonly selectedId = computed(() => catTheme(this.value()).id);
  protected readonly hovered = signal<string | null>(null);

  protected pick(theme: CatTheme): void {
    if (theme.id !== this.selectedId()) this.valueChange.emit(theme.id);
  }

  /** Radio-group keys: arrows move and select (wrapping), Home / End jump. */
  protected onKeydown(event: KeyboardEvent): void {
    const count = this.themes.length;
    const index = this.themes.findIndex((t) => t.id === this.selectedId());
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % count;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const theme = this.themes[next];
    this.pick(theme);
    // Focus follows the selection once the new card has become the tab stop.
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-theme="${theme.id}"]`)?.focus());
  }
}
