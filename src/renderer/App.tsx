import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DndContext,
  DragEndEvent,
  DraggableAttributes,
  DraggableSyntheticListeners,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Inbox,
  ListPlus,
  Maximize2,
  Minus,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  GripVertical,
  PieChart,
  Sun,
  XCircle,
  X,
  Trash2
} from 'lucide-react';
import type {
  DailyTimeEntry,
  DailyTimeSummary,
  Priority,
  Task,
  TaskStatus,
  TaskView,
  Theme,
  TodoList,
  WeeklyTimeTrend,
  WeeklyTimeTrendDay
} from '../shared/types';
import './styles.css';

const priorityLabels: Record<Priority, string> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高'
};

const priorityOrder: Priority[] = ['high', 'medium', 'low', 'none'];

const viewLabels: Record<string, string> = {
  today: '今日',
  upcoming: '即将到来',
  all: '全部',
  completed: '已完成',
  abandoned: '已放弃',
  'daily-summary': '每日总结'
};

const statusLabels: Record<TaskStatus, string> = {
  pending: '未开始',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已放弃'
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const THEME_STORAGE_KEY = 'todo-theme';

export default function App(): JSX.Element {
  const [lists, setLists] = useState<TodoList[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedView, setSelectedView] = useState<TaskView>('today');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickDue, setQuickDue] = useState('');
  const [quickEstimate, setQuickEstimate] = useState('');
  const [newListName, setNewListName] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [summaryDate, setSummaryDate] = useState(() => formatDateInput(new Date()));
  const [dailySummary, setDailySummary] = useState<DailyTimeSummary | null>(null);
  const [weeklyTrend, setWeeklyTrend] = useState<WeeklyTimeTrend | null>(null);
  const quickTitleInputRef = useRef<HTMLInputElement>(null);
  const pendingTaskRef = useRef<Task | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const selectedTask = selectedView === 'daily-summary' ? null : tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
  const defaultListId = lists[0]?.id ?? '';

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return tasks;
    }

    return tasks.filter((task) => `${task.title} ${task.notes}`.toLowerCase().includes(needle));
  }, [query, tasks]);

  const canDragToday = selectedView === 'today' && query.trim() === '';
  const groupedTodayTasks = useMemo(() => groupTasksByPriority(filteredTasks), [filteredTasks]);

  useEffect(() => {
    void loadLists();
  }, []);

  useEffect(() => {
    if (selectedView === 'daily-summary') {
      setTasks([]);
      setSelectedTaskId(null);
      void loadDailySummary();
      return;
    }

    void loadTasks(selectedView);
  }, [selectedView, summaryDate]);

  useEffect(() => {
    return window.todoApi.tasks.onChanged(() => {
      if (selectedView === 'daily-summary') {
        void loadDailySummary();
      } else {
        void loadTasks(selectedView);
      }
    });
  }, [selectedView, summaryDate]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    syncStoredTheme(theme);
    void window.todoApi.theme.set(theme);
  }, [theme]);

  useEffect(() => {
    return window.todoApi.theme.onChanged((nextTheme) => setTheme(nextTheme));
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      setError('');
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败');
    }
  }

  async function loadLists(): Promise<void> {
    const nextLists = await window.todoApi.lists.list();
    setLists(nextLists);
  }

  async function loadTasks(view: TaskView = selectedView): Promise<void> {
    if (view === 'daily-summary') {
      return;
    }

    const nextTasks = await window.todoApi.tasks.list(view);
    setTasks(nextTasks);
    setSelectedTaskId((current) => {
      if (current && nextTasks.some((task) => task.id === current)) {
        return current;
      }

      return nextTasks[0]?.id ?? null;
    });
  }

  async function loadDailySummary(): Promise<void> {
    const [nextSummary, nextTrend] = await Promise.all([
      window.todoApi.tasks.dailySummary(summaryDate),
      window.todoApi.tasks.weeklyTrend(summaryDate)
    ]);
    setDailySummary(nextSummary);
    setWeeklyTrend(nextTrend);
  }

  async function createTask(event: FormEvent): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const title = quickTitle.trim();
      if (!title) {
        return;
      }

      const listId = selectedView.startsWith('list:') ? selectedView.slice('list:'.length) : defaultListId;
      const task = await window.todoApi.tasks.create({
        title,
        listId,
        dueAt: defaultDueForView(selectedView, quickDue),
        estimatedMinutes: parsePositiveInteger(quickEstimate)
      });
      setQuickTitle('');
      setQuickDue('');
      setQuickEstimate('');
      await loadTasks();
      setSelectedTaskId(task.id);
      window.setTimeout(() => quickTitleInputRef.current?.focus(), 0);
    });
  }

  async function createList(event: FormEvent): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const name = newListName.trim();
      if (!name) {
        return;
      }

      const list = await window.todoApi.lists.create({ name });
      setNewListName('');
      await loadLists();
      setSelectedView(`list:${list.id}`);
    });
  }

  function changeTaskDraft(task: Task): void {
    setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
    scheduleTaskSave(task);
  }

  function scheduleTaskSave(task: Task): void {
    pendingTaskRef.current = task;
    setSaveStatus('saving');
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      void flushPendingTaskSave();
    }, 500);
  }

  async function flushPendingTaskSave(): Promise<void> {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const task = pendingTaskRef.current;
    if (!task) {
      return;
    }

    pendingTaskRef.current = null;
    setSaveStatus('saving');
    try {
      const savedTask = await window.todoApi.tasks.update({
        id: task.id,
        listId: task.listId,
        title: task.title,
        notes: task.notes,
        priority: task.priority,
        dueAt: task.dueAt,
        remindAt: task.remindAt,
        estimatedMinutes: task.estimatedMinutes
      });
      setTasks((items) => items.map((item) => (item.id === savedTask.id ? savedTask : item)));
      setSaveStatus('saved');
    } catch (caught) {
      pendingTaskRef.current = task;
      setSaveStatus('error');
      setError(caught instanceof Error ? caught.message : '自动保存失败');
    }
  }

  async function selectTask(id: string): Promise<void> {
    await flushPendingTaskSave();
    setSelectedTaskId(id);
  }

  async function updateList(list: TodoList): Promise<void> {
    await run(async () => {
      await window.todoApi.lists.update(list);
      await loadLists();
    });
  }

  async function deleteList(list: TodoList): Promise<void> {
    await run(async () => {
      await window.todoApi.lists.delete(list.id);
      await loadLists();
      setSelectedView('all');
    });
  }

  async function toggleTask(task: Task): Promise<void> {
    await run(async () => {
      await flushPendingTaskSave();
      if (task.status === 'completed' || task.status === 'abandoned') {
        await window.todoApi.tasks.reopen(task.id);
      } else {
        await window.todoApi.tasks.complete(task.id);
      }
      await loadTasks();
    });
  }

  async function changeTaskStatus(task: Task, action: 'start' | 'pause' | 'complete' | 'abandon' | 'reopen'): Promise<void> {
    await run(async () => {
      await flushPendingTaskSave();
      await window.todoApi.tasks[action](task.id);
      await loadTasks();
    });
  }

  async function deleteTask(task: Task): Promise<void> {
    await run(async () => {
      await flushPendingTaskSave();
      await window.todoApi.tasks.delete(task.id);
      await loadTasks();
    });
  }

  async function reorderToday(event: DragEndEvent): Promise<void> {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) {
      return;
    }

    const activeTask = tasks.find((task) => task.id === activeId);
    const overTask = tasks.find((task) => task.id === overId);
    if (!activeTask || !overTask) {
      return;
    }

    if (activeTask.priority !== overTask.priority) {
      setError('只能在同一重要性分组内拖拽排序');
      return;
    }

    const groupTasks = tasks.filter((task) => task.priority === activeTask.priority);
    const oldIndex = groupTasks.findIndex((task) => task.id === activeId);
    const newIndex = groupTasks.findIndex((task) => task.id === overId);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const reorderedGroup = arrayMove(groupTasks, oldIndex, newIndex);
    const orderedIds = reorderedGroup.map((task) => task.id);
    const nextTasks = mergePriorityGroup(tasks, activeTask.priority, reorderedGroup);
    setTasks(nextTasks);

    try {
      setError('');
      const savedTasks = await window.todoApi.tasks.reorderToday(activeTask.priority, orderedIds);
      setTasks(savedTasks);
    } catch (caught) {
      await loadTasks('today');
      setError(caught instanceof Error ? caught.message : '排序保存失败');
    }
  }

  function currentTitle(): string {
    if (selectedView.startsWith('list:')) {
      return lists.find((list) => list.id === selectedView.slice('list:'.length))?.name ?? '清单';
    }

    return viewLabels[selectedView] ?? '任务';
  }

  function shiftSummaryDate(days: number): void {
    setSummaryDate((current) => {
      const date = new Date(`${current}T00:00:00`);
      date.setDate(date.getDate() + days);
      return formatDateInput(date);
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">T</div>
          <div>
            <h1>个人 ToDoList</h1>
            <p>本地离线</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="任务视图">
          <SidebarButton
            icon={<CalendarDays size={18} />}
            label="今日"
            active={selectedView === 'today'}
            onClick={() => setSelectedView('today')}
          />
          <SidebarButton
            icon={<Clock3 size={18} />}
            label="即将到来"
            active={selectedView === 'upcoming'}
            onClick={() => setSelectedView('upcoming')}
          />
          <SidebarButton
            icon={<Inbox size={18} />}
            label="全部"
            active={selectedView === 'all'}
            onClick={() => setSelectedView('all')}
          />
          <SidebarButton
            icon={<Check size={18} />}
            label="已完成"
            active={selectedView === 'completed'}
            onClick={() => setSelectedView('completed')}
          />
          <SidebarButton
            icon={<XCircle size={18} />}
            label="已放弃"
            active={selectedView === 'abandoned'}
            onClick={() => setSelectedView('abandoned')}
          />
          <SidebarButton
            icon={<PieChart size={18} />}
            label="每日总结"
            active={selectedView === 'daily-summary'}
            onClick={() => setSelectedView('daily-summary')}
          />
        </nav>

        <section className="list-section">
          <div className="section-title">清单</div>
          <div className="nav-list">
            {lists.map((list) => (
              <SidebarButton
                key={list.id}
                icon={<span className="color-dot" style={{ backgroundColor: list.color }} />}
                label={list.name}
                active={selectedView === `list:${list.id}`}
                onClick={() => setSelectedView(`list:${list.id}`)}
              />
            ))}
          </div>

          <form className="new-list" onSubmit={createList}>
            <input
              aria-label="新清单名称"
              value={newListName}
              onChange={(event) => setNewListName(event.target.value)}
              placeholder="新清单"
            />
            <button type="submit" title="新建清单" aria-label="新建清单">
              <ListPlus size={17} />
            </button>
          </form>
        </section>
      </aside>

      <section className="task-area">
        <header className="toolbar">
          <div>
            <h2>{currentTitle()}</h2>
            <p>
              {selectedView === 'daily-summary'
                ? `${formatSummaryDate(summaryDate)} · ${formatSeconds(dailySummary?.totalSeconds ?? 0)}`
                : `${filteredTasks.length} 个任务`}
            </p>
          </div>
          <div className="toolbar-actions">
            {selectedView === 'daily-summary' ? (
              <div className="date-controls" aria-label="每日总结日期">
                <button type="button" title="前一天" aria-label="前一天" onClick={() => shiftSummaryDate(-1)}>
                  <ChevronLeft size={17} />
                </button>
                <input
                  type="date"
                  value={summaryDate}
                  onChange={(event) => setSummaryDate(event.target.value || formatDateInput(new Date()))}
                  aria-label="选择日期"
                />
                <button type="button" title="后一天" aria-label="后一天" onClick={() => shiftSummaryDate(1)}>
                  <ChevronRight size={17} />
                </button>
              </div>
            ) : (
              <label className="search-box">
                <Search size={17} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" />
              </label>
            )}
            <button
              className="theme-toggle"
              type="button"
              title={theme === 'dark' ? '切换到浅色模式' : '切换到夜间模式'}
              aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到夜间模式'}
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>

        <WindowControls />

        {selectedView !== 'daily-summary' && (
          <form className="quick-add" onSubmit={createTask}>
            <input
              ref={quickTitleInputRef}
              value={quickTitle}
              onChange={(event) => setQuickTitle(event.target.value)}
              placeholder="添加一个任务"
            />
            <input
              type="datetime-local"
              value={quickDue}
              onChange={(event) => setQuickDue(event.target.value)}
              aria-label="截止时间"
              title={selectedView === 'today' ? '留空则默认为今天' : '截止时间'}
            />
            <input
              type="number"
              min="1"
              step="1"
              value={quickEstimate}
              onChange={(event) => setQuickEstimate(event.target.value)}
              aria-label="预估时间"
              placeholder="预估分钟"
            />
            <button type="submit" title="添加任务" aria-label="添加任务">
              <Plus size={19} />
            </button>
          </form>
        )}

        {error && <div className="error-banner">{error}</div>}

        {selectedView === 'daily-summary' ? (
          <DailySummaryView summary={dailySummary} weeklyTrend={weeklyTrend} />
        ) : (
        <div className="task-list">
          {canDragToday ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorderToday(event)}>
              {priorityOrder.map((priority) => {
                const groupTasks = groupedTodayTasks[priority];
                if (groupTasks.length === 0) {
                  return null;
                }

                return (
                  <section className="priority-group" key={priority}>
                    <div className="priority-group-title">{priorityLabels[priority]}</div>
                    <SortableContext items={groupTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                      {groupTasks.map((task) => (
                        <SortableTaskRow
                          key={task.id}
                          task={task}
                          lists={lists}
                          selected={selectedTask?.id === task.id}
                          nowTick={nowTick}
                          draggable
                          onSelect={selectTask}
                          onToggle={toggleTask}
                        />
                      ))}
                    </SortableContext>
                  </section>
                );
              })}
            </DndContext>
          ) : (
            filteredTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                lists={lists}
                selected={selectedTask?.id === task.id}
                nowTick={nowTick}
                draggable={false}
                onSelect={selectTask}
                onToggle={toggleTask}
              />
            ))
          )}

          {filteredTasks.length === 0 && (
            <div className="empty-state">
              <strong>{emptyTitle(selectedView)}</strong>
              <span>{emptyDescription(selectedView)}</span>
              <button type="button" onClick={() => quickTitleInputRef.current?.focus()}>
                <Plus size={17} />
                <span>添加任务</span>
              </button>
            </div>
          )}
        </div>
        )}
      </section>

      <aside className="detail-panel">
        {selectedView === 'daily-summary' ? (
          <DailySummaryPanel summary={dailySummary} weeklyTrend={weeklyTrend} />
        ) : selectedTask ? (
          <TaskEditor
            task={selectedTask}
            lists={lists}
            saveStatus={saveStatus}
            nowTick={nowTick}
            onChange={changeTaskDraft}
            onToggle={toggleTask}
            onStatusChange={changeTaskStatus}
            onDelete={deleteTask}
          />
        ) : (
          <div className="empty-detail">选择一个任务查看详情</div>
        )}

        {selectedView.startsWith('list:') && (
          <ListEditor
            list={lists.find((list) => list.id === selectedView.slice('list:'.length))}
            onChange={(list) => setLists((items) => items.map((item) => (item.id === list.id ? list : item)))}
            onSave={updateList}
            onDelete={deleteList}
          />
        )}
      </aside>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('找不到应用挂载节点 #root');
}

const windowParams = new URLSearchParams(window.location.search);
const isFloatingWindow = windowParams.get('window') === 'floating';
if (isFloatingWindow) {
  document.body.classList.add('floating-body');
}

applyTheme(readStoredTheme());
window.todoApi.theme.onChanged(syncStoredTheme);

createRoot(root).render(
  isFloatingWindow ? <FloatingTaskWindow taskId={windowParams.get('taskId') ?? ''} /> : <App />
);

function WindowControls(): JSX.Element {
  return (
    <div className="window-controls" aria-label="窗口控制">
      <button type="button" title="最小化" aria-label="最小化" onClick={() => void window.todoApi.window.minimize()}>
        <Minus size={16} />
      </button>
      <button type="button" title="最大化或还原" aria-label="最大化或还原" onClick={() => void window.todoApi.window.toggleMaximize()}>
        <Maximize2 size={15} />
      </button>
      <button className="window-close" type="button" title="关闭" aria-label="关闭" onClick={() => void window.todoApi.window.close()}>
        <X size={16} />
      </button>
    </div>
  );
}

interface FloatingTaskWindowProps {
  taskId: string;
}

function FloatingTaskWindow({ taskId }: FloatingTaskWindowProps): JSX.Element {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadTask();
    return window.todoApi.tasks.onChanged((changedTaskId) => {
      if (!changedTaskId || changedTaskId === taskId) {
        void loadTask();
      }
    });
  }, [taskId]);

  async function loadTask(): Promise<void> {
    if (!taskId) {
      setError('没有可显示的任务');
      return;
    }

    try {
      setError('');
      setTask(await window.todoApi.tasks.get(taskId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取任务失败');
    }
  }

  async function runFloatingAction(action: 'start' | 'pause' | 'complete'): Promise<void> {
    if (!task) {
      return;
    }

    try {
      setError('');
      const updatedTask = await window.todoApi.tasks[action](task.id);
      setTask(updatedTask);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败');
    }
  }

  const trackedSeconds = task ? currentTrackedSeconds(task, nowTick) : 0;
  const canStart = task?.status === 'pending' || task?.status === 'paused';
  const canPause = task?.status === 'running';
  const ended = task?.status === 'completed' || task?.status === 'abandoned';

  return (
    <main className="floating-shell">
      <div className="floating-drag-region">
        <span className={`floating-status-dot ${task ? `floating-status-${task.status}` : ''}`} />
        <span>{task ? statusLabels[task.status] : '任务'}</span>
      </div>

      <section className="floating-content">
        <h1 title={task?.title}>{task?.title ?? '正在读取任务'}</h1>
        <div className="floating-time">{formatSeconds(trackedSeconds)}</div>
        {error && <div className="floating-error">{error}</div>}
      </section>

      <div className="floating-actions">
        {canStart && (
          <button type="button" title="开始任务" aria-label="开始任务" onClick={() => void runFloatingAction('start')}>
            <Play size={18} />
            <span>开始</span>
          </button>
        )}
        {canPause && (
          <button type="button" title="暂停任务" aria-label="暂停任务" onClick={() => void runFloatingAction('pause')}>
            <Pause size={18} />
            <span>暂停</span>
          </button>
        )}
        <button
          type="button"
          title="结束任务"
          aria-label="结束任务"
          disabled={!task || ended}
          onClick={() => void runFloatingAction('complete')}
        >
          <Check size={18} />
          <span>结束</span>
        </button>
      </div>
    </main>
  );
}

interface SidebarButtonProps {
  icon: JSX.Element;
  label: string;
  active: boolean;
  onClick(): void;
}

function SidebarButton({ icon, label, active, onClick }: SidebarButtonProps): JSX.Element {
  return (
    <button className={`sidebar-button ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

interface TaskRowProps {
  task: Task;
  lists: TodoList[];
  selected: boolean;
  nowTick: number;
  draggable: boolean;
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
  onSelect(id: string): Promise<void>;
  onToggle(task: Task): Promise<void>;
}

function TaskRow({
  task,
  lists,
  selected,
  nowTick,
  draggable,
  attributes,
  listeners,
  setActivatorNodeRef,
  onSelect,
  onToggle
}: TaskRowProps): JSX.Element {
  return (
    <div
      className={`task-row ${draggable ? 'task-row-draggable' : ''} ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => void onSelect(task.id)}
    >
      {draggable ? (
        <button
          className="drag-handle"
          type="button"
          title="拖拽排序"
          aria-label="拖拽排序"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical size={17} />
        </button>
      ) : (
        <span
          className="complete-button"
          role="checkbox"
          aria-checked={task.status === 'completed'}
          onClick={(event) => {
            event.stopPropagation();
            void onToggle(task);
          }}
        >
          {task.status === 'completed' ? <Check size={16} /> : task.status === 'abandoned' ? <XCircle size={16} /> : <Circle size={16} />}
        </span>
      )}
      {draggable && (
        <span
          className="complete-button"
          role="checkbox"
          aria-checked={task.status === 'completed'}
          onClick={(event) => {
            event.stopPropagation();
            void onToggle(task);
          }}
        >
          {task.status === 'completed' ? <Check size={16} /> : task.status === 'abandoned' ? <XCircle size={16} /> : <Circle size={16} />}
        </span>
      )}
      <span className="task-row-main">
        <span className={task.status === 'completed' || task.status === 'abandoned' ? 'done-title' : ''}>{task.title}</span>
        <span>
          {listName(lists, task.listId)}
          {task.dueAt ? ` · ${formatDateTime(task.dueAt)}` : ''}
          {task.estimatedMinutes ? ` · 预估 ${formatMinutes(task.estimatedMinutes)}` : ''}
          {currentTrackedSeconds(task, nowTick) > 0 ? ` · 实际 ${formatSeconds(currentTrackedSeconds(task, nowTick))}` : ''}
          {task.timeRatio !== null ? ` · 实际/预估 ${task.timeRatio.toFixed(2)}x` : ''}
        </span>
      </span>
      <span className="task-badges">
        <span className={`status-badge status-${task.status}`}>{statusLabels[task.status]}</span>
        <span className={`priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span>
      </span>
    </div>
  );
}

function SortableTaskRow(props: Omit<TaskRowProps, 'attributes' | 'listeners' | 'setActivatorNodeRef'>): JSX.Element {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id
  });

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'sortable-row dragging' : 'sortable-row'}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <TaskRow
        {...props}
        attributes={attributes}
        listeners={listeners}
        setActivatorNodeRef={setActivatorNodeRef}
      />
    </div>
  );
}

interface DailySummaryViewProps {
  summary: DailyTimeSummary | null;
  weeklyTrend: WeeklyTimeTrend | null;
}

function DailySummaryView({ summary, weeklyTrend }: DailySummaryViewProps): JSX.Element {
  const entries = summary?.entries ?? [];
  const timedEntries = entries.filter((entry) => entry.trackedSeconds > 0);
  const totalSeconds = summary?.totalSeconds ?? 0;

  if (!summary) {
    return (
      <div className="summary-empty">
        <strong>正在读取每日总结</strong>
        <span>稍等一下，统计马上出来。</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="daily-summary-view">
        <div className="summary-empty">
          <strong>这一天还没有完成任务</strong>
          <span>完成任务后，会在这里看到每日总结。</span>
        </div>
        <WeeklyTrendChart trend={weeklyTrend} />
      </div>
    );
  }

  return (
    <div className="daily-summary-view">
      <section className="summary-chart-section">
        {timedEntries.length > 0 ? (
          <SummaryPie entries={timedEntries} />
        ) : (
          <div className="summary-no-time">
            <strong>暂无计时数据</strong>
            <span>已完成任务会列在下方</span>
          </div>
        )}
        <div className="summary-total">
          <span>总计</span>
          <strong>{formatSeconds(totalSeconds)}</strong>
          <small>{summary.completedTaskCount} 个完成任务</small>
        </div>
      </section>

      <section className="summary-legend" aria-label="每日任务耗时明细">
        {entries.map((entry, index) => (
          <div className="summary-entry" key={entry.taskId}>
            <span className="summary-swatch" style={{ backgroundColor: summaryEntryColor(entry, index, entries) }} />
            <span className="summary-entry-main">
              <strong title={entry.taskTitle}>{entry.taskTitle}</strong>
              <span>{entry.listName}</span>
            </span>
            <span className="summary-entry-time">
              <strong>{formatSeconds(entry.trackedSeconds)}</strong>
              <span>{formatPercent(entry.percent)}</span>
            </span>
          </div>
        ))}
      </section>

      <WeeklyTrendChart trend={weeklyTrend} />
    </div>
  );
}

function SummaryPie({ entries }: { entries: DailyTimeEntry[] }): JSX.Element {
  let accumulated = 0;
  const total = entries.reduce((sum, entry) => sum + entry.trackedSeconds, 0);

  return (
    <svg className="summary-pie" viewBox="0 0 220 220" role="img" aria-label="每日任务耗时扇形图">
      {entries.map((entry, index) => {
        const start = accumulated / total;
        accumulated += entry.trackedSeconds;
        const end = accumulated / total;
        const color = summaryEntryColor(entry, index, entries);

        if (entries.length === 1) {
          return <circle key={entry.taskId} cx="110" cy="110" r="92" fill={color} />;
        }

        return <path key={entry.taskId} d={pieSlicePath(110, 110, 92, start, end)} fill={color} />;
      })}
      <circle cx="110" cy="110" r="42" fill="var(--surface)" />
    </svg>
  );
}

function WeeklyTrendChart({ trend }: { trend: WeeklyTimeTrend | null }): JSX.Element {
  const days = trend?.days ?? [];
  const maxSeconds = Math.max(...days.map((day) => day.trackedSeconds), 0);

  return (
    <section className="weekly-trend-section" aria-label="每周时间趋势">
      <div className="summary-section-header">
        <div>
          <h3>每周趋势</h3>
          <span>{trend ? `${formatShortDate(trend.weekStartDate)} - ${formatShortDate(trend.weekEndDate)}` : '正在读取'}</span>
        </div>
      </div>
      {trend && maxSeconds > 0 ? (
        <div className="weekly-bars">
          {days.map((day) => (
            <div className={`weekly-bar-item ${day.isSelected ? 'selected' : ''}`} key={day.date}>
              <div className="weekly-bar-track">
                <div className="weekly-bar-fill" style={{ height: `${Math.max(8, (day.trackedSeconds / maxSeconds) * 100)}%` }} />
              </div>
              <strong>{day.label.slice(1)}</strong>
              <span>{formatSeconds(day.trackedSeconds)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="weekly-empty">这一周还没有可统计的完成任务</div>
      )}
    </section>
  );
}

function DailySummaryPanel({ summary, weeklyTrend }: DailySummaryViewProps): JSX.Element {
  const entries = summary?.entries ?? [];
  const listTotals = summarizeByList(entries);
  const bestDay = bestWeeklyDay(weeklyTrend?.days ?? []);

  return (
    <section className="editor-section summary-panel">
      <div className="editor-header">
        <h3>当日摘要</h3>
      </div>
      <div className="summary-stats">
        <span>
          <strong>{formatSeconds(summary?.totalSeconds ?? 0)}</strong>
          <small>总耗时</small>
        </span>
        <span>
          <strong>{summary?.completedTaskCount ?? 0}</strong>
          <small>完成任务</small>
        </span>
      </div>
      <div className="summary-stats">
        <span>
          <strong>{formatSeconds(weeklyTrend?.totalSeconds ?? 0)}</strong>
          <small>本周总耗时</small>
        </span>
        <span>
          <strong>{formatSeconds(Math.round((weeklyTrend?.totalSeconds ?? 0) / 7))}</strong>
          <small>日均耗时</small>
        </span>
      </div>
      <div className="weekly-best-day">
        <span>最高耗时日</span>
        <strong>{bestDay ? `${bestDay.label} · ${formatSeconds(bestDay.trackedSeconds)}` : '暂无'}</strong>
      </div>
      <div className="summary-list-breakdown">
        <div className="section-title">清单汇总</div>
        {listTotals.length > 0 ? (
          listTotals.map((item) => (
            <div className="summary-list-row" key={item.listId}>
              <span className="summary-swatch" style={{ backgroundColor: item.listColor }} />
              <span>{item.listName} · {item.completedTaskCount}项</span>
              <strong>{formatSeconds(item.trackedSeconds)}</strong>
            </div>
          ))
        ) : (
          <div className="summary-muted">暂无可汇总的清单</div>
        )}
      </div>
    </section>
  );
}

interface TaskEditorProps {
  task: Task;
  lists: TodoList[];
  saveStatus: SaveStatus;
  nowTick: number;
  onChange(task: Task): void;
  onToggle(task: Task): Promise<void>;
  onStatusChange(task: Task, action: 'start' | 'pause' | 'complete' | 'abandon' | 'reopen'): Promise<void>;
  onDelete(task: Task): Promise<void>;
}

function TaskEditor({
  task,
  lists,
  saveStatus,
  nowTick,
  onChange,
  onToggle,
  onStatusChange,
  onDelete
}: TaskEditorProps): JSX.Element {
  const trackedSeconds = currentTrackedSeconds(task, nowTick);
  const canStart = task.status === 'pending' || task.status === 'paused';
  const canPause = task.status === 'running';
  const canFinish = task.status !== 'completed' && task.status !== 'abandoned';
  const canReopen = task.status === 'completed' || task.status === 'abandoned';

  return (
    <section className="editor-section">
      <div className="editor-header">
        <h3>任务详情</h3>
        <div className="icon-actions">
          {canStart && (
            <button title="开始任务" aria-label="开始任务" onClick={() => void onStatusChange(task, 'start')}>
              <Play size={18} />
            </button>
          )}
          {canPause && (
            <button title="暂停任务" aria-label="暂停任务" onClick={() => void onStatusChange(task, 'pause')}>
              <Pause size={18} />
            </button>
          )}
          {canFinish && (
            <button title="完成任务" aria-label="完成任务" onClick={() => void onToggle(task)}>
              <Check size={18} />
            </button>
          )}
          {canFinish && (
            <button title="放弃任务" aria-label="放弃任务" onClick={() => void onStatusChange(task, 'abandon')}>
              <XCircle size={18} />
            </button>
          )}
          {canReopen && (
            <button title="恢复任务" aria-label="恢复任务" onClick={() => void onStatusChange(task, 'reopen')}>
              <RotateCcw size={18} />
            </button>
          )}
          <button title="删除任务" aria-label="删除任务" onClick={() => void onDelete(task)}>
            <Trash2 size={18} />
          </button>
        </div>
      </div>
      <div className={`save-status save-status-${saveStatus}`}>{saveStatusLabel(saveStatus)}</div>

      <label>
        标题
        <input value={task.title} onChange={(event) => onChange({ ...task, title: event.target.value })} />
      </label>
      <label>
        备注
        <textarea value={task.notes} onChange={(event) => onChange({ ...task, notes: event.target.value })} />
      </label>
      <label>
        清单
        <select value={task.listId} onChange={(event) => onChange({ ...task, listId: event.target.value })}>
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        优先级
        <select value={task.priority} onChange={(event) => onChange({ ...task, priority: event.target.value as Priority })}>
          {Object.entries(priorityLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        预估时间（分钟）
        <input
          type="number"
          min="1"
          step="1"
          value={task.estimatedMinutes ?? ''}
          onChange={(event) => onChange({ ...task, estimatedMinutes: parsePositiveInteger(event.target.value) })}
        />
      </label>
      <div className="time-summary">
        <span>状态：{statusLabels[task.status]}</span>
        <span>实际：{formatSeconds(trackedSeconds)}</span>
        <span>预估：{task.estimatedMinutes ? formatMinutes(task.estimatedMinutes) : '未设置'}</span>
        <span>实际/预估：{task.timeRatio !== null ? `${task.timeRatio.toFixed(2)}x` : '无'}</span>
      </div>
      <label>
        截止时间
        <input
          type="datetime-local"
          value={toLocalInput(task.dueAt)}
          onChange={(event) => onChange({ ...task, dueAt: event.target.value ? toIsoFromLocalInput(event.target.value) : null })}
        />
      </label>
      <label>
        提醒时间
        <input
          type="datetime-local"
          value={toLocalInput(task.remindAt)}
          onChange={(event) => onChange({ ...task, remindAt: event.target.value ? toIsoFromLocalInput(event.target.value) : null })}
        />
      </label>
    </section>
  );
}

interface ListEditorProps {
  list?: TodoList;
  onChange(list: TodoList): void;
  onSave(list: TodoList): Promise<void>;
  onDelete(list: TodoList): Promise<void>;
}

function ListEditor({ list, onChange, onSave, onDelete }: ListEditorProps): JSX.Element | null {
  if (!list) {
    return null;
  }

  return (
    <section className="editor-section list-editor">
      <div className="editor-header">
        <h3>清单设置</h3>
        <button title="删除清单" aria-label="删除清单" onClick={() => void onDelete(list)}>
          <Trash2 size={18} />
        </button>
      </div>
      <label>
        名称
        <input value={list.name} onChange={(event) => onChange({ ...list, name: event.target.value })} />
      </label>
      <label>
        颜色
        <input type="color" value={list.color} onChange={(event) => onChange({ ...list, color: event.target.value })} />
      </label>
      <button className="primary-action" onClick={() => void onSave(list)}>
        <Save size={18} />
        <span>保存清单</span>
      </button>
    </section>
  );
}

function listName(lists: TodoList[], id: string): string {
  return lists.find((list) => list.id === id)?.name ?? '清单';
}

function groupTasksByPriority(tasks: Task[]): Record<Priority, Task[]> {
  return {
    high: tasks.filter((task) => task.priority === 'high'),
    medium: tasks.filter((task) => task.priority === 'medium'),
    low: tasks.filter((task) => task.priority === 'low'),
    none: tasks.filter((task) => task.priority === 'none')
  };
}

function mergePriorityGroup(tasks: Task[], priority: Priority, reorderedGroup: Task[]): Task[] {
  const nextGroup = [...reorderedGroup];
  return tasks.map((task) => (task.priority === priority ? nextGroup.shift() ?? task : task));
}

function toIsoFromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

function parsePositiveInteger(value: string | number | null): number | null {
  if (value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed);
}

function currentTrackedSeconds(task: Task, nowTick: number): number {
  if (task.status !== 'running' || !task.activeStartedAt) {
    return task.trackedSeconds;
  }

  const activeSeconds = Math.max(0, Math.floor((nowTick - Date.parse(task.activeStartedAt)) / 1000));
  return task.trackedSeconds + activeSeconds;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${hours}h`;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(restSeconds).padStart(2, '0')}s`;
  }

  return restSeconds > 0 ? `${minutes}m ${String(restSeconds).padStart(2, '0')}s` : `${minutes}m`;
}

function defaultDueForView(view: TaskView, quickDue: string): string | null {
  if (quickDue) {
    return toIsoFromLocalInput(quickDue);
  }

  if (view === 'today') {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    return date.toISOString();
  }

  return null;
}

type DailyListSummary = Pick<DailyTimeEntry, 'listId' | 'listName' | 'listColor' | 'trackedSeconds'> & {
  completedTaskCount: number;
};

function summarizeByList(entries: DailyTimeEntry[]): DailyListSummary[] {
  const totals = new Map<string, DailyListSummary>();
  entries.forEach((entry) => {
    const current = totals.get(entry.listId);
    if (current) {
      current.trackedSeconds += entry.trackedSeconds;
      current.completedTaskCount += 1;
      return;
    }

    totals.set(entry.listId, {
      listId: entry.listId,
      listName: entry.listName,
      listColor: entry.listColor,
      trackedSeconds: entry.trackedSeconds,
      completedTaskCount: 1
    });
  });

  return [...totals.values()].sort((left, right) => {
    if (right.trackedSeconds !== left.trackedSeconds) {
      return right.trackedSeconds - left.trackedSeconds;
    }

    return right.completedTaskCount - left.completedTaskCount;
  });
}

function summaryEntryColor(entry: DailyTimeEntry, index: number, entries: DailyTimeEntry[]): string {
  const sameListIndex = entries.slice(0, index + 1).filter((item) => item.listId === entry.listId).length - 1;
  const offsets = [-8, 8, -18, 18, -28, 28];
  return adjustHexLightness(entry.listColor, offsets[sameListIndex % offsets.length]);
}

function adjustHexLightness(hex: string, amount: number): string {
  const normalized = hex.replace('#', '');
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return hex;
  }

  const next = [0, 2, 4].map((start) => {
    const value = Number.parseInt(normalized.slice(start, start + 2), 16);
    const adjusted = Math.max(0, Math.min(255, value + amount));
    return adjusted.toString(16).padStart(2, '0');
  });

  return `#${next.join('')}`;
}

function pieSlicePath(cx: number, cy: number, radius: number, startRatio: number, endRatio: number): string {
  const startAngle = startRatio * Math.PI * 2 - Math.PI / 2;
  const endAngle = endRatio * Math.PI * 2 - Math.PI / 2;
  const startX = cx + radius * Math.cos(startAngle);
  const startY = cy + radius * Math.sin(startAngle);
  const endX = cx + radius * Math.cos(endAngle);
  const endY = cy + radius * Math.sin(endAngle);
  const largeArc = endRatio - startRatio > 0.5 ? 1 : 0;

  return `M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatSummaryDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(`${value}T00:00:00`));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(`${value}T00:00:00`));
}

function formatPercent(value: number): string {
  if (value === 0) {
    return '0%';
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function bestWeeklyDay(days: WeeklyTimeTrendDay[]): WeeklyTimeTrendDay | null {
  return days.reduce<WeeklyTimeTrendDay | null>((best, day) => {
    if (day.trackedSeconds === 0) {
      return best;
    }

    if (!best || day.trackedSeconds > best.trackedSeconds) {
      return day;
    }

    return best;
  }, null);
}

function emptyTitle(view: TaskView): string {
  if (view === 'today') {
    return '今天还没有任务';
  }

  if (view === 'upcoming') {
    return '未来一周还没有安排';
  }

  if (view === 'completed') {
    return '还没有完成的任务';
  }

  return '这里还没有任务';
}

function emptyDescription(view: TaskView): string {
  if (view === 'today') {
    return '输入一个标题，按回车就能加入今日待办。';
  }

  if (view === 'completed') {
    return '完成任务后会自动出现在这里。';
  }

  return '可以先快速添加一个任务，再到右侧补充详情。';
}

function saveStatusLabel(status: SaveStatus): string {
  if (status === 'saving') {
    return '保存中';
  }

  if (status === 'saved') {
    return '已自动保存';
  }

  if (status === 'error') {
    return '保存失败';
  }

  return '自动保存';
}

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme preference is optional; the UI still works if storage is unavailable.
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function syncStoredTheme(theme: Theme): void {
  applyTheme(theme);
  writeStoredTheme(theme);
}

function toLocalInput(value: string | null): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}
