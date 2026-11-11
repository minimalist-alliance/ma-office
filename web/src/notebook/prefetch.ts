// The Notebook editor's chunk (`NotebookApp.tsx`): its loader and its prefetch. Apart from `NotebookWindow.tsx`, which is in the
// windows' own chunk (`windows/WindowLayer.tsx`), so the shell can prefetch the editor without the window in the first load.
import type { ComponentType } from 'react';
import type { NotebookAppProps } from './NotebookApp';

/** Rendering never wakes a desk, and this asks nothing of one: it only has the code ready (design budget B4). */
const PREFETCH_TIMEOUT_MS = 4_000;
const PREFETCH_AFTER_MS = 1_000;

export const loadNotebookApp = (): Promise<{ default: ComponentType<NotebookAppProps> }> => import('./NotebookApp');

/** At idle, once per page, after the office has settled in. A failure only means the window loads it when it opens. */
export function prefetchNotebook(): () => void {
  let idle = 0;
  const run = (): void => void loadNotebookApp().catch(() => {});
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(run, { timeout: PREFETCH_TIMEOUT_MS });
    else run();
  }, PREFETCH_AFTER_MS);
  return () => {
    window.clearTimeout(timer);
    if (idle) window.cancelIdleCallback(idle);
  };
}
