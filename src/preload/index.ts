import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, CreateListInput, CreateTaskInput, Priority, TaskView, UpdateListInput, UpdateTaskInput } from '../shared/types';

const api: AppApi = {
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  lists: {
    list: () => ipcRenderer.invoke('lists:list'),
    create: (input: CreateListInput) => ipcRenderer.invoke('lists:create', input),
    update: (input: UpdateListInput) => ipcRenderer.invoke('lists:update', input),
    delete: (id: string) => ipcRenderer.invoke('lists:delete', id)
  },
  tasks: {
    list: (view: TaskView) => ipcRenderer.invoke('tasks:list', view),
    get: (id: string) => ipcRenderer.invoke('tasks:get', id),
    create: (input: CreateTaskInput) => ipcRenderer.invoke('tasks:create', input),
    update: (input: UpdateTaskInput) => ipcRenderer.invoke('tasks:update', input),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    start: (id: string) => ipcRenderer.invoke('tasks:start', id),
    pause: (id: string) => ipcRenderer.invoke('tasks:pause', id),
    complete: (id: string) => ipcRenderer.invoke('tasks:complete', id),
    abandon: (id: string) => ipcRenderer.invoke('tasks:abandon', id),
    reopen: (id: string) => ipcRenderer.invoke('tasks:reopen', id),
    reorderToday: (priority: Priority, orderedTaskIds: string[]) =>
      ipcRenderer.invoke('tasks:reorderToday', priority, orderedTaskIds),
    dueForReminder: (nowIso?: string) => ipcRenderer.invoke('tasks:dueForReminder', nowIso),
    onChanged: (callback: (taskId: string | null) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, taskId: string | null) => callback(taskId);
      ipcRenderer.on('tasks:changed', listener);
      return () => ipcRenderer.removeListener('tasks:changed', listener);
    }
  }
};

contextBridge.exposeInMainWorld('todoApi', api);
