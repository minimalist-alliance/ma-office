// The demo page (index.html, demo/) and the unit tests. The module itself is src/, which the Desk
// app imports from source when it adopts it, so there's no library build.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { deskThemesPlugin } from './demo/deskThemes.ts';
import { commonsThemesPlugin } from './vite-plugins/commonsThemes.ts';

export default defineConfig({
  plugins: [react(), deskThemesPlugin(), commonsThemesPlugin()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    // The page's policy has no font-src data:, so nothing gets inlined.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    // No modulepreload polyfill: it's the one piece of a Vite bundle that can call fetch() (as web/notebook).
    modulePreload: { polyfill: false },
  },
  server: {
    // The vendored avatar kit sits at the repo root, beside apps/.
    fs: { allow: ['.', '../../../packages/avatar-kit'] },
    // `npm run dev` proxies the room link to a stand-in server on 8790.
    proxy: { '/ws': { target: 'ws://127.0.0.1:8790', ws: true } },
  },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
