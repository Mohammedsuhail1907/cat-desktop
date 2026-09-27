import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { TaskItem, TaskPriority } from '../../core/models';
import { TasksService } from '../../core/services/tasks.service';
import { ConfirmDialog } from '../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe';

type DueStatus = 'overdue' | 'today' | 'tomorrow' | 'later';

const DUE_MIN_YEAR = 1970;
const DUE_MAX_YEAR = 9999;

const PRIORITY_LABELS: Record<TaskPriority, string> = { 0: 'Normal', 1: 'Medium', 2: 'High' };

@Component({
  selector: 'app-tasks',
  imports: [Icon, EmptyState, ConfirmDialog, RelativeTimePipe],
  templateUrl: './tasks.html',
  styleUrl: './tasks.scss',
})
export class Tasks {
  private readonly injector = inject(Injector);
  private readonly confirm = viewChild.required(ConfirmDialog);
  private readonly editInput = viewChild<ElementRef<HTMLInputElement>>('editInput');
  private readonly dueInput = viewChild<ElementRef<HTMLInputElement>>('dueInput');

  protected readonly tasks = inject(TasksService);
  protected readonly priorities: readonly TaskPriority[] = [0, 1, 2];
  protected readonly priorityLabels = PRIORITY_LABELS;

  protected readonly newTitle = signal('');
  protected readonly newPriority = signal<TaskPriority>(0);
  protected readonly newDue = signal('');
  protected readonly editingId = signal<string | null>(null);
  protected readonly editingTitle = signal('');
  protected readonly dueEditingId = signal<string | null>(null);
  protected readonly completedExpanded = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly openTasks = computed(() =>
    [...this.tasks.open()].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)),
  );
  protected readonly completedTasks = computed(() =>
    [...this.tasks.completed()].sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)),
  );
  /** A due date outside 1970–9999: block adding rather than silently dropping it. */
  protected readonly newDueInvalid = computed(() => this.newDue().trim() !== '' && dateInputToIso(this.newDue()) === null);
  protected readonly canAdd = computed(() => this.newTitle().trim().length > 0 && !this.newDueInvalid() && !this.busy());

  // ---- create -------------------------------------------------------------------------------

  protected async add(): Promise<void> {
    const title = this.newTitle().trim();
    if (!title || this.newDueInvalid()) return;
    await this.run(async () => {
      await this.tasks.create({ title, priority: this.newPriority(), dueAt: dateInputToIso(this.newDue()) });
      this.newTitle.set('');
      this.newDue.set('');
      this.newPriority.set(0);
    });
  }

  protected onPrioritySelect(value: string): void {
    this.newPriority.set(parsePriority(value));
  }

  // ---- row actions --------------------------------------------------------------------------

  protected toggle(task: TaskItem): void {
    void this.run(() => this.tasks.toggle(task.id));
  }

  protected cyclePriority(task: TaskItem): void {
    const next = ((task.priority + 1) % 3) as TaskPriority;
    void this.run(() => this.tasks.update({ id: task.id, priority: next }));
  }

  protected remove(task: TaskItem): void {
    if (this.editingId() === task.id) this.editingId.set(null);
    void this.run(() => this.tasks.delete(task.id));
  }

  protected startEdit(task: TaskItem): void {
    if (task.completed) return;
    this.editingId.set(task.id);
    this.editingTitle.set(task.title);
    afterNextRender(() => this.editInput()?.nativeElement.select(), { injector: this.injector });
  }

  protected commitEdit(task: TaskItem): void {
    if (this.editingId() !== task.id) return;
    const title = this.editingTitle().trim();
    this.editingId.set(null);
    if (!title || title === task.title) return;
    void this.run(() => this.tasks.update({ id: task.id, title }));
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
  }

  protected startDueEdit(task: TaskItem): void {
    this.dueEditingId.set(task.id);
    afterNextRender(
      () => {
        const input = this.dueInput()?.nativeElement;
        if (!input) return;
        input.focus();
        if (typeof input.showPicker === 'function') {
          try {
            input.showPicker();
          } catch {
            /* the picker requires a user gesture in some contexts; the input is still usable */
          }
        }
      },
      { injector: this.injector },
    );
  }

  /** Enter or leaving the field commits; a half-typed or out-of-range date keeps the current due date. */
  protected commitDue(task: TaskItem, input: HTMLInputElement): void {
    if (this.dueEditingId() !== task.id) return;
    this.dueEditingId.set(null);
    if (input.validity.badInput) return;
    const value = input.value.trim();
    const dueAt = value ? dateInputToIso(value) : null;
    if ((value && !dueAt) || dueAt === task.dueAt) return;
    void this.run(() => this.tasks.update({ id: task.id, dueAt }));
  }

  protected clearDue(task: TaskItem): void {
    this.dueEditingId.set(null);
    void this.run(() => this.tasks.update({ id: task.id, dueAt: null }));
  }

  protected async clearCompleted(): Promise<void> {
    const count = this.completedTasks().length;
    if (count === 0) return;
    const ok = await this.confirm().open(`${count} completed ${count === 1 ? 'task' : 'tasks'} will be deleted permanently.`, {
      title: 'Clear completed tasks?',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    await this.run(() => this.tasks.clearCompleted());
  }

  // ---- presentation -------------------------------------------------------------------------

  protected dueStatus(task: TaskItem): DueStatus | null {
    if (!task.dueAt) return null;
    const days = daysFromToday(new Date(task.dueAt));
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return 'later';
  }

  protected dueLabel(task: TaskItem): string {
    if (!task.dueAt) return '';
    const date = new Date(task.dueAt);
    const days = daysFromToday(date);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, sameYear ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected dueInputValue(task: TaskItem): string {
    return isoToDateInput(task.dueAt);
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

function parsePriority(value: string): TaskPriority {
  const n = Number(value);
  return n === 1 || n === 2 ? n : 0;
}

/** "YYYY-MM-DD" from a date input → ISO string for local midnight, or null when empty/invalid/outside 1970–9999. */
function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  // The bounds also keep years 0–99 away from the Date constructor, which would map them to 1900–1999.
  if (year < DUE_MIN_YEAR || year > DUE_MAX_YEAR) return null;
  const date = new Date(year, Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysFromToday(date: Date): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((target - start) / 86_400_000);
}
