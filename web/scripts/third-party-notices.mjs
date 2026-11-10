// Writes THIRD-PARTY-NOTICES.txt: every production dependency in package-lock.json (the app's bundle is a subset of
// them), with its version, license and the license text its package ships (MIT notices for React, Konva and the rest,
// and the SIL Open Font License for the bundled fonts).
//   node scripts/third-party-notices.mjs [<output file>]     # default: dist/release/THIRD-PARTY-NOTICES.txt
// build:release runs it after the bundle is built.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = process.argv[2] ?? 'dist/release/THIRD-PARTY-NOTICES.txt';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const LICENSE_FILE = /^(licen[cs]e|copying|notice|ofl)([.-].*)?$/i;

const entries = Object.entries(lock.packages ?? {})
  .filter(([path, p]) => path.startsWith('node_modules/') && !p.dev && !p.devOptional)
  .map(([path, p]) => {
    const dir = path;
    const pkgFile = join(dir, 'package.json');
    const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : {};
    const name = pkg.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort() : [];
    const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim());
    return { name, version: pkg.version ?? p.version ?? '', license: pkg.license ?? p.license ?? 'see the package', texts };
  })
  .filter((e) => !e.name.startsWith('@minimalist-alliance/')) // our own packages are under this repository's license
  .sort((a, b) => a.name.localeCompare(b.name));

const rule = '-'.repeat(78);
const body = [
  'Third-party software in the Minimalist Alliance office app',
  '',
  'The app is licensed under the Apache License, Version 2.0 (LICENSE in its source repository). It includes the',
  'following packages, each under its own license, reproduced here as the package ships it.',
  '',
  ...entries.flatMap((e) => [rule, `${e.name} ${e.version}`, `License: ${e.license}`, '', ...(e.texts.length ? e.texts.flatMap((t) => [t, '']) : ['(The package ships no license file; its license is named above.)', ''])]),
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${body}\n`);
console.log(`notices   ${out} (${entries.length} packages)`);
