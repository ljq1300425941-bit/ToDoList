import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTodoRepository } from './database';
import type { Task } from '../shared/types';

describe('TodoRepository', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs migrations repeatedly and creates a default list', async () => {
    const repo = await createInMemoryTodoRepository();

    expect(repo.listLists()).toHaveLength(1);
    expect(repo.listLists()[0].name).toBe('收集箱');
  });

  it('supports task CRUD and completion workflow', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];
    const task = repo.createTask({ title: '写周计划', listId: list.id, estimatedMinutes: 30 });

    expect(repo.listTasks('all')).toHaveLength(1);
    const completed = repo.completeTask(task.id);
    expect(completed.completedAt).toBeTruthy();
    expect(completed.status).toBe('completed');
    expect(completed.estimatedMinutes).toBe(30);
    expect(repo.listTasks('completed')).toHaveLength(1);
    const reopened = repo.reopenTask(task.id);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.status).toBe('paused');

    repo.deleteTask(task.id);
    expect(repo.listTasks('all')).toHaveLength(0);
  });

  it('tracks elapsed time across start, pause, complete, abandon, and reopen workflows', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];
    const task = repo.createTask({ title: '写实现', listId: list.id, estimatedMinutes: 1 });

    repo.startTask(task.id);
    let running = repo.listTasks('all')[0];
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeTruthy();

    repo.pauseTask(task.id);
    let paused = repo.listTasks('all')[0];
    expect(paused.status).toBe('paused');
    expect(paused.activeStartedAt).toBeNull();

    repo.startTask(task.id);
    const completed = repo.completeTask(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.timeRatio).not.toBeNull();

    const reopened = repo.reopenTask(task.id);
    expect(reopened.status).toBe('paused');
    expect(reopened.trackedSeconds).toBe(completed.trackedSeconds);

    repo.startTask(task.id);
    const abandoned = repo.abandonTask(task.id);
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.trackedSeconds).toBeGreaterThanOrEqual(reopened.trackedSeconds);
    expect(abandoned.timeRatio).toBeNull();
    expect(repo.listTasks('abandoned')).toHaveLength(1);
  });

  it('filters reminder candidates and marks them once', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];
    const task = repo.createTask({ title: '喝水', listId: list.id });

    repo.updateTask({
      id: task.id,
      listId: task.listId,
      title: task.title,
      notes: '',
      priority: 'low',
      dueAt: null,
      remindAt: '2026-06-15T09:00:00.000Z',
      estimatedMinutes: null
    });

    const due = repo.dueForReminder('2026-06-15T09:01:00.000Z');
    expect(due).toHaveLength(1);

    repo.markReminded(task.id, '2026-06-15T09:01:00.000Z');
    expect(repo.dueForReminder('2026-06-15T09:02:00.000Z')).toHaveLength(0);
  });

  it('blocks deleting a non-empty list', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.createList({ name: '工作' });
    repo.createTask({ title: '整理需求', listId: list.id });

    expect(() => repo.deleteList(list.id)).toThrow('清单中还有任务');
  });

  it('orders today tasks by priority before manual order', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];
    const today = todayAtNoon();
    const low = repo.createTask({ title: '低优先级', listId: list.id, dueAt: today });
    const high = repo.createTask({ title: '高优先级', listId: list.id, dueAt: today });
    const medium = repo.createTask({ title: '中优先级', listId: list.id, dueAt: today });

    repo.updateTask({ ...toUpdateInput(low), priority: 'low' });
    repo.updateTask({ ...toUpdateInput(high), priority: 'high' });
    repo.updateTask({ ...toUpdateInput(medium), priority: 'medium' });

    expect(repo.listTasks('today').map((task) => task.title)).toEqual(['高优先级', '中优先级', '低优先级']);
  });

  it('persists manual order within the same today priority group', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];
    const today = todayAtNoon();
    const first = repo.createTask({ title: '第一个', listId: list.id, dueAt: today });
    const second = repo.createTask({ title: '第二个', listId: list.id, dueAt: today });
    const third = repo.createTask({ title: '第三个', listId: list.id, dueAt: today });

    [first, second, third].forEach((task) => repo.updateTask({ ...toUpdateInput(task), priority: 'high' }));
    repo.reorderTodayTasks('high', [first.id, third.id, second.id]);

    expect(repo.listTasks('today').map((task) => task.title)).toEqual(['第一个', '第三个', '第二个']);
    expect(repo.listTasks('today').map((task) => task.sortOrder)).toEqual([1000, 2000, 3000]);
  });

  it('rejects reordering tasks outside today or outside the chosen priority', async () => {
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];
    const today = todayAtNoon();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    const high = repo.createTask({ title: '高优先级', listId: list.id, dueAt: today });
    const low = repo.createTask({ title: '低优先级', listId: list.id, dueAt: today });
    const future = repo.createTask({ title: '明天', listId: list.id, dueAt: tomorrow.toISOString() });

    repo.updateTask({ ...toUpdateInput(high), priority: 'high' });
    repo.updateTask({ ...toUpdateInput(low), priority: 'low' });
    repo.updateTask({ ...toUpdateInput(future), priority: 'high' });

    expect(() => repo.reorderTodayTasks('high', [high.id, low.id])).toThrow('只能调整今日同一重要性内的任务顺序');
    expect(() => repo.reorderTodayTasks('high', [high.id, future.id])).toThrow('只能调整今日同一重要性内的任务顺序');
  });

  it('summarizes completed tracked time for the selected local day', async () => {
    vi.useFakeTimers();
    const repo = await createInMemoryTodoRepository();
    const inbox = repo.listLists()[0];
    const work = repo.createList({ name: '工作', color: '#336699' });

    const planning = repo.createTask({ title: '整理计划', listId: inbox.id });
    vi.setSystemTime(new Date('2026-06-16T01:00:00.000Z'));
    repo.startTask(planning.id);
    vi.setSystemTime(new Date('2026-06-16T01:30:00.000Z'));
    repo.completeTask(planning.id);

    const coding = repo.createTask({ title: '写代码', listId: work.id });
    vi.setSystemTime(new Date('2026-06-16T03:00:00.000Z'));
    repo.startTask(coding.id);
    vi.setSystemTime(new Date('2026-06-16T04:30:00.000Z'));
    repo.completeTask(coding.id);

    const abandoned = repo.createTask({ title: '放弃项', listId: work.id });
    vi.setSystemTime(new Date('2026-06-16T05:00:00.000Z'));
    repo.startTask(abandoned.id);
    vi.setSystemTime(new Date('2026-06-16T05:30:00.000Z'));
    repo.abandonTask(abandoned.id);

    const zeroTracked = repo.createTask({ title: '零耗时', listId: work.id });
    repo.completeTask(zeroTracked.id);

    const previousDay = repo.createTask({ title: '昨天完成', listId: inbox.id });
    vi.setSystemTime(new Date('2026-06-15T01:00:00.000Z'));
    repo.startTask(previousDay.id);
    vi.setSystemTime(new Date('2026-06-15T01:45:00.000Z'));
    repo.completeTask(previousDay.id);

    const summary = repo.dailySummary('2026-06-16');

    expect(summary.date).toBe('2026-06-16');
    expect(summary.totalSeconds).toBe(7200);
    expect(summary.completedTaskCount).toBe(3);
    expect(summary.entries.map((entry) => entry.taskTitle)).toEqual(['写代码', '整理计划', '零耗时']);
    expect(summary.entries[0]).toMatchObject({
      listId: work.id,
      listName: '工作',
      listColor: '#336699',
      trackedSeconds: 5400,
      percent: 75
    });
    expect(summary.entries[1].percent).toBe(25);
    expect(summary.entries[2]).toMatchObject({
      taskTitle: '零耗时',
      trackedSeconds: 0,
      percent: 0
    });
  });

  it('summarizes weekly tracked time from Monday to Sunday for the selected local day', async () => {
    vi.useFakeTimers();
    const repo = await createInMemoryTodoRepository();
    const list = repo.listLists()[0];

    const mondayFirst = repo.createTask({ title: '周一上午', listId: list.id });
    vi.setSystemTime(new Date('2026-06-15T01:00:00.000Z'));
    repo.startTask(mondayFirst.id);
    vi.setSystemTime(new Date('2026-06-15T01:30:00.000Z'));
    repo.completeTask(mondayFirst.id);

    const mondaySecond = repo.createTask({ title: '周一下午', listId: list.id });
    vi.setSystemTime(new Date('2026-06-15T03:00:00.000Z'));
    repo.startTask(mondaySecond.id);
    vi.setSystemTime(new Date('2026-06-15T03:15:00.000Z'));
    repo.completeTask(mondaySecond.id);

    const wednesday = repo.createTask({ title: '周三任务', listId: list.id });
    vi.setSystemTime(new Date('2026-06-17T02:00:00.000Z'));
    repo.startTask(wednesday.id);
    vi.setSystemTime(new Date('2026-06-17T03:00:00.000Z'));
    repo.completeTask(wednesday.id);

    const outsideWeek = repo.createTask({ title: '下周任务', listId: list.id });
    vi.setSystemTime(new Date('2026-06-22T01:00:00.000Z'));
    repo.startTask(outsideWeek.id);
    vi.setSystemTime(new Date('2026-06-22T02:00:00.000Z'));
    repo.completeTask(outsideWeek.id);

    const abandoned = repo.createTask({ title: '放弃项', listId: list.id });
    vi.setSystemTime(new Date('2026-06-18T01:00:00.000Z'));
    repo.startTask(abandoned.id);
    vi.setSystemTime(new Date('2026-06-18T01:20:00.000Z'));
    repo.abandonTask(abandoned.id);

    const zeroTracked = repo.createTask({ title: '零耗时', listId: list.id });
    vi.setSystemTime(new Date('2026-06-19T01:00:00.000Z'));
    repo.completeTask(zeroTracked.id);

    const trend = repo.weeklyTrend('2026-06-17');

    expect(trend.weekStartDate).toBe('2026-06-15');
    expect(trend.weekEndDate).toBe('2026-06-21');
    expect(trend.selectedDate).toBe('2026-06-17');
    expect(trend.totalSeconds).toBe(6300);
    expect(trend.days).toHaveLength(7);
    expect(trend.days.map((day) => day.date)).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21'
    ]);
    expect(trend.days[0]).toMatchObject({
      label: '周一',
      trackedSeconds: 2700,
      completedTaskCount: 2,
      isSelected: false
    });
    expect(trend.days[2]).toMatchObject({
      label: '周三',
      trackedSeconds: 3600,
      completedTaskCount: 1,
      isSelected: true
    });
    expect(trend.days[3].trackedSeconds).toBe(0);
    expect(trend.days[4].completedTaskCount).toBe(0);
  });
});

function todayAtNoon(): string {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return today.toISOString();
}

function toUpdateInput(task: Task) {
  return {
    id: task.id,
    listId: task.listId,
    title: task.title,
    notes: task.notes,
    priority: task.priority,
    dueAt: task.dueAt,
    remindAt: task.remindAt,
    estimatedMinutes: task.estimatedMinutes
  };
}
