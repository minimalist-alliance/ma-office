// The demo page (index.html, demo/) and the unit tests. The module itself is src/, which the Desk
// app imports from source when it adopts it, so there's no library build.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { brandThemesPlugin } from './demo/brandThemes.ts';
import { notebookThemesPlugin } from './vite-plugins/notebookThemes.ts';

// The Desk harness's default policy (web/harness/serve.mjs), so the demo proves the module needs no
// inline script or style, no CDN and no network. `npm run demo` serves the built page with it.
export const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join('; ');

export default defineConfig({
  plugins: [react(), notebookThemesPlugin(), brandThemesPlugin()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    // The policy has no font-src data:, so nothing gets inlined.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    // No modulepreload polyfill: it's the one piece of a Vite bundle that can call fetch() (as web/agent).
    modulePreload: { polyfill: false },
  },
  preview: { headers: { 'Content-Security-Policy': CSP } },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
