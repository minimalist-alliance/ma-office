import { describe, expect, it } from 'vitest';
import { AgentError } from '../client/agentClient';
import type { AgentAccess, Approval, AutoDone, Message } from '../client/types';
import {
  ALL_UNDONE,
  autoLineOf,
  autoRowsOf,
  autoWord,
  chipStateWord,
  countsAsDone,
  dontAskDone,
  dontAskOf,
  isAuto,
  joinWords,
  mayOfferDontAsk,
  mayUndo,
  parentFolder,
  rowStateOf,
  tabLabel,
  undoActivity,
  undoAllText,
  undoName,
  undoOrder,
  undoOutcomeOf,
  undoSentence,
  type LocalUndo,
} from './auto';
import { runSummaryOf, runSummaryParts } from './runSummary';

const row = (over: Partial<AutoDone> & Pick<AutoDone, 'approvalId'>): AutoDone => ({ tool: 'files_write', target: { kind: 'file', path: 'Research/a.md' }, group: 'files', state: 'done', undoneAt: null, ...over });

const approval = (over: Partial<Approval>): Approval =>
  ({
    id: 'ap-1',
    agentId: 'scout',
    runId: 'r1',
    messageId: 'm1',
    tool: 'files_write',
    risk: 'write',
    title: 'Save “Research/a.md” in your Files',
    context: 'agent',
    target: { kind: 'file', path: 'Research/a.md' },
    payload: { path: 'Research/a.md', text: 'x', replace: false },
    before: null,
    sha256: '0'.repeat(64),
    untrusted: false,
    origin: { kind: 'member' },
    state: 'pending',
    detail: null,
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    decidedAt: null,
    decidedBy: null,
    note: null,
    result: null,
    ...over,
  }) as Approval;

const access = (over: Partial<AgentAccess> = {}): AgentAccess => ({
  chosen: true,
  setup: null,
  apps: { notebook: true, files: true, browser: true, courier: false, todos: true },
  auto: { notebook: null, files: null, todos: false },
  desks: [],
  incoming: [],
  updatedAt: 1,
  ...over,
});

const TABS = [
  { id: 'tab-ideas', title: 'Ideas' },
  { id: 'tab-blank', title: '  ' },
];
const tabName = (id: string): string | null => TABS.find((t) => t.id === id)?.title ?? null;
const none: Readonly<Record<string, LocalUndo>> = {};

describe('a row done without asking', () => {
  it('is never a card: decidedBy auto', () => {
    expect(isAuto({ decidedBy: 'auto' })).toBe(true);
    expect(isAuto({ decidedBy: 'owner' })).toBe(false);
    expect(isAuto({ decidedBy: null })).toBe(false);
  });

  it('says what it did, by tool and, for the Notebook, by op', () => {
    expect(autoWord({ tool: 'files_write', target: null })).toBe('Saved a file');
    expect(autoWord({ tool: 'files_mkdir', target: null })).toBe('Made a folder');
    expect(autoWord({ tool: 'notebook_write', target: { kind: 'page', pageId: null, title: 'New' } })).toBe('Made a page');
    expect(autoWord({ tool: 'notebook_write', target: { kind: 'page', pageId: 'p1', title: 'Old' } })).toBe('Added to a page');
    // The payload's op wins over the target's guess.
    expect(autoWord({ tool: 'notebook_write', target: { kind: 'page', pageId: 'p1', title: 'Old' } }, { payload: { op: 'create' } })).toBe('Made a page');
    expect(autoWord({ tool: 'todo_create', target: null })).toBe('Added a to-do');
  });

  it('stands where its row, its approval and its undo here say', () => {
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, null)).toBe('undoable');
    expect(rowStateOf({ state: 'approved', undoneAt: null }, null, null)).toBe('running');
    // The approval's event is newer than the reply's copy.
    expect(rowStateOf({ state: 'approved', undoneAt: null }, { state: 'done', undoneAt: null }, null)).toBe('undoable');
    expect(rowStateOf({ state: 'failed', undoneAt: null }, null, null)).toBe('not_done');
    expect(rowStateOf({ state: 'done', undoneAt: 5 }, null, null)).toBe('undone');
    expect(rowStateOf({ state: 'done', undoneAt: null }, { state: 'done', undoneAt: 5 }, null)).toBe('undone');
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'working' })).toBe('working');
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'undone' } })).toBe('undone');
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'already' } })).toBe('undone');
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'changed' } })).toBe('kept');
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'failed' } })).toBe('retry');
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'not_done' } })).toBe('not_done');
    // A newer agent edit to the page goes first: this one can still be undone after it.
    expect(rowStateOf({ state: 'done', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'newer' } })).toBe('undoable');
    expect(countsAsDone('kept')).toBe(true);
    expect(countsAsDone('undone')).toBe(false);
    // Cut off by a restart: deskd may have finished it. Undo is offered, and it isn't counted as done (Security's AAB-I2).
    expect(rowStateOf({ state: 'interrupted', undoneAt: null }, null, null)).toBe('maybe');
    expect(rowStateOf({ state: 'approved', undoneAt: null }, { state: 'interrupted', undoneAt: null }, null)).toBe('maybe');
    expect(rowStateOf({ state: 'interrupted', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'not_done' } })).toBe('not_done');
    expect(rowStateOf({ state: 'interrupted', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'undone' } })).toBe('undone');
    // Cut off with no end recorded: it may have happened and can't be taken back here; it stays (AAB-I6).
    expect(rowStateOf({ state: 'interrupted', undoneAt: null }, null, { kind: 'answered', result: { outcome: 'unknown' } })).toBe('kept');
    expect(undoSentence({ tool: 'files_write', target: null }, { outcome: 'unknown' })).toBe('It may have happened, and it can’t be undone from here. If it did, it’s still there.');
    expect(mayUndo('maybe')).toBe(true);
    expect(countsAsDone('maybe')).toBe(false);
  });

  it('comes from the reply’s auto, else from its chips that carry their approval id', () => {
    const auto = [row({ approvalId: 'ap-1' })];
    expect(autoRowsOf({ auto, tools: [] })).toBe(auto);
    const m: Pick<Message, 'auto' | 'tools'> = {
      tools: [
        { name: 'files_mkdir', summary: 'Made a folder', ok: true, auto: 'files', approval: { id: 'ap-9', decision: 'auto' }, target: { kind: 'file', path: 'Research/x' } },
        { name: 'files_write', summary: 'Saved a file', ok: true, auto: 'files' }, // no id: no Undo, no row
        { name: 'files_write', summary: 'Saved a file', ok: true, approval: { id: 'ap-2', decision: 'approved' } },
      ],
    };
    expect(autoRowsOf(m)).toEqual([{ approvalId: 'ap-9', tool: 'files_mkdir', target: { kind: 'file', path: 'Research/x' }, group: 'files', state: 'done', undoneAt: null }]);
  });
});

describe('the line under a reply: "Did 3 things without asking: …"', () => {
  it('reads the API’s own example: 2 notes and a file in Research', () => {
    const rows = [
      row({ approvalId: 'n1', tool: 'notebook_write', group: 'notebook', target: { kind: 'page', pageId: 'p1', title: 'Lamps' } }),
      row({ approvalId: 'f1' }),
      row({ approvalId: 'n2', tool: 'notebook_write', group: 'notebook', target: { kind: 'page', pageId: 'p2', title: 'Desks' } }),
    ];
    const approvals = new Map([['f1', approval({ id: 'f1', decidedBy: 'auto', state: 'done', auto: { group: 'files', folder: 'Research' } })]]);
    const v = autoLineOf(rows, approvals, none, () => null);
    expect(v.text).toBe('Did 3 things without asking: 2 notes and a file in Research');
    expect(v.done).toBe(3);
    expect(v.undoable).toEqual(['n1', 'f1', 'n2']);
    // Undo all takes them back the newest first, as a page's own undo goes (the test desk, Nov 13).
    expect(undoOrder(rows).map((r) => r.approvalId)).toEqual(['n2', 'f1', 'n1']);
    expect(rows.map((r) => r.approvalId)).toEqual(['n1', 'f1', 'n2']);
  });

  it('counts only what was done and is still there, and names a tab only by a name the app knows', () => {
    const approvals = new Map([
      ['a', approval({ id: 'a', tool: 'notebook_write', decidedBy: 'auto', state: 'done', payload: { op: 'create' }, auto: { group: 'notebook', tabId: 'tab-ideas' } })],
      ['b', approval({ id: 'b', tool: 'notebook_write', decidedBy: 'auto', state: 'done', payload: { op: 'append' }, auto: { group: 'notebook', tabId: 'tab-ideas' } })],
      ['c', approval({ id: 'c', tool: 'notebook_write', decidedBy: 'auto', state: 'done', payload: { op: 'append' }, auto: { group: 'notebook', tabId: 'tab-ideas' } })],
    ]);
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row({ approvalId: id, tool: 'notebook_write', group: 'notebook', target: { kind: 'page', pageId: 'p', title: 'T' } }));
    rows[3] = { ...rows[3]!, state: 'failed' };
    rows[4] = { ...rows[4]!, undoneAt: 7 };
    const v = autoLineOf(rows.slice(0, 4), approvals, none, tabName);
    expect(v.text).toBe('Did 3 things without asking: a new page and 2 notes in Ideas');
    // A tab the app can't name isn't named; an id never shows.
    expect(autoLineOf(rows.slice(0, 3), approvals, none, () => null).text).toBe('Did 3 things without asking: a new page and 2 notes');
    // An undone row and one undone here leave the count, and the place stays for the rest.
    const w = autoLineOf(rows, approvals, { a: { kind: 'answered', result: { outcome: 'undone' } } }, tabName);
    expect(w.text).toBe('Did 2 things without asking: 2 notes in Ideas');
    expect(w.undoable).toEqual(['b', 'c']);
  });

  it('names no place when a group’s rows differ, and keeps groups in the order the run touched them', () => {
    const approvals = new Map([
      ['f1', approval({ id: 'f1', decidedBy: 'auto', state: 'done', auto: { group: 'files', folder: 'Research' } })],
      ['f2', approval({ id: 'f2', decidedBy: 'auto', state: 'done', auto: { group: 'files', folder: 'Trips' } })],
    ]);
    const rows = [row({ approvalId: 't1', tool: 'todo_create', group: 'todos', target: null }), row({ approvalId: 'f1' }), row({ approvalId: 'f2', tool: 'files_mkdir' }), row({ approvalId: 't2', tool: 'todo_create', group: 'todos', target: null })];
    expect(autoLineOf(rows, approvals, none, tabName).text).toBe('Did 4 things without asking: 2 to-dos and a file and a folder');
    expect(autoLineOf([row({ approvalId: 'f1' })], approvals, none, tabName).text).toBe('Did 1 thing without asking: a file in Research');
  });

  it('says when everything was undone, and has no line for a run where nothing it did stands', () => {
    expect(autoLineOf([row({ approvalId: 'a', undoneAt: 3 })], new Map(), none, tabName).text).toBe(ALL_UNDONE);
    expect(autoLineOf([row({ approvalId: 'a', state: 'failed' })], new Map(), none, tabName).text).toBeNull();
  });

  it('says what a restart cut off may have been done, with Undo, and doesn’t count it (Security’s AAB-I2)', () => {
    const one = autoLineOf([row({ approvalId: 'a', state: 'interrupted' })], new Map(), none, tabName);
    expect(one.text).toBe('One thing may have been done without asking');
    expect(one.done).toBe(0);
    expect(one.undoable).toEqual(['a']);
    const mixed = autoLineOf([row({ approvalId: 'a' }), row({ approvalId: 'b', state: 'interrupted' }), row({ approvalId: 'c', state: 'interrupted' })], new Map(), none, tabName);
    expect(mixed.text).toBe('Did 1 thing without asking: a file. 2 more may have been done');
    expect(mixed.undoable).toEqual(['a', 'b', 'c']);
  });

  it('shows hidden characters in a folder’s name', () => {
    const approvals = new Map([['f1', approval({ id: 'f1', decidedBy: 'auto', state: 'done', auto: { group: 'files', folder: 'Re‮search' } })]]);
    expect(autoLineOf([row({ approvalId: 'f1' })], approvals, none, tabName).text).toBe('Did 1 thing without asking: a file in Re⟨U+202E⟩search');
  });

  it('joins words as a sentence', () => {
    expect(joinWords([])).toBe('');
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a and b');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('leaves “done without asking” out of the run summary when the line says it', () => {
    const m: Message = {
      id: 'm1',
      role: 'assistant',
      text: 'Done.',
      at: 1,
      state: 'done',
      tools: [{ name: 'files_write', summary: 'Saved a file', ok: true, risk: 'write', auto: 'files', approval: { id: 'f1', decision: 'auto' } }],
      auto: [row({ approvalId: 'f1' })],
    };
    const auto = approval({ id: 'f1', decidedBy: 'auto', state: 'done' });
    expect(runSummaryParts(runSummaryOf(m, [auto])!)).toEqual(['1 tool']);
    // An auto row is never counted as a card the member approved, chip or no chip.
    expect(runSummaryParts(runSummaryOf({ ...m, tools: [{ name: 'files_read', summary: 'Read', ok: true, risk: 'read' }], auto: null }, [auto])!)).toEqual(['1 tool']);
  });
});

describe('an undo in Activity', () => {
  it('says why one was refused, in fixed words', () => {
    expect(undoActivity('refused:newer', 'Added to a page').why).toBe('An agent had changed the page again since');
    expect(undoActivity('refused:unknown', 'Saved a file').why).toBe('It may have happened, and couldn’t be undone from here');
    expect(undoActivity('refused:<b>', 'Saved a file').why).toBe('Not undone');
  });
});

describe('what an undo answered', () => {
  it('reads each refusal of agent.approval.undo', () => {
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'changed', versionId: 'v1' }))).toEqual({ outcome: 'changed', versionId: 'v1' });
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'changed' }))).toEqual({ outcome: 'changed', versionId: null });
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'undone' }))).toEqual({ outcome: 'already' });
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'not_done' }))).toEqual({ outcome: 'not_done' });
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'trashed' }))).toEqual({ outcome: 'trashed' });
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'newer' }))).toEqual({ outcome: 'newer' });
    expect(undoOutcomeOf(new AgentError('conflict', { reason: 'unknown' }))).toEqual({ outcome: 'unknown' });
    expect(undoOutcomeOf(new AgentError('not_found', { detail: 'approval' }))).toEqual({ outcome: 'gone' });
    expect(undoOutcomeOf(new AgentError('forbidden', {}))).toEqual({ outcome: 'forbidden' });
    expect(undoOutcomeOf(new AgentError('unavailable', {}))).toEqual({ outcome: 'failed' });
    expect(undoOutcomeOf(new Error('lost'))).toEqual({ outcome: 'failed' });
  });

  it('says it in plain words, by what was undone', () => {
    const file = { tool: 'files_write', target: null };
    const page = { tool: 'notebook_write', target: { kind: 'page' as const, pageId: null, title: 'New' } };
    const note = { tool: 'notebook_write', target: { kind: 'page' as const, pageId: 'p', title: 'Old' } };
    expect(undoSentence(file, { outcome: 'undone' })).toBe('Undone. The file is in the Trash in Files.');
    expect(undoSentence({ tool: 'files_mkdir', target: null }, { outcome: 'undone' })).toBe('Undone. The folder is in the Trash in Files.');
    expect(undoSentence(page, { outcome: 'undone' })).toBe('Undone. The page is in Notebook’s Trash.');
    expect(undoSentence(note, { outcome: 'undone' })).toBe('Undone. What it added is gone from the page.');
    expect(undoSentence(file, { outcome: 'changed' })).toBe('It’s been changed since, so it stays.');
    expect(undoSentence(note, { outcome: 'changed', versionId: 'v1' })).toBe('It’s been changed since, so it stays. The page as it was before is in its History.');
    expect(undoSentence(file, { outcome: 'already' })).toBe('This was undone already.');
    expect(undoSentence(file, { outcome: 'not_done' })).toBe('It didn’t happen, so there’s nothing to undo.');
    expect(undoSentence(page, { outcome: 'trashed' })).toBe('The page is in Notebook’s Trash already.');
    expect(undoSentence(note, { outcome: 'newer' })).toBe('An agent changed this page again since. Undo the later change first.');
    expect(undoSentence(file, { outcome: 'gone' })).toBe('This can’t be undone any more.');
    expect(undoSentence(file, { outcome: 'forbidden' })).toBe('Only the desk’s owner can undo this.');
    expect(undoSentence(file, { outcome: 'failed' })).toBe('Couldn’t undo it just now. Try again.');
    expect(chipStateWord('undone')).toBe('Undone');
    expect(chipStateWord('kept')).toBe('Kept');
    expect(chipStateWord('retry')).toBe('Couldn’t undo');
    expect(chipStateWord('undoable')).toBeNull();
    expect(undoName({ word: 'Saved a file', target: 'Research/a.md' })).toBe('Undo: Saved a file, Research/a.md');
  });

  it('reports Undo all: everything, one kept with why, or several kept', () => {
    const v = (t: string) => ({ word: 'Saved a file', target: t });
    expect(undoAllText([{ view: v('a'), ok: true, sentence: '' }])).toBe('Undone.');
    expect(undoAllText([1, 2, 3].map((i) => ({ view: v(String(i)), ok: true, sentence: '' })))).toBe('Undid all 3.');
    expect(undoAllText([{ view: v('a'), ok: true, sentence: '' }, { view: v('Research/b.md'), ok: false, sentence: 'It’s been changed since, so it stays.' }, { view: v('c'), ok: true, sentence: '' }])).toBe(
      'Undid 2 of 3. Research/b.md: It’s been changed since, so it stays.',
    );
    expect(undoAllText([{ view: v('a'), ok: false, sentence: 'x' }, { view: v('b'), ok: false, sentence: 'y' }, { view: v('c'), ok: true, sentence: '' }])).toBe('Undid 1 of 3. 2 couldn’t be undone, and each says why below.');
  });
});

describe('“Don’t ask again” on a card (API.md section 18)', () => {
  it('offers a file’s folder, by name, and sends only that switch', () => {
    const d = dontAskOf(approval({}), access(), TABS)!;
    expect(d.words).toBe('Save new files in Research without asking');
    expect(d.change).toEqual({ auto: { files: { folder: 'Research' } } });
    expect(dontAskDone('Scout', d)).toBe('Approved. Scout now saves new files in Research without asking.');
    const deep = dontAskOf(approval({ payload: { path: 'Research/2026/lamps.md', text: 'x', replace: false } }), access(), TABS)!;
    expect(deep.change).toEqual({ auto: { files: { folder: 'Research/2026' } } });
    const mkdir = dontAskOf(approval({ tool: 'files_mkdir', payload: { path: 'Research/Lamps' } }), access(), TABS)!;
    expect(mkdir.change).toEqual({ auto: { files: { folder: 'Research' } } });
  });

  it('offers a Notebook tab by its title: the new page’s for create, the page’s for append', () => {
    const create = approval({ tool: 'notebook_write', payload: { op: 'create', new: { tabId: 'tab-ideas', title: 'Lamps' }, markdown: 'x' }, target: { kind: 'page', pageId: null, title: 'Lamps' } });
    const d = dontAskOf(create, access(), TABS)!;
    expect(d.words).toBe('Add pages and notes in Ideas without asking');
    expect(d.change).toEqual({ auto: { notebook: { tabId: 'tab-ideas' } } });
    expect(dontAskDone('Scout', d)).toBe('Approved. Scout now adds pages and notes in Ideas without asking.');
    const append = approval({ tool: 'notebook_write', payload: { op: 'append', pageId: 'p1', markdown: 'x' }, target: { kind: 'page', pageId: 'p1', title: 'Lamps', tabId: 'tab-ideas' } });
    expect(dontAskOf(append, access(), TABS)?.change).toEqual({ auto: { notebook: { tabId: 'tab-ideas' } } });
    // No name for the tab, or none known: no offer, never an id.
    expect(dontAskOf({ ...create, payload: { op: 'create', new: { tabId: 'tab-blank' }, markdown: 'x' } }, access(), TABS)).toBeNull();
    expect(dontAskOf(create, access(), null)).toBeNull();
    expect(dontAskOf({ ...append, target: { kind: 'page', pageId: 'p1', title: 'Lamps' } }, access(), TABS)).toBeNull();
  });

  it('names a tab’s notebook too when another tab has the same title (Security’s AAB-I3)', () => {
    const tabs = [
      { id: 'tab-in-home', title: 'Inbox', notebook: 'Home' },
      { id: 'tab-in-work', title: ' inbox ', notebook: 'Work' },
      { id: 'tab-ideas', title: 'Ideas', notebook: 'Work' },
      { id: 'tab-in-old', title: 'Inbox' },
    ];
    expect(tabLabel(tabs, 'tab-in-work')).toBe('Work › inbox');
    expect(tabLabel(tabs, 'tab-in-home')).toBe('Home › Inbox');
    expect(tabLabel(tabs, 'tab-ideas')).toBe('Ideas');
    expect(tabLabel(tabs, 'tab-in-old')).toBe('Inbox'); // no notebook known: the title alone
    expect(tabLabel(tabs, 'tab-none')).toBeNull();
    const create = approval({ tool: 'notebook_write', payload: { op: 'create', new: { tabId: 'tab-in-work', title: 'Lamps' }, markdown: 'x' }, target: { kind: 'page', pageId: null, title: 'Lamps' } });
    const d = dontAskOf(create, access(), tabs)!;
    expect(d.words).toBe('Add pages and notes in Work › inbox without asking');
    expect(d.change).toEqual({ auto: { notebook: { tabId: 'tab-in-work' } } });
  });

  it('is offered only in the class done without asking', () => {
    const ok = approval({});
    expect(dontAskOf({ ...ok, payload: { path: 'Research/a.md', text: 'x', replace: true } }, access(), TABS)).toBeNull();
    expect(dontAskOf({ ...ok, payload: { path: 'Research/a.md', text: 'x' } }, access(), TABS)).toBeNull(); // replace must be false
    expect(dontAskOf({ ...ok, tool: 'notebook_write', payload: { op: 'replace_text', pageId: 'p', find: 'a', markdown: 'b' }, target: { kind: 'page', pageId: 'p', title: 'T', tabId: 'tab-ideas' } }, access(), TABS)).toBeNull();
    expect(dontAskOf({ ...ok, tool: 'files_move', payload: { from: 'a/b', to: 'a/c' } }, access(), TABS)).toBeNull();
    expect(dontAskOf({ ...ok, tool: 'files_trash', risk: 'delete', payload: { path: 'Research/a.md' } }, access(), TABS)).toBeNull();
    expect(dontAskOf({ ...ok, risk: 'egress' }, access(), TABS)).toBeNull();
    expect(dontAskOf({ ...ok, context: 'member:shop.example.com' }, access(), TABS)).toBeNull();
    expect(mayOfferDontAsk(ok)).toBe('files');
    expect(mayOfferDontAsk({ ...ok, tool: 'browser_open' })).toBeNull();
  });

  it('is never offered after the run read untrusted content, once answered, or for a row done without asking', () => {
    expect(dontAskOf(approval({ untrusted: true }), access(), TABS)).toBeNull();
    expect(dontAskOf(approval({ state: 'approved' }), access(), TABS)).toBeNull();
    expect(dontAskOf(approval({ state: 'done', decidedBy: 'auto' }), access(), TABS)).toBeNull();
    expect(mayOfferDontAsk(approval({ untrusted: true }))).toBeNull();
  });

  it('needs the agent’s switch off and its app on, and its screen saved', () => {
    expect(dontAskOf(approval({}), access({ auto: { notebook: null, files: { folder: 'Other' }, todos: false } }), TABS)).toBeNull();
    expect(dontAskOf(approval({}), access({ apps: { notebook: true, files: false, browser: true, courier: false, todos: true } }), TABS)).toBeNull();
    expect(dontAskOf(approval({}), access({ chosen: false }), TABS)).toBeNull();
    expect(dontAskOf(approval({}), null, TABS)).toBeNull();
    const create = approval({ tool: 'notebook_write', payload: { op: 'create', new: { tabId: 'tab-ideas', title: 'L' }, markdown: 'x' } });
    expect(dontAskOf(create, access({ auto: { notebook: { tabId: 'tab-other' }, files: null, todos: false } }), TABS)).toBeNull();
    expect(dontAskOf(create, access({ apps: { notebook: false, files: true, browser: true, courier: false, todos: true } }), TABS)).toBeNull();
  });

  it('never offers the whole of Files: a path at the top has no folder', () => {
    expect(parentFolder('notes.md')).toBeNull();
    expect(parentFolder('/notes.md')).toBeNull();
    expect(parentFolder('Research/notes.md')).toBe('Research');
    expect(parentFolder('/Research/notes.md/')).toBe('Research');
    expect(parentFolder('Research/../notes.md')).toBeNull();
    expect(parentFolder('Research//notes.md')).toBeNull();
    expect(parentFolder(42)).toBeNull();
    expect(dontAskOf(approval({ payload: { path: 'notes.md', text: 'x', replace: false } }), access(), TABS)).toBeNull();
  });

  it('shows hidden characters in the place it names', () => {
    const d = dontAskOf(approval({ payload: { path: 'Re​search/a.md', text: 'x', replace: false } }), access(), TABS)!;
    expect(d.words).toBe('Save new files in Re⟨U+200B⟩search without asking');
    // What goes to the desk is the path as the card's payload has it, which deskd checks again.
    expect(d.change).toEqual({ auto: { files: { folder: 'Re​search' } } });
  });
});
