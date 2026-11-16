// Each app window's own chunk, by its loader. The windows themselves are a chunk (`windows/WindowLayer.tsx`), but these loaders
// stay in the first load, imported by `WindowLayer`: `main.tsx` prefetches the Browser at idle through them without the
// windows, and with `cssCodeSplit: false` Vite writes a chunk's CSS in the order it first finds the chunk's `import()`, so
// keeping them where the windows were keeps the one stylesheet in the order it had. Keep this order (Agent, Files, Commons,
// Browser, To-do, Courier, Documents), and check the built `style-*.css` against main's after any change here.

export const loadAgentBody = (): Promise<typeof import('../agent/AgentBody')> => import('../agent/AgentBody');
export const loadFilesBody = (): Promise<typeof import('./files/FilesBody')> => import('./files/FilesBody');
export const loadCommonsBody = (): Promise<typeof import('../guild/CommonsBody')> => import('../guild/CommonsBody');
export const loadBrowser = (): Promise<typeof import('../browser/BrowserApp')> => import('../browser/BrowserApp');
/** To-do's, last, so its stylesheet (every rule `.todo-*`) comes after the others and moves none of them. */
export const loadTodoBody = (): Promise<typeof import('./todo/TodoBody')> => import('./todo/TodoBody');
/** Courier's, after To-do's, so its stylesheet (every rule `.courier-*`) comes last and moves none of the others. */
export const loadCourierBody = (): Promise<typeof import('./courier/CourierBody')> => import('./courier/CourierBody');
/** Documents', after Courier's, so its stylesheet (every rule `.docs-*` and `.documents-*`) comes last and moves none of the others. */
export const loadDocumentsBody = (): Promise<typeof import('./documents/DocumentsBody')> => import('./documents/DocumentsBody');
/** Courier's tile count and names (no stylesheet), loaded by `desk/liveStore.ts` only while Courier's switch is on. */
export const loadCourierTile = (): Promise<typeof import('./courier/tile')> => import('./courier/tile');

/**
 * Every app's window (`registry.tsx` and what it imports: the windows' states before each app's own chunk, Browser's
 * `PanelBody` and the Notebook's `deskPanel` that the desk app host borrows), one chunk out of the first load since
 * `sub/mm-js-budget`. No window is on the first paint. What draws an app's window (the window frame, a carousel's stage, an
 * open tile, the Maia Mode room) fetches it beside its own chunk through `withWindows`, so neither waits for the other; the
 * first load fetches it at idle (`prefetchWindows` in `windows/WindowLayer.tsx`).
 */
export const loadRegistry = (): Promise<typeof import('./registry')> => import('./registry');

/** `load`'s chunk and the windows' chunk, fetched together: one round trip, as when the windows were in the first load. */
export function withWindows<T>(load: () => Promise<T>): () => Promise<T> {
  return () => Promise.all([load(), loadRegistry()]).then(([m]) => m);
}

/** The Browser's code is fetched once the office is idle, so opening it doesn't wait. */
export function prefetchBrowser(): void {
  void loadBrowser().catch(() => undefined);
}
