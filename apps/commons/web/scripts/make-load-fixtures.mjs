// Makes the load test's board traffic: real Yjs updates, each adding one pen stroke of about 60
// points from its own Y.Doc, as a member's client would send when a stroke ends. Written as
// [len u32 LE][update] records. Run from apps/commons/web (it has yjs):
//   node scripts/make-load-fixtures.mjs ../loadtest/strokes.bin
import { writeFileSync } from 'node:fs';
import * as Y from 'yjs';

const out = process.argv[2] ?? 'strokes.bin';
const parts = [];
for (let i = 0; i < 256; i++) {
  const doc = new Y.Doc();
  const n = 60;
  const p = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) {
    p[j * 3] = j * 4;
    p[j * 3 + 1] = Math.sin(j / 6 + i) * 30;
    p[j * 3 + 2] = 0.5;
  }
  doc.transact(() => {
    const m = new Y.Map();
    m.set('k', 's');
    m.set('x', (i % 16) * 300);
    m.set('y', Math.floor(i / 16) * 200);
    m.set('w', 0);
    m.set('h', 0);
    m.set('c', 'ink');
    m.set('s', 1);
    m.set('z', 1_700_000_000_000 + i);
    m.set('p', new Uint8Array(p.buffer));
    doc.getMap('items').set(`load${i}`, m);
  });
  const u = Y.encodeStateAsUpdate(doc);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(u.byteLength);
  parts.push(len, Buffer.from(u));
}
writeFileSync(out, Buffer.concat(parts));
console.log(`wrote ${out}: 256 stroke updates, ${Buffer.concat(parts).byteLength} bytes`);
