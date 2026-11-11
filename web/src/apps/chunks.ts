// Each app window's own chunk, by its loader. The windows themselves are a chunk (`windows/WindowLayer.tsx`), but these loaders
// stay in the first load, imported by `WindowLayer`: `main.tsx` prefetches the Browser at idle through them without the
// windows, and with `cssCodeSplit: false` Vite writes a chunk's CSS in the order it first finds the chunk's `import()`, so
// keeping them where the windows were keeps the one stylesheet in the order it had. Keep this order (Agent, Files, Commons,
// Browser), and check the built `style-*.css` against main's after any change here.

export const loadAgentBody = (): Promise<typeof import('../agent/AgentBody')> => import('../agent/AgentBody');
export const loadFilesBody = (): Promise<typeof import('./files/FilesBody')> => import('./files/FilesBody');
export const loadCommonsBody = (): Promise<typeof import('../guild/CommonsBody')> => import('../guild/CommonsBody');
export const loadBrowser = (): Promise<typeof import('../browser/BrowserApp')> => import('../browser/BrowserApp');

/** The Browser's code is fetched once the office is idle, so opening it doesn't wait. */
export function prefetchBrowser(): void {
  void loadBrowser().catch(() => undefined);
}
