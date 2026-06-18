# Personal ToDoList

A local-first Windows desktop todo app built with Electron, React, TypeScript, and sql.js. It keeps task data on the device and focuses on day-to-day planning, time tracking, and lightweight review.

## Features

- Manage today, upcoming, all, completed, abandoned, and per-list task views.
- Create, edit, delete, complete, reopen, and abandon tasks.
- Track task time with start, pause, complete, and floating timer windows.
- Organize tasks with lists, colors, due dates, reminders, priorities, estimates, and notes.
- Reorder today's tasks within priority groups by drag and drop.
- Review daily completed-task time with a pie chart, task breakdown, list totals, and weekly trend bars.
- Switch between light and dark themes.
- Use custom frameless window controls for minimize, maximize, and close.
- Store data locally under the Electron user data directory.

## Tech Stack

- Electron + electron-vite
- React + TypeScript
- sql.js for local persistence
- Vitest for repository tests
- @dnd-kit for sortable task groups
- lucide-react for UI icons

## Local Development

```bash
npm install
npm run dev
```

## Common Commands

```bash
npm test
npm run build
npm run dist
```

## Data Storage

Task data is saved locally in the app's user data directory. The app exposes the active database path from settings so the storage location can be inspected while developing.
