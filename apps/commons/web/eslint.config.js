// The Desk app's rules (web/eslint.config.js), with its color-literal rule reused as it stands.
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import noColorLiterals from '../../../web/eslint-rules/no-color-literals.js';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'tests/perf/results/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'demo/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, ma: { rules: { 'no-color-literals': noColorLiterals } } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'ma/no-color-literals': 'error',
    },
  },
  // The one file allowed to hold colors, and the tests that check them.
  { files: ['src/theme/tokens.ts', 'tests/**/*.ts'], rules: { 'ma/no-color-literals': 'off' } },
);
