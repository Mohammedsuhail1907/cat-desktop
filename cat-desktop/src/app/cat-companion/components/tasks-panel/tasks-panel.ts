import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TaskItem } from '../../../core/models';
import { NavigationService } from '../../../core/services/navigation.service';
import { TasksService } from '../../../core/services/tasks.service';

const MAX_VISIBLE = 6;

/** Quick add + the first open tasks; everything else lives in the main window. */
@Component({
  selector: 'app-tasks-panel',
  imports: [DatePipe],
  templateUrl: './tasks-panel.html',
  styleUrl: './tasks-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TasksPanel {
  protected readonly tasks = inject(TasksService);
  private readonly navigation = inject(NavigationService);

  protected readonly newTitle = signal('');
  protected readonly adding = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly visible = computed(() => this.tasks.open().slice(0, MAX_VISIBLE));
  protected readonly hiddenCount = computed(() => Math.max(0, this.tasks.openCount() - MAX_VISIBLE));

  constructor() {
    void this.tasks.refresh();
  }

  protected async add(): Promise<void> {
    const title = this.newTitle().trim();
    if (!title || this.adding()) return;
    this.adding.set(true);
    this.error.set(null);
    try {
      await this.tasks.create({ title });
      this.newTitle.set('');
    } catch (err) {
      this.error.set((err as Error).message ?? 'Could not add the task.');
    } finally {
      this.adding.set(false);
    }
  }

  protected async toggle(task: TaskItem): Promise<void> {
    try {
      await this.tasks.toggle(task.id);
    } catch (err) {
      this.error.set((err as Error).message ?? 'Could not update the task.');
    }
  }

  protected openAll(): void {
    this.navigation.navigate('/tasks').catch((err) => console.warn('[cat] navigate failed', err));
  }

  protected isOverdue(task: TaskItem): boolean {
    return !!task.dueAt && new Date(task.dueAt).getTime() < Date.now();
  }
}
