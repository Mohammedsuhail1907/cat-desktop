import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, input, output } from '@angular/core';
import { Icon } from '../../../shared/components/icon/icon';

export type CatMenuCommand = 'toggle-walking' | 'move' | 'theme' | 'size' | 'always-on-top' | 'settings' | 'hide';

interface MenuItem {
  id: CatMenuCommand;
  label: string;
  icon: string;
  /** Set for checkbox items. */
  checked?: boolean;
  separatorBefore?: boolean;
}

/**
 * The cat's right-click menu. A roving-focus menu: ↑/↓/Home/End/Tab move, Enter/Space activate, Esc closes.
 * It only emits; CatCompanionWindow runs the commands (the settings themselves live on the Settings page).
 */
@Component({
  selector: 'app-cat-context-menu',
  imports: [Icon],
  templateUrl: './cat-context-menu.html',
  styleUrl: './cat-context-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'menu',
    'aria-label': 'Cat Companion',
    '(keydown)': 'onKeydown($event)',
  },
})
export class CatContextMenu {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly autoWalk = input.required<boolean>();
  readonly alwaysOnTop = input.required<boolean>();
  /** Small status text under the title. */
  readonly status = input('');

  readonly command = output<CatMenuCommand>();
  readonly closed = output<void>();

  protected readonly items = computed<MenuItem[]>(() => [
    this.autoWalk()
      ? { id: 'toggle-walking', label: 'Pause Walking', icon: 'pause' }
      : { id: 'toggle-walking', label: 'Resume Walking', icon: 'play' },
    { id: 'move', label: 'Move Cat', icon: 'move' },
    { id: 'theme', label: 'Change Theme', icon: 'palette' },
    { id: 'size', label: 'Change Size', icon: 'resize' },
    { id: 'always-on-top', label: 'Always on Top', icon: 'pin', checked: this.alwaysOnTop() },
    { id: 'settings', label: 'Cat Settings', icon: 'settings' },
    { id: 'hide', label: 'Hide Cat', icon: 'eye-off', separatorBefore: true },
  ]);

  constructor() {
    afterNextRender(() => this.buttons()[0]?.focus({ preventScroll: true }));
  }

  protected onKeydown(event: KeyboardEvent): void {
    const buttons = this.buttons();
    const index = buttons.indexOf(this.host.nativeElement.ownerDocument.activeElement as HTMLButtonElement);
    let next = -1;
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % buttons.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? buttons.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
      case 'Tab':
        next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.closed.emit();
        return;
      default:
        return; // Enter / Space activate the focused button natively
    }
    event.preventDefault();
    buttons[next]?.focus();
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'));
  }
}
