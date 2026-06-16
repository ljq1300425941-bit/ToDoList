import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs, { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type {
  CreateListInput,
  CreateTaskInput,
  Task,
  Priority,
  TaskView,
  TodoList,
  UpdateListInput,
  UpdateTaskInput
} from '../shared/types';

const require = createRequire(import.meta.url);
const DEFAULT_LIST_COLOR = '#2f7d5f';

export interface TodoRepository {
  databasePath: string;
  listLists(): TodoList[];
  createList(input: CreateListInput): TodoList;
  updateList(input: UpdateListInput): TodoList;
  deleteList(id: string): void;
  listTasks(view: TaskView): Task[];
  getTask(id: string): Task;
  createTask(input: CreateTaskInput): Task;
  updateTask(input: UpdateTaskInput): Task;
  deleteTask(id: string): void;
  startTask(id: string): Task;
  pauseTask(id: string): Task;
  completeTask(id: string): Task;
  abandonTask(id: string): Task;
  reopenTask(id: string): Task;
  reorderTodayTasks(priority: Priority, orderedTaskIds: string[]): Task[];
  dueForReminder(nowIso: string): Task[];
  markReminded(id: string, nowIso: string): Task;
}

export async function createTodoRepository(userDataPath: string, wasmPath?: string): Promise<TodoRepository> {
  fs.mkdirSync(userDataPath, { recursive: true });
  const resolvedWasmPath = wasmPath ?? resolveSqlWasmPath();
  const SQL = await initSqlJs({ locateFile: () => resolvedWasmPath });
  const databasePath = path.join(userDataPath, 'todolist.sqlite');
  const db = openDatabase(SQL, databasePath);
  const repo = new SqlJsTodoRepository(db, databasePath);
  repo.migrate();
  return repo;
}

export async function createInMemoryTodoRepository(wasmPath?: string): Promise<TodoRepository> {
  const SQL = await initSqlJs({ locateFile: () => wasmPath ?? resolveSqlWasmPath() });
  const repo = new SqlJsTodoRepository(new SQL.Database(), ':memory:');
  repo.migrate();
  return repo;
}

function resolveSqlWasmPath(): string {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'sql-wasm.wasm'))) {
    return path.join(process.resourcesPath, 'sql-wasm.wasm');
  }

  return require.resolve('sql.js/dist/sql-wasm.wasm');
}

function openDatabase(SQL: SqlJsStatic, databasePath: string): Database {
  if (!fs.existsSync(databasePath)) {
    return new SQL.Database();
  }

  return new SQL.Database(fs.readFileSync(databasePath));
}

class SqlJsTodoRepository implements TodoRepository {
  constructor(
    private readonly db: Database,
    public readonly databasePath: string
  ) {}

  migrate(): void {
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const existing = this.scalar<number>('SELECT COUNT(*) FROM schema_migrations WHERE version = 1') ?? 0;
    if (existing === 0) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT 'none',
          due_at TEXT,
          remind_at TEXT,
          reminded_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE RESTRICT
        )
      `);
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_remind_at ON tasks(remind_at)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at)');

      const now = new Date().toISOString();
      this.db.run('INSERT INTO lists (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        crypto.randomUUID(),
        '收集箱',
        DEFAULT_LIST_COLOR,
        now,
        now
      ]);
      this.db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)', [now]);
      this.persist();
    }

    const existingV2 = this.scalar<number>('SELECT COUNT(*) FROM schema_migrations WHERE version = 2') ?? 0;
    if (existingV2 === 0) {
      this.addColumnIfMissing('tasks', 'status', "TEXT NOT NULL DEFAULT 'pending'");
      this.addColumnIfMissing('tasks', 'estimated_minutes', 'INTEGER');
      this.addColumnIfMissing('tasks', 'tracked_seconds', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('tasks', 'active_started_at', 'TEXT');
      this.addColumnIfMissing('tasks', 'started_at', 'TEXT');
      this.addColumnIfMissing('tasks', 'paused_at', 'TEXT');
      this.addColumnIfMissing('tasks', 'abandoned_at', 'TEXT');
      this.db.run("UPDATE tasks SET status = 'completed' WHERE completed_at IS NOT NULL");
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');

      const now = new Date().toISOString();
      this.db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)', [now]);
      this.persist();
    }

    const existingV3 = this.scalar<number>('SELECT COUNT(*) FROM schema_migrations WHERE version = 3') ?? 0;
    if (existingV3 === 0) {
      this.addColumnIfMissing('tasks', 'sort_order', 'INTEGER');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_today_sort ON tasks(priority, sort_order, due_at)');

      const now = new Date().toISOString();
      this.db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)', [now]);
      this.persist();
    }
  }

  listLists(): TodoList[] {
    return this.all<TodoList>(
      'SELECT id, name, color, created_at AS createdAt, updated_at AS updatedAt FROM lists ORDER BY created_at ASC'
    );
  }

  createList(input: CreateListInput): TodoList {
    const name = input.name.trim();
    if (!name) {
      throw new Error('清单名称不能为空');
    }

    const now = new Date().toISOString();
    const list: TodoList = {
      id: crypto.randomUUID(),
      name,
      color: input.color ?? DEFAULT_LIST_COLOR,
      createdAt: now,
      updatedAt: now
    };
    this.db.run('INSERT INTO lists (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      list.id,
      list.name,
      list.color,
      list.createdAt,
      list.updatedAt
    ]);
    this.persist();
    return list;
  }

  updateList(input: UpdateListInput): TodoList {
    const now = new Date().toISOString();
    const name = input.name.trim();
    if (!name) {
      throw new Error('清单名称不能为空');
    }

    this.db.run('UPDATE lists SET name = ?, color = ?, updated_at = ? WHERE id = ?', [
      name,
      input.color,
      now,
      input.id
    ]);
    this.persist();
    return this.getList(input.id);
  }

  deleteList(id: string): void {
    const taskCount = this.scalar<number>('SELECT COUNT(*) FROM tasks WHERE list_id = ?', [id]) ?? 0;
    if (taskCount > 0) {
      throw new Error('清单中还有任务，暂不能删除');
    }

    this.db.run('DELETE FROM lists WHERE id = ?', [id]);
    this.persist();
  }

  listTasks(view: TaskView): Task[] {
    const todayStart = startOfTodayIso();
    const tomorrowStart = startOfTomorrowIso();
    const sevenDaysLater = addDaysIso(7);

    if (view === 'today') {
      return this.queryTasks(
        "status NOT IN ('completed', 'abandoned') AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?",
        [todayStart, tomorrowStart],
        'today'
      );
    }

    if (view === 'upcoming') {
      return this.queryTasks(
        "status NOT IN ('completed', 'abandoned') AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?",
        [tomorrowStart, sevenDaysLater]
      );
    }

    if (view === 'completed') {
      return this.queryTasks("status = 'completed'", []);
    }

    if (view === 'abandoned') {
      return this.queryTasks("status = 'abandoned'", []);
    }

    if (view.startsWith('list:')) {
      return this.queryTasks('list_id = ?', [view.slice('list:'.length)]);
    }

    return this.queryTasks('1 = 1', []);
  }

  createTask(input: CreateTaskInput): Task {
    const title = input.title.trim();
    if (!title) {
      throw new Error('任务标题不能为空');
    }

    const listId = input.listId ?? this.defaultListId();
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      listId,
      title,
      notes: '',
      priority: 'none',
      dueAt: input.dueAt ?? null,
      remindAt: null,
      remindedAt: null,
      status: 'pending',
      estimatedMinutes: normalizeEstimatedMinutes(input.estimatedMinutes ?? null),
      trackedSeconds: 0,
      activeStartedAt: null,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
      abandonedAt: null,
      timeRatio: null,
      sortOrder: null,
      createdAt: now,
      updatedAt: now
    };
    this.db.run(
      `INSERT INTO tasks (
        id, list_id, title, notes, priority, due_at, remind_at, reminded_at, status, estimated_minutes,
        tracked_seconds, active_started_at, started_at, paused_at, completed_at, abandoned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.listId,
        task.title,
        task.notes,
        task.priority,
        task.dueAt,
        task.remindAt,
        task.remindedAt,
        task.status,
        task.estimatedMinutes,
        task.trackedSeconds,
        task.activeStartedAt,
        task.startedAt,
        task.pausedAt,
        task.completedAt,
        task.abandonedAt,
        task.createdAt,
        task.updatedAt
      ]
    );
    this.persist();
    return task;
  }

  updateTask(input: UpdateTaskInput): Task {
    const title = input.title.trim();
    if (!title) {
      throw new Error('任务标题不能为空');
    }

    const now = new Date().toISOString();
    const current = this.getTask(input.id);
    const remindedAt = current.remindAt === input.remindAt ? current.remindedAt : null;
    this.db.run(
      `UPDATE tasks
        SET list_id = ?, title = ?, notes = ?, priority = ?, due_at = ?, remind_at = ?, reminded_at = ?,
          estimated_minutes = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.listId,
        title,
        input.notes,
        input.priority,
        input.dueAt,
        input.remindAt,
        remindedAt,
        normalizeEstimatedMinutes(input.estimatedMinutes),
        now,
        input.id
      ]
    );
    this.persist();
    return this.getTask(input.id);
  }

  deleteTask(id: string): void {
    this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
    this.persist();
  }

  startTask(id: string): Task {
    const now = new Date().toISOString();
    const task = this.getTask(id);
    if (task.status !== 'pending' && task.status !== 'paused') {
      throw new Error('只有未开始或已暂停的任务可以开始');
    }

    this.db.run(
      `UPDATE tasks
        SET status = 'running', active_started_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ?`,
      [now, now, now, id]
    );
    this.persist();
    return this.getTask(id);
  }

  pauseTask(id: string): Task {
    const now = new Date().toISOString();
    const task = this.getTask(id);
    if (task.status !== 'running' || !task.activeStartedAt) {
      throw new Error('只有进行中的任务可以暂停');
    }

    this.db.run(
      `UPDATE tasks
        SET status = 'paused', tracked_seconds = ?, active_started_at = NULL, paused_at = ?, updated_at = ?
        WHERE id = ?`,
      [this.elapsedSeconds(task, now), now, now, id]
    );
    this.persist();
    return this.getTask(id);
  }

  completeTask(id: string): Task {
    const now = new Date().toISOString();
    const task = this.getTask(id);
    if (task.status === 'completed' || task.status === 'abandoned') {
      throw new Error('已结束的任务不能再次完成');
    }

    this.db.run(
      `UPDATE tasks
        SET status = 'completed', tracked_seconds = ?, active_started_at = NULL, completed_at = ?, updated_at = ?
        WHERE id = ?`,
      [this.elapsedSeconds(task, now), now, now, id]
    );
    this.persist();
    return this.getTask(id);
  }

  abandonTask(id: string): Task {
    const now = new Date().toISOString();
    const task = this.getTask(id);
    if (task.status === 'completed' || task.status === 'abandoned') {
      throw new Error('已结束的任务不能放弃');
    }

    this.db.run(
      `UPDATE tasks
        SET status = 'abandoned', tracked_seconds = ?, active_started_at = NULL, abandoned_at = ?, updated_at = ?
        WHERE id = ?`,
      [this.elapsedSeconds(task, now), now, now, id]
    );
    this.persist();
    return this.getTask(id);
  }

  reopenTask(id: string): Task {
    const now = new Date().toISOString();
    const task = this.getTask(id);
    if (task.status !== 'completed' && task.status !== 'abandoned') {
      throw new Error('只有已完成或已放弃的任务可以恢复');
    }

    this.db.run(
      `UPDATE tasks
        SET status = 'paused', active_started_at = NULL, completed_at = NULL, abandoned_at = NULL, updated_at = ?
        WHERE id = ?`,
      [now, id]
    );
    this.persist();
    return this.getTask(id);
  }

  reorderTodayTasks(priority: Priority, orderedTaskIds: string[]): Task[] {
    if (orderedTaskIds.length === 0) {
      return this.listTasks('today');
    }

    const todayStart = startOfTodayIso();
    const tomorrowStart = startOfTomorrowIso();
    const placeholders = orderedTaskIds.map(() => '?').join(', ');
    const matching = this.all<{ id: string }>(
      `SELECT id FROM tasks
        WHERE id IN (${placeholders})
          AND priority = ?
          AND status NOT IN ('completed', 'abandoned')
          AND due_at IS NOT NULL
          AND due_at >= ?
          AND due_at < ?`,
      [...orderedTaskIds, priority, todayStart, tomorrowStart]
    );
    const matchingIds = new Set(matching.map((task) => task.id));
    if (matchingIds.size !== orderedTaskIds.length) {
      throw new Error('只能调整今日同一重要性内的任务顺序');
    }

    const now = new Date().toISOString();
    orderedTaskIds.forEach((id, index) => {
      this.db.run('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?', [(index + 1) * 1000, now, id]);
    });
    this.persist();
    return this.listTasks('today');
  }

  dueForReminder(nowIso: string): Task[] {
    return this.queryTasks(
      "status NOT IN ('completed', 'abandoned') AND remind_at IS NOT NULL AND remind_at <= ? AND reminded_at IS NULL",
      [nowIso]
    );
  }

  markReminded(id: string, nowIso: string): Task {
    this.db.run('UPDATE tasks SET reminded_at = ?, updated_at = ? WHERE id = ?', [nowIso, nowIso, id]);
    this.persist();
    return this.getTask(id);
  }

  private queryTasks(whereClause: string, params: SqlValue[], orderMode: 'default' | 'today' = 'default'): Task[] {
    const orderBy =
      orderMode === 'today'
        ? `CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
        sort_order IS NULL ASC,
        sort_order ASC,
        due_at IS NULL ASC,
        due_at ASC,
        created_at DESC`
        : `completed_at IS NOT NULL ASC,
        abandoned_at IS NOT NULL ASC,
        status = 'running' DESC,
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
        due_at IS NULL ASC,
        due_at ASC,
        created_at DESC`;

    return this.all<Task>(
      `SELECT
        id,
        list_id AS listId,
        title,
        notes,
        priority,
        due_at AS dueAt,
        remind_at AS remindAt,
        reminded_at AS remindedAt,
        status,
        estimated_minutes AS estimatedMinutes,
        tracked_seconds AS trackedSeconds,
        active_started_at AS activeStartedAt,
        started_at AS startedAt,
        paused_at AS pausedAt,
        completed_at AS completedAt,
        abandoned_at AS abandonedAt,
        sort_order AS sortOrder,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tasks
      WHERE ${whereClause}
      ORDER BY ${orderBy}`,
      params
    );
  }

  private getList(id: string): TodoList {
    const list = this.first<TodoList>(
      'SELECT id, name, color, created_at AS createdAt, updated_at AS updatedAt FROM lists WHERE id = ?',
      [id]
    );
    if (!list) {
      throw new Error('清单不存在');
    }

    return list;
  }

  getTask(id: string): Task {
    const task = this.queryTasks('id = ?', [id])[0];
    if (!task) {
      throw new Error('任务不存在');
    }

    return task;
  }

  private defaultListId(): string {
    const id = this.scalar<string>('SELECT id FROM lists ORDER BY created_at ASC LIMIT 1');
    if (!id) {
      throw new Error('没有可用清单');
    }

    return id;
  }

  private first<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  private scalar<T>(sql: string, params: SqlValue[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    return result[0]?.values[0]?.[0] as T | undefined;
  }

  private all<T>(sql: string, params: SqlValue[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (result.length === 0) {
      return [];
    }

    const columns = result[0].columns;
    return result[0].values.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index]]))
    ).map((item) => this.hydrateTask(item)) as T[];
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.exec(`PRAGMA table_info(${table})`)[0]?.values.map((row) => row[1]) ?? [];
    if (!columns.includes(column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private elapsedSeconds(task: Task, nowIso: string): number {
    if (task.status !== 'running' || !task.activeStartedAt) {
      return task.trackedSeconds;
    }

    const activeSeconds = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(task.activeStartedAt)) / 1000));
    return task.trackedSeconds + activeSeconds;
  }

  private hydrateTask<T>(item: Record<string, SqlValue>): Record<string, SqlValue> | T {
    if (!('trackedSeconds' in item) || !('estimatedMinutes' in item) || !('status' in item)) {
      return item;
    }

    const trackedSeconds = Number(item.trackedSeconds ?? 0);
    const estimatedMinutes = item.estimatedMinutes === null ? null : Number(item.estimatedMinutes);
    return {
      ...item,
      estimatedMinutes,
      trackedSeconds,
      timeRatio:
        item.status === 'completed' && estimatedMinutes && estimatedMinutes > 0
          ? trackedSeconds / 60 / estimatedMinutes
          : null
    };
  }

  private persist(): void {
    if (this.databasePath === ':memory:') {
      return;
    }

    fs.writeFileSync(this.databasePath, Buffer.from(this.db.export()));
  }
}

function startOfTodayIso(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfTomorrowIso(): string {
  const date = new Date();
  date.setHours(24, 0, 0, 0);
  return date.toISOString();
}

function addDaysIso(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function normalizeEstimatedMinutes(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}
