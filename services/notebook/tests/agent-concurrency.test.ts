// The member and agents on one page at once (src/agent.ts; draft ADR "the Agent's tools and approvals" §17, Notebook:
// "1,000 interleavings of the member typing while an agent appends: 0 lost keystrokes, 0 duplicate blocks"). The member
// types through a real @hocuspocus/provider over the real socket while two agents' edits go through deskd's own
// calls; every keystroke and every agent block must be there exactly once, in order, on the desk and in the editor
// alike. Then two agents after the same text, and one agent's edit planned on another's. Fake text only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until, type RpcError } from './helpers/deskd.ts';
import { bodyOf, doc, h1, p, setBody } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { Rng } from './helpers/randomPages.ts';
import { DOC_FIELD, type PMNode } from '../src/model.ts';

let h: Harness;
let s: DeskdSession;
const sessions: DeskdSession[] = [];
const clients: Client[] = [];

const KEYSTROKES = Number(process.env['NOTEBOOK_KEYSTROKES'] ?? 1000);

const client = (): Client => {
  const c = new Client(h.socket);
  clients.push(c);
  return c;
};
const session = (): DeskdSession => {
  const x = h.session();
  sessions.push(x);
  return x;
};
const edit = (x: DeskdSession, params: Record<string, unknown>): Promise<any> => x.rpc('notebook.page.agentEdit', { agentName: 'ag-1', ...params });
const deskBody = async (pageId: string): Promise<PMNode> => JSON.parse((await s.rpc('notebook.page.content', { pageId })).part) as PMNode;
const textOfBlock = (b: PMNode): string => (b.content ?? []).map((n) => n.text ?? (n.content ? textOfBlock(n) : '')).join('');

/** The member's caret in one paragraph: what they type goes at its end, whatever lands around it. */
function caretIn(y: Y.Doc, blockIndex: number): (ch: string) => void {
  const el = y.getXmlFragment(DOC_FIELD).get(blockIndex) as Y.XmlElement;
  const t = el.get(0) as Y.XmlText;
  return (ch) => y.transact(() => t.insert(t.length, ch));
}

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100 });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const x of sessions.splice(0)) x.close();
  await h.clean();
});

describe('the member typing while agents edit the same page', () => {
  it(`${KEYSTROKES} keystrokes interleaved with two agents' appends and replacements: none lost, none doubled`, async () => {
    const slots = 20;
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Live'), p('mine:'), ...Array.from({ length: slots }, (_, k) => p(`slot-${k} waits`))));
    await until('ack', () => !provider.hasUnsyncedChanges);
    const type = caretIn(provider.document, 1);
    const rng = new Rng(20261112);
    let typed = '';

    const member = (async () => {
      for (let i = 0; i < KEYSTROKES; i += 1) {
        const ch = String.fromCharCode(97 + (i % 26));
        type(ch);
        typed += ch;
        // A burst of keys, then a pause, as typing is: the provider sends whatever has built up.
        if (rng.chance(0.3)) await sleep(rng.int(3));
      }
    })();
    const agentA = session();
    const agentB = session();
    const appendsA = (async () => {
      for (let k = 0; k < 40; k += 1) {
        await edit(agentA, { op: 'append', pageId, markdown: `agent A block ${k}`, agentName: 'ag-a' });
        await sleep(rng.int(4));
      }
    })();
    const editsB = (async () => {
      for (let k = 0; k < 40; k += 1) {
        if (k < slots) await edit(agentB, { op: 'replace_text', pageId, find: `slot-${k} waits`, markdown: `slot-${k} **done**`, agentName: 'ag-b' });
        else await edit(agentB, { op: 'append', pageId, markdown: `agent B block ${k}`, agentName: 'ag-b' });
        await sleep(rng.int(4));
      }
    })();
    await Promise.all([member, appendsA, editsB]);
    await until('ack', () => !provider.hasUnsyncedChanges, 30_000);

    // On the desk and in the editor alike.
    await until('the desk to have every keystroke', async () => textOfBlock((await deskBody(pageId)).content?.[1] as PMNode) === `mine:${typed}`, 30_000);
    const desk = await deskBody(pageId);
    await until('the editor to have every edit', () => JSON.stringify(bodyOf(provider.document)) === JSON.stringify(desk), 30_000);
    const blocks = (desk.content ?? []).map(textOfBlock);
    expect(blocks[1]).toBe(`mine:${typed}`);
    for (let k = 0; k < 40; k += 1) expect(blocks.filter((b) => b === `agent A block ${k}`), `A ${k}`).toHaveLength(1);
    for (let k = slots; k < 40; k += 1) expect(blocks.filter((b) => b === `agent B block ${k}`), `B ${k}`).toHaveLength(1);
    for (let k = 0; k < slots; k += 1) expect(blocks.filter((b) => b === `slot-${k} done`), `slot ${k}`).toHaveLength(1);
    expect(blocks.some((b) => b.includes('waits'))).toBe(false);
    // Nothing else: the Title, the member's line, the slots, 40 of A's and 20 of B's.
    expect(blocks).toHaveLength(2 + slots + 40 + 20);
    // Every agent edit left its version and its row.
    const edits = (await s.rpc('notebook.page.agentEdits', { pageId })).edits;
    expect(edits).toHaveLength(50);
  }, 120_000);

  it('typing inside the very block an agent rewrites in place: the keystrokes stay, and so does the rewrite', async () => {
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Live'), p('Status: draft')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    const type = caretIn(provider.document, 1);
    let typed = '';
    const typing = (async () => {
      for (const ch of ' and still typing') {
        type(ch);
        typed += ch;
        await sleep(1);
      }
    })();
    // The same kind of block, so the agent's change goes inside it, not in a new one.
    await edit(s, { op: 'replace_text', pageId, find: 'Status: draft', markdown: 'Status: **final**' });
    await typing;
    await until('ack', () => !provider.hasUnsyncedChanges);
    await until('both on the desk', async () => textOfBlock((await deskBody(pageId)).content?.[1] as PMNode).endsWith(typed));
    expect(textOfBlock((await deskBody(pageId)).content?.[1] as PMNode)).toBe(`Status: final${typed}`);
  });
});

describe('two agents on one page', () => {
  it('after the same text at once: one changes it, the other finds it gone, never both', async () => {
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Plan'), p('Owner: TBD')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    const a = session();
    const b = session();
    const results = await Promise.allSettled([
      edit(a, { op: 'replace_text', pageId, find: 'TBD', markdown: 'Alice', agentName: 'ag-a' }),
      edit(b, { op: 'replace_text', pageId, find: 'TBD', markdown: 'Bob', agentName: 'ag-b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as RpcError).details).toEqual({ reason: 'not_found' });
    const line = textOfBlock((await deskBody(pageId)).content?.[1] as PMNode);
    expect(['Owner: Alice', 'Owner: Bob']).toContain(line);
  });

  it("one agent's edit is planned on the page as another's left it", async () => {
    const { pageId } = await makeNotebook(s);
    // Sent back to back on one connection: the second is queued behind the first, so it finds what the first wrote.
    const [first, second] = await Promise.all([
      edit(s, { op: 'append', pageId, markdown: 'placeholder-7f3', agentName: 'ag-a' }),
      edit(s, { op: 'replace_text', pageId, find: 'placeholder-7f3', markdown: 'filled in', agentName: 'ag-b' }),
    ]);
    expect(first.op).toBe('append');
    expect(second.op).toBe('replace_text');
    expect((await deskBody(pageId)).content?.map(textOfBlock)).toEqual(['', 'filled in']);
  });

  it('many appends at once from many agents: each once, none lost', async () => {
    const { pageId } = await makeNotebook(s);
    const agents = Array.from({ length: 4 }, () => session());
    await Promise.all(agents.flatMap((x, a) => Array.from({ length: 25 }, (_, k) => edit(x, { op: 'append', pageId, markdown: `agent ${a} note ${k}`, agentName: `ag-${a}` }))));
    const blocks = ((await deskBody(pageId)).content ?? []).map(textOfBlock);
    for (let a = 0; a < 4; a += 1) for (let k = 0; k < 25; k += 1) expect(blocks.filter((b) => b === `agent ${a} note ${k}`)).toHaveLength(1);
    expect(blocks).toHaveLength(1 + 100);
  });
});
