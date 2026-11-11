import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { commonsThemesPlugin } from '../apps/commons/web/vite-plugins/commonsThemes.ts';
import { notebookThemesPlugin } from './notebook/vite-plugins/notebookThemes.ts';
import { noPreloadPlugin } from './vite-plugins/noPreload.ts';
import { releasePlugin } from './vite-plugins/release.ts';
import { themesPlugin } from './vite-plugins/themes.ts';

const version = process.env['MA_VERSION'] ?? 'dev';

export default defineConfig({
  plugins: [react(), themesPlugin(), notebookThemesPlugin(), commonsThemesPlugin(), noPreloadPlugin(), releasePlugin(version)],
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
    rollupOptions: {
      input: 'src/main.tsx',
      // The vendored avatar kit (renderer and parts) is one lazy chunk of its own, loaded when a built avatar is drawn.
      output: { manualChunks: (id) => (id.includes('/packages/avatar-kit/') ? 'avatar-kit' : undefined) },
    },
  },
  // The dev server may read Commons' source, beside this package.
  server: { host: 'localhost', fs: { allow: ['.', '../apps/commons/web', '../packages/avatar-kit', '../packages/bell-kit'] } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
