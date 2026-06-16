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
  Circle,
  Clock3,
  Inbox,
  ListPlus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  GripVertical,
  XCircle,
  Trash2
} from 'lucide-react';
import type { Priority, Task, TaskStatus, TaskView, TodoList } from '../shared/types';
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
  abandoned: '已放弃'
};

const statusLabels: Record<TaskStatus, string> = {
  pending: '未开始',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已放弃'
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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
  const [nowTick, setNowTick] = useState(() => Date.now());
  const quickTitleInputRef = useRef<HTMLInputElement>(null);
  const pendingTaskRef = useRef<Task | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
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
    void loadTasks(selectedView);
  }, [selectedView]);

  useEffect(() => {
    return window.todoApi.tasks.onChanged(() => {
      void loadTasks(selectedView);
    });
  }, [selectedView]);

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
    const nextTasks = await window.todoApi.tasks.list(view);
    setTasks(nextTasks);
    setSelectedTaskId((current) => {
      if (current && nextTasks.some((task) => task.id === current)) {
        return current;
      }

      return nextTasks[0]?.id ?? null;
    });
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
            <p>{filteredTasks.length} 个任务</p>
          </div>
          <label className="search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" />
          </label>
        </header>

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

        {error && <div className="error-banner">{error}</div>}

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
      </section>

      <aside className="detail-panel">
        {selectedTask ? (
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

createRoot(root).render(
  isFloatingWindow ? <FloatingTaskWindow taskId={windowParams.get('taskId') ?? ''} /> : <App />
);

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
    return `${minutes} 分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes === 0) {
    return `${restSeconds} 秒`;
  }

  return restSeconds > 0 ? `${formatMinutes(minutes)} ${restSeconds} 秒` : formatMinutes(minutes);
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
