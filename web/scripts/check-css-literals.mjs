// The CSS half of the color-literal rule: every color in src/**/*.css comes from a token.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.css') ? [p] : [];
  });
}

let bad = 0;
for (const file of walk('src')) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (COLOR.test(line.replace(/\/\*.*?\*\//g, ''))) {
      console.error(`${file}:${i + 1}: color literal: ${line.trim()}`);
      bad += 1;
    }
  });
}
if (bad) process.exit(1);
