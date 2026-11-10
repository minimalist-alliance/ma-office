// The edit budget as a setting: deskd's `settings.editBudget` in the hello and in `settings` frames, and what a
// connection checks with. Fake members and fake text only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until, type RpcError } from './helpers/deskd.ts';
import { doc, p, setBody, textOf } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { DOC_FIELD } from '../src/model.ts';
import { Removals } from '../src/owners.ts';
import { DEFAULT_EDIT_BUDGET, parseEditBudget, parseSettings } from '../src/settings.ts';

const ALL_GRANTS = ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'];
const member = (memberId: string, name: string, grants: string[] = [], role = 'member') => ({ kind: 'guild_member', memberId, role, grants, name, badge: null, teen: false });
const ANA = member('gm-ana1', 'Ana');
const BO = member('gm-bo2', 'Bo');
const MO = member('gm-mo3', 'Mo', ['moderate'], 'officer');
const LEE = member('gm-lee4', 'Lee', ALL_GRANTS, 'lead');
const budget = (chars: number, windowMinutes: number) => ({ editBudget: { chars, windowMinutes } });
const hello = (caller: unknown, settings?: unknown) => ({
  t: 'hello',
  sessionId: 'cs-1',
  sub: (caller as { memberId: string }).memberId,
  caller,
  ...(settings === undefined ? {} : { settings }),
});

let h: Harness;
let skew = 0;
const advance = (ms: number): void => {
  skew += ms;
};
const essay = (n: number, seed = 'Ana wrote this. '): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const sessions: DeskdSession[] = [];
const clients: Client[] = [];
const as = (caller: unknown, settings?: unknown): DeskdSession => {
  const s = new DeskdSession(h.socket, hello(caller, settings));
  sessions.push(s);
  return s;
};
const clientAs = (caller: unknown, settings?: unknown): Client => {
  const c = new Client(h.socket, hello(caller, settings));
  clients.push(c);
  return c;
};
const closes = (provider: ReturnType<Client['open']>): string[] => {
  const out: string[] = [];
  provider.on('close', ({ event }: { event: { reason: string } }) => out.push(event.reason));
  return out;
};
async function fails(pr: Promise<unknown>, code: string, reason?: string): Promise<void> {
  const e = (await pr.then(
    () => null,
    (err: RpcError) => err,
  )) as RpcError | null;
  expect(e?.code).toBe(code);
  if (reason) expect(e?.details).toEqual({ reason });
}
const deleteIn = (y: Y.Doc, block: number, from: number, len: number): void => {
  const el = y.getXmlFragment(DOC_FIELD).get(block) as Y.XmlElement;
  y.transact(() => (el.get(0) as Y.XmlText).delete(from, len));
};

describe('the setting, parsed', () => {
  it('chars 0 to 100,000 and windowMinutes 1 to 1,440, whole numbers, else null', () => {
    expect(parseEditBudget({ chars: 500, windowMinutes: 10 })).toEqual({ chars: 500, windowMs: 600_000 });
    expect(parseEditBudget({ chars: 0, windowMinutes: 1 })).toEqual({ chars: 0, windowMs: 60_000 });
    expect(parseEditBudget({ chars: 100_000, windowMinutes: 1_440 })).toEqual({ chars: 100_000, windowMs: 1_440 * 60_000 });
    for (const bad of [
      { chars: -1, windowMinutes: 10 },
      { chars: 100_001, windowMinutes: 10 },
      { chars: 5, windowMinutes: 0 },
      { chars: 5, windowMinutes: 1_441 },
      { chars: 1.5, windowMinutes: 10 },
      { chars: '500', windowMinutes: 10 },
      { chars: 500 },
      { windowMinutes: 10 },
      { chars: null, windowMinutes: 10 },
      [],
      null,
      'x',
      7,
    ]) {
      expect(parseEditBudget(bad)).toBeNull();
    }
    expect(parseSettings(budget(7, 3))).toEqual({ chars: 7, windowMs: 180_000 });
    expect(parseSettings({})).toBeNull();
    expect(parseSettings(undefined)).toBeNull();
    expect(parseSettings({ editBudget: { chars: -1, windowMinutes: 3 } })).toBeNull();
    expect(DEFAULT_EDIT_BUDGET).toEqual({ chars: 500, windowMs: 600_000 });
  });
});

describe('the ledger under a changing budget', () => {
  it('counts what it counted: a shorter window sees less of it, a longer one more, and nothing is dropped early', () => {
    let t = 0;
    const r = new Removals(() => t);
    r.charge('pg', 'gm-bo2', 300, { chars: 500, windowMs: 10 * 60_000 });
    t = 5 * 60_000;
    r.charge('pg', 'gm-bo2', 100, { chars: 500, windowMs: 10 * 60_000 });
    expect(r.used('pg', 'gm-bo2')).toBe(400);
    // A shorter window: only the 100.
    expect(r.used('pg', 'gm-bo2', 2 * 60_000)).toBe(100);
    // A longer one: 60 minutes sees both, and once it has been asked about the entries are kept that long.
    expect(r.used('pg', 'gm-bo2', 60 * 60_000)).toBe(400);
    t = 12 * 60_000;
    expect(r.used('pg', 'gm-bo2')).toBe(100);
    expect(r.used('pg', 'gm-bo2', 60 * 60_000)).toBe(400);
    t = 30 * 60_000;
    expect(r.used('pg', 'gm-bo2', 60 * 60_000)).toBe(400);
    expect(r.used('pg', 'gm-bo2')).toBe(0);
  });

  it('fits: a cost beyond chars never fits, chars 0 refuses any removal, a zero cost always fits', () => {
    const r = new Removals(() => 0);
    expect(r.fits('pg', 'm', 500)).toBe(true);
    expect(r.fits('pg', 'm', 501)).toBe(false);
    expect(r.fits('pg', 'm', 1, { chars: 0, windowMs: 60_000 })).toBe(false);
    expect(r.fits('pg', 'm', 0, { chars: 0, windowMs: 60_000 })).toBe(true);
    expect(r.fits('pg', 'm', 100_000, { chars: 100_000, windowMs: 60_000 })).toBe(true);
  });
});

describe('on a connection', () => {
  beforeEach(async () => {
    skew = 0;
    h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100, now: () => Date.now() + skew });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    for (const s of sessions.splice(0)) s.close();
    await h.clean();
  });

  let pageId: string;
  let ana: ReturnType<Client['open']>;
  async function setup(text = [p('Ana one'), p('Ana two'), p(essay(2000))]): Promise<void> {
    pageId = (await makeNotebook(as(ANA))).pageId;
    ana = clientAs(ANA).open(pageId);
    await synced(ana);
    setBody(ana.document, doc(...text));
    await until('ack', () => !ana.hasUnsyncedChanges);
  }
  async function openAs(caller: unknown, settings?: unknown): Promise<{ provider: ReturnType<Client['open']>; seen: string[]; client: Client }> {
    const client = clientAs(caller, settings);
    const provider = client.open(pageId);
    const seen = closes(provider);
    await synced(provider);
    await until('the text', () => textOf(provider.document).includes('Ana two'));
    return { provider, seen, client };
  }
  const frame = async (client: Client, settings: unknown): Promise<void> => {
    await until('the session', () => client.session !== null);
    client.session?.sendJson({ t: 'settings', settings });
  };
  const used = (memberId = 'gm-bo2'): number => h.service.removals.used(pageId, memberId, 24 * 60 * 60_000);

  it('no settings in the hello is 500 in 10 minutes, as before', async () => {
    await setup();
    const { provider: bo, seen } = await openAs(BO);
    deleteIn(bo.document, 2, 0, 500);
    await until('ack', () => !bo.hasUnsyncedChanges);
    deleteIn(bo.document, 2, 0, 1);
    await until('the refusal', () => seen.includes('forbidden'));
  });

  it("chars 0 in the hello: a typo fix in another's text is refused without moderate, and Bo's own is fine", async () => {
    await setup();
    const { provider: bo, seen } = await openAs(BO, budget(0, 10));
    // Bo's own line in Ana's page is Bo's to change.
    const el = bo.document.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement;
    bo.document.transact(() => {
      (el.get(0) as Y.XmlText).delete(4, 1);
      (el.get(0) as Y.XmlText).insert(4, 'O');
    });
    await until('the refusal', () => seen.includes('forbidden'));
    expect(textOf(ana.document)).toContain('Ana one');
    expect(used()).toBe(0);
  });

  it('chars 0 still lets a moderator and a lead remove, and the owner is untouched', async () => {
    await setup();
    for (const who of [MO, LEE]) {
      const { provider, seen } = await openAs(who, budget(0, 10));
      deleteIn(provider.document, 2, 0, 700);
      await until('ack', () => !provider.hasUnsyncedChanges);
      expect(seen).toEqual([]);
    }
    expect(used('gm-mo3')).toBe(0);
  });

  it('a settings frame changes enforcement live, for the next update, and what was counted stays counted', async () => {
    await setup();
    const { provider: bo, seen, client } = await openAs(BO);
    deleteIn(bo.document, 2, 0, 100);
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(100);
    // Down to 150: 50 more fit, 51 don't.
    await frame(client, budget(150, 10));
    await sleep(50);
    deleteIn(bo.document, 2, 0, 50);
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(150);
    deleteIn(bo.document, 2, 0, 1);
    await until('the refusal', () => seen.includes('forbidden'));
    // Up to 1,000 on the same connection: a fresh provider on it takes more, with the 150 still counted.
    await frame(client, budget(1_000, 10));
    await sleep(50);
    const again = client.open(pageId);
    const seen2 = closes(again);
    await synced(again);
    await until('the text', () => textOf(again.document).includes('Ana two'));
    deleteIn(again.document, 2, 0, 850);
    await until('ack', () => !again.hasUnsyncedChanges);
    expect(seen2).toEqual([]);
    expect(used()).toBe(1_000);
    deleteIn(again.document, 2, 0, 1);
    await until('the refusal', () => seen2.includes('forbidden'));
  });

  it("a frame's window applies too: 2 minutes forgets what 10 would still count", async () => {
    await setup();
    const { provider: bo, client } = await openAs(BO);
    deleteIn(bo.document, 2, 0, 400);
    await until('ack', () => !bo.hasUnsyncedChanges);
    advance(3 * 60_000);
    await frame(client, budget(500, 2));
    await sleep(50);
    deleteIn(bo.document, 2, 0, 500);
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(h.service.removals.used(pageId, 'gm-bo2', 2 * 60_000)).toBe(500);
  });

  it("one connection's setting is not another's", async () => {
    await setup();
    const strict = await openAs(BO, budget(0, 10));
    const loose = await openAs(BO, budget(2_000, 10));
    deleteIn(strict.provider.document, 2, 0, 1);
    await until('the refusal', () => strict.seen.includes('forbidden'));
    deleteIn(loose.provider.document, 2, 0, 1_500);
    await until('ack', () => !loose.provider.hasUnsyncedChanges);
    expect(loose.seen).toEqual([]);
  });

  it('settings out of bounds or malformed, in the hello or a frame, are ignored', async () => {
    await setup();
    // A hello with a bad budget keeps the default: 500 fits, 501 doesn't.
    for (const bad of [budget(-1, 10), budget(100_001, 10), budget(5, 0), budget(5, 1_441), budget(2.5, 10), { editBudget: 'lots' }, 'x', 7, []]) {
      const s = as(BO, bad);
      expect(await s.rpc('notebook.tree')).toBeTruthy();
    }
    const { provider: bo, seen, client } = await openAs(BO, budget(-5, 10));
    await frame(client, budget(0, 10_000));
    await frame(client, { editBudget: { chars: '0', windowMinutes: 10 } });
    await frame(client, 'garbage');
    await sleep(50);
    deleteIn(bo.document, 2, 0, 500);
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    deleteIn(bo.document, 2, 0, 1);
    await until('the refusal', () => seen.includes('forbidden'));
  });

  it("a restore is judged against the connection's budget", async () => {
    pageId = (await makeNotebook(as(ANA))).pageId;
    const bo = as(BO, budget(0, 10));
    const pb = clientAs(BO).open(pageId);
    await synced(pb);
    setBody(pb.document, doc(p('Bo first')));
    await until('ack', () => !pb.hasUnsyncedChanges);
    await sleep(30);
    const v1: any = await bo.rpc('notebook.version.save', { pageId });
    const pa = clientAs(ANA).open(pageId);
    await synced(pa);
    setBody(pa.document, doc(p('Bo first'), p('Ana later')));
    await until('ack', () => !pa.hasUnsyncedChanges);
    // 'Ana later' as a block costs 50: refused at 0, fine at the default.
    await fails(bo.rpc('notebook.version.restore', { pageId, versionId: v1.version.id }), 'forbidden', 'grant');
    const bo2 = as(BO);
    expect(await bo2.rpc('notebook.version.restore', { pageId, versionId: v1.version.id })).toEqual({});
  });

  it('an owner connection ignores a settings frame: nothing it does is limited', async () => {
    await setup();
    const owner = new Client(h.socket, true);
    clients.push(owner);
    const provider = owner.open(pageId);
    await synced(provider);
    await frame(owner, budget(0, 10));
    await sleep(50);
    deleteIn(provider.document, 2, 0, 1_500);
    await until('ack', () => !provider.hasUnsyncedChanges);
  });
});
