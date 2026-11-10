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
      // The app's stylesheet only. The simplified view's is a `?url` asset the Browser window fetches with the view's chunk
      // (`simple/SimpleLayer.tsx`), so the loader must not inject it for every member.
      const css = files.filter((f) => f.type === 'asset' && f.fileName.endsWith('.css') && !/\/simple-[\w-]+\.css$/.test(f.fileName)).map((f) => f.fileName);
      if (!css.length) throw new Error('ma-release: no stylesheet in the bundle');
      const manifest = { app: 'desk-web', version, deskApiRange: DESK_API_RANGE, entry: entry.fileName, css };
      writeFileSync(join(options.dir ?? 'dist', 'ma-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
