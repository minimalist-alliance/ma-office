// The first load as one chunk. Rolldown splits the modules the entry imports statically into a shared chunk for each set of
// lazy chunks that also use them: 20 files in the first load, each gzipped on its own (no shared dictionary, a header each)
// and each with its own import and export lists. They're all fetched before the first paint anyway, so packing them into
// one chunk (`first-load-*.js`, beside the entry and Rolldown's runtime) changes no module, no order and nothing a member
// sees, and the first load is about 11 KB gzipped smaller. Lazy chunks import what they share from it; it's always here first.
// `isFirstLoad` is for `output.manualChunks`: true for a module the entry reaches by static imports, found once per build
// from the module graph (the entry itself stays the entry chunk).
//
// A group (`groups`, `sub/mm-js-budget`) is code taken out of the first load as one chunk of its own: every module its roots
// reach by static imports that isn't in the first load. Left to Rolldown, that code is split by which lazy chunks share each
// part (every app's window, say, is also imported by its own app's chunk), and the group's root chunk then waits for the
// shared chunks it imports, one round trip after the other. As one chunk it imports nothing but the first load, so a loader
// that fetches it beside its own chunk (`withWindows` in `src/apps/chunks.ts`) adds no round trip. `groupOf` names a module's
// group, or undefined.
import type { Plugin } from 'vite';

type ModuleInfo = (id: string) => { readonly importedIds: readonly string[] } | null;

export function firstLoad(
  entry: string,
  groups: Readonly<Record<string, readonly string[]>> = {},
): { plugin: Plugin; isFirstLoad: (id: string, getModuleInfo: ModuleInfo) => boolean; groupOf: (id: string, getModuleInfo: ModuleInfo) => string | undefined } {
  let found: Set<string> | null = null;
  let grouped: Map<string, string> | null = null;
  const reach = (roots: readonly string[], getModuleInfo: ModuleInfo, stop: ReadonlySet<string>): Set<string> => {
    const seen = new Set<string>();
    const todo = [...roots];
    for (let m = todo.pop(); m !== undefined; m = todo.pop()) {
      if (seen.has(m) || stop.has(m)) continue;
      seen.add(m);
      todo.push(...(getModuleInfo(m)?.importedIds ?? []));
    }
    return seen;
  };
  const first = (getModuleInfo: ModuleInfo): Set<string> => (found ??= reach([entry], getModuleInfo, new Set()));
  return {
    plugin: {
      name: 'ma-first-load',
      apply: 'build',
      buildStart() {
        found = null;
        grouped = null;
      },
    },
    isFirstLoad(id, getModuleInfo) {
      return id !== entry && first(getModuleInfo).has(id);
    },
    groupOf(id, getModuleInfo) {
      if (!grouped) {
        grouped = new Map();
        // The first group to reach a module keeps it.
        for (const [name, roots] of Object.entries(groups)) {
          for (const m of reach(roots, getModuleInfo, first(getModuleInfo))) if (!grouped.has(m)) grouped.set(m, name);
        }
      }
      return grouped.get(id);
    },
  };
}
