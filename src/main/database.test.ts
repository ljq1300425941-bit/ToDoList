import { describe, expect, it } from 'vitest';
import { createInMemoryTodoRepository } from './database';
import type { Task } from '../shared/types';

describe('TodoRepository', () => {
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
