import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { createTodoRepository, TodoRepository } from './database';
import { startReminderService } from './reminders';
import type { CreateListInput, CreateTaskInput, Priority, UpdateListInput, UpdateTaskInput } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let floatingWindow: BrowserWindow | null = null;
let floatingTaskId: string | null = null;
let repository: TodoRepository;
let reminderTimer: NodeJS.Timeout | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: '个人 ToDoList',
    backgroundColor: '#f5f3ef',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    floatingWindow?.close();
    floatingWindow = null;
    floatingTaskId = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function createFloatingWindow(taskId: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 248,
    height: 118,
    minWidth: 220,
    minHeight: 104,
    maxWidth: 320,
    maxHeight: 150,
    title: '任务悬浮窗',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#fffdfa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  });

  window.setAlwaysOnTop(true, 'floating');
  window.on('closed', () => {
    floatingWindow = null;
  });

  loadFloatingWindow(window, taskId);
  return window;
}

function loadFloatingWindow(window: BrowserWindow, taskId: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?window=floating&taskId=${encodeURIComponent(taskId)}`);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: {
        window: 'floating',
        taskId
      }
    });
  }
}

function showFloatingWindow(taskId: string): void {
  floatingTaskId = taskId;
  if (!floatingWindow) {
    floatingWindow = createFloatingWindow(taskId);
  } else {
    loadFloatingWindow(floatingWindow, taskId);
  }

  floatingWindow.show();
}

function hideFloatingWindow(taskId?: string): void {
  if (taskId && floatingTaskId !== taskId) {
    return;
  }

  floatingTaskId = null;
  floatingWindow?.hide();
}

function notifyTasksChanged(taskId: string | null = null): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('tasks:changed', taskId);
  });
}

function registerIpc(): void {
  ipcMain.handle('app:getSettings', () => ({
    databasePath: repository.databasePath,
    userDataPath: app.getPath('userData')
  }));

  ipcMain.handle('lists:list', () => repository.listLists());
  ipcMain.handle('lists:create', (_event, input: CreateListInput) => repository.createList(input));
  ipcMain.handle('lists:update', (_event, input: UpdateListInput) => repository.updateList(input));
  ipcMain.handle('lists:delete', (_event, id: string) => {
    repository.deleteList(id);
    return { ok: true };
  });

  ipcMain.handle('tasks:list', (_event, view) => repository.listTasks(view));
  ipcMain.handle('tasks:get', (_event, id: string) => repository.getTask(id));
  ipcMain.handle('tasks:create', (_event, input: CreateTaskInput) => {
    const task = repository.createTask(input);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:update', (_event, input: UpdateTaskInput) => {
    const task = repository.updateTask(input);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:delete', (_event, id: string) => {
    repository.deleteTask(id);
    hideFloatingWindow(id);
    notifyTasksChanged(id);
    return { ok: true };
  });
  ipcMain.handle('tasks:start', (_event, id: string) => {
    const task = repository.startTask(id);
    showFloatingWindow(task.id);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:pause', (_event, id: string) => {
    const task = repository.pauseTask(id);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:complete', (_event, id: string) => {
    const task = repository.completeTask(id);
    hideFloatingWindow(id);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:abandon', (_event, id: string) => {
    const task = repository.abandonTask(id);
    hideFloatingWindow(id);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:reopen', (_event, id: string) => {
    const task = repository.reopenTask(id);
    notifyTasksChanged(task.id);
    return task;
  });
  ipcMain.handle('tasks:reorderToday', (_event, priority: Priority, orderedTaskIds: string[]) => {
    const tasks = repository.reorderTodayTasks(priority, orderedTaskIds);
    notifyTasksChanged(null);
    return tasks;
  });
  ipcMain.handle('tasks:dueForReminder', (_event, nowIso?: string) =>
    repository.dueForReminder(nowIso ?? new Date().toISOString())
  );
}

app.whenReady()
  .then(async () => {
    repository = await createTodoRepository(app.getPath('userData'));
    registerIpc();
    createWindow();
    reminderTimer = startReminderService(repository);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((error: unknown) => {
    console.error('启动 ToDoList 失败', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (reminderTimer) {
    clearInterval(reminderTimer);
  }
});
