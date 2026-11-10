// Vite wraps every `import()` in a client build in its preload helper, which fetches the chunk's own imports and
// CSS ahead of it: about 0.7 KB gzipped in the main bundle. This app has one entry and one stylesheet
// (`cssCodeSplit: false`), so a lazy chunk (the export page) needs nothing that isn't already loaded, and the helper
// would only ever call `import()`. So it's replaced by exactly that. If a chunk ever does have something to preload,
// Vite writes `__vite__mapDeps`, and the build fails here rather than ship a chunk without its CSS.
import type { Plugin } from 'vite';

const HELPER = '\0vite/preload-helper.js';

export function noPreloadPlugin(): Plugin {
  return {
    name: 'ma-no-preload',
    apply: 'build',
    enforce: 'pre',
    resolveId(id) {
      return id === HELPER ? HELPER : null;
    },
    load(id) {
      return id === HELPER ? 'export const __vitePreload = (load) => load();\n' : null;
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.code.includes('__vite__mapDeps')) this.error(`${file.fileName} has dependencies to preload, which ma-no-preload would drop`);
      }
    },
  };
}
