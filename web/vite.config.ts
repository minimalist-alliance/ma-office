import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { commonsThemesPlugin } from '../apps/commons/web/vite-plugins/commonsThemes.ts';
import { notebookThemesPlugin } from './notebook/vite-plugins/notebookThemes.ts';
import { firstLoad } from './vite-plugins/firstLoad';
import { noPreloadPlugin } from './vite-plugins/noPreload.ts';
import { releasePlugin } from './vite-plugins/release.ts';
import { themesPlugin } from './vite-plugins/themes.ts';

const version = process.env['MA_VERSION'] ?? 'dev';
const entry = fileURLToPath(new URL('./src/main.tsx', import.meta.url));
// Every app's window, out of the first load as one chunk of its own (`withWindows` in `src/apps/chunks.ts`): the registry,
// and the window states the desk app host borrows from it (`src/deskapps/hostDeps.ts`).
const first = firstLoad(entry, {
  windows: [fileURLToPath(new URL('./src/apps/registry.tsx', import.meta.url)), fileURLToPath(new URL('./src/deskapps/hostDeps.ts', import.meta.url))],
});

export default defineConfig({
  plugins: [react(), themesPlugin(), notebookThemesPlugin(), commonsThemesPlugin(), noPreloadPlugin(), first.plugin, releasePlugin(version)],
  // `notebook/` and `agent/` are packages of their own, imported as source, and may have their own node_modules beside this one:
  // one copy of each, or React and Yjs break. Commons (`../apps/commons/web/src`, task 48) is outside this folder, so its
  // bare imports resolve from here too, `perfect-freehand` included.
  resolve: { dedupe: ['react', 'react-dom', 'yjs', 'perfect-freehand', 'y-protocols', 'lib0', '@tiptap/core', '@tiptap/pm', '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-collaboration', '@tiptap/extension-highlight', '@tiptap/extension-list', '@tiptap/extensions', '@tiptap/y-tiptap'] },
  define: { __MA_VERSION__: JSON.stringify(version) },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    // The default CSP has no font-src data:, so nothing gets inlined.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 800, // the real budget is enforced by scripts/build-release.mjs
    // No list of each lazy chunk's dependencies to preload: `noPreload.ts` makes the helper a bare `import()`, which never
    // read it, and there's one stylesheet (`cssCodeSplit: false`), so there's no CSS to list either. About 0.9 KB gzipped
    // of file names off the first load.
    modulePreload: false,
    rollupOptions: {
      input: entry,
      // The vendored avatar kit (renderer and parts) is one lazy chunk of its own, loaded when a built avatar is drawn. Everything
      // else the entry imports statically is one chunk, `first-load` (`vite-plugins/firstLoad.ts`), and every app's window
      // another, `windows`.
      output: {
        manualChunks: (id, { getModuleInfo }) =>
          id.includes('/packages/avatar-kit/') ? 'avatar-kit' : first.isFirstLoad(id, getModuleInfo) ? 'first-load' : first.groupOf(id, getModuleInfo),
      },
    },
  },
  // The dev server may read Commons' source, beside this package, and the sample app's view and manifest (the mock desk's Tally).
  server: { host: 'localhost', fs: { allow: ['.', '../apps/commons/web', '../packages/avatar-kit', '../packages/bell-kit', '../spikes/app-contract-sample/app'] } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
