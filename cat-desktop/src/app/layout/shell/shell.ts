import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { CatSettingsService } from '../../core/services/cat-settings.service';
import { CatWindowService } from '../../core/services/cat-window.service';
import { FocusTimerService } from '../../core/services/focus-timer.service';
import { NotesService } from '../../core/services/notes.service';
import { TasksService } from '../../core/services/tasks.service';
import { Icon } from '../../shared/components/icon/icon';

interface NavItem {
  route: string;
  label: string;
  icon: string;
}

/** Main-window frame: sidebar navigation, the cat's show/hide toggle and the routed content area. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly notes = inject(NotesService);
  private readonly catSettings = inject(CatSettingsService);

  protected readonly tasks = inject(TasksService);
  protected readonly catWindow = inject(CatWindowService);
  protected readonly focus = inject(FocusTimerService);

  protected readonly navItems: readonly NavItem[] = [
    { route: '/dashboard', label: 'Dashboard', icon: 'home' },
    { route: '/notes', label: 'Notes', icon: 'note' },
    { route: '/tasks', label: 'Tasks', icon: 'tasks' },
    { route: '/focus', label: 'Focus', icon: 'timer' },
    { route: '/settings', label: 'Settings', icon: 'settings' },
  ];

  protected readonly catEnabled = computed(() => this.catSettings.settings().enabled);
  protected readonly catOnScreen = computed(() => this.catEnabled() && this.catWindow.visible());
  protected readonly catBusy = signal(false);
  protected readonly catHint = computed(() => {
    if (!this.catEnabled()) return 'The cat is turned off in Settings';
    return this.catWindow.visible() ? 'Hide the cat' : 'Show the cat';
  });

  constructor() {
    // navigation.navigate from the host is handled by NavigationService (created in the app initializer).
    // Load once so counts are available on every page (services keep them fresh via events).
    void this.notes.refresh();
    void this.tasks.refresh();
  }

  protected async toggleCat(): Promise<void> {
    if (!this.catEnabled() || this.catBusy()) return;
    this.catBusy.set(true);
    try {
      await this.catWindow.toggle();
    } catch (err) {
      console.warn('[shell] cat.toggle failed', err);
    } finally {
      this.catBusy.set(false);
    }
  }
}
