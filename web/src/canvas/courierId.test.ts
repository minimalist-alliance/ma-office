// Courier's id (docs/sub-status/courier-id.md): members' saved layouts, on Platform and in the mirror, say `chat`. This build
// reads `chat` as `courier`, and still writes `chat` (`STORED_COURIER`), which every earlier release reads, so a rollback
// keeps the tile. `courierId.flip.test.ts` is the release that writes `courier`.
import { describe, expect, it } from 'vitest';
import { arrivingLayout, MAX_SERVER_BYTES, mergeServerLayout, migrateLayoutV1, readLayoutDoc, readServerLayout, sameDesk, sameLayout, SCHEMA_VERSION, storedLayoutDoc, writeServerLayout, type LayoutDoc, type ServerRead } from './layoutDoc';
import { defaultDesk, type LayoutDesk } from './layout';
import { STORED_COURIER } from './storedIds';

const P = 'd-test5i2qpxdh';
const W = 'd-test9w4kzt7m';
const S = 'd-test3hqr8xb6';

/**
 * A member's document as release 19, and every build before this one, saves it (`writeServerLayout`, field for field and in
 * its order): Personal with Courier open-size, raised (its stack) and showing in the carousel, an agent of its own and the
 * Bible; Work as a first visit left it, in a style; Studio with Courier under a stack of three. `prefs` from the Agent and the tour.
 */
const RELEASE_19 = {
  prefs: { showProviderBadges: false, tourOff: true },
  schemaVersion: 2,
  desks: {
    [P]: {
      x: 0, y: 0, w: 800, h: 500,
      items: [
        { id: `${P}:chat`, app: 'chat', x: 24, y: 24, w: 352, h: 352 },
        { id: `${P}:notebook`, app: 'notebook', x: 392, y: 24, w: 168, h: 168 },
        { id: `${P}:browser`, app: 'browser', x: 392, y: 208, w: 76, h: 76 },
        { id: `${P}:agent`, app: 'agent', x: 484, y: 208, w: 76, h: 76 },
        { id: `${P}:agent:ag-scout0000001`, app: 'agent:ag-scout0000001', x: 576, y: 24, w: 76, h: 76 },
        { id: `${P}:app:org.example.bible`, app: 'app:org.example.bible', x: 576, y: 116, w: 76, h: 76 },
      ],
      stack: [`${P}:notebook`, `${P}:browser`, `${P}:agent`, `${P}:agent:ag-scout0000001`, `${P}:app:org.example.bible`, `${P}:chat`],
      carousel: { on: true, app: 'chat' },
    },
    [W]: {
      x: 900, y: 0, w: 584, h: 236,
      items: [
        { id: `${W}:chat`, app: 'chat', x: 24, y: 24, w: 76, h: 76 },
        { id: `${W}:notebook`, app: 'notebook', x: 116, y: 24, w: 76, h: 76 },
        { id: `${W}:browser`, app: 'browser', x: 208, y: 24, w: 76, h: 76 },
        { id: `${W}:agent`, app: 'agent', x: 300, y: 24, w: 76, h: 76 },
      ],
      style: 'walnut',
    },
    [S]: {
      x: 0, y: 600, w: 800, h: 400,
      items: [
        { id: `${S}:chat`, app: 'chat', x: 100, y: 100, w: 168, h: 168 },
        { id: `${S}:notebook`, app: 'notebook', x: 140, y: 120, w: 168, h: 168 },
        { id: `${S}:files`, app: 'files', x: 400, y: 24, w: 76, h: 76 },
      ],
      stack: [`${S}:files`, `${S}:chat`, `${S}:notebook`],
      carousel: { on: false, app: 'chat' },
    },
  },
  z: [S, W, P],
};
const RELEASE_19_BODY = JSON.stringify({ layout: RELEASE_19 });

const ok = (raw: unknown): Extract<ServerRead, { kind: 'ok' }> => {
  const r = readServerLayout(raw);
  if (r.kind !== 'ok') throw new Error(`not read: ${r.kind}`);
  return r;
};
const layoutOf = (body: string): Record<string, unknown> => (JSON.parse(body) as { layout: Record<string, unknown> }).layout;
const appsOf = (d: LayoutDesk): string[] => d.items.map((i) => i.app);

/**
 * What release 18 (`2026.11.12-09cbc49d`) and main up to release 19 keep of an app when they read a document (`isApp` in their
 * `layoutDoc.ts`): one of these six, an agent's own or an installed app's. Anything else, `courier` included, is dropped
 * (`readItem` returns null), and the next save takes it from the document for good.
 */
const OLD_APPS = ['notebook', 'browser', 'chat', 'agent', 'commons', 'files'];
const oldReads = (app: unknown): boolean => typeof app === 'string' && (OLD_APPS.includes(app) || /^agent:[a-z0-9][a-z0-9_-]{0,63}$/.test(app) || /^app:[a-z][a-z0-9.-]{4,63}$/.test(app));
/** Every app an older build would drop from what this build stored, with its desk. */
function droppedByOldBuilds(layout: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [id, d] of Object.entries(layout['desks'] as Record<string, { items: { app: unknown }[]; carousel?: { app: unknown } }>)) {
    for (const i of d.items) if (!oldReads(i.app)) out.push(`${id} ${String(i.app)}`);
    if (d.carousel && !oldReads(d.carousel.app)) out.push(`${id} carousel ${String(d.carousel.app)}`);
  }
  return out;
}

describe('a layout saved before Courier had its id', () => {
  const read = ok(RELEASE_19);

  it('reads every Courier tile as `courier`, with its own `<desk>:courier` id, wherever it is', () => {
    expect(appsOf(read.doc.desks[P]!)).toEqual(['courier', 'notebook', 'browser', 'agent', 'agent:ag-scout0000001', 'app:org.example.bible']);
    expect(read.doc.desks[P]!.items[0]).toEqual({ id: `${P}:courier`, app: 'courier', x: 24, y: 24, w: 352, h: 352 });
    expect(read.doc.desks[W]!.items.map((i) => i.id)).toEqual([`${W}:courier`, `${W}:notebook`, `${W}:browser`, `${W}:agent`]);
    expect(appsOf(read.doc.desks[S]!)).toEqual(['courier', 'notebook', 'files']);
  });

  it('keeps the stack, the carousel and the style, with Courier in them', () => {
    expect(read.doc.desks[P]!.stack).toEqual([`${P}:notebook`, `${P}:browser`, `${P}:agent`, `${P}:agent:ag-scout0000001`, `${P}:app:org.example.bible`, `${P}:courier`]);
    expect(read.doc.desks[P]!.carousel).toEqual({ on: true, app: 'courier' });
    expect(read.doc.desks[S]!.stack).toEqual([`${S}:files`, `${S}:courier`, `${S}:notebook`]);
    expect(read.doc.desks[S]!.carousel).toEqual({ on: false, app: 'courier' });
    expect(read.doc.desks[W]!.style).toBe('walnut');
    expect(read.doc.z).toEqual([S, W, P]);
    expect(read.extra).toEqual({ prefs: { showProviderBadges: false, tourOff: true } });
  });

  it('is the same layout a first visit makes today, where nobody moved anything', () => {
    // Work is a first visit's row: the fresh desk this build makes has the same apps at the same places, so it stays untouched.
    const fresh = defaultDesk(W, 900, 0);
    expect(read.doc.desks[W]!.items.map(({ id, app, x, y }) => ({ id, app, x, y }))).toEqual(fresh.items.map(({ id, app, x, y }) => ({ id, app, x, y })));
  });

  it('saves back byte for byte as release 19 wrote it, schema version and all, while the transition writes `chat`', () => {
    expect(STORED_COURIER).toBe('chat');
    const body = writeServerLayout(read.doc, read.extra);
    expect(body).toBe(RELEASE_19_BODY);
    expect(layoutOf(body)['schemaVersion']).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2); // no new version: a newer one would freeze every older build's saving (`newer`)
  });

  it('leaves nothing that release 18 or 19 would drop, so a rollback keeps every tile', () => {
    const body = writeServerLayout(read.doc, read.extra);
    expect(droppedByOldBuilds(layoutOf(body))).toEqual([]);
    // What this build would have lost them had it written its own id.
    expect(droppedByOldBuilds({ desks: { [P]: { items: [{ app: 'courier' }], carousel: { app: 'courier' } } } })).toEqual([`${P} courier`, `${P} carousel courier`]);
  });

  it('writes the mirror as every build reads it, and reads it back to the same layout', () => {
    const mirror = JSON.parse(JSON.stringify(storedLayoutDoc(read.doc))) as LayoutDoc;
    expect(JSON.stringify(mirror)).not.toContain('courier');
    expect(droppedByOldBuilds(mirror as unknown as Record<string, unknown>)).toEqual([]);
    expect(sameLayout(readLayoutDoc(mirror)!, read.doc)).toBe(true);
    // The document in memory is never changed by writing it.
    expect(read.doc.desks[P]!.items[0]!.app).toBe('courier');
  });

  it('reads the same from a document the next release writes, with `courier` in it', () => {
    const flipped = JSON.parse(RELEASE_19_BODY.replaceAll('"chat"', '"courier"').replaceAll(':chat"', ':courier"')) as { layout: unknown };
    expect(JSON.stringify(flipped)).not.toContain('chat');
    const theirs = ok(flipped.layout);
    expect(sameLayout(theirs.doc, read.doc)).toBe(true);
    for (const id of [P, W, S]) expect(sameDesk(theirs.doc.desks[id]!, read.doc.desks[id]!)).toBe(true);
    // A rollback from that release to this one: saved again here, it's what release 19 reads.
    expect(writeServerLayout(theirs.doc, theirs.extra)).toBe(RELEASE_19_BODY);
  });

  it('reads a document with both, as two builds would leave it on one member\'s devices', () => {
    const mixed = JSON.parse(RELEASE_19_BODY.replace(`"id":"${W}:chat","app":"chat"`, `"id":"${W}:courier","app":"courier"`)) as { layout: unknown };
    const r = ok(mixed.layout);
    expect(sameLayout(r.doc, read.doc)).toBe(true);
  });

  it('still stops at a newer schema version, and still replaces an older one, as it did', () => {
    expect(readServerLayout({ ...RELEASE_19, schemaVersion: 3 }).kind).toBe('newer');
    expect(readServerLayout({ ...RELEASE_19, schemaVersion: 1 }).kind).toBe('bad');
  });

  it('leaves an id that isn\'t Courier\'s own as it is', () => {
    const doc = ok({
      schemaVersion: 2, z: ['d'],
      desks: { d: { x: 0, y: 0, w: 800, h: 500, items: [
        { id: 'a', app: 'chat', x: 24, y: 24, w: 76, h: 76 }, // an older test's or a hand-made id
        { id: 'd:chat', app: 'notebook', x: 116, y: 24, w: 76, h: 76 }, // not Courier's, whatever its id says
        { id: 'd:agent:chat', app: 'agent:chat', x: 208, y: 24, w: 76, h: 76 },
      ], stack: ['d:agent:chat', 'a', 'd:chat'] } },
    });
    expect(doc.doc.desks['d']!.items.map(({ id, app }) => `${id} ${app}`)).toEqual(['a courier', 'd:chat notebook', 'd:agent:chat agent:chat']);
    expect(doc.doc.desks['d']!.stack).toEqual(['d:agent:chat', 'a', 'd:chat']);
    expect(writeServerLayout(doc.doc)).toContain('{"id":"a","app":"chat"');
  });

  it('never gives two tiles one id', () => {
    // A `<desk>:chat` Courier beside an item that already has `<desk>:courier`: it keeps its own id, and so does the other.
    const doc = ok({ schemaVersion: 2, z: ['d'], desks: { d: { x: 0, y: 0, w: 800, h: 500, items: [
      { id: 'd:chat', app: 'chat', x: 24, y: 24, w: 76, h: 76 },
      { id: 'd:courier', app: 'notebook', x: 116, y: 24, w: 76, h: 76 },
    ] } } });
    const ids = doc.doc.desks['d']!.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(writeServerLayout(doc.doc)).toBe(JSON.stringify({ layout: { schemaVersion: 2, desks: { d: { x: 0, y: 0, w: 800, h: 500, items: [
      { id: 'd:chat', app: 'chat', x: 24, y: 24, w: 76, h: 76 },
      { id: 'd:courier', app: 'notebook', x: 116, y: 24, w: 76, h: 76 },
    ] } }, z: ['d'] } }));
  });
});

describe('a version-1 layout in this browser, from before the units', () => {
  // A real one (`layoutDoc.test.ts`'s REAL_V1, from 983b427), its apps as that build stored them.
  const V1 = { desks: { [P]: { id: P, x: 0, y: 36, cols: 7, rows: 3, items: [{ id: `${P}:chat`, app: 'chat', size: 'small' }, { id: `${P}:notebook`, app: 'notebook', size: 'icon' }] } }, z: [P] };

  it('migrates with Courier as `courier`, and its mirror is what every build reads', () => {
    const doc = migrateLayoutV1(V1)!;
    expect(doc.desks[P]!.items.map(({ id, app }) => `${id} ${app}`)).toEqual([`${P}:courier courier`, `${P}:notebook notebook`]);
    const mirror = JSON.stringify(storedLayoutDoc(doc));
    expect(mirror).toContain(`{"id":"${P}:chat","app":"chat"`);
    expect(sameLayout(readLayoutDoc(JSON.parse(mirror))!, doc)).toBe(true);
  });
});

describe('the 64 KiB cap', () => {
  /** A desk of Courier and three more, the ids as long as Platform's. */
  const deskAt = (n: number): [string, Record<string, unknown>] => {
    const id = `d-${String(n).padStart(12, '0')}`;
    return [id, { x: n * 700, y: 0, w: 584, h: 236, items: ['chat', 'notebook', 'browser', 'agent'].map((app, k) => ({ id: `${id}:${app}`, app, x: 24 + 92 * k, y: 24, w: 76, h: 76 })), stack: [`${id}:notebook`, `${id}:browser`, `${id}:agent`, `${id}:chat`] }];
  };
  /** So many desks that only some fit: the most recently raised go first. */
  const BIG = { schemaVersion: 2, desks: Object.fromEntries(Array.from({ length: 160 }, (_, n) => deskAt(n))), z: Array.from({ length: 160 }, (_, n) => `d-${String(n).padStart(12, '0')}`) };

  it('keeps a save under the cap, exactly as release 19 would have cut it', () => {
    const raw = JSON.stringify(BIG);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(MAX_SERVER_BYTES);
    const read = ok(BIG);
    const body = writeServerLayout(read.doc);
    const bytes = new TextEncoder().encode(body).length;
    expect(bytes).toBeLessThanOrEqual(MAX_SERVER_BYTES);
    const kept = layoutOf(body);
    const keptIds = kept['z'] as string[];
    // The top of `z`, in order, and every Courier on them as every build reads it.
    expect(keptIds).toEqual(BIG.z.slice(BIG.z.length - keptIds.length));
    expect(keptIds.length).toBeGreaterThan(50);
    expect(droppedByOldBuilds(kept)).toEqual([]);
    // Courier's stored id is the one it had, so the same desks fit as before: each kept desk is as it came.
    const desks = kept['desks'] as Record<string, unknown>;
    for (const id of keptIds) expect(JSON.stringify(desks[id])).toBe(JSON.stringify((BIG.desks as Record<string, unknown>)[id]));
  });

  it('cuts at a smaller cap too, as a 413 asks', () => {
    const read = ok(BIG);
    const body = writeServerLayout(read.doc, {}, 8 * 1024);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(8 * 1024);
    expect(droppedByOldBuilds(layoutOf(body))).toEqual([]);
  });
});

describe('one member on several devices', () => {
  const theirs = ok(RELEASE_19);
  /** This browser's own copy, read from its mirror: the same layout, Courier at `courier`. */
  const mine = (): LayoutDoc => readLayoutDoc(JSON.parse(JSON.stringify(storedLayoutDoc(theirs.doc))))!;

  it('a device on release 19 and one on this build hold the same layout, so neither has anything to send', () => {
    const local = mine();
    expect(sameLayout(theirs.doc, local)).toBe(true);
    const arrived = arrivingLayout(theirs.doc, local, new Set());
    for (const id of [P, W, S]) expect(arrived.desks[id]).toBe(local.desks[id]); // the same objects: nothing renders or saves
    expect(writeServerLayout(arrived, theirs.extra)).toBe(RELEASE_19_BODY);
  });

  it('a change here goes on top of what the other device saved, and the other device reads it', () => {
    const local = mine();
    // Here: Courier moved on Work. There (release 19): Studio's Notebook moved, and saved.
    const moved: LayoutDesk = { ...local.desks[W]!, items: local.desks[W]!.items.map((i) => (i.app === 'courier' ? { ...i, y: 112 } : i)) };
    const here: LayoutDoc = { ...local, desks: { ...local.desks, [W]: moved } };
    const other = JSON.parse(RELEASE_19_BODY) as { layout: typeof RELEASE_19 };
    other.layout.desks[S].items[1]!.x = 400;
    other.layout.desks[S].items[1]!.y = 150;
    const fromOther = ok(other.layout);
    const merged = mergeServerLayout(fromOther.doc, here, new Set([W]));
    expect(merged.desks[W]).toBe(moved);
    expect(merged.desks[S]!.items.find((i) => i.app === 'notebook')).toMatchObject({ x: 400, y: 150 });
    // This device's save, as the other device reads it: every tile there, Courier where it was moved to.
    const body = writeServerLayout(merged, fromOther.extra);
    expect(droppedByOldBuilds(layoutOf(body))).toEqual([]);
    const work = (layoutOf(body)['desks'] as Record<string, { items: { id: string; app: string; y: number }[] }>)[W]!;
    expect(work.items[0]).toMatchObject({ id: `${W}:chat`, app: 'chat', y: 112 });
    // And reads its own save back as it left it.
    expect(sameLayout(ok(layoutOf(body)).doc, merged)).toBe(true);
  });

  it('a device already writing `courier` and this one settle, with no save going back and forth', () => {
    const flipped = ok((JSON.parse(RELEASE_19_BODY.replaceAll('"chat"', '"courier"').replaceAll(':chat"', ':courier"')) as { layout: unknown }).layout);
    const local = mine();
    expect(sameLayout(flipped.doc, local)).toBe(true);
    const arrived = arrivingLayout(flipped.doc, local, new Set());
    expect(sameLayout(arrived, local)).toBe(true);
    for (const id of [P, W, S]) expect(arrived.desks[id]).toBe(local.desks[id]);
  });
});
