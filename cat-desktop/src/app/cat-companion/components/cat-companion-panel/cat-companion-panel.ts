import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { QuickAction } from '../../../core/models';
import { Icon } from '../../../shared/components/icon/icon';
import { CompanionTab } from '../../services/cat-interaction.service';
import { FocusPanel } from '../focus-panel/focus-panel';
import { QuickNotePanel } from '../quick-note-panel/quick-note-panel';
import { RemindersPanel } from '../reminders-panel/reminders-panel';
import { TasksPanel } from '../tasks-panel/tasks-panel';

const TAB_TITLES: Readonly<Record<CompanionTab, string>> = {
  home: 'Cat',
  'quick-note': 'Quick note',
  tasks: 'Tasks',
  focus: 'Focus',
  reminders: 'Reminders',
};

/** The tab a quick action opens inside the panel (null: it runs elsewhere). */
export function tabForAction(action: QuickAction): CompanionTab | null {
  switch (action.actionType) {
    case 'quick-note':
    case 'tasks':
    case 'focus':
    case 'reminders':
      return action.actionType;
    default:
      return null;
  }
}

/**
 * The double-click companion panel: header, a strip of the configurable quick actions and the active tab
 * (a grid of the actions, quick note, tasks, focus or reminders). It only emits; CatCompanionWindow runs actions.
 */
@Component({
  selector: 'app-cat-companion-panel',
  imports: [Icon, QuickNotePanel, TasksPanel, FocusPanel, RemindersPanel],
  templateUrl: './cat-companion-panel.html',
  styleUrl: './cat-companion-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'dialog', 'aria-label': 'Cat companion' },
})
export class CatCompanionPanel {
  readonly tab = input.required<CompanionTab>();
  readonly actions = input.required<QuickAction[]>();
  /** Always-on-top state, shown on the pin action. */
  readonly pinned = input(false);

  readonly tabChange = output<CompanionTab>();
  readonly action = output<QuickAction>();
  readonly closed = output<void>();
  readonly hide = output<void>();

  protected readonly titles = TAB_TITLES;
  protected readonly tabFor = tabForAction;

  protected iconFor(action: QuickAction): string {
    return action.icon || 'sparkles';
  }
}
