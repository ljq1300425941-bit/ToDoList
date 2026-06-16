import { Notification } from 'electron';
import type { TodoRepository } from './database';

const REMINDER_INTERVAL_MS = 30_000;

export function startReminderService(repo: TodoRepository): NodeJS.Timeout {
  const tick = (): void => {
    const now = new Date().toISOString();
    const tasks = repo.dueForReminder(now);
    for (const task of tasks) {
      new Notification({
        title: 'ToDoList 提醒',
        body: task.title
      }).show();
      repo.markReminded(task.id, now);
    }
  };

  tick();
  return setInterval(tick, REMINDER_INTERVAL_MS);
}
