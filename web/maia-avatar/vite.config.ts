// Three builds. The default is the package for browsers: dist/lib/maia-avatar.js, one minified ES module.
// `--mode score` is dist/lib/score.js, the parser and schema alone, for servers (services/maia, desk-agent).
// `--mode demo` is the demo page, into dist/demo/, with the package from source.
import { defineConfig } from 'vite';

const lib = (name: string, entry: string, empty: boolean) => ({
  json: { stringify: false },
  build: {
    outDir: 'dist/lib',
    emptyOutDir: empty,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    lib: { entry, formats: ['es' as const], fileName: () => `${name}.js` },
    // Library mode keeps whitespace in ES output by default; the budget is for what a browser downloads.
    rolldownOptions: { output: { minify: true } },
  },
});

export default defineConfig(({ mode }) =>
  mode === 'demo'
    ? {
        root: 'demo',
        base: '/',
        build: { outDir: '../dist/demo', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0, modulePreload: { polyfill: false } },
      }
    : mode === 'score'
      ? lib('score', 'src/score.ts', false)
      : lib('maia-avatar', 'src/index.ts', true),
);
