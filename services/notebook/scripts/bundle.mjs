// Bundles the service into one file, dist/desk-notebook.mjs: that file is all the image carries beside Node.
// web/notebook/src/model/ is imported as source. Its bare imports are resolved from this package, so there is one
// copy of yjs and of ProseMirror, and the build needs no node_modules under web/notebook.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = resolve(serviceDir, '../../web/notebook/src/model');

const fromThisPackage = {
  name: 'model-deps-from-this-package',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (!args.resolveDir.startsWith(modelDir) || args.path.startsWith('node:')) return undefined;
      return b.resolve(args.path, { resolveDir: serviceDir, kind: args.kind, importer: args.importer });
    });
  },
};

const started = performance.now();
const result = await build({
  absWorkingDir: serviceDir,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/desk-notebook.mjs',
  // tsconfig.json's paths are for tsc. They point at package directories, which would make esbuild read each package's
  // CommonJS `main` and ignore its `exports`.
  tsconfigRaw: '{}',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'none',
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  // A few CommonJS dependencies call require('node:…') inside the ESM bundle.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  plugins: [fromThisPackage],
});
// Two copies of yjs break its constructor checks, quietly and later. Stop here instead.
const yjsFiles = Object.keys(result.metafile.inputs).filter((f) => /node_modules\/yjs\/dist\//.test(f));
if (yjsFiles.length !== 1) throw new Error(`expected one copy of yjs in the bundle, found: ${yjsFiles.join(', ')}`);
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundle: dist/desk-notebook.mjs ${(bytes / 1024).toFixed(0)} KiB in ${(performance.now() - started).toFixed(0)} ms`);
