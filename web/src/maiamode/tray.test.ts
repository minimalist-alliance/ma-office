// The decision tray as the office reads and draws it (deskd API.md §23 "The tray"): papers read leniently, one primary at most and
// never on a send, the confirm strip's exact words from the payload, the time chip, her line labelled as hers, filed lines, her
// chat's `[paper:…]` tokens, the stack in the catch-up, and members never reading "paper", "tray" or "Maia Mode".
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readReach } from './reach';
import { boxWords, chipWords, confirmWords, fillName, filedWords, lineLabel, paperTokens, readPaper, readTray, readTrayGet, riskWords, tallyWords, type Paper } from './tray';

const pp = (c: string): string => `pp-${c.repeat(20)}`;

const send = {
  paperId: pp('b'),
  itemId: 'mi-approval',
  kind: 'approval',
  asker: { kind: 'agent', deskId: 'd-work', agentId: 'ag-writer', label: 'Work · Writer', name: 'Writer' },
  title: 'Writer needs your OK',
  line: { text: 'Same as v2 except pricing on page 2.', by: 'maia', from: 'm-doc' },
  answers: [
    { id: 'approve', label: 'Approve…', does: 'approve', confirm: { verb: 'send' } },
    { id: 'revise', label: 'Ask for changes', does: 'revise' },
    { id: 'decline', label: 'Decline', does: 'decline' },
  ],
  pick: null,
  freeform: { to: 'Writer', max: 500, as: 'note' },
  later: { allowed: true, until: 2, kind: 'catchup' },
  dismissable: false,
  materials: [{ materialId: 'm-doc', kind: 'doc', deskId: 'd-work', ref: { docId: 'd_01x' }, label: 'Proposal v3' }],
  reply: { kind: 'approval', deskId: 'd-work', approvalId: 'ap-aaaaaaaaaaaaaaaaaaaa', agentId: 'ag-writer' },
  dueAt: null,
  expiresAt: Date.UTC(2026, 10, 16, 23, 10),
  untrusted: true,
  risk: 'send',
  state: 'open',
  laterCount: 0,
  at: 1,
};
const report = {
  ...send,
  paperId: pp('a'),
  kind: 'report',
  asker: { kind: 'agent', deskId: 'd-work', label: 'Work · Scout', name: 'Scout' },
  title: 'Pick a laptop for Dana’s team',
  line: { text: 'Three fit the budget.', by: 'agent', from: 'm-writeup' },
  answers: [
    { id: 'a1', label: 'X1 Carbon', does: 'custom', value: 'X1 Carbon' },
    { id: 'a2', label: 'MacBook Air', does: 'custom', value: 'MacBook Air' },
  ],
  pick: 0,
  freeform: { to: 'Scout', max: 2000, as: 'message' },
  materials: [{ materialId: 'm-writeup', kind: 'writeup', deskId: 'd-work', ref: { writeupId: 'wu-aaaaaaaaaaaaaaaaaaaa' }, label: 'Scout’s write-up' }],
  reply: { kind: 'maia_brief', deskId: 'd-work', messageId: 'msg-1' },
  risk: null,
  dueAt: Date.UTC(2026, 10, 20, 17),
  expiresAt: null,
};

describe('reading papers', () => {
  it('reads a paper, and drops anything out of shape', () => {
    const p = readPaper(send)!;
    expect(p.kind).toBe('approval');
    expect(p.answers.map((a) => a.label)).toEqual(['Approve…', 'Ask for changes', 'Decline']);
    expect(p.answers[0]!.confirm).toBe('send');
    expect(p.pick).toBeNull();
    expect(p.reply).toEqual({ kind: 'approval', deskId: 'd-work', approvalId: 'ap-aaaaaaaaaaaaaaaaaaaa', agentId: 'ag-writer' });
    expect(readPaper({ ...send, paperId: 'pp-x' })).toBeNull();
    expect(readPaper({ ...send, kind: 'wire' })).toBeNull();
    expect(readPaper({ ...send, answers: [{ id: 'X', label: 'Approve', does: 'approve' }] })).toBeNull();
    // An answer with a does it doesn't know is dropped; a confirm verb it doesn't know is no confirm.
    const odd = readPaper({ ...send, answers: [...send.answers, { id: 'batch', label: 'Approve all', does: 'approve_all' }], pick: 9 })!;
    expect(odd.answers.map((a) => a.id)).toEqual(['approve', 'revise', 'decline']);
    expect(odd.pick).toBeNull();
    // A material ref with a URL in it is dropped.
    expect(readPaper({ ...send, materials: [{ materialId: 'm', kind: 'doc', deskId: 'd-work', ref: { docId: 'https://evil.example/x' }, label: 'x' }] })!.materials[0]!.ref).toEqual({});
  });

  it('reads the tray in the room’s reach, and tray.get’s waiting answers', () => {
    const r = readReach({ on: true, line: { kind: 'held', text: '6 held', held: 6 }, held: { count: 6, now: 0 }, tray: { count: 3, now: 2, later: 1, papers: [report, send], filed: [{ paperId: pp('c'), kind: 'approval', label: 'X1 Carbon', to: 'Scout', state: 'sent', at: 5 }] } })!;
    expect(r.tray!.papers.map((p) => p.paperId)).toEqual([pp('a'), pp('b')]);
    expect(r.tray!.count).toBe(3);
    expect(r.tray!.filed[0]!.label).toBe('X1 Carbon');
    expect(readReach({ on: true, line: {}, held: {} })!.tray).toBeNull();
    const got = readTrayGet({ papers: [send], out: [{ outId: 'po-aaaaaaaaaaaaaaaaaaaa', paperId: pp('b'), deskId: 'd-work', replyKind: 'approval', answerId: 'approve', does: 'approve', text: null, at: 1, expiresAt: null, reply: { kind: 'approval', deskId: 'd-work', approvalId: 'ap-aaaaaaaaaaaaaaaaaaaa', extra: 7 }, sha256: 'ab'.repeat(32) }, { outId: 'po-bbbbbbbbbbbbbbbbbbbb', paperId: pp('b'), deskId: 'd-work', replyKind: 'approval', answerId: 'revise', does: 'revise', text: 'Keep the intro.', at: 1, expiresAt: null, sha256: 'not a hash' }, { outId: 'bad' }] });
    expect(got.out).toHaveLength(2);
    // A queued answer carries its own ids and the hash the member approved; nothing else of the row's.
    expect(got.out[0]!.reply).toEqual({ kind: 'approval', deskId: 'd-work', approvalId: 'ap-aaaaaaaaaaaaaaaaaaaa' });
    expect(got.out[0]!.sha256).toBe('ab'.repeat(32));
    expect(got.out[1]!.text).toBe('Keep the intro.');
    expect(got.out[1]!.sha256).toBeNull();
    expect(got.out[1]!.reply).toEqual({ kind: 'approval', deskId: 'd-work' });
    expect(readTray({ papers: 'x' })!.papers).toEqual([]);
  });
});

describe('the words', () => {
  it('says the time as a chip, never an alarm', () => {
    const now = Date.UTC(2026, 10, 16, 20);
    expect(chipWords({ expiresAt: Date.UTC(2026, 10, 16, 23, 10), dueAt: null }, now, 'en-US', 'UTC')).toBe('Expires 11:10');
    expect(chipWords({ expiresAt: null, dueAt: Date.UTC(2026, 10, 20, 17) }, now, 'en-US', 'UTC')).toBe('Due Fri');
    expect(chipWords({ expiresAt: null, dueAt: Date.UTC(2026, 10, 17, 9) }, now, 'en-US', 'UTC')).toBe('Due tomorrow');
    expect(chipWords({ expiresAt: null, dueAt: null }, now)).toBeNull();
  });

  it('labels her line as hers and an agent’s as the agent’s; code’s has no label', () => {
    const p = readPaper(send)!;
    expect(lineLabel(p, null)).toBe('Maia’s summary');
    expect(lineLabel(readPaper(report)!, null)).toBe('Scout’s summary');
    expect(lineLabel(readPaper({ ...send, line: { text: 'x', by: 'code' } })!, null)).toBeNull();
    expect(riskWords('send')?.text).toBe('Sends outside your desk');
    expect(riskWords('write')).toBeNull();
  });

  it('addresses the box to whoever asked, and fills {who} only at draw time', () => {
    expect(boxWords(readPaper(send)!, null)).toBe('Note for Writer…');
    expect(boxWords(readPaper({ ...report, freeform: { to: '{who}', max: 2000, as: 'reply' } })!, 'Rosa')).toBe('Reply to Rosa…');
    expect(boxWords(readPaper({ ...report, freeform: { to: null, max: 0, as: 'none' } })!, null)).toBeNull();
    expect(fillName('{who} is waiting on your reply', null)).toBe('Someone is waiting on your reply');
  });

  it('says exactly what goes where in the confirm strip, from the payload', () => {
    expect(confirmWords('send', { tool: 'browser_click', payload: { origin: 'https://mail.acme.com', label: 'Send' }, target: {} }, 'Work')).toEqual({ title: 'Send to mail.acme.com from your Work desk?', foot: 'Once it’s sent, it can’t be called back.', button: 'Send it' });
    expect(confirmWords('pay', { tool: 'browser_click', payload: { origin: 'https://acme.com' }, target: {} }, 'Work').button).toBe('Pay');
    expect(confirmWords('delete', { tool: 'files_trash', payload: { path: 'Q3 plan (old).md' }, target: {} }, 'Work').title).toBe('Delete “Q3 plan (old).md” for good?');
    expect(confirmWords('send', null, 'Work').title).toBe('Send this from your Work desk?');
    // A move to a Trash says how to get it back, never "for good".
    expect(confirmWords('delete', { tool: 'files_trash', payload: { path: 'Old.md' }, target: {}, undo: 'You can bring it back from the Trash in Files.' }, 'Work')).toEqual({ title: 'Move “Old.md” to the Trash?', foot: 'You can bring it back from the Trash in Files.', button: 'Move to Trash' });
    expect(riskWords('delete', true)!.text).toBe('Moves it to the Trash');
    expect(riskWords('delete', false)!.text).toBe('Deletes for good');
    expect(riskWords('delete')!.text).toBe('Deletes');
    // A kind of action the desk didn't name still asks once more (TRAY-L3).
    expect(confirmWords('approve', null, 'Work')).toEqual({ title: 'Let it go ahead on your Work desk?', foot: 'Check what it does before you confirm.', button: 'Approve' });
  });

  it('files an answer as one line, and tallies the group', () => {
    expect(filedWords({ paperId: pp('a'), kind: 'report', label: 'X1 Carbon', to: 'Scout', who: null, state: 'sent', at: 1 }, null)).toEqual({ lead: 'X1 Carbon', rest: 'sent to Scout' });
    expect(filedWords({ paperId: pp('a'), kind: 'approval', label: 'Ask for changes', to: 'Writer', who: null, state: 'sent', at: 1 }, null)).toEqual({ lead: 'Sent back', rest: 'to Writer with your note' });
    expect(filedWords({ paperId: pp('a'), kind: 'approval', label: 'Approve…', to: 'Writer', who: null, state: 'queued', at: 1 }, null).rest).toBe('goes to Writer when that desk wakes');
    expect(filedWords({ paperId: pp('a'), kind: 'approval', label: null, to: null, who: null, state: 'withdrawn', at: 1 }, null).lead).toBe('Answered elsewhere');
    expect(tallyWords(2, 1)).toBe('2 answered · 1 for later');
  });

  it('takes papers out of her chat words, only real paper ids, at most five', () => {
    expect(paperTokens(`Three things need you. [paper:${pp('a')}] [paper:${pp('b')}]`)).toEqual({ text: 'Three things need you.', ids: [pp('a'), pp('b')] });
    expect(paperTokens('[paper:pp-NOTREAL] hello')).toEqual({ text: '[paper:pp-NOTREAL] hello', ids: [] });
  });
});

vi.mock('./shield/actions', () => ({ nameOf: () => Promise.resolve(null), runGo: () => undefined, openApp: () => undefined, answerItem: () => Promise.resolve(), answerCatchup: () => Promise.resolve(), answerQuestion: () => Promise.resolve(), answerCard: () => Promise.resolve(), quoteOf: () => Promise.resolve(null) }));
vi.mock('./focusSource', () => ({ useReach: (f: (s: { reach: null }) => unknown) => f({ reach: null }), reachCall: () => Promise.resolve({}) }));
// Quick reply reads the live desks (the browser's); none here.
vi.mock('./shield/quickReply', () => ({ HOLD_MS: 5000, canOffer: () => false, openLink: () => null, MEDIUM_WORDS: { email: 'By email', ma: 'MA message', imessage: 'iMessage', sms: 'Text message' }, replyContext: () => Promise.resolve(null), replyContextCached: () => Promise.resolve({ quote: null, medium: null, accountId: null, replyTo: null, subject: null, to: [], canSend: false }), forgetReplies: () => undefined, sendReply: () => Promise.resolve(), holdSend: () => ({ undo: () => true, done: new Promise(() => undefined) }) }));
vi.mock('./shield/Materials', () => ({ Materials: () => null }));
vi.mock('./shield/trayActions', () => ({ answerPaper: () => Promise.resolve({ delivered: 'sent' }), laterPaper: () => Promise.resolve(), approvalOf: () => Promise.resolve(null) }));
const { Paper: PaperView } = await import('./shield/Paper');
const { Stack } = await import('./shield/Tray');

const draw = (p: Paper): string => renderToStaticMarkup(createElement(PaperView, { paper: p, open: null, onMaterial: () => undefined, onAnswered: () => undefined, onLater: () => undefined, onOpenAsker: () => undefined }));
const pills = (markup: string): { cls: string; text: string }[] => Array.from(markup.matchAll(/<button[^>]*class="sh-btn ([a-z ]+)"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g), (m) => ({ cls: m[1]!, text: m[2]! }));

describe('a paper', () => {
  it('draws the source, the time chip, the risk, her line in its inset, the materials, the answers, the box and Later', () => {
    const markup = draw(readPaper(send)!);
    expect(markup).toContain('sh-etch">Work<');
    expect(markup).toContain('Expires ');
    expect(markup).toContain('Sends outside your desk');
    expect(markup).toContain('Writer read web pages before asking');
    expect(markup).toContain('Maia’s summary');
    expect(markup).toContain('Proposal v3');
    expect(markup).toContain('placeholder="Note for Writer…"');
    // A send has no primary on its first tap; Decline is quiet. Approve waits for the asking desk's payload and its hash check
    // (TRAY-M1): until then, Ask for changes, Decline and Later only.
    const ps = pills(markup);
    expect(ps.find((x) => x.text === 'Approve…')).toBeUndefined();
    expect(ps.find((x) => x.text === 'Ask for changes')!.cls).toBe('soft');
    expect(ps.find((x) => x.text === 'Decline')!.cls).toBe('quiet');
    expect(ps.some((x) => x.cls === 'primary')).toBe(false);
    expect(markup).toMatch(/>Later</);
  });

  it('marks her pick as the one primary', () => {
    const ps = pills(draw(readPaper(report)!));
    expect(ps.filter((x) => x.cls === 'primary').map((x) => x.text)).toEqual(['X1 Carbon']);
  });

  it('hides the words while someone can see the screen', () => {
    const markup = renderToStaticMarkup(createElement(PaperView, { paper: readPaper(send)!, hidden: true, open: null, onMaterial: () => undefined, onAnswered: () => undefined, onLater: () => undefined, onOpenAsker: () => undefined }));
    expect(markup).toContain('Something from Writer');
    expect(markup).not.toContain('Same as v2');
  });

  it('never says paper, tray, Maia Mode, urgent or an exclamation', () => {
    for (const p of [send, report]) {
      const text = draw(readPaper(p)!).replace(/<[^>]+>/g, ' ');
      expect(text).not.toMatch(/\bpaper\b|\btray\b|Maia Mode|urgent|!/i);
    }
  });
});

describe('the stack', () => {
  it('shows Needs you with "1 of 2", the top paper and its sheet edge, and the filed lines', () => {
    const tray = readTray({ count: 2, papers: [report, send], filed: [{ paperId: pp('c'), kind: 'report', label: 'X1 Carbon', to: 'Scout', state: 'sent', at: 5 }] })!;
    const markup = renderToStaticMarkup(createElement(Stack, { tray }));
    expect(markup).toContain('Needs you');
    expect(markup).toContain('1 of 2');
    expect(markup).toContain('data-under="1"');
    expect(markup).toContain('Pick a laptop for Dana’s team');
    expect(markup).not.toContain('Writer needs your OK');
    expect(markup).toContain('sent to Scout');
  });
});
