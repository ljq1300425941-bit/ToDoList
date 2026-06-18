export type Priority = 'none' | 'low' | 'medium' | 'high';
export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'abandoned';
export type Theme = 'light' | 'dark';

export interface TodoList {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes: string;
  priority: Priority;
  dueAt: string | null;
  remindAt: string | null;
  remindedAt: string | null;
  status: TaskStatus;
  estimatedMinutes: number | null;
  trackedSeconds: number;
  activeStartedAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  abandonedAt: string | null;
  timeRatio: number | null;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DailyTimeEntry {
  taskId: string;
  taskTitle: string;
  listId: string;
  listName: string;
  listColor: string;
  trackedSeconds: number;
  percent: number;
}

export interface DailyTimeSummary {
  date: string;
  totalSeconds: number;
  completedTaskCount: number;
  entries: DailyTimeEntry[];
}

export interface WeeklyTimeTrendDay {
  date: string;
  label: string;
  trackedSeconds: number;
  completedTaskCount: number;
  isSelected: boolean;
}

export interface WeeklyTimeTrend {
  weekStartDate: string;
  weekEndDate: string;
  selectedDate: string;
  totalSeconds: number;
  days: WeeklyTimeTrendDay[];
}

export type TaskView = 'today' | 'upcoming' | 'all' | 'completed' | 'abandoned' | 'daily-summary' | `list:${string}`;

export interface CreateListInput {
  name: string;
  color?: string;
}

export interface UpdateListInput {
  id: string;
  name: string;
  color: string;
}

export interface CreateTaskInput {
  title: string;
  listId?: string;
  dueAt?: string | null;
  estimatedMinutes?: number | null;
}

export interface UpdateTaskInput {
  id: string;
  listId: string;
  title: string;
  notes: string;
  priority: Priority;
  dueAt: string | null;
  remindAt: string | null;
  estimatedMinutes: number | null;
}

export interface AppSettings {
  databasePath: string;
  userDataPath: string;
}

export interface AppApi {
  getSettings(): Promise<AppSettings>;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
  };
  theme: {
    set(theme: Theme): Promise<void>;
    onChanged(callback: (theme: Theme) => void): () => void;
  };
  lists: {
    list(): Promise<TodoList[]>;
    create(input: CreateListInput): Promise<TodoList>;
    update(input: UpdateListInput): Promise<TodoList>;
    delete(id: string): Promise<{ ok: true }>;
  };
  tasks: {
    list(view: TaskView): Promise<Task[]>;
    get(id: string): Promise<Task>;
    create(input: CreateTaskInput): Promise<Task>;
    update(input: UpdateTaskInput): Promise<Task>;
    delete(id: string): Promise<{ ok: true }>;
    start(id: string): Promise<Task>;
    pause(id: string): Promise<Task>;
    complete(id: string): Promise<Task>;
    abandon(id: string): Promise<Task>;
    reopen(id: string): Promise<Task>;
    reorderToday(priority: Priority, orderedTaskIds: string[]): Promise<Task[]>;
    dailySummary(date: string): Promise<DailyTimeSummary>;
    weeklyTrend(date: string): Promise<WeeklyTimeTrend>;
    dueForReminder(nowIso?: string): Promise<Task[]>;
    onChanged(callback: (taskId: string | null) => void): () => void;
  };
}
