import { Injectable, computed, inject, signal } from '@angular/core';
import { DesktopBridgeService } from '../desktop/desktop-bridge.service';
import { TaskCreate, TaskItem, TaskUpdate } from '../models';

@Injectable({ providedIn: 'root' })
export class TasksService {
  private readonly bridge = inject(DesktopBridgeService);
  /** False until a page asked for the list; until then a change event has nothing to keep fresh. */
  private loadedOnce = false;

  readonly tasks = signal<TaskItem[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly open = computed(() => this.tasks().filter((t) => !t.completed));
  readonly completed = computed(() => this.tasks().filter((t) => t.completed));
  readonly openCount = computed(() => this.open().length);
  readonly dueToday = computed(() => {
    const today = new Date().toDateString();
    return this.open().filter((t) => t.dueAt && new Date(t.dueAt).toDateString() === today);
  });
  readonly overdue = computed(() => {
    const now = Date.now();
    return this.open().filter((t) => t.dueAt && new Date(t.dueAt).getTime() < now && new Date(t.dueAt).toDateString() !== new Date().toDateString());
  });

  constructor() {
    this.bridge.on('tasks.changed').subscribe(() => {
      if (this.loadedOnce) void this.refresh();
    });
  }

  async refresh(includeCompleted = true): Promise<void> {
    this.loadedOnce = true;
    this.loading.set(true);
    try {
      const tasks = await this.bridge.invoke('tasks.list', { includeCompleted });
      this.tasks.set(tasks);
      this.error.set(null);
    } catch (err) {
      this.error.set(String((err as Error).message ?? err));
    } finally {
      this.loading.set(false);
    }
  }

  async create(input: TaskCreate): Promise<TaskItem> {
    const task = await this.bridge.invoke('tasks.create', input);
    this.tasks.update((list) => [...list, task]);
    return task;
  }

  async update(input: TaskUpdate): Promise<TaskItem> {
    const task = await this.bridge.invoke('tasks.update', input);
    this.tasks.update((list) => list.map((t) => (t.id === task.id ? task : t)));
    return task;
  }

  async toggle(id: string): Promise<TaskItem> {
    const task = await this.bridge.invoke('tasks.toggle', { id });
    this.tasks.update((list) => list.map((t) => (t.id === task.id ? task : t)));
    return task;
  }

  async delete(id: string): Promise<void> {
    await this.bridge.invoke('tasks.delete', { id });
    this.tasks.update((list) => list.filter((t) => t.id !== id));
  }

  async clearCompleted(): Promise<number> {
    const { deleted } = await this.bridge.invoke('tasks.clearCompleted');
    this.tasks.update((list) => list.filter((t) => !t.completed));
    return deleted;
  }
}
