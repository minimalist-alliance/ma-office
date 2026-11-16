// The release after the transition (docs/sub-status/courier-id.md, "Removal"): `STORED_COURIER` is `courier`, so a save
// says `courier` and `<desk>:courier`. Played here by the same code with that one constant flipped. It proves that release
// writes the new id and keeps under the cap with the longer one; this build's reader, which that release keeps, reads it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./storedIds', async (importOriginal) => {
  const real = await importOriginal<typeof import('./storedIds')>();
  return {
    ...real,
    STORED_COURIER: real.COURIER,
    appToStored: (app: string) => real.appToStored(app, real.COURIER),
    keyToStored: (key: string) => real.keyToStored(key, real.COURIER),
  };
});

const { MAX_SERVER_BYTES, readServerLayout, sameLayout, storedLayoutDoc, writeServerLayout } = await import('./layoutDoc');

const P = 'd-test5i2qpxdh';
/** A document release 19 saved: Courier as `chat`, in its item, the stack and the carousel. */
const OLD = { schemaVersion: 2, desks: { [P]: { x: 0, y: 0, w: 800, h: 500, items: [{ id: `${P}:chat`, app: 'chat', x: 24, y: 24, w: 352, h: 352 }, { id: `${P}:notebook`, app: 'notebook', x: 392, y: 24, w: 76, h: 76 }], stack: [`${P}:notebook`, `${P}:chat`], carousel: { on: true, app: 'chat' } } }, z: [P] };

const ok = (raw: unknown) => {
  const r = readServerLayout(raw);
  if (r.kind !== 'ok') throw new Error(r.kind);
  return r;
};

describe('the release that writes `courier`', () => {
  it('migrates a `chat` document on its next save: `courier` everywhere, nothing of `chat` left', () => {
    const body = writeServerLayout(ok(OLD).doc);
    expect(body).toBe(JSON.stringify({ layout: { schemaVersion: 2, desks: { [P]: { x: 0, y: 0, w: 800, h: 500, items: [{ id: `${P}:courier`, app: 'courier', x: 24, y: 24, w: 352, h: 352 }, { id: `${P}:notebook`, app: 'notebook', x: 392, y: 24, w: 76, h: 76 }], stack: [`${P}:notebook`, `${P}:courier`], carousel: { on: true, app: 'courier' } } }, z: [P] } }));
    expect(JSON.stringify(storedLayoutDoc(ok(OLD).doc))).not.toContain('chat');
  });

  it('and what it wrote reads as the same layout (the reader is this build\'s: only the writer flips)', () => {
    // `courierId.test.ts` has this build saving such a document back with `chat`, still read by both.
    const body = writeServerLayout(ok(OLD).doc);
    expect(sameLayout(ok((JSON.parse(body) as { layout: unknown }).layout).doc, ok(OLD).doc)).toBe(true);
  });

  it('keeps under the 64 KiB cap with the longer id, the most recently raised first', () => {
    const ids = Array.from({ length: 300 }, (_, n) => `d-${String(n).padStart(12, '0')}`);
    const big = { schemaVersion: 2, z: ids, desks: Object.fromEntries(ids.map((id, n) => [id, { x: n * 700, y: 0, w: 584, h: 236, items: ['chat', 'notebook', 'browser', 'agent'].map((app, k) => ({ id: `${id}:${app}`, app, x: 24 + 92 * k, y: 24, w: 76, h: 76 })) }])) };
    const body = writeServerLayout(ok(big).doc);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_SERVER_BYTES);
    const kept = (JSON.parse(body) as { layout: { z: string[]; desks: Record<string, { items: { id: string; app: string }[] }> } }).layout;
    expect(kept.z).toEqual(ids.slice(ids.length - kept.z.length));
    for (const id of kept.z) expect(kept.desks[id]!.items[0]).toMatchObject({ id: `${id}:courier`, app: 'courier' });
    expect(kept.z.length).toBeGreaterThan(50);
    expect(kept.z.length).toBeLessThan(ids.length);
  });
});
