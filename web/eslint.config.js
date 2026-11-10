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
  // The one file allowed to hold colors, and the tests that check them.
  { files: ['src/theme/tokens.ts', 'src/**/*.test.ts'], rules: { 'ma/no-color-literals': 'off' } },
);
