import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TaskItem } from '../../../core/models';
import { TasksService } from '../../../core/services/tasks.service';

/** Overdue and due-today tasks with one-tap completion. */
@Component({
  selector: 'app-reminders-panel',
  imports: [DatePipe],
  templateUrl: './reminders-panel.html',
  styleUrl: './reminders-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemindersPanel {
  protected readonly tasks = inject(TasksService);

  protected readonly error = signal<string | null>(null);
  protected readonly overdue = this.tasks.overdue;
  protected readonly dueToday = this.tasks.dueToday;
  protected readonly empty = computed(() => this.overdue().length === 0 && this.dueToday().length === 0);

  constructor() {
    void this.tasks.refresh();
  }

  protected async complete(task: TaskItem): Promise<void> {
    this.error.set(null);
    try {
      await this.tasks.toggle(task.id);
    } catch (err) {
      this.error.set((err as Error).message ?? 'Could not complete the task.');
    }
  }
}
