// The package's own lint. ESLint 10 looks for a config from each file's folder up, so this one, not web/'s,
// covers web/maia-avatar/, and web/'s `npm run lint` uses it here too.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Each package under web/ has its own config, and ESLint 10 loads them all in one run, so typescript-eslint
  // needs to be told the root: otherwise every file fails with "multiple candidate TSConfigRootDirs".
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { ignores: ['dist/', 'test-results/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  // The reference engine's code, kept as it was approved: it holds one constant it never reads (REST_POSE).
  { files: ['src/engine.js'], rules: { '@typescript-eslint/no-unused-vars': 'off' } },
);
