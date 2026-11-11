import { describe, expect, it } from 'vitest';
import { defaultDesk, fitDeskSize, G, panelH, panelW, placeNewDesk, settleDesk, span, stackOrder, withStack, type LayoutDesk } from './layout';
import { DESK_GAP, separation } from './deskPush';
import { arrivingLayout, clearLayoutDoc, fitDeskToBand, fitDocToBand, freshDesk, isUntouched, MAX_SERVER_BYTES, mergeServerLayout, migrateLayoutV1, readLayoutDoc, readServerLayout, sameBounds, sameDesk, sameLayout, SCHEMA_VERSION, writeServerLayout, type LayoutDoc, type ServerRead } from './layoutDoc';

// Written by the app itself, by a real browser, on the last version-1 build (983b427): Work dragged
// down and right, Personal grown by a column and two rows with a Chat widget, Guild reordered.
const REAL_V1 = '{"desks":{"d-test5i2qpxd":{"id":"d-test5i2qpxd","x":0,"y":36,"cols":7,"rows":3,"items":[{"id":"d-test5i2qpxd:chat","app":"chat","size":"small"},{"id":"d-test5i2qpxd:notebook","app":"notebook","size":"icon"},{"id":"d-test5i2qpxd:browser","app":"browser","size":"icon"},{"id":"d-test5i2qpxd:agent","app":"agent","size":"icon"}]},"d-test9w4kzt7":{"id":"d-test9w4kzt7","x":728,"y":128,"cols":6,"rows":1,"items":[{"id":"d-test9w4kzt7:chat","app":"chat","size":"icon"},{"id":"d-test9w4kzt7:notebook","app":"notebook","size":"icon"},{"id":"d-test9w4kzt7:browser","app":"browser","size":"icon"},{"id":"d-test9w4kzt7:agent","app":"agent","size":"icon"}]},"d-test3hqr8xb":{"id":"d-test3hqr8xb","x":1312,"y":36,"cols":6,"rows":1,"items":[{"id":"d-test3hqr8xb:agent","app":"agent","size":"icon"},{"id":"d-test3hqr8xb:chat","app":"chat","size":"icon"},{"id":"d-test3hqr8xb:notebook","app":"notebook","size":"icon"},{"id":"d-test3hqr8xb:browser","app":"browser","size":"icon"}]}},"z":["d-test3hqr8xb","d-test9w4kzt7","d-test5i2qpxd"]}';
const PERSONAL = 'd-test5i2qpxd';
const WORK = 'd-test9w4kzt7';
const GUILD = 'd-test3hqr8xb';

describe('migrating a real version-1 layout', () => {
  const doc = migrateLayoutV1(JSON.parse(REAL_V1))!;

  it('keeps every desk, where the member put it', () => {
    expect(Object.keys(doc.desks)).toEqual([PERSONAL, WORK, GUILD]);
    expect(doc.desks[WORK]).toMatchObject({ x: 728, y: 128 });
    expect(doc.desks[PERSONAL]).toMatchObject({ x: 0, y: 36 });
    expect(doc.desks[GUILD]).toMatchObject({ x: 1312, y: 36 });
  });

  it('keeps the stacking order', () => {
    expect(doc.z).toEqual([GUILD, WORK, PERSONAL]);
  });

  it('keeps every app, in the member\'s order', () => {
    expect(doc.desks[GUILD]!.items.map((i) => i.app)).toEqual(['agent', 'chat', 'notebook', 'browser']);
    expect(doc.desks[PERSONAL]!.items.map((i) => i.id)).toEqual([`${PERSONAL}:chat`, `${PERSONAL}:notebook`, `${PERSONAL}:browser`, `${PERSONAL}:agent`]);
  });

  it('keeps the size the member grew a desk to', () => {
    expect(doc.desks[PERSONAL]).toMatchObject({ w: panelW(7), h: panelH(3) });
    expect(doc.desks[WORK]).toMatchObject({ w: 584, h: 144 });
  });

  it('puts apps where packing put them, with widgets at their size', () => {
    const [chat, notebook, browser, agent] = doc.desks[PERSONAL]!.items;
    expect(chat).toMatchObject({ x: G.padX, y: G.padTop, w: span(2), h: span(2) });
    expect(notebook).toMatchObject({ x: G.padX + 2 * G.pitch, y: G.padTop, w: span(1), h: span(1) });
    expect(browser).toMatchObject({ x: G.padX + 3 * G.pitch, y: G.padTop });
    expect(agent).toMatchObject({ x: G.padX + 4 * G.pitch, y: G.padTop });
  });

  it('reads back unchanged as version 2', () => {
    expect(readLayoutDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});

describe('Platform\'s copy', () => {
  const desk = (id: string, x = 0, y = 0): LayoutDesk => ({ id, x, y, w: 584, h: 144, items: [{ id: `${id}:chat`, app: 'chat', x: 24, y: 24, w: 76, h: 76 }] });
  const doc = (...desks: LayoutDesk[]): LayoutDoc => ({ desks: Object.fromEntries(desks.map((d) => [d.id, d])), z: desks.map((d) => d.id) });
  const roundTrip = (d: LayoutDoc): ServerRead => readServerLayout((JSON.parse(writeServerLayout(d)) as { layout: unknown }).layout);

  it('a real old layout survives the whole way: version 1, version 2, Platform and back', () => {
    const local = migrateLayoutV1(JSON.parse(REAL_V1))!;
    const read = roundTrip(local);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(sameLayout(read.doc, local)).toBe(true);
    expect(read.doc.z).toEqual(local.z);
    expect(read.extra).toEqual({});
  });

  it('declares an integer schemaVersion, and leaves out what a key already says', () => {
    const { layout } = JSON.parse(writeServerLayout(doc(desk('a')))) as { layout: { schemaVersion: number; desks: Record<string, Record<string, unknown>> } };
    expect(layout.schemaVersion).toBe(SCHEMA_VERSION);
    expect(layout.desks['a']).not.toHaveProperty('id');
  });

  it('a newer document can\'t be read and mustn\'t be replaced; a bad one can be', () => {
    expect(readServerLayout({ schemaVersion: SCHEMA_VERSION + 1, anything: true }).kind).toBe('newer');
    for (const bad of [null, [], 'x', 7, {}, { schemaVersion: 1.5 }, { schemaVersion: 1, desks: {} }, { schemaVersion: SCHEMA_VERSION }, { schemaVersion: SCHEMA_VERSION, desks: [] }, { schemaVersion: SCHEMA_VERSION, desks: { a: 7 } }, { schemaVersion: SCHEMA_VERSION, desks: { a: { items: 'no' } } }]) {
      expect(readServerLayout(bad).kind, JSON.stringify(bad)).toBe('bad');
    }
  });

  it('won\'t try to repair a desk with an absurd number of apps, which could hang the tab', () => {
    const items = Array.from({ length: 800 }, (_, i) => ({ id: `i${i}`, app: 'chat', x: 8, y: 8, w: 56, h: 56 }));
    expect(readServerLayout({ schemaVersion: SCHEMA_VERSION, desks: { a: { x: 0, y: 0, w: 500, h: 500, items } } }).kind).toBe('bad');
  });

  it('fields a newer build added go back as they came', () => {
    const body = writeServerLayout(doc(desk('a')), { prefs: { theme: 'dusk' } });
    const read = readServerLayout((JSON.parse(body) as { layout: unknown }).layout);
    expect(read.kind === 'ok' && read.extra).toEqual({ prefs: { theme: 'dusk' } });
  });

  it('merging: Platform\'s copy, with this browser\'s unsaved desks on top', () => {
    const local = doc(desk('mine', 1), desk('theirs', 2), desk('same', 3));
    const server = doc(desk('mine', 10), desk('theirs', 20), desk('same', 3));
    const merged = mergeServerLayout(server, local, new Set(['mine']));
    expect(merged.desks['mine']!.x).toBe(1);
    expect(merged.desks['theirs']!.x).toBe(20);
    expect(merged.desks['same']).toBe(local.desks['same']); // the same object: no render, and undo stays good
  });

  const twoApps = (id: string, x: number): LayoutDesk => {
    const d = desk(id, x);
    return { ...d, items: [...d.items, { ...d.items[0]!, id: `${id}:notebook`, app: 'notebook' as const, x: d.items[0]!.x + 100 }] };
  };

  it('a stack comes through Platform\'s copy whole, and a desk without one saves as it always did', () => {
    const plain = desk('plain', 1);
    const two = twoApps('stacked', 700);
    const stacked = withStack(two, two.items.map((i) => i.id).reverse());
    expect(stacked.stack).toHaveLength(2);
    const body = writeServerLayout(doc(plain, stacked));
    const raw = (JSON.parse(body) as { layout: { desks: Record<string, Record<string, unknown>> } }).layout;
    expect('stack' in raw.desks['plain']!).toBe(false);
    expect(raw.desks['stacked']!['stack']).toEqual(stacked.stack);
    const read = readServerLayout(raw) as Extract<ServerRead, { kind: 'ok' }>;
    expect(read.doc.desks['stacked']!.stack).toEqual(stacked.stack);
    expect(sameDesk(read.doc.desks['stacked']!, stacked)).toBe(true);
    expect('stack' in read.doc.desks['plain']!).toBe(false);
  });

  it('a carousel comes through Platform\'s copy as it was, only on its own desk, and a desk without one saves as it always did', () => {
    const plain = desk('plain', 1);
    const shown: LayoutDesk = { ...desk('shown', 700), carousel: { on: true, app: 'browser' } };
    const off: LayoutDesk = { ...desk('off', 1400), carousel: { on: false, app: 'agent:research' } };
    const body = writeServerLayout(doc(plain, shown, off));
    const raw = (JSON.parse(body) as { layout: { desks: Record<string, Record<string, unknown>> } }).layout;
    expect('carousel' in raw.desks['plain']!).toBe(false);
    expect(raw.desks['shown']!['carousel']).toEqual({ on: true, app: 'browser' });
    expect(raw.desks['off']!['carousel']).toEqual({ on: false, app: 'agent:research' });
    const read = readServerLayout(raw) as Extract<ServerRead, { kind: 'ok' }>;
    expect(read.doc.desks['shown']!.carousel).toEqual({ on: true, app: 'browser' });
    expect(read.doc.desks['off']!.carousel).toEqual({ on: false, app: 'agent:research' });
    expect('carousel' in read.doc.desks['plain']!).toBe(false);
    expect(sameDesk(read.doc.desks['shown']!, shown)).toBe(true);
    expect(writeServerLayout(read.doc)).toBe(body); // read back and saved again, the same bytes
  });

  it('a carousel that isn\'t one is no carousel, which is off', () => {
    for (const carousel of [true, 'on', { on: 'yes', app: 'browser' }, { on: true, app: 'nope' }, { on: true }, null]) {
      const read = readLayoutDoc({ desks: { a: { ...desk('a'), carousel } }, z: ['a'] })!;
      expect('carousel' in read.desks['a']!, JSON.stringify(carousel)).toBe(false);
    }
  });

  it('only the carousel is different: that\'s a different desk, so it arrives and saves', () => {
    const plain = desk('a', 1);
    const on: LayoutDesk = { ...plain, carousel: { on: true, app: 'chat' } };
    expect(sameDesk(plain, on)).toBe(false);
    expect(sameDesk(on, { ...plain, carousel: { on: true, app: 'notebook' } })).toBe(false);
    expect(sameDesk(on, { ...plain, carousel: { on: false, app: 'chat' } })).toBe(false);
    expect(sameDesk(on, { ...plain, carousel: { on: true, app: 'chat' } })).toBe(true);
  });

  it('only a stack is different: that\'s a different desk, so it arrives and a merge keeps the right one', () => {
    const plain = twoApps('a', 1);
    const stacked = withStack(plain, plain.items.map((i) => i.id).reverse());
    expect(sameDesk(plain, stacked)).toBe(false);
    expect(mergeServerLayout(doc(stacked), doc(plain), new Set()).desks['a']).toBe(stacked);
    expect(mergeServerLayout(doc(stacked), doc(plain), new Set(['a'])).desks['a']).toBe(plain);
  });

  it('a server document that overlaps clears as a local one does, once, and clearing it again changes nothing', () => {
    const overlapping = { schemaVersion: SCHEMA_VERSION, desks: { a: desk('a', 0), b: desk('b', 100) }, z: ['a', 'b'] };
    const read = readServerLayout(overlapping) as Extract<ServerRead, { kind: 'ok' }>;
    const clear = clearLayoutDoc(read.doc);
    expect(separation(clear.desks['a']!, clear.desks['b']!)).toBeGreaterThanOrEqual(DESK_GAP - 0.01);
    expect(clearLayoutDoc(clear)).toBe(clear);
    // The same document again, merged over what's here: the same answer, so nothing moves and nothing saves.
    expect(sameLayout(clearLayoutDoc(mergeServerLayout(read.doc, clear, new Set())), clear)).toBe(true);
  });

  it('clearing around a member\'s own unsaved desk leaves it where they put it', () => {
    const server = doc(desk('a', 0), desk('b', 900));
    const local = doc(desk('a', 0), desk('b', 100)); // b is what they just moved, and it's over a
    const merged = mergeServerLayout(server, local, new Set(['b']));
    expect(clearLayoutDoc(merged, ['b']).desks['b']!.x).toBe(100);
    expect(clearLayoutDoc(merged, ['a']).desks['a']!.x).toBe(0);
  });

  it('a fresh browser\'s desks are untouched however many rows they take, as the store places them', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `d${i}`);
    const placed: LayoutDesk[] = [];
    for (const id of ids) placed.push(freshDesk(id, placed));
    const local: LayoutDoc = { desks: Object.fromEntries(placed.map((d) => [d.id, d])), z: ids };
    expect(isUntouched(local, ids)).toBe(true);
    expect(clearLayoutDoc(local)).toBe(local);
  });

  it('a desk the member switched to carousel has been touched, even with nothing moved', () => {
    const ids = ['d0', 'd1'];
    const placed: LayoutDesk[] = [];
    for (const id of ids) placed.push(freshDesk(id, placed));
    const local: LayoutDoc = { desks: { d0: placed[0]!, d1: { ...placed[1]!, carousel: { on: true, app: 'browser' } } }, z: ids };
    expect(isUntouched(local, ids)).toBe(false);
  });

  it('merging: a desk only one side has stays, so one desk going elsewhere can\'t wipe the others', () => {
    const local = doc(desk('a', 1), desk('only-here', 2));
    const server = doc(desk('a', 1), desk('only-there', 3));
    const merged = mergeServerLayout(server, local, new Set());
    expect(Object.keys(merged.desks).sort()).toEqual(['a', 'only-here', 'only-there']);
    expect(mergeServerLayout(doc(), doc(desk('a', 1)), new Set()).desks['a']!.x).toBe(1); // an empty document wipes nothing
  });

  it('merging: stacking stays this browser\'s, and a new desk joins it', () => {
    const local: LayoutDoc = { desks: doc(desk('a'), desk('b')).desks, z: ['b', 'a'] };
    const server: LayoutDoc = { desks: doc(desk('a'), desk('b'), desk('c')).desks, z: ['a', 'c', 'b'] };
    expect(mergeServerLayout(server, local, new Set()).z).toEqual(['b', 'a', 'c']);
  });

  it('merging with nothing different is the same layout', () => {
    const local = doc(desk('a', 1), desk('b', 2));
    expect(sameLayout(mergeServerLayout(doc(desk('a', 1), desk('b', 2)), local, new Set()), local)).toBe(true);
  });

  it('sameLayout notices a change in any place, size, app or order', () => {
    const a = desk('a');
    const moved = { ...a, items: [{ ...a.items[0]!, x: 25 }] };
    expect(sameDesk(a, desk('a'))).toBe(true);
    expect(sameDesk(a, moved)).toBe(false);
    expect(sameDesk(a, { ...a, w: 585 })).toBe(false);
    expect(sameLayout(doc(a), doc(moved))).toBe(false);
    expect(sameLayout(doc(a, desk('b')), { desks: doc(a, desk('b')).desks, z: ['b', 'a'] })).toBe(false);
  });

  it('stays under the limit with a hostile number of desks, keeping the most recently raised', () => {
    const many = Array.from({ length: 5000 }, (_, i) => desk(`d-${String(i).padStart(12, '0')}`, i));
    const hostile = doc(...many);
    const body = writeServerLayout(hostile);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_SERVER_BYTES);
    const read = readServerLayout((JSON.parse(body) as { layout: unknown }).layout);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    const kept = Object.keys(read.doc.desks);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept).toContain(`d-${String(4999).padStart(12, '0')}`); // the top of the stack
    expect(kept).not.toContain(`d-${String(0).padStart(12, '0')}`);
    expect(read.doc.z[read.doc.z.length - 1]).toBe(`d-${String(4999).padStart(12, '0')}`);
  });

  it('a browser nobody arranged anything in has nothing to upload', () => {
    const ids = ['a', 'b', 'c'];
    const placed: LayoutDesk[] = [];
    for (const id of ids) {
      const { x, y } = placeNewDesk(placed);
      placed.push(defaultDesk(id, x, y));
    }
    const untouched = doc(...placed);
    expect(isUntouched(untouched, ids)).toBe(true);
    expect(isUntouched(doc(), ids)).toBe(true);
    // Through the mirror and back, as on the next load.
    expect(isUntouched(readLayoutDoc(JSON.parse(JSON.stringify(untouched)))!, ids)).toBe(true);
    // Any arrangement at all is worth keeping.
    expect(isUntouched(doc({ ...placed[0]!, y: 8 }, placed[1]!, placed[2]!), ids)).toBe(false);
    expect(isUntouched(doc(placed[0]!, { ...placed[1]!, w: placed[1]!.w + 8 }, placed[2]!), ids)).toBe(false);
    const a = placed[2]!;
    expect(isUntouched(doc(placed[0]!, placed[1]!, { ...a, items: [{ ...a.items[0]!, y: a.items[0]!.y + 8 }, ...a.items.slice(1)] }), ids)).toBe(false);
  });

  describe('what arrives', () => {
    const place = (id: string, x: number, y = 0): LayoutDesk => ({ ...desk(id, x, y), h: 300 });
    const inOrder = (z: string[], ...desks: LayoutDesk[]): LayoutDoc => ({ desks: Object.fromEntries(desks.map((d) => [d.id, d])), z });
    const clashes = (d: LayoutDoc): string[] => {
      const all = Object.values(d.desks);
      return all.flatMap((a, i) => all.slice(i + 1).filter((b) => separation(a, b) < -0.01).map((b) => `${a.id}/${b.id}`));
    };

    it('a document that overlaps clears the same way in every browser, whatever each one\'s own z says', () => {
      const server = inOrder(['a', 'b'], place('a', 0), place('b', 100));
      const one = arrivingLayout(server, inOrder(['a', 'b'], place('a', 0), place('b', 900)), new Set());
      const two = arrivingLayout(server, inOrder(['b', 'a'], place('a', 0), place('b', 900)), new Set());
      expect(clashes(one)).toEqual([]);
      expect(one.desks).toEqual(two.desks);
      // Doing what `clearLayoutDoc` does on load, in the local order, is what would have told them apart.
      expect(clearLayoutDoc(mergeServerLayout(server, { ...one, z: ['b', 'a'] }, new Set())).desks).not.toEqual(clearLayoutDoc(mergeServerLayout(server, { ...one, z: ['a', 'b'] }, new Set())).desks);
    });

    it('two clean sides that merge into an overlap: this browser\'s stays put, and it comes out clear', () => {
      // Each moved its own desk to a place that was free on its side. Together they're on the same spot.
      const start = inOrder(['a', 'b'], place('a', 0), place('b', 700));
      const hereMovedB = inOrder(['a', 'b'], start.desks['a']!, place('b', 0, 400));
      const thereMovedA = inOrder(['a', 'b'], place('a', 0, 400), start.desks['b']!);
      expect(clashes(hereMovedB)).toEqual([]);
      expect(clashes(thereMovedA)).toEqual([]);
      const here = arrivingLayout(thereMovedA, hereMovedB, new Set(['b']));
      expect(clashes(here)).toEqual([]);
      expect(here.desks['b']).toBe(hereMovedB.desks['b']); // their own desk, exactly where they put it
      expect(here.desks['a']!.y).not.toBe(400); // and what the document said has given way
    });

    it('it settles: what one browser saves, the other takes with nothing to send, and nothing further moves', () => {
      const server = inOrder(['a', 'b'], place('a', 0, 400), place('b', 700));
      const here = arrivingLayout(server, inOrder(['a', 'b'], place('a', 0), place('b', 0, 400)), new Set(['b']));
      // Reading it again changes nothing, so a repeat of the same read can't move anything.
      expect(sameLayout(arrivingLayout(server, here, new Set(['b'])), here)).toBe(true);
      // What it saved reaches the other browser, whose own z is the other way about. It has nothing unsaved, and takes it whole.
      const saved = readServerLayout((JSON.parse(writeServerLayout(here)) as { layout: unknown }).layout) as Extract<ServerRead, { kind: 'ok' }>;
      const there = arrivingLayout(saved.doc, inOrder(['b', 'a'], place('a', 0, 400), place('b', 700)), new Set());
      expect(there.desks).toEqual(here.desks);
      // From here both are the same, and neither has anything to say to the other.
      expect(sameLayout(arrivingLayout(saved.doc, there, new Set()), there)).toBe(true);
    });

    it('a desk only this browser has goes round what the document says, and an unsaved one doesn\'t', () => {
      const server = inOrder(['a'], place('a', 0));
      const moved = arrivingLayout(server, inOrder(['a', 'new'], place('a', 900), place('new', 100)), new Set());
      expect(moved.desks['a']!.x).toBe(0);
      expect(moved.desks['new']).not.toEqual(place('new', 100));
      expect(clashes(moved)).toEqual([]);
      const kept = arrivingLayout(server, inOrder(['a', 'new'], place('a', 900), place('new', 100)), new Set(['new']));
      expect(kept.desks['new']!.x).toBe(100);
      expect(clashes(kept)).toEqual([]);
    });

    it('a desk the list doesn\'t have stays out, and any answer without a list keeps it until there is one', () => {
      const server = inOrder(['a', 'gone'], place('a', 0), place('gone', 900));
      expect(Object.keys(arrivingLayout(server, doc(), new Set(), new Set(['a'])).desks)).toEqual(['a']);
      expect(Object.keys(arrivingLayout(server, doc(), new Set()).desks).sort()).toEqual(['a', 'gone']);
    });

    it('a clean document with nothing unsaved is untouched, object for object', () => {
      const local = inOrder(['a', 'b'], place('a', 0), place('b', 700));
      const same = arrivingLayout(inOrder(['b', 'a'], place('a', 0), place('b', 700)), local, new Set());
      expect(same.desks['a']).toBe(local.desks['a']);
      expect(same.desks['b']).toBe(local.desks['b']);
      expect(sameBounds(same, local)).toBe(true);
    });

    it('sameBounds asks about places and sizes only, so a stack alone never moves the camera', () => {
      const plain = twoApps('a', 1);
      const stacked = withStack(plain, plain.items.map((i) => i.id).reverse());
      expect(sameBounds(doc(plain), doc(stacked))).toBe(true);
      expect(sameBounds(doc(plain), doc({ ...plain, x: 2 }))).toBe(false);
      expect(sameBounds(doc(plain), doc({ ...plain, h: plain.h + 1 }))).toBe(false);
      expect(sameBounds(doc(plain), doc(plain, desk('b')))).toBe(false);
    });

    it('randomised: never an overlap, unsaved desks never move, every browser lands on the same place, and the second read changes nothing', () => {
      let seed = 20261106;
      const rnd = (n: number): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return Math.floor((seed / 4294967296) * n);
      };
      const spread = (ids: string[], n: number): LayoutDesk[] => {
        // Far enough apart that none of them overlap, so a document or a browser is clean on its own.
        const slots = ids.map((_, i) => i).sort(() => rnd(3) - 1);
        return ids.map((id, i) => place(id, (slots[i]! % 4) * (720 + n), Math.floor(slots[i]! / 4) * 340));
      };
      for (let round = 0; round < 300; round += 1) {
        const ids = Array.from({ length: 2 + rnd(6) }, (_, i) => `d${i}`);
        const server = inOrder([...ids].sort(() => rnd(3) - 1), ...spread(ids, rnd(5)));
        // Now and then the document itself overlaps, as an older build or another browser's merge could leave it.
        if (rnd(3) === 0) server.desks[ids[0]!] = { ...server.desks[ids[0]!]!, x: server.desks[ids[1]!]!.x + 50, y: server.desks[ids[1]!]!.y + 50 };
        const local = inOrder([...ids].sort(() => rnd(3) - 1), ...spread(ids, rnd(5)));
        const unsaved = new Set(ids.filter(() => rnd(3) === 0));
        const mine = arrivingLayout(server, local, unsaved);
        expect(clashes(mine), `round ${round}`).toEqual([]);
        for (const id of unsaved) expect(mine.desks[id], `round ${round}`).toBe(local.desks[id]);
        expect(sameLayout(arrivingLayout(server, mine, unsaved), mine), `round ${round}: a second read`).toBe(true);
        // Another browser with nothing to send, in its own order, reading the same document: the same places as any other.
        const a = arrivingLayout(server, inOrder([...ids].reverse(), ...spread(ids, rnd(5))), new Set());
        const b = arrivingLayout(server, inOrder(ids, ...spread(ids, rnd(5))), new Set());
        expect(a.desks, `round ${round}: two browsers`).toEqual(b.desks);
        // What this browser sends next is what everyone lands on.
        const sent = readServerLayout((JSON.parse(writeServerLayout(mine)) as { layout: unknown }).layout) as Extract<ServerRead, { kind: 'ok' }>;
        expect(arrivingLayout(sent.doc, a, new Set()).desks, `round ${round}: after a save`).toEqual(mine.desks);
      }
    });
  });

  describe('stacking, across the round trip', () => {
    const stackedDesk = (): LayoutDesk => {
      const two = twoApps('s', 700);
      return withStack(two, two.items.map((i) => i.id).reverse());
    };
    const readBack = (body: string): Extract<ServerRead, { kind: 'ok' }> => readServerLayout((JSON.parse(body) as { layout: unknown }).layout) as Extract<ServerRead, { kind: 'ok' }>;

    it('a save, read back and saved again, is the same bytes, stack and all', () => {
      const body = writeServerLayout(doc(desk('plain', 1), stackedDesk()));
      expect(writeServerLayout(readBack(body).doc)).toBe(body);
    });

    it('each desk\'s entry is exact: `stack` only if it has one, and in its own order', () => {
      const raw = JSON.parse(writeServerLayout(doc(desk('plain', 1), stackedDesk()))) as { layout: { desks: Record<string, unknown> } };
      expect(JSON.stringify(raw.layout.desks['plain'])).toBe('{"x":1,"y":0,"w":584,"h":144,"items":[{"id":"plain:chat","app":"chat","x":24,"y":24,"w":76,"h":76}]}');
      expect(JSON.stringify(raw.layout.desks['s'])).toBe('{"x":700,"y":0,"w":584,"h":144,"items":[{"id":"s:chat","app":"chat","x":24,"y":24,"w":76,"h":76},{"id":"s:notebook","app":"notebook","x":124,"y":24,"w":76,"h":76}],"stack":["s:notebook","s:chat"]}');
    });

    it('a desk raised and put back saves without a stack, the same bytes as one that never stacked', () => {
      const plain = twoApps('a', 1);
      const back = withStack(withStack(plain, plain.items.map((i) => i.id).reverse()), plain.items.map((i) => i.id));
      expect(writeServerLayout(doc(back))).toBe(writeServerLayout(doc(plain)));
    });

    it('a stack from the mirror and the same one from Platform are the same desk, and neither reads as a change', () => {
      const s = stackedDesk();
      const fromMirror = readLayoutDoc(JSON.parse(JSON.stringify(doc(s))))!;
      const fromPlatform = readBack(writeServerLayout(doc(s))).doc;
      expect(sameDesk(fromMirror.desks['s']!, fromPlatform.desks['s']!)).toBe(true);
      expect(arrivingLayout(fromPlatform, fromMirror, new Set()).desks['s']).toBe(fromMirror.desks['s']);
    });
  });

  it('a desk that\'s already sound isn\'t recomputed, so it comes back as it went', () => {
    const d = desk('a');
    expect(sameDesk(settleDesk(d), d)).toBe(true);
    const crowded = { ...d, items: [...d.items, { ...d.items[0]!, id: 'a:notebook', app: 'notebook' as const }] };
    expect(sameDesk(settleDesk(crowded), crowded)).toBe(true); // and apps over each other are sound too (ADR 0064)
  });

  it('a lower limit is respected too, and oversized extras are the first to go', () => {
    const d = doc(...Array.from({ length: 60 }, (_, i) => desk(`d${i}`, i)));
    expect(new TextEncoder().encode(writeServerLayout(d, {}, 8192)).length).toBeLessThanOrEqual(8192);
    const big = { junk: 'x'.repeat(40_000) };
    const body = writeServerLayout(doc(desk('a')), big);
    expect(body).not.toContain('junk');
    expect(body).toContain('"a"');
  });
});

// What each older build's own code wrote for a first visit, from running `defaultDesk` and `placeNewDesk` at that commit.
// Written 1f75161 to before b0de92f: the name still sat over the desk, so the row is 36 down. b0de92f to before eca1294: at 0. Both one row high.
const OLD_APPS = (id: string): string => `[{"id":"${id}:chat","app":"chat","x":24,"y":24,"w":76,"h":76},{"id":"${id}:notebook","app":"notebook","x":116,"y":24,"w":76,"h":76},{"id":"${id}:browser","app":"browser","x":208,"y":24,"w":76,"h":76},{"id":"${id}:agent","app":"agent","x":300,"y":24,"w":76,"h":76}]`;
const OLD_V2 = (y: number, h: number, ...ids: string[]): LayoutDoc => readLayoutDoc(JSON.parse(`{"desks":{${ids.map((id, i) => `"${id}":{"id":"${id}","x":${i * 656},"y":${y},"w":584,"h":${h},"items":${OLD_APPS(id)}}`).join()}},"z":${JSON.stringify(ids)}}`))!;
// c36a199 to before 1f75161 stored cells under ma.layout.v1, 36 down.
const OLD_V1 = (...ids: string[]): unknown => JSON.parse(`{"desks":{${ids.map((id, i) => `"${id}":{"id":"${id}","x":${i * 656},"y":36,"cols":6,"rows":1,"items":[{"id":"${id}:chat","app":"chat","size":"icon"},{"id":"${id}:notebook","app":"notebook","size":"icon"},{"id":"${id}:browser","app":"browser","size":"icon"},{"id":"${id}:agent","app":"agent","size":"icon"}]}`).join()}},"z":${JSON.stringify(ids)}}`);

describe('a browser nobody arranged anything in, in any build that has shipped', () => {
  const ids = ['d-a', 'd-b', 'd-c'];

  it.each([
    ['one row high, under the old label (1f75161)', OLD_V2(36, 144, ...ids)],
    ['one row high, at the top (b0de92f)', OLD_V2(0, 144, ...ids)],
    ['today\'s, two rows high (eca1294)', OLD_V2(0, 236, ...ids)],
    ['cells, under the old label, migrated (c36a199)', migrateLayoutV1(OLD_V1(...ids))!],
  ])('%s counts as untouched', (_, old) => {
    expect(isUntouched(old, ids)).toBe(true);
    // And on the next load, from the mirror.
    expect(isUntouched(clearLayoutDoc(readLayoutDoc(JSON.parse(JSON.stringify(old)))!), ids)).toBe(true);
    expect(isUntouched({ desks: { 'd-a': old.desks['d-a']! }, z: ['d-a'] }, ['d-a'])).toBe(true);
  });

  it('a desk added by a newer build beside older ones is still untouched', () => {
    const older = OLD_V2(0, 144, 'd-a');
    const placed = [older.desks['d-a']!];
    const added = freshDesk('d-b', placed);
    expect(added.h).toBe(236);
    expect(isUntouched({ desks: { 'd-a': placed[0]!, 'd-b': added }, z: ['d-a', 'd-b'] }, ['d-a', 'd-b'])).toBe(true);
    const under = OLD_V2(36, 144, 'd-a');
    const addedUnder = freshDesk('d-b', [under.desks['d-a']!]);
    expect(addedUnder.y).toBe(36);
    expect(isUntouched({ desks: { 'd-a': under.desks['d-a']!, 'd-b': addedUnder }, z: ['d-a', 'd-b'] }, ['d-a', 'd-b'])).toBe(true);
  });

  it('pressing an app at the defaults doesn\'t make it arranged: nothing overlaps, so the stack shows nothing', () => {
    const old = OLD_V2(0, 144, ...ids);
    const a = old.desks['d-a']!;
    const pressed = withStack(a, [...stackOrder(a).slice(1), stackOrder(a)[0]!]);
    expect(pressed.stack).toBeDefined();
    expect(isUntouched({ ...old, desks: { ...old.desks, 'd-a': pressed } }, ids)).toBe(true);
    // Nor does focusing a desk, which is only `z`.
    expect(isUntouched({ ...old, z: [...ids].reverse() }, ids)).toBe(true);
  });

  it('a real older layout that was arranged is never untouched', () => {
    const real = migrateLayoutV1(JSON.parse(REAL_V1))!;
    expect(isUntouched(real, Object.keys(real.desks))).toBe(false);
  });

  describe('anything really arranged counts, however small, in each generation', () => {
    const generations: [string, () => LayoutDoc][] = [
      ['1f75161', () => OLD_V2(36, 144, ...ids)],
      ['b0de92f', () => OLD_V2(0, 144, ...ids)],
      ['eca1294', () => OLD_V2(0, 236, ...ids)],
    ];
    const withDesk = (old: LayoutDoc, id: string, change: (d: LayoutDesk) => LayoutDesk): LayoutDoc => ({ ...old, desks: { ...old.desks, [id]: change(old.desks[id]!) } });
    it.each(generations)('%s', (_, make) => {
      const old = make();
      const changes: [string, LayoutDoc][] = [
        ['first desk moved along', withDesk(old, 'd-a', (d) => ({ ...d, x: 8 }))],
        ['first desk moved down a little', withDesk(old, 'd-a', (d) => ({ ...d, y: d.y + 0.01 }))],
        ['last desk out of the row', withDesk(old, 'd-c', (d) => ({ ...d, y: d.y + 8 }))],
        ['middle desk along the row', withDesk(old, 'd-b', (d) => ({ ...d, x: d.x + 0.01 }))],
        ['a desk wider', withDesk(old, 'd-b', (d) => ({ ...d, w: d.w + 8 }))],
        ['a desk narrower', withDesk(old, 'd-b', (d) => ({ ...d, w: d.w - 0.01 }))],
        ['a desk taller by a little', withDesk(old, 'd-c', (d) => ({ ...d, h: d.h + 0.01 }))],
        ['a height no build ever gave one', withDesk(old, 'd-c', (d) => ({ ...d, h: 200 }))],
        ['an app moved', withDesk(old, 'd-b', (d) => ({ ...d, items: [{ ...d.items[0]!, x: d.items[0]!.x + 0.01 }, ...d.items.slice(1)] }))],
        ['an app resized', withDesk(old, 'd-b', (d) => ({ ...d, items: [{ ...d.items[0]!, w: 168, h: 168 }, ...d.items.slice(1)] }))],
        ['a phone\'s reorder', withDesk(old, 'd-c', (d) => ({ ...d, items: [...d.items].reverse() }))],
        ['an app missing', withDesk(old, 'd-c', (d) => ({ ...d, items: d.items.slice(1) }))],
        ['two desks swapped along the row', { ...old, desks: { ...old.desks, 'd-a': { ...old.desks['d-a']!, x: 656 }, 'd-b': { ...old.desks['d-b']!, x: 0 } } }],
        ['a gap in the row', withDesk(old, 'd-c', (d) => ({ ...d, x: d.x + 656 }))],
      ];
      for (const [what, arranged] of changes) expect(isUntouched(arranged, ids), what).toBe(false);
    });

    it('the old row is the first desk\'s to say, and the others have to be in it', () => {
      const old = OLD_V2(0, 144, ...ids);
      expect(isUntouched(withDesk(old, 'd-b', (d) => ({ ...d, y: 36 })), ids)).toBe(false);
      const under = OLD_V2(36, 144, ...ids);
      expect(isUntouched(withDesk(under, 'd-b', (d) => ({ ...d, y: 0 })), ids)).toBe(false);
    });
  });

  it('the one thing it can\'t tell apart: a new desk shrunk to its smallest with nothing else touched reads as an old default', () => {
    // Documented in `isUntouched`. This stays here until the next real change, and anything else about it is enough to tell.
    const fresh = OLD_V2(0, 236, 'd-a');
    const d = fresh.desks['d-a']!;
    expect(fitDeskSize(d.items, d.w, 1)).toEqual({ w: 584, h: 144 });
    expect(isUntouched({ ...fresh, desks: { 'd-a': { ...d, h: 144 } } }, ['d-a'])).toBe(true);
    expect(isUntouched({ ...fresh, desks: { 'd-a': { ...d, h: 144, w: 576 } } }, ['d-a'])).toBe(false);
  });
});

describe('a version-1 layout it has to be careful with', () => {
  it('renders a widget too wide for its desk at what the member was seeing', () => {
    const doc = migrateLayoutV1({ desks: { d: { id: 'd', x: 0, y: 36, cols: 2, rows: 1, items: [{ id: 'a', app: 'chat', size: 'large' }] } }, z: ['d'] })!;
    expect(doc.desks['d']!.items[0]).toMatchObject({ w: span(2), h: span(2) });
    expect(doc.desks['d']).toMatchObject({ w: G.minDeskW, h: panelH(2) });
  });

  it('leaves out only what it can\'t read', () => {
    const doc = migrateLayoutV1({
      desks: {
        good: { id: 'good', x: 5, y: 6, cols: 6, rows: 1, items: [{ id: 'a', app: 'chat', size: 'icon' }, { id: 'b', app: 'not-an-app', size: 'icon' }, { app: 'chat', size: 'icon' }, 'junk', { id: 'c', app: 'agent', size: 'huge' }] },
        junk: 'not a desk',
        bare: {},
      },
      z: ['good', 'gone', 3],
    })!;
    expect(doc.desks['good']!.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(doc.desks['good']!.items[1]).toMatchObject({ w: 76, h: 76 });
    expect(doc.desks['junk']).toBeUndefined();
    expect(doc.desks['bare']).toMatchObject({ x: 0, y: 0, w: 584, h: 144, items: [] });
    expect(doc.z).toEqual(['good']);
  });

  it.each([[null], ['text'], [[]], [{}], [{ desks: 'no' }]])('%j is not a layout', (raw) => {
    expect(migrateLayoutV1(raw)).toBeNull();
    expect(readLayoutDoc(raw)).toBeNull();
  });
});

describe('reading version 2', () => {
  it('loads apps stored on top of each other as they are, with no repair', () => {
    const items = [{ id: 'a', app: 'chat', x: 100, y: 100, w: 76, h: 76 }, { id: 'b', app: 'agent', x: 110, y: 100, w: 76, h: 76 }, { id: 'c', app: 'browser', x: 100, y: 100, w: 76, h: 76 }];
    const doc = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items } }, z: [] })!;
    expect(doc.desks['d']!.items).toEqual(items);
    expect(doc.desks['d']).toMatchObject({ w: 800, h: 500 });
  });

  it('the list reads back in its order, with no sort', () => {
    const items = [{ id: 'low', app: 'chat', x: 300, y: 300, w: 76, h: 76 }, { id: 'top', app: 'agent', x: 24, y: 24, w: 76, h: 76 }, { id: 'mid', app: 'browser', x: 200, y: 24, w: 76, h: 76 }];
    const doc = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items } }, z: [] })!;
    expect(doc.desks['d']!.items.map((i) => i.id)).toEqual(['low', 'top', 'mid']);
    expect(readLayoutDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('grows a desk that holds more than its stored size', () => {
    const doc = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 100, h: 100, items: [{ id: 'a', app: 'chat', x: 24, y: 24, w: 400, h: 300 }] } }, z: ['d'] })!;
    expect(doc.desks['d']).toMatchObject({ w: 24 + 400 + G.edge, h: 24 + 300 + G.strip });
  });

  it('keeps an app with no usable position or size, and finds it a place', () => {
    const doc = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 584, h: 144, items: [{ id: 'a', app: 'chat', x: 24, y: 24, w: 0, h: 76 }, { id: 'b', app: 'agent', x: 'no', y: 24, w: 76, h: 76 }] } }, z: [] })!;
    const items = doc.desks['d']!.items;
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(items[0]).toMatchObject({ x: 24, y: 24, w: 76, h: 76 });
    expect(items[1]).toMatchObject({ w: 76, h: 76 });
    expect(items[1]!.x).toBe(100); // beside the first, not on top of it
  });

  it('an app with bad numbers looks for a free spot, and nothing else moves for it', () => {
    const doc = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items: [{ id: 'a', app: 'chat', x: 24, y: 24, w: 76, h: 76 }, { id: 'b', app: 'notebook', x: 30, y: 30, w: 76, h: 76 }, { id: 'c', app: 'agent', x: null, y: 24, w: 76, h: 76 }] } }, z: [] })!;
    const [a, b, c] = doc.desks['d']!.items;
    expect(a).toMatchObject({ x: 24, y: 24 });
    expect(b).toMatchObject({ x: 30, y: 30 });
    expect(c).toMatchObject({ x: 24, y: 106 }); // clear of both
  });

  it('still leaves out what isn\'t an app at all', () => {
    const doc = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 584, h: 144, items: ['junk', { id: 'a', app: 'not-an-app', x: 24, y: 24, w: 76, h: 76 }] } }, z: [] })!;
    expect(doc.desks['d']!.items).toEqual([]);
  });

  it('a desk with no list of apps is left out, and the desk list gives it a default later', () => {
    expect(readLayoutDoc({ desks: { d: { id: 'd', cols: 6, rows: 1 } }, z: [] })!.desks['d']).toBeUndefined();
  });
});

// ADR 0064: an optional field on version 2, with no key of its own.
describe('a desk\'s stack', () => {
  const ITEMS = [{ id: 'a', app: 'chat', x: 24, y: 24, w: 76, h: 76 }, { id: 'b', app: 'agent', x: 60, y: 24, w: 76, h: 76 }, { id: 'c', app: 'browser', x: 300, y: 24, w: 76, h: 76 }];
  const read = (stack: unknown): LayoutDesk => readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items: ITEMS, stack } }, z: ['d'] })!.desks['d']!;
  const roundTrip = (text: string): string => JSON.stringify(readLayoutDoc(JSON.parse(text)));

  it('a doc with no stack comes through byte-identical', () => {
    const text = '{"desks":{"d-test5i2qpxd":{"id":"d-test5i2qpxd","x":-12.5,"y":36,"w":800.25,"h":500,"items":[{"id":"d-test5i2qpxd:agent","app":"agent","x":24,"y":24,"w":76,"h":76},{"id":"d-test5i2qpxd:chat","app":"chat","x":60.5,"y":24,"w":168,"h":168}]},"d-test9w4kzt7":{"id":"d-test9w4kzt7","x":900,"y":0,"w":584,"h":144,"items":[]}},"z":["d-test9w4kzt7","d-test5i2qpxd"]}';
    expect(roundTrip(text)).toBe(text);
    expect(text).not.toContain('stack');
  });

  it('a real version-1 layout, migrated, comes through byte-identical too, with no stack', () => {
    const text = JSON.stringify(migrateLayoutV1(JSON.parse(REAL_V1)));
    expect(roundTrip(text)).toBe(text);
    expect(text).not.toContain('stack');
  });

  it('a doc with a stack comes through byte-identical', () => {
    const text = '{"desks":{"d":{"id":"d","x":1,"y":2,"w":800,"h":500,"items":[{"id":"a","app":"chat","x":24,"y":24,"w":76,"h":76},{"id":"b","app":"agent","x":60,"y":24,"w":76,"h":76}],"stack":["b","a"]}},"z":["d"]}';
    expect(roundTrip(text)).toBe(text);
  });

  it('keeps a valid one, and leaves the list as it is', () => {
    const d = read(['c', 'a', 'b']);
    expect(d.stack).toEqual(['c', 'a', 'b']);
    expect(d.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('survives a save and a load', () => {
    const doc = { desks: { d: read(['c', 'a', 'b']) }, z: ['d'] };
    expect(readLayoutDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('keeps the stack of a desk whose apps need repair', () => {
    const items = [{ id: 'a', app: 'chat', x: 'no', y: 24, w: 76, h: 76 }, { id: 'b', app: 'agent', x: 60, y: 24, w: 0, h: 76 }];
    expect(readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items, stack: ['b', 'a'] } }, z: [] })!.desks['d']!.stack).toEqual(['b', 'a']);
  });

  it('doesn\'t keep one that says what the list says', () => {
    expect('stack' in read(['a', 'b', 'c'])).toBe(false);
  });

  it.each([
    ['text', 'nope'],
    ['a number', 7],
    ['null', null],
    ['an object', { a: 1 }],
    ['an empty list', []],
    ['a list of junk', [1, null, {}, ['a'], true]],
    ['only ids that aren\'t on the desk', ['gone', 'also-gone']],
  ])('a stack that\'s %s loads as the list\'s order, with no field', (_what, stack) => {
    const d = read(stack);
    expect(d.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(stackOrder(d)).toEqual(['a', 'b', 'c']);
    expect('stack' in d).toBe(false);
  });

  it('makes what it can of one that\'s partly good: junk, repeats and unknown ids go, and what it left out goes on top', () => {
    expect(read([9, 'c', null, 'gone', 'c']).stack).toEqual(['c', 'a', 'b']);
    expect(read(['b']).stack).toEqual(['b', 'a', 'c']);
  });

  it('a desk with no stack has no field at all, not an empty one', () => {
    const d = readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items: ITEMS } }, z: ['d'] })!.desks['d']!;
    expect('stack' in d).toBe(false);
  });
});

// The owner's desk textures: a desk's style is the member's choice, kept on the desk like its stack.
describe('a desk\'s style', () => {
  const ITEMS = [{ id: 'a', app: 'chat', x: 24, y: 24, w: 76, h: 76 }];
  const read = (style: unknown): LayoutDesk => readLayoutDoc({ desks: { d: { id: 'd', x: 1, y: 2, w: 800, h: 500, items: ITEMS, style } }, z: ['d'] })!.desks['d']!;
  const roundTrip = (text: string): string => JSON.stringify(readLayoutDoc(JSON.parse(text)));
  const server = (doc: LayoutDoc): ServerRead => readServerLayout(JSON.parse(writeServerLayout(doc)).layout);

  it('a doc with a style comes through byte-identical, stack and all', () => {
    const text = '{"desks":{"d":{"id":"d","x":1,"y":2,"w":800,"h":500,"items":[{"id":"a","app":"chat","x":24,"y":24,"w":76,"h":76},{"id":"b","app":"agent","x":60,"y":24,"w":76,"h":76}],"stack":["b","a"],"style":"oak"}},"z":["d"]}';
    expect(roundTrip(text)).toBe(text);
  });

  it('a desk nobody chose a style for has no field at all, and saves as it always did', () => {
    const d = read(undefined);
    expect('style' in d).toBe(false);
    expect(writeServerLayout({ desks: { d }, z: ['d'] })).not.toContain('style');
  });

  it('goes to Platform and comes back, known here or not: one from a newer build goes back as it came', () => {
    for (const style of ['plain', 'walnut-from-a-newer-build']) {
      const doc: LayoutDoc = { desks: { d: read(style) }, z: ['d'] };
      const back = server(doc);
      expect(back.kind).toBe('ok');
      expect(back.kind === 'ok' && back.doc.desks['d']!.style).toBe(style);
      expect(JSON.parse(writeServerLayout(doc)).layout.desks.d.style).toBe(style);
    }
  });

  it.each([
    ['upper case', 'Oak'],
    ['markup', '<b>oak</b>'],
    ['a number', 7],
    ['null', null],
    ['an object', { id: 'oak' }],
    ['far too long', 'o'.repeat(200)],
  ])('one that\'s %s isn\'t an id, and loads as no choice', (_what, style) => {
    expect('style' in read(style)).toBe(false);
  });

  it('is part of the desk: a different style is a different desk, so it saves, arrives and merges', () => {
    const plain = read(undefined);
    const oak = read('oak');
    expect(sameDesk(plain, oak)).toBe(false);
    expect(sameDesk(oak, read('oak'))).toBe(true);
    expect(sameLayout({ desks: { d: plain }, z: ['d'] }, { desks: { d: oak }, z: ['d'] })).toBe(false);
    // Nothing else moved, so the camera doesn't hear of it.
    expect(sameBounds({ desks: { d: plain }, z: ['d'] }, { desks: { d: oak }, z: ['d'] })).toBe(true);
    // Platform's copy has another browser's choice; this browser's unsaved one wins on its own desk, as any change does.
    const theirs = { desks: { d: read('linen') }, z: ['d'] };
    expect(mergeServerLayout(theirs, { desks: { d: oak }, z: ['d'] }, new Set(['d'])).desks['d']!.style).toBe('oak');
    expect(mergeServerLayout(theirs, { desks: { d: oak }, z: ['d'] }, new Set()).desks['d']!.style).toBe('linen');
  });

  it('a browser where only a style was chosen has something to upload', () => {
    const fresh = freshDesk('d-1', []);
    expect(isUntouched({ desks: { 'd-1': fresh }, z: ['d-1'] }, ['d-1'])).toBe(true);
    expect(isUntouched({ desks: { 'd-1': { ...fresh, style: 'plain' } }, z: ['d-1'] }, ['d-1'])).toBe(false);
  });

  it('survives what the store does to a desk: a stack, a repair, a band and clearing overlaps', () => {
    const d = { ...read('oak'), items: [...read('oak').items, { id: 'b', app: 'agent' as const, x: 24, y: 24, w: 76, h: 76 }] };
    expect(withStack(d, ['b', 'a']).style).toBe('oak');
    expect(settleDesk(d, new Set(['b'])).style).toBe('oak');
    expect(fitDeskToBand(d, 'teen').style).toBe('oak');
    const other = { ...read(undefined), id: 'e' };
    const cleared = clearLayoutDoc({ desks: { d, e: other }, z: ['d', 'e'] });
    expect(cleared.desks['d']!.style).toBe('oak');
    expect('style' in cleared.desks['e']!).toBe(false);
  });
});

// ADR 0062, item 7: only a brand-new desk is 236 tall. A desk that's stored, or that was stored, keeps its size.
describe('a new desk and a saved one', () => {
  const ICONS = ['chat', 'notebook', 'browser', 'agent'].map((app) => ({ id: `d:${app}`, app, size: 'icon' }));
  const ROW = [24, 116, 208, 300].map((x, n) => ({ id: ICONS[n]!.id, app: ICONS[n]!.app, x, y: 24, w: 76, h: 76 }));

  it('a new desk is 584 x 236, with its apps in a row at the top', () => {
    expect(defaultDesk('d', 5, 6)).toEqual({ id: 'd', x: 5, y: 6, w: 584, h: 236, items: ROW });
  });

  it('a saved 584 x 144 desk stays 584 x 144 on read, with nothing moved', () => {
    const saved = { id: 'd', x: 5, y: 6, w: 584, h: 144, items: ROW };
    expect(readLayoutDoc({ desks: { d: saved }, z: ['d'] })!.desks['d']).toEqual(saved);
  });

  it('a saved new desk stays 584 x 236 on read', () => {
    const saved = defaultDesk('d', 5, 6);
    expect(readLayoutDoc(JSON.parse(JSON.stringify({ desks: { d: saved }, z: ['d'] })))!.desks['d']).toEqual(saved);
  });

  it('a desk on a saved document migrates to exactly the size it was on version 1', () => {
    const migrated = (cols: number, rows: number) => migrateLayoutV1({ desks: { d: { id: 'd', x: 5, y: 6, cols, rows, items: ICONS } }, z: ['d'] })!.desks['d'];
    expect(migrated(6, 1)).toEqual({ id: 'd', x: 5, y: 6, w: 584, h: 144, items: ROW });
    expect(migrated(6, 2)).toMatchObject({ w: 584, h: 236 });
    expect(migrated(6, 3)).toMatchObject({ w: 584, h: 328 });
    expect(migrated(7, 1)).toMatchObject({ w: 676, h: 144 });
  });

  it('a bare desk in a version-1 document is repaired at the version-1 size, since it\'s a saved desk and not a new one', () => {
    expect(migrateLayoutV1({ desks: { d: {} }, z: [] })!.desks['d']).toEqual({ id: 'd', x: 0, y: 0, w: 584, h: 144, items: [] });
  });
});

describe('a saved layout whose desks overlap (ADR 0064)', () => {
  const desk = (id: string, x: number, y: number, w = 400, h = 200) => ({ id, x, y, w, h, items: [] });

  it('a clean one is this same object, and byte for byte what was stored, close and touching desks included', () => {
    const text = JSON.stringify({ desks: { a: desk('a', -10.5, 0), b: desk('b', 399.5, 0), c: desk('c', 799.5, 0) }, z: ['a', 'b', 'c'] });
    const read = readLayoutDoc(JSON.parse(text))!;
    expect(clearLayoutDoc(read)).toBe(read);
    expect(JSON.stringify(clearLayoutDoc(read))).toBe(text);
  });

  it('moves the least it can, keeps the shape, and running it again changes nothing', () => {
    const read = readLayoutDoc({ desks: { a: desk('a', 0, 0), b: desk('b', 390, 0), c: desk('c', 2000, 0) }, z: ['b', 'a', 'c'] })!;
    const clear = clearLayoutDoc(read);
    expect(clear.z).toEqual(['b', 'a', 'c']);
    expect(Object.keys(clear.desks)).toEqual(['a', 'b', 'c']);
    expect(separation(clear.desks['a']!, clear.desks['b']!)).toBe(DESK_GAP);
    expect(clear.desks['c']).toBe(read.desks['c']); // it overlapped nothing
    expect(clearLayoutDoc(clear)).toBe(clear);
    expect(readLayoutDoc(JSON.parse(JSON.stringify(clear)))).toEqual(clear);
  });

  it('keeps the desk on top where it is, when moving either costs the same', () => {
    const read = readLayoutDoc({ desks: { a: desk('a', 0, 0), b: desk('b', 390, 0) }, z: ['a', 'b'] })!; // b is on top
    expect(clearLayoutDoc(read).desks['b']).toBe(read.desks['b']);
    const other = readLayoutDoc({ desks: { a: desk('a', 0, 0), b: desk('b', 390, 0) }, z: ['b', 'a'] })!;
    expect(clearLayoutDoc(other).desks['a']).toBe(other.desks['a']);
  });

  it('counts a size that grew when it was read', () => {
    const items = [{ id: 'x', app: 'chat', x: 24, y: 24, w: 400, h: 300 }];
    const read = readLayoutDoc({ desks: { a: { ...desk('a', 0, 0, 100, 100), items }, b: desk('b', 200, 200) }, z: [] })!;
    expect(read.desks['a']).toMatchObject({ w: 24 + 400 + G.edge, h: 24 + 300 + G.strip }); // it now reaches b
    const clear = clearLayoutDoc(read);
    expect(separation(clear.desks['a']!, clear.desks['b']!)).toBeGreaterThanOrEqual(DESK_GAP);
  });

  it('a version-1 doc goes through the same check', () => {
    const old = migrateLayoutV1({ desks: { a: { id: 'a', x: 0, y: 36, cols: 6, rows: 1, items: [] }, b: { id: 'b', x: 100, y: 40, cols: 6, rows: 1, items: [] } }, z: ['a', 'b'] })!;
    const clear = clearLayoutDoc(old);
    expect(separation(clear.desks['a']!, clear.desks['b']!)).toBeGreaterThanOrEqual(DESK_GAP);
  });

  it('the real version-1 layout from a browser needed nothing', () => {
    const old = migrateLayoutV1(JSON.parse(REAL_V1))!;
    expect(clearLayoutDoc(old)).toBe(old);
  });
});

describe('a desk and an age band', () => {
  const desk = (id = 'd-1', x = 0): LayoutDesk => defaultDesk(id, x, 0);
  const apps = (d: LayoutDesk): string[] => d.items.map((i) => i.app);

  it('no band and adult change nothing, to the same object', () => {
    const d = desk();
    expect(fitDeskToBand(d, null)).toBe(d);
    expect(fitDeskToBand(d, 'adult')).toBe(d);
    const doc: LayoutDoc = { desks: { 'd-1': d }, z: ['d-1'] };
    expect(fitDocToBand(doc, null)).toBe(doc);
    expect(fitDocToBand(doc, 'adult')).toBe(doc);
  });

  it('no band leaves a desk with no Agent exactly as it is', () => {
    const d = fitDeskToBand(desk(), 'teen');
    expect(fitDeskToBand(d, null)).toBe(d);
  });

  it('a teen has no adults-only app, and everything else stays where it was', () => {
    const d = desk();
    const fit = fitDeskToBand(d, 'teen');
    expect(apps(fit)).toEqual(['chat', 'notebook', 'browser']);
    expect(fit.items).toEqual(d.items.slice(0, 3));
    expect({ x: fit.x, y: fit.y, w: fit.w, h: fit.h }).toEqual({ x: d.x, y: d.y, w: d.w, h: d.h });
    expect(fitDeskToBand(fit, 'teen')).toBe(fit);
  });

  it('the stack forgets it, and one that then says what the list says is not stored', () => {
    const d = desk();
    const [chat, notebook, browser, agent] = d.items.map((i) => i.id);
    const stacked = fitDeskToBand(withStack(d, [agent!, browser!, chat!, notebook!]), 'teen');
    expect(stacked.stack).toEqual([browser, chat, notebook]);
    expect(fitDeskToBand(withStack(d, [chat!, notebook!, agent!, browser!]), 'teen').stack).toBeUndefined();
  });

  it('nothing of it reaches a save', () => {
    const doc = fitDocToBand({ desks: { 'd-1': desk() }, z: ['d-1'] }, 'teen');
    expect(writeServerLayout(doc)).not.toMatch(/agent/);
  });

  it('turning 18 brings the Agent back at its default place, an untouched desk being a default desk again', () => {
    const d = desk();
    const back = fitDeskToBand(fitDeskToBand(d, 'teen'), 'adult');
    expect(back.items).toEqual(d.items);
    expect(isUntouched({ desks: { 'd-1': back }, z: ['d-1'] }, ['d-1'])).toBe(true);
    expect(fitDeskToBand(back, 'adult')).toBe(back);
  });

  it('with its place taken, it comes back on the nearest free spot, on the desk', () => {
    const d = fitDeskToBand(desk(), 'teen');
    const slot = desk().items[3]!;
    const moved = { ...d, items: d.items.map((i) => (i.app === 'browser' ? { ...i, x: slot.x, y: slot.y } : i)) };
    const back = fitDeskToBand(moved, 'adult');
    const agent = back.items.find((i) => i.app === 'agent')!;
    const browser = back.items.find((i) => i.app === 'browser')!;
    expect(agent.x === browser.x && agent.y === browser.y).toBe(false);
    expect(agent.x + agent.w).toBeLessThanOrEqual(back.w);
    expect(agent.y + agent.h).toBeLessThanOrEqual(back.h);
    expect(stackOrder(back).at(-1)).toBe(agent.id);
  });

  it('a document with no overlap is cleared of nothing, and desks a returning app grows stay apart', () => {
    const left = fitDeskToBand(desk('d-1'), 'teen');
    const tiny = { ...left, w: 200, h: 120, items: left.items.slice(0, 1) };
    const right = fitDeskToBand(desk('d-2', tiny.x + tiny.w + DESK_GAP), 'teen');
    const fit = fitDocToBand({ desks: { 'd-1': tiny, 'd-2': right }, z: ['d-1', 'd-2'] }, 'adult');
    expect(fit.desks['d-1']!.items.some((i) => i.app === 'agent')).toBe(true);
    expect(separation(fit.desks['d-1']!, fit.desks['d-2']!)).toBeGreaterThanOrEqual(0);
  });

  it('a new desk is what its band has, and a teen who arranged nothing has nothing to upload', () => {
    expect(apps(freshDesk('d-1', [], 'teen'))).toEqual(['chat', 'notebook', 'browser']);
    expect(apps(freshDesk('d-1', [], 'adult'))).toEqual(['chat', 'notebook', 'browser', 'agent']);
    expect(apps(freshDesk('d-1', []))).toEqual(['chat', 'notebook', 'browser', 'agent']);
    const doc: LayoutDoc = { desks: { 'd-1': freshDesk('d-1', [], 'teen') }, z: ['d-1'] };
    expect(isUntouched(doc, ['d-1'])).toBe(true);
    const moved = { ...doc.desks['d-1']!, x: 40 };
    expect(isUntouched({ desks: { 'd-1': moved }, z: ['d-1'] }, ['d-1'])).toBe(false);
  });

  it("untouched stays narrow for everyone else: the Agent moved is a change, and so is any other app missing", () => {
    const d = desk();
    const moved = { ...d, items: d.items.map((i) => (i.app === 'agent' ? { ...i, x: i.x + 8 } : i)) };
    expect(isUntouched({ desks: { 'd-1': d }, z: ['d-1'] }, ['d-1'])).toBe(true);
    expect(isUntouched({ desks: { 'd-1': moved }, z: ['d-1'] }, ['d-1'])).toBe(false);
    const noChat = { ...d, items: d.items.filter((i) => i.app !== 'chat') };
    expect(isUntouched({ desks: { 'd-1': noChat }, z: ['d-1'] }, ['d-1'])).toBe(false);
  });

  it('a document from Platform with an Agent in it comes down to what a teen has, and merges as if it never had it', () => {
    const mine = fitDeskToBand(desk(), 'teen');
    const theirs = fitDocToBand({ desks: { 'd-1': desk() }, z: ['d-1'] }, 'teen');
    const merged = arrivingLayout(theirs, { desks: { 'd-1': mine }, z: ['d-1'] }, new Set());
    expect(merged.desks['d-1']).toBe(mine);
  });
});
