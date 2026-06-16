import type { AppApi } from '../shared/types';

declare global {
  interface Window {
    todoApi: AppApi;
  }
}

export {};
