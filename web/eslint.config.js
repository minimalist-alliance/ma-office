import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import noColorLiterals from './eslint-rules/no-color-literals.js';

export default tseslint.config(
  // Each package under web/ has its own config, and ESLint 10 loads them all in one run, so typescript-eslint
  // needs to be told the root: otherwise every file fails with "multiple candidate TSConfigRootDirs".
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'tests/perf/results/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, ma: { rules: { 'no-color-literals': noColorLiterals } } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'ma/no-color-literals': 'error',
    },
  },
  // The one file allowed to hold colors, and the tests that check them. The app glyphs' tables are generated from the tokens
  // (the fallback hexes and the fold shades, design-drafts/app-icons/final-3d/build/make_draw3d.py), and glyphs.test.ts fails
  // when a token moves without them. To-do's draft glyph (`apps/todo/glyph3d.ts`) copies those rows, and its test checks them.
  // The theme sliders' colour math (`theme/tune/xf.ts`) holds no colour, but writes the tokens' own forms back (`rgba(`).
  { files: ['src/theme/tokens.ts', 'src/**/*.test.ts', 'src/canvas/draw3d.ts', 'src/deskapps/host/draw3d-bible.ts', 'src/apps/todo/glyph3d.ts', 'src/theme/tune/xf.ts'], rules: { 'ma/no-color-literals': 'off' } },
);
