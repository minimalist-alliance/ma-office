// The demo page and the module's unit tests. The colors are the Desk app's own: the virtual module below
// is web/src/theme/tokens.ts turned into CSS by the Desk app's own generator, so there's one token set.
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { themeCss } from '../src/theme/themeCss.ts';

function deskThemes(): Plugin {
  const id = 'virtual:ma-themes.css';
  const resolved = `\0${id}`;
  return {
    name: 'ma-desk-themes',
    resolveId: (source) => (source === id ? resolved : null),
    load: (source) => (source === resolved ? themeCss() : null),
  };
}

export default defineConfig({
  plugins: [react(), deskThemes()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    // Matches the Desk app: the default CSP has no font-src data:, so nothing gets inlined.
    assetsInlineLimit: 0,
    // No modulepreload polyfill: it's the one piece of a Vite bundle that can call fetch().
    modulePreload: { polyfill: false },
  },
  server: { host: 'localhost' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
