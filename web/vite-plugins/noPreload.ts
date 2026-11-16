// Vite wraps every `import()` in a client build in its preload helper, which fetches the chunk's own imports and
// CSS ahead of it: about 0.7 KB gzipped in the main bundle. This app has one entry and one stylesheet
// (`cssCodeSplit: false`), so a lazy chunk (the export page) needs nothing that isn't already loaded, and the helper
// would only ever call `import()`. So it's replaced by exactly that, and `build.modulePreload: false` (`vite.config.ts`)
// stops Vite listing each chunk's JS dependencies for it. If a chunk ever does have CSS to preload, Vite still writes
// `__vite__mapDeps`, and the build fails here rather than ship a chunk without its CSS. The check runs once the bundle is
// written: Vite's own import analysis writes `__vite__mapDeps` after this plugin's `generateBundle`, where it never saw it.
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
    writeBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.code.includes('__vite__mapDeps')) this.error(`${file.fileName} has dependencies to preload, which ma-no-preload would drop`);
      }
    },
  };
}
