// `notebook.activity` past what one reply holds: tens of thousands of rows, paged by `cursor` and `next`, over the real
// socket. Rows are seeded straight into notebook.db (`helpers/seed-activity.mjs`), as a desk takes years to write them.
// Fake text and fake members only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeskdSession, type RpcError } from './helpers/deskd.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { seedActivity, seedDay, seedPageId } from './helpers/seed-activity.mjs';
import { ACTIVITY_BYTES, ACTIVITY_PAGE, activitySql } from '../src/notebook.ts';

const MIB = 1024 * 1024;
const ALL = { fromDay: '0000-01-01', toDay: '9999-12-31' };

interface Row {
  pageId: string;
  day: string;
  created: boolean;
  edits: number;
  actors: string[];
  actorNames?: (string | null)[];
}

let h: Harness;
const sessions: DeskdSession[] = [];

beforeEach(async () => {
  // The readable copy waits: it would rewrite thousands of seeded pages' files in this process, and the timings would be its.
  h = await harness({ storeDebounceMs: 10, storeMaxWaitMs: 50, readableDebounceMs: 3_600_000 });
});
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await h.clean();
});

const session = (hello?: Record<string, unknown>): DeskdSession => {
  const s = hello ? new DeskdSession(h.socket, hello) : h.session();
  sessions.push(s);
  return s;
};

/** Every reply of one read, following `next`: the rows in order, each reply's size, and how long each took. */
async function readAll(s: DeskdSession, range: { fromDay: string; toDay: string } = ALL) {
  const rows: Row[] = [];
  const replies: { rows: number; bytes: number; rowBytes: number; ms: number; next: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const t0 = performance.now();
    const r = (await s.rpc('notebook.activity', { ...range, ...(cursor ? { cursor } : {}) })) as { rows: Row[]; next: string | null };
    const ms = performance.now() - t0;
    expect(Object.keys(r).sort()).toEqual(['next', 'rows']);
    replies.push({ rows: r.rows.length, bytes: Buffer.byteLength(JSON.stringify(r)), rowBytes: Buffer.byteLength(JSON.stringify(r.rows)) - 2, ms, next: r.next });
    rows.push(...r.rows);
    cursor = r.next ?? undefined;
    expect(replies.length).toBeLessThan(500);
  } while (cursor);
  return { rows, replies };
}

/** Newest day first, then page id, highest first: the order the desk promises. */
const inOrder = (rows: Row[]): boolean =>
  rows.every((r, i) => {
    const prev = rows[i - 1];
    return !prev || prev.day > r.day || (prev.day === r.day && prev.pageId > r.pageId);
  });
const keyOf = (r: Row): string => `${r.day} ${r.pageId}`;
const liveRowsInDb = (): number =>
  (h.service.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM page_activity a JOIN pages p ON p.id = a.page_id WHERE p.deleted_at IS NULL') as { n: number }).n;
const trashedIds = (): Set<string> => new Set(h.service.db.all<{ id: string }>('SELECT id FROM pages WHERE deleted_at IS NOT NULL').map((r) => r.id));

describe('notebook.activity, a page at a time', () => {
  it('40,000 rows come a page at a time, each once, newest day first, none from Trash, every reply under 1 MiB', async () => {
    const s = session();
    const { tabId } = await makeNotebook(s);
    const seeded = seedActivity(h.service.db.raw, { tabId, pages: 4000, days: 10, trashEvery: 25 });
    expect(seeded.rows).toBe(40_000);
    expect(seeded.trashed).toBe(160);

    const { rows, replies } = await readAll(s);
    // The seed's live rows and the first page's own "created" row, today.
    expect(rows).toHaveLength(seeded.liveRows + 1);
    expect(rows).toHaveLength(liveRowsInDb());
    expect(new Set(rows.map(keyOf)).size).toBe(rows.length);
    expect(inOrder(rows)).toBe(true);
    const trashed = trashedIds();
    expect(rows.some((r) => trashed.has(r.pageId))).toBe(false);
    // Whole, it would be several times RES's 1 MiB: what used to be `too_large` past about 7,000 rows.
    expect(Buffer.byteLength(JSON.stringify({ rows }))).toBeGreaterThan(5 * MIB);
    expect(replies.length).toBeGreaterThan(5);
    for (const [i, r] of replies.entries()) {
      expect(r.bytes).toBeLessThanOrEqual(MIB - 1024);
      expect(r.rowBytes).toBeLessThanOrEqual(ACTIVITY_BYTES);
      expect(r.rows).toBeLessThanOrEqual(ACTIVITY_PAGE);
      expect(r.next === null).toBe(i === replies.length - 1);
      // Each reply but the last is as full as the budget lets it be: the next row wouldn't have fitted.
      const following = rows[replies.slice(0, i + 1).reduce((n, x) => n + x.rows, 0)];
      if (following) expect(r.rowBytes + 1 + Buffer.byteLength(JSON.stringify(following))).toBeGreaterThan(ACTIVITY_BYTES);
    }
    const slowest = Math.max(...replies.map((r) => r.ms));
    process.stderr.write(`activity: ${rows.length} rows in ${replies.length} replies, ${Math.min(...replies.map((r) => r.rows))} to ${Math.max(...replies.map((r) => r.rows))} rows each, ${replies.map((r) => r.ms.toFixed(0)).join(', ')} ms\n`);
    expect(slowest).toBeLessThan(2_000);
  });

  it('a client that sends no cursor gets everything it got before, in one reply, as long as that fitted', async () => {
    const s = session();
    const { tabId } = await makeNotebook(s);
    // About 1,000 KB of rows, under the old reply's 1 MiB: an older app reads only `rows`, and must still see them all.
    const seeded = seedActivity(h.service.db.raw, { tabId, pages: 550, days: 10 });
    const r = (await s.rpc('notebook.activity', ALL)) as { rows: Row[]; next: string | null };
    expect(r.rows).toHaveLength(seeded.liveRows + 1);
    expect(r.next).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeGreaterThan(950 * 1024);
    expect(inOrder(r.rows)).toBe(true);
  });

  it('a small desk gets the reply it always had, with next: null', async () => {
    const s = session();
    const made = await makeNotebook(s);
    expect(await s.rpc('notebook.activity', ALL)).toEqual({ rows: [expect.objectContaining({ pageId: made.pageId, created: true, actors: ['user'] })], next: null });
  });

  it('past that, a client that sends no cursor gets the newest rows rather than too_large', async () => {
    const s = session();
    const { tabId } = await makeNotebook(s);
    seedActivity(h.service.db.raw, { tabId, pages: 2000, days: 10 });
    const first = (await s.rpc('notebook.activity', ALL)) as { rows: Row[]; next: string | null };
    expect(first.next).not.toBeNull();
    expect(first.rows.length).toBeGreaterThan(5_000);
    // Today's own row first, then the seed's newest days.
    const days = [...new Set(first.rows.map((r) => r.day))];
    expect(days[0]).toBe(new Date().toISOString().slice(0, 10));
    const { rows } = await readAll(s);
    expect(first.rows).toEqual(rows.slice(0, first.rows.length));
  });

  it('a range pages the same way, and holds only its own days', async () => {
    const s = session();
    const { tabId } = await makeNotebook(s);
    seedActivity(h.service.db.raw, { tabId, pages: 3000, days: 10 });
    const range = { fromDay: seedDay(37 * 2), toDay: seedDay(37 * 6 - 1) };
    const { rows, replies } = await readAll(s, range);
    expect(replies.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.day >= range.fromDay && r.day <= range.toDay)).toBe(true);
    const everything = (await readAll(s)).rows.filter((r) => r.day >= range.fromDay && r.day <= range.toDay);
    expect(rows).toEqual(everything);
    expect(rows).toHaveLength(3000 * 4);
  });

  it('writes between pages never repeat or skip a row that was there, and a trashed page leaves at once', async () => {
    const s = session();
    const { tabId } = await makeNotebook(s);
    seedActivity(h.service.db.raw, { tabId, pages: 2000, days: 10 });
    const before = (await readAll(s)).rows;

    const first = (await s.rpc('notebook.activity', ALL)) as { rows: Row[]; next: string };
    const seen = [...first.rows];
    const lastSent = first.rows.at(-1) as Row;
    const ahead = before[first.rows.length + 10] as Row;
    // A row already sent and one not yet sent change; a row is added on a day before the cursor's (still to come) and on a
    // newer one (behind it, for the next read); a page whose rows are still to come goes to Trash.
    h.service.db.run('UPDATE page_activity SET edits = edits + 100 WHERE page_id = ? AND day = ?', lastSent.pageId, lastSent.day);
    h.service.db.run('UPDATE page_activity SET edits = edits + 100 WHERE page_id = ? AND day = ?', ahead.pageId, ahead.day);
    const newPage = seedPageId(999_999);
    seedActivity(h.service.db.raw, { tabId, pages: 1, days: 0, start: 999_999 });
    h.service.db.run(`INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, '2024-01-02', 1, 1, 2, 1, 0, 0, '["user"]')`, newPage);
    h.service.db.run(`INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, '2099-01-01', 0, 1, 2, 1, 0, 0, '["user"]')`, newPage);
    const goes = before.findLast((r) => r.pageId !== ahead.pageId && r.pageId !== lastSent.pageId) as Row;
    expect(await s.rpc('notebook.page.trash', { pageId: goes.pageId })).toEqual({});
    const sentFirst = new Set(first.rows.map(keyOf));

    let cursor: string | null = first.next;
    while (cursor) {
      const r = (await s.rpc('notebook.activity', { ...ALL, cursor })) as { rows: Row[]; next: string | null };
      seen.push(...r.rows);
      cursor = r.next;
    }
    expect(new Set(seen.map(keyOf)).size).toBe(seen.length);
    expect(inOrder(seen)).toBe(true);
    // The trashed page's rows that were sent before it went stay sent; none come after.
    const expected = before.filter((r) => r.pageId !== goes.pageId || sentFirst.has(keyOf(r))).map(keyOf);
    expected.push(`2024-01-02 ${newPage}`);
    expect(seen.map(keyOf).sort()).toEqual(expected.sort());
    expect(seen.find((r) => keyOf(r) === keyOf(ahead))?.edits).toBe(ahead.edits + 100);
    // The newer row is the next read's, which the topic's event asks for.
    expect((await readAll(s)).rows[0]).toMatchObject({ pageId: newPage, day: '2099-01-01' });
  });

  it('a cursor that is not one of its own is bad_request, and one past the end gives nothing more', async () => {
    const s = session();
    await makeNotebook(s);
    const refused = async (cursor: unknown): Promise<void> => {
      const e = (await s.rpc('notebook.activity', { ...ALL, cursor }).then(
        () => null,
        (err: RpcError) => err,
      )) as RpcError | null;
      expect(e).toEqual({ code: 'bad_request', details: { reason: 'cursor' } });
    };
    await refused('x');
    await refused('p:abc');
    await refused('a:2026-11-11');
    await refused('a:2026-11-11:');
    await refused(`a:2026-11-11:${'x'.repeat(201)}`);
    await refused('y'.repeat(401));
    await refused(7);
    expect(await s.rpc('notebook.activity', { ...ALL, cursor: 'a:0001-01-01:x' })).toEqual({ rows: [], next: null });
    // Null or no cursor is the first page.
    expect(((await s.rpc('notebook.activity', { ...ALL, cursor: null })) as { rows: Row[] }).rows).toHaveLength(1);
  });

  it('reads the day index backwards and sorts nothing, from the start and from a cursor', () => {
    for (const after of [false, true]) {
      const plan = (h.service.db.raw.prepare(`EXPLAIN QUERY PLAN ${activitySql(after)}`).all(...(after ? ['0000-01-01', '9999-12-31', '2026-01-01', 'x'] : ['0000-01-01', '9999-12-31'])) as { detail: string }[]).map((r) => r.detail);
      expect(plan.join(' | ')).toMatch(/page_activity_by_day/);
      expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/);
    }
  });
});

describe('notebook.activity on a guild desk', () => {
  const member = (memberId: string, name: string, grants: string[] = [], role = 'member') => ({ kind: 'guild_member', memberId, role, grants, name, badge: null, teen: false });
  const hello = (caller: { memberId: string }) => ({ t: 'hello', sessionId: `cs-${caller.memberId}`, sub: caller.memberId, caller });
  const ANA = member('gm-ana1', 'Ana', ['manage_spaces']);
  const BO = member('gm-bo2', 'Bo');
  const CAL = member('gm-cal5', 'Cal');
  const MO = member('gm-mo3', 'Mo', ['moderate'], 'officer');

  it("a plain member pages through every live page's rows with names, and none of Trash, whoever trashed it", async () => {
    const ana = session(hello(ANA));
    session(hello(BO));
    const cal = session(hello(CAL));
    const mo = session(hello(MO));
    const { tabId } = await makeNotebook(ana);
    const seeded = seedActivity(h.service.db.raw, { tabId, pages: 3000, days: 10, trashEvery: 20, trashedBy: 'gm-mo3', actors: ['gm-ana1', 'gm-bo2'] });
    // Through the real calls too: Cal trashes a page of his own, and Mo one of Ana's.
    const cals = (await cal.rpc('notebook.page.create', { tabId })) as { page: { id: string } };
    expect(await cal.rpc('notebook.page.trash', { pageId: cals.page.id })).toEqual({});
    expect(await mo.rpc('notebook.page.trash', { pageId: seedPageId(0) })).toEqual({});

    const { rows, replies } = await readAll(cal);
    const trashed = trashedIds();
    expect(trashed.size).toBe(seeded.trashed + 2);
    expect(rows.some((r) => trashed.has(r.pageId))).toBe(false);
    expect(rows).toHaveLength(liveRowsInDb());
    expect(rows).toHaveLength(seeded.liveRows - 10 + 1);
    expect(new Set(rows.map(keyOf)).size).toBe(rows.length);
    expect(inOrder(rows)).toBe(true);
    // Names make rows longer, so they're inside the budget too.
    expect(rows.filter((r) => r.pageId.includes('-5eed-')).every((r) => JSON.stringify(r.actorNames) === '["Ana","Bo"]')).toBe(true);
    expect(rows.find((r) => !r.pageId.includes('-5eed-'))?.actorNames).toEqual(['Ana']);
    expect(replies.length).toBeGreaterThan(4);
    for (const r of replies) {
      expect(r.bytes).toBeLessThanOrEqual(MIB - 1024);
      expect(r.rowBytes).toBeLessThanOrEqual(ACTIVITY_BYTES);
    }
    // A moderator sees exactly the same rows: Trash is nobody's in the Temporal view.
    expect((await readAll(mo)).rows).toEqual(rows);
    // And the owner's session on the same desk has no names, as before.
    const owner = session();
    const ownerRows = (await readAll(owner)).rows;
    expect(ownerRows.map(keyOf)).toEqual(rows.map(keyOf));
    expect(ownerRows.some((r) => 'actorNames' in r)).toBe(false);
  });

  it('a page brought back from Trash brings its rows back, for every member', async () => {
    const ana = session(hello(ANA));
    const cal = session(hello(CAL));
    const mo = session(hello(MO));
    const { tabId } = await makeNotebook(ana);
    seedActivity(h.service.db.raw, { tabId, pages: 100, days: 3, actors: ['gm-ana1'] });
    const id = seedPageId(7);
    expect(await mo.rpc('notebook.page.trash', { pageId: id })).toEqual({});
    expect((await readAll(cal)).rows.some((r) => r.pageId === id)).toBe(false);
    expect(await mo.rpc('notebook.page.restore', { pageId: id })).toEqual({});
    expect((await readAll(cal)).rows.filter((r) => r.pageId === id)).toHaveLength(3);
  });
});
