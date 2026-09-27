export type TaskPriority = 0 | 1 | 2;

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  completed: boolean;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreate {
  title: string;
  notes?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
}

export interface TaskUpdate {
  id: string;
  title?: string;
  notes?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
  completed?: boolean;
  sortOrder?: number;
}
