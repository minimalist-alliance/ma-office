// Real SQLite on temp directories and real providers over the real socket. model/ is imported as source from
// web/notebook, so its bare imports are resolved from this package whatever is or isn't installed over there.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    dedupe: [
      'yjs',
      'lib0',
      'y-protocols',
      '@tiptap/core',
      '@tiptap/pm',
      '@tiptap/y-tiptap',
      '@tiptap/starter-kit',
      '@tiptap/extension-highlight',
      '@tiptap/extension-list',
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/quiet.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // The machine is shared, and each file opens real databases and sockets.
    maxWorkers: 2,
  },
});
