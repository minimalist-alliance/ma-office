// `node --test test/` runs this file: Node 24 takes a folder given to --test as a module, not as a list of files. It
// loads every *.test.mjs here, so that one command runs them all. `node --test test/*.test.mjs` runs each on its own.
import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
for (const name of readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(new URL(name, dir));
}
