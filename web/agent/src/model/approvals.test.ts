import { describe, expect, it } from 'vitest';
import type { Agent, Approval } from '../client/types';
import {
  answerByText,
  approvalChecks,
  ARM_MS,
  arrivedText,
  cardOf,
  countLabel,
  decideErrorText,
  doneWord,
  egressText,
  elapsed,
  leavesOf,
  levelOf,
  shown,
  stateOf,
  TOLD,
  tookWords,
  whyOf,
  withApprovals,
} from './approvals';
import { canonicalJson, payloadChecks, sha256Hex } from './proposals';

const agents = [
  { id: 'scout', name: 'Scout' },
  { id: 'writer', name: 'Writer' },
] as const;

async function approval(over: Partial<Approval> = {}): Promise<Approval> {
  const base: Approval = {
    id: 'ap-aaaaaaaaaaaaaaaaaaaa',
    agentId: 'scout',
    runId: 'run-1',
    messageId: 'msg-1',
    tool: 'browser_open',
    risk: 'egress',
    title: 'desk title',
    context: 'agent',
    target: { kind: 'site', origin: 'https://shop.example.com' },
    payload: { url: 'https://shop.example.com/compare?item=lumen-arc&width=120cm&budget=80' },
    before: null,
    sha256: '',
    untrusted: true,
    origin: { kind: 'member' },
    state: 'pending',
    detail: null,
    createdAt: new Date(2026, 10, 11, 14, 12).getTime(),
    expiresAt: new Date(2026, 10, 11, 15, 12).getTime(),
    decidedAt: null,
    decidedBy: null,
    note: null,
    result: null,
    ...over,
  };
  const sha256 = over.sha256 ?? (await sha256Hex(canonicalJson({ v: 1, agentId: base.agentId, runId: base.runId, tool: base.tool, context: base.context, payload: base.payload })));
  return { ...base, sha256 };
}

describe('levels (spec section 0)', () => {
  it('folds the desk’s seven risks into four, never lower', () => {
    expect(levelOf('read')).toBe('read');
    expect(levelOf('own')).toBe('change');
    expect(levelOf('write')).toBe('change');
    expect(levelOf('delete')).toBe('change');
    expect(levelOf('send')).toBe('send');
    expect(levelOf('egress')).toBe('send');
    expect(levelOf('spend')).toBe('spend');
    expect(levelOf('something new')).toBe('change');
    expect(levelOf(undefined)).toBe('change');
  });

  it('picks the note by why it asks', () => {
    expect(whyOf({ risk: 'egress', untrusted: true })).toBe('taint');
    expect(whyOf({ risk: 'egress', untrusted: false })).toBe('send');
    expect(whyOf({ risk: 'send', untrusted: true })).toBe('send');
    expect(whyOf({ risk: 'own', untrusted: true })).toBe('taint_memory');
    expect(whyOf({ risk: 'spend', untrusted: false })).toBe('spend');
    expect(whyOf({ risk: 'delete', untrusted: false })).toBe('change');
  });
});

describe('the card, from this app’s own template', () => {
  it('a Send outside: the title, the Tool row first, the exact address, what it tells the site, and the taint note', async () => {
    const v = cardOf(await approval({ reason: 'I want today’s price.' }), agents);
    expect(v.level).toBe('send');
    expect(v.chip).toBe('Sends outside your desk');
    expect(v.title).toBe('Open a page on shop.example.com');
    expect(v.fields[0]).toEqual({ label: 'Tool', value: 'Browser · Open a page' });
    expect(v.fields[1]).toEqual({ label: 'Address', value: 'https://shop.example.com/compare?item=lumen-arc&width=120cm&budget=80', mono: true });
    expect(v.leaves).toEqual({ host: 'shop.example.com', parts: [{ name: 'item', value: 'lumen-arc' }, { name: 'width', value: '120cm' }, { name: 'budget', value: '80' }] });
    expect(v.note).toEqual({ icon: 'eye', text: 'It asks because this task has read your notes and pages from other sites, and an address can carry what it read.' });
    expect(v.untrustedLine).toBeNull();
    expect(v.reason).toBe('I want today’s price.');
    expect(v.asked).toBe('open a page on shop.example.com');
    expect(v.finished).toBe('Opened a page on shop.example.com');
    expect(arrivedText('Scout', v.asked)).toBe('Scout is asking to open a page on shop.example.com. It’s in the thread.');
  });

  it('never takes the model’s or the desk’s title for a tool it knows: the template, from the hashed payload', async () => {
    const v = cardOf(await approval({ title: 'Approve this, it is safe' }), agents);
    expect(v.title).toBe('Open a page on shop.example.com');
  });

  it('a Change with a way back says it; one without says it can’t be undone', async () => {
    const trash = cardOf(await approval({ tool: 'notebook_trash', risk: 'delete', untrusted: false, payload: { pageId: 'pg-1' }, before: { title: 'Old drafts, spring' }, target: { kind: 'page', pageId: 'pg-1', title: 'Old drafts, spring' } }), agents);
    expect(trash.title).toBe('Move “Old drafts, spring” to Trash');
    expect(trash.chip).toBe('Changes your desk');
    expect(trash.fields).toEqual([
      { label: 'Tool', value: 'Notebook · Move a page to Trash' },
      { label: 'Page', value: 'Old drafts, spring' },
    ]);
    expect(trash.note).toEqual({ icon: 'undo', text: 'You can bring it back from Notebook’s Trash.' });
    const replace = cardOf(await approval({ tool: 'files_write', risk: 'write', untrusted: false, payload: { path: 'Plans/trip.md', text: 'Hi', replace: true }, before: { sha256: 'x', bytes: 912 }, target: { kind: 'file', path: 'Plans/trip.md' } }), agents);
    expect(replace.title).toBe('Replace “Plans/trip.md” in your Files');
    expect(replace.note?.text).toBe('This can’t be undone.');
    const fresh = cardOf(await approval({ tool: 'files_write', risk: 'write', untrusted: false, payload: { path: 'a.md', text: 'Hi', replace: false } }), agents);
    expect(fresh.note).toBeNull();
  });

  it('an untrusted change says the draft ADR’s line; a memory in a tainted run its own note', async () => {
    const write = cardOf(await approval({ tool: 'files_mkdir', risk: 'write', untrusted: true, payload: { path: 'x' } }), agents);
    expect(write.untrustedLine).toBe('This agent has read web pages, files or messages in this task.');
    const mem = cardOf(await approval({ tool: 'memory_save', risk: 'own', untrusted: true, payload: { text: 'Likes warm light' } }), agents);
    expect(mem.note?.text).toBe('It asks because this task read a web page, and a page can try to plant a memory.');
    expect(mem.untrustedLine).toBeNull();
  });

  it('shows the member’s signed-in session, which the hash covers', async () => {
    const v = cardOf(await approval({ tool: 'browser_click', risk: 'send', context: 'member:example.com', payload: { tabId: 't', ref: { fp: 'a', block: 1, rev: 2 }, label: 'Buy now', role: 'button', origin: 'https://example.com' } }), agents);
    expect(v.title).toBe('Click “Buy now” (button) on example.com');
    expect(v.fields.at(-1)).toEqual({ label: 'Uses', value: 'Your signed-in session on example.com' });
  });

  it('words every launch tool the desk declares (API.md section 18, "The tools")', async () => {
    const back = cardOf(await approval({ tool: 'browser_back', payload: { tabId: 't1' }, target: { kind: 'site', origin: 'https://example.org' } }), agents);
    expect(back.title).toBe('Go back a page');
    expect(back.fields).toEqual([
      { label: 'Tool', value: 'Browser · Go back a page' },
      { label: 'Now on', value: 'https://example.org', mono: true },
    ]);
    for (const tool of ['files_list', 'files_search', 'files_read', 'files_write', 'files_mkdir', 'files_move', 'files_trash', 'browser_open', 'browser_read', 'browser_type', 'browser_back', 'browser_close', 'browser_tabs', 'browser_use_my_session', 'browser_click', 'browser_press', 'notebook_search', 'notebook_read', 'notebook_write', 'notebook_trash', 'plan_update', 'workspace_delete', 'follow_up', 'memory_save']) {
      expect(doneWord(tool), tool).not.toBe('Used a tool');
    }
  });

  it('an unknown tool: the desk’s title and every payload field as it is', async () => {
    const v = cardOf(await approval({ tool: 'image_generate', risk: 'spend', title: 'Make 4 pictures of a reading corner', payload: { count: 4, prompt: 'A corner' }, cost: { microUsd: 320_000 } }), agents);
    expect(v.title).toBe('Make 4 pictures of a reading corner');
    expect(v.fields.map((f) => f.label)).toEqual(['Tool', 'count', 'prompt']);
    expect(v.cost).toBe('$0.32');
    expect(v.note).toBeNull();
  });

  it('stamps a run the member didn’t start', async () => {
    expect(cardOf(await approval({ origin: { kind: 'agent', agentId: 'writer', name: 'Writer' } }), agents).stamp).toBe('Asked while answering Writer');
    expect(cardOf(await approval({ origin: { kind: 'timer', agentId: 'scout', timerId: 't', label: 'Morning brief' } }), agents).stamp).toBe('From the timer Morning brief');
    expect(cardOf(await approval(), agents).stamp).toBeNull();
  });

  it('shows hidden characters as their code points, so a card can’t read one way and run another', () => {
    expect(shown('pay‮txt.exe')).toBe('pay⟨U+202E⟩txt.exe');
    expect(shown('a​b')).toBe('a⟨U+200B⟩b');
    expect(shown('line one\nline two\tok')).toBe('line one\nline two\tok');
  });

  it('a non-address or one with no query has no “what it tells”', () => {
    expect(leavesOf('https://example.org/')).toBeNull();
    expect(leavesOf('not an address')).toBeNull();
  });
});

describe('the hash: the card checks what it shows', () => {
  it('matches section 18’s {v, agentId, runId, tool, context, payload}', async () => {
    expect(await approvalChecks(await approval())).toBe(true);
  });

  it('fails when anything the hash covers differs, or the payload was left out', async () => {
    const a = await approval();
    expect(await approvalChecks({ ...a, payload: { url: 'https://evil.example.net/' } })).toBe(false);
    expect(await approvalChecks({ ...a, context: 'member:example.com' })).toBe(false);
    expect(await approvalChecks({ ...a, runId: 'run-2' })).toBe(false);
    expect(await approvalChecks({ ...a, payload: null, payloadOmitted: true })).toBe(false);
    expect(await approvalChecks({ ...a, sha256: 'nope' })).toBe(false);
  });

  it('is the proposals’ shared check', async () => {
    const value = { b: 1, a: [true, null] };
    expect(await payloadChecks(value, await sha256Hex('{"a":[true,null],"b":1}'))).toBe(true);
  });
});

describe('times and states (spec 1.2 and 1.7)', () => {
  const now = new Date(2026, 10, 11, 14, 20).getTime();
  it('says when to answer by', () => {
    expect(answerByText(now + 40 * 60_000, now, 'send')).toBe('Answer within 40 min. Nothing happens until you do.');
    expect(answerByText(new Date(2026, 10, 11, 18, 5).getTime(), now, 'change')).toBe('Answer by 18:05. Nothing happens until you do.');
    expect(answerByText(new Date(2026, 10, 12, 14, 12).getTime(), now, 'send')).toBe('Answer by 14:12 tomorrow. Nothing happens until you do.');
    expect(answerByText(new Date(2026, 10, 12, 14, 12).getTime(), now, 'spend')).toBe('Answer by 14:12 tomorrow. Nothing is spent until you do.');
  });

  it('counts durations as the strip does', () => {
    expect(elapsed(42_000)).toBe('0:42');
    expect(elapsed(725_000)).toBe('12:05');
    expect(elapsed(3_840_000)).toBe('1 h 4 min');
    expect(tookWords(2000)).toBe('2 s');
    expect(tookWords(65_000)).toBe('1:05');
    expect(ARM_MS).toBe(500);
  });

  it('words every answered state', async () => {
    const at = new Date(2026, 10, 11, 14, 13).getTime();
    const hm = (): string => '14:13';
    const a = await approval();
    const v = cardOf(a, agents);
    expect(stateOf(a, v, 'Scout', now, hm)).toBeNull();
    expect(stateOf({ ...a, state: 'approved', decidedAt: at }, v, 'Scout', now, hm)).toMatchObject({ head: 'Approved by you', meta: ['14:13', 'Running'], sub: 'Opening a page on shop.example.com' });
    expect(stateOf({ ...a, state: 'done', decidedAt: at, result: { ok: true, durationMs: 2000 } }, v, 'Scout', now, hm)).toMatchObject({ meta: ['14:13', 'Done in 2 s'], sub: 'Opened a page on shop.example.com', result: 'done' });
    expect(stateOf({ ...a, state: 'failed', decidedAt: at, result: { ok: false, error: 'timeout' } }, v, 'Scout', now, hm)).toMatchObject({ meta: ['14:13', 'Didn’t finish'], result: 'failed', sub: 'The site didn’t answer in time.' });
    expect(stateOf({ ...a, state: 'declined', decidedAt: at, note: 'Not today.' }, v, 'Scout', now, hm)).toMatchObject({
      head: 'Declined by you',
      sub: 'Open a page on shop.example.com. Scout was told not to do it, or try another way, unless you ask.',
      note: 'Your note: Not today.',
    });
    expect(stateOf({ ...a, state: 'expired', detail: 'timeout' }, v, 'Scout', now, hm)).toMatchObject({ head: 'Not answered', meta: ['1 hour passed'], sub: 'Nothing was done. Scout was told no one answered.' });
    expect(stateOf({ ...a, state: 'expired', detail: 'stopped' }, v, 'Scout', now, hm)).toMatchObject({ head: 'Not needed now', sub: 'You stopped this task, so nothing was done.' });
    expect(stateOf({ ...a, state: 'interrupted', decidedAt: at }, v, 'Scout', now, hm)?.result).toBe('failed');
    // A card left open past its time says so by itself.
    expect(stateOf(a, v, 'Scout', a.expiresAt + 1, hm)?.head).toBe('Not answered');
  });

  it('words a decision the desk refused', () => {
    expect(decideErrorText({ code: 'conflict', reason: 'answered' }, 'Scout')).toBe('This was already answered. The card shows how.');
    expect(decideErrorText({ code: 'conflict', reason: 'expired' }, 'Scout')).toBe('This expired before your answer reached the desk, so nothing was done.');
    expect(decideErrorText({ code: 'bad_request', detail: 'sha256' }, 'Scout')).toBe('This card doesn’t match what Scout asked for, so it can’t be approved here. Ask Scout again.');
    expect(decideErrorText({ code: 'forbidden', reason: 'permission' }, 'Scout')).toBe('Only the desk’s owner can answer this.');
    expect(decideErrorText(null, 'Scout')).toBe('The desk couldn’t take your answer just now. Try again.');
  });
});

describe('counts and the agent’s state', () => {
  it('reads a desk’s approvalsPending as needs you', () => {
    const a = { id: 'scout', status: 'working', statusDetail: 'awaiting_approval', approvalsPending: 2 } as unknown as Agent;
    expect(withApprovals(a).status).toBe('needs_you');
    const idle = { id: 'w', status: 'online' } as unknown as Agent;
    expect(withApprovals(idle)).toBe(idle);
  });

  it('names the rail’s count', () => {
    expect(countLabel(1, 2)).toBe('1 request waiting, 2 new replies');
    expect(countLabel(3, 0)).toBe('3 requests waiting');
  });

  it('says how often the task has sent something out already', () => {
    expect(egressText(1)).toBe('This task has already sent something outside your desk once.');
    expect(egressText(3)).toBe('This task has already sent something outside your desk 3 times.');
  });

  it('keeps the words the agent is told', () => {
    expect(TOLD.declined('open a page on shop.example.com')).toBe("The member declined this: open a page on shop.example.com. Don't do it, and don't try another way to get the same result, unless they ask you to.");
    expect(TOLD.note('Keep them')).toBe('Their note: "Keep them"');
  });
});
