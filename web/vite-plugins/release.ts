// Writes ma-release.json at the bundle root (contract hostnames.md, "office. layout"). The Platform
// loader reads it to inject the entry module and the CSS. It runs after the bundle is on disk,
// when Vite's CSS plugin has emitted the stylesheet.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export const DESK_API_RANGE = '>=1.0 <2.0';

export function releasePlugin(version: string): Plugin {
  return {
    name: 'ma-release',
    apply: 'build',
    writeBundle(options, bundle) {
      const files = Object.values(bundle);
      const entry = files.find((f) => f.type === 'chunk' && f.isEntry);
      if (!entry) throw new Error('ma-release: no entry chunk');
      // The app's stylesheet only. The simplified view's, the office tour's and Maia Mode's room's are `?url` assets fetched with
      // their own chunks (`simple/SimpleLayer.tsx`, `tour/TourLayer.tsx`, `maiamode/chunk.ts`, the held line's `maiamode/shield/chunk.ts`, Maia's welcome's `welcome/WelcomeLayer.tsx`),
      // so the loader must not inject them
      // for every member (release 4's B4: the room's was fetched by members Maia Mode doesn't list). Courier's message frame's
      // is loaded inside its sandboxed frame only (`apps/courier/frame.ts`): on the office's page its `html` and `body` rules
      // would restyle the whole office.
      const css = files.filter((f) => f.type === 'asset' && f.fileName.endsWith('.css') && !/\/(simple|tour|room|shield|welcome|courier-frame)-[\w-]+\.css$/.test(f.fileName)).map((f) => f.fileName);
      if (!css.length) throw new Error('ma-release: no stylesheet in the bundle');
      // `loadingOverlay`: this bundle takes the loader's overlay away itself (ADR 0058); without it the loader does, at the entry's load.
      const manifest = { app: 'desk-web', version, deskApiRange: DESK_API_RANGE, entry: entry.fileName, css, loadingOverlay: 1 };
      writeFileSync(join(options.dir ?? 'dist', 'ma-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
