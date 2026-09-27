import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { catTheme } from '../../cat-companion/components/cat-sprite/cat-themes';
import { TaskItem } from '../../core/models';
import { FocusTimerService } from '../../core/services/focus-timer.service';
import { HotkeysService } from '../../core/services/hotkeys.service';
import { NotesService } from '../../core/services/notes.service';
import { CatSettingsService } from '../../core/services/cat-settings.service';
import { CatWindowService } from '../../core/services/cat-window.service';
import { TasksService } from '../../core/services/tasks.service';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe';

const MAX_TODAY_TASKS = 6;
const MAX_PINNED_NOTES = 6;

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, Icon, EmptyState, RelativeTimePipe],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly router = inject(Router);
  private readonly newTaskInput = viewChild<ElementRef<HTMLInputElement>>('newTaskInput');

  protected readonly tasks = inject(TasksService);
  protected readonly notes = inject(NotesService);
  protected readonly focus = inject(FocusTimerService);
  protected readonly catWindow = inject(CatWindowService);
  protected readonly catSettings = inject(CatSettingsService);
  protected readonly hotkeys = inject(HotkeysService);

  protected readonly greeting = greetingFor(new Date().getHours());
  protected readonly todayLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  protected readonly newTaskTitle = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Overdue + due today, oldest first; falls back to the next open tasks when nothing is due. */
  protected readonly todayTasks = computed<TaskItem[]>(() => {
    const due = [...this.tasks.overdue(), ...this.tasks.dueToday()].sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
    return due.slice(0, MAX_TODAY_TASKS);
  });
  protected readonly upNext = computed<TaskItem[]>(() => (this.todayTasks().length > 0 ? [] : this.tasks.open().slice(0, MAX_TODAY_TASKS)));
  protected readonly pinnedNotes = computed(() => this.notes.pinned().slice(0, MAX_PINNED_NOTES));
  protected readonly catHotkey = computed(() => this.hotkeys.hotkeys().toggleCat);
  protected readonly catEnabled = computed(() => this.catSettings.settings().enabled);
  protected readonly catWalking = computed(() => this.catSettings.settings().autoWalk);
  protected readonly catLook = computed(() => {
    const s = this.catSettings.settings();
    return `${catTheme(s.theme).name} · ${Math.round(s.scale * 100)} %`;
  });

  constructor() {
    void this.focus.refreshStats();
  }

  protected isOverdue(task: TaskItem): boolean {
    return this.tasks.overdue().some((t) => t.id === task.id);
  }

  protected focusNewTask(): void {
    this.newTaskInput()?.nativeElement.focus();
  }

  protected async addTask(): Promise<void> {
    const title = this.newTaskTitle().trim();
    if (!title) return;
    await this.run(async () => {
      await this.tasks.create({ title });
      this.newTaskTitle.set('');
    });
  }

  protected toggleTask(task: TaskItem): void {
    void this.run(() => this.tasks.toggle(task.id));
  }

  protected openNote(id: string): void {
    void this.router.navigate(['/notes'], { queryParams: { id } });
  }

  protected newNote(): void {
    void this.router.navigate(['/notes'], { queryParams: { new: 1 } });
  }

  protected startFocus(): void {
    void this.run(() => this.focus.start());
  }

  protected pauseFocus(): void {
    void this.run(() => this.focus.pause());
  }

  protected resumeFocus(): void {
    void this.run(() => this.focus.resume());
  }

  protected stopFocus(): void {
    void this.run(() => this.focus.stop());
  }

  protected showCat(): void {
    void this.run(() => this.catWindow.show());
  }

  protected hideCat(): void {
    void this.run(() => this.catWindow.hide());
  }

  protected toggleWalking(): void {
    void this.run(() => this.catSettings.save({ autoWalk: !this.catWalking() }));
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.error.set(null);
    } catch (err) {
      this.error.set((err as Error).message ?? String(err));
    } finally {
      this.busy.set(false);
    }
  }
}

function greetingFor(hour: number): string {
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
