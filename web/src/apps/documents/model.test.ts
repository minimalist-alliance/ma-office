// Documents' pure rules: an item's line in code's words, its chips, the "All desks" merge in the browser, the viewer's sums, and
// the words (§20 exactly, calm: no exclamation marks, never "Maia Mode").
import { describe, expect, it } from 'vitest';
import { byPerson, chipsFor, downloadPath, itemLine, itemParts, mergeHits, mergeLists, noteFor, openingPage, pageForKey, pageInView, pageWidth, placeCount, sumCounts, viewableName, type DeskList } from './model';
import type { Doc } from './types';
import { emptyWords, pageList, W } from './words';

let n = 0;
const doc = (o: Partial<Doc> = {}): Doc => ({
  id: `d_01JC${String((n += 1)).padStart(22, '0')}`,
  kind: 'attachment',
  type: 'pdf',
  title: '12 Nov · Rosa Ortiz · Contract',
  origName: 'Contract.pdf',
  size: 1,
  place: 'needs',
  maybe: false,
  reason: { code: 'changed', text: 'Page 3 changed' },
  dueAt: null,
  from: { name: 'Rosa Ortiz', personKey: 'pk_3f9a12c04b7e8d51' },
  arrivedAt: 0,
  changedAt: 0,
  changedBy: { kind: 'person', name: null },
  state: 'seen',
  heldUntil: null,
  copies: 1,
  versions: 1,
  changedPages: [],
  lastPage: 1,
  pageCount: 6,
  viewable: true,
  danger: null,
  untrusted: true,
  sensitive: false,
  sensitiveText: null,
  summary: null,
  source: { kind: 'courier', label: '' },
  ...o,
});
const counts = (needs = 0, maybe = 0) => ({ needs, maybe, read: 1, records: 2, working: 0 });

describe('an item', () => {
  it('is {who} · {what} · {reason}, from the desk’s title and reason', () => {
    expect(itemParts(doc())).toEqual({ date: '12 Nov', who: 'Rosa Ortiz', what: 'Contract', reason: 'Page 3 changed' });
    expect(itemLine(doc())).toBe('Rosa Ortiz · Contract · Page 3 changed');
    // A title in another shape stands whole, with the sender as the who.
    expect(itemLine(doc({ title: 'Lease', reason: { code: 'from', text: 'From Sam' }, from: { name: 'Sam', personKey: null } }))).toBe('Sam · Lease · From Sam');
    expect(itemLine(doc({ title: 'Lease', from: null }))).toBe('Lease · Page 3 changed');
    // A what with its own dot stays whole.
    expect(itemParts(doc({ title: '1 Dec · Acme · Q3 · draft' })).what).toBe('Q3 · draft');
  });

  it('offers the shield’s chips plus Done in Needs you, fewer elsewhere', () => {
    expect(chipsFor(doc())).toEqual(['not_now', 'not_important', 'sooner', 'done']);
    expect(chipsFor(doc({ place: 'read' }))).toEqual(['not_important', 'sooner', 'done']);
    expect(chipsFor(doc({ place: 'records' }))).toEqual(['sooner', 'done']);
  });

  it('shows her note, or code’s fixed words for a sensitive one outside the viewer', () => {
    const summary = { line: 'Your appointment is on 4 December.', what: 'letter', asks: [], due: null, pages: {}, changeLine: null };
    expect(noteFor(doc({ summary }))).toEqual({ kind: 'summary', text: summary.line });
    const s = doc({ summary, sensitive: true, sensitiveText: 'A letter from Harbor Dental. Open to read.' });
    expect(noteFor(s)).toEqual({ kind: 'sensitive', text: 'A letter from Harbor Dental. Open to read.' });
    expect(noteFor(s, true)).toEqual({ kind: 'summary', text: summary.line });
    expect(noteFor(doc())).toBeNull();
  });
});

describe('All desks', () => {
  const a: DeskList = { deskId: 'd-a', items: [doc({ title: '1 · A · one' }), doc({ title: '1 · A · maybe', maybe: true })], counts: counts(1, 1), end: 'That’s all for now.', more: false };
  const b: DeskList = { deskId: 'd-b', items: [doc({ title: '1 · B · two' }), doc({ title: '1 · B · maybe', maybe: true })], counts: counts(1, 1), end: 'That’s all for now.', more: false };

  it('keeps each desk’s order, this desk first, every sure one before any Maybe, and says which desk', () => {
    const m = mergeLists([a, b], 'needs');
    expect(m.sure.map((d) => [d.deskId, itemParts(d).what])).toEqual([['d-a', 'one'], ['d-b', 'two']]);
    expect(m.maybe.map((d) => [d.deskId, itemParts(d).what])).toEqual([['d-a', 'maybe'], ['d-b', 'maybe']]);
    expect(m.counts).toEqual({ needs: 2, maybe: 2, read: 2, records: 4, working: 0 });
    expect(m.end).toBe('That’s all for now.');
  });

  it('says the end only when every desk has nothing more', () => {
    expect(mergeLists([a, { ...b, end: null, more: true }], 'needs')).toMatchObject({ end: null, more: true });
    expect(mergeLists([a, { ...b, end: null }], 'needs').end).toBeNull();
    expect(mergeLists([], 'needs').end).toBeNull();
  });

  it('outside Needs you there’s no Maybe divider', () => {
    const m = mergeLists([a], 'read');
    expect(m.maybe).toEqual([]);
    expect(m.sure).toHaveLength(2);
  });

  it('the same id on two desks is two documents; on one desk, once', () => {
    const one = doc();
    expect(mergeLists([{ ...a, items: [one, one] }, { ...b, items: [one] }], 'records').sure.map((d) => d.deskId)).toEqual(['d-a', 'd-b']);
  });

  it('search hits keep each desk’s order', () => {
    expect(mergeHits([{ deskId: 'd-a', items: [doc({ title: 'x · y · 1' })] }, { deskId: 'd-b', items: [doc({ title: 'x · y · 2' })] }]).map((d) => [d.deskId, itemParts(d).what])).toEqual([['d-a', '1'], ['d-b', '2']]);
  });

  it('counts: Needs you counts its Maybe too', () => {
    expect(placeCount(counts(2, 3), 'needs')).toBe(5);
    expect(placeCount(counts(2, 3), 'records')).toBe(2);
    expect(sumCounts([counts(1, 1), null, counts(2, 0)])).toEqual({ needs: 3, maybe: 1, read: 2, records: 4, working: 0 });
  });

  it('People groups each sender once, in the desk’s order, the ones with nobody last', () => {
    const items = [doc({ from: null }), doc(), doc({ from: { name: 'Sam', personKey: 'pk_0000000000000001' } }), doc()].map((d) => ({ ...d, deskId: 'd-a' }));
    expect(byPerson(items).map((g) => [g.name, g.items.length])).toEqual([['Rosa Ortiz', 2], ['Sam', 1], ['', 1]]);
  });
});

describe('the viewer’s sums', () => {
  it('asks a page at its width times the pixel ratio, in hundreds, 200 to 1,600', () => {
    expect(pageWidth(390, 3)).toBe(1200);
    expect(pageWidth(820, 2)).toBe(1600);
    expect(pageWidth(100, 1)).toBe(200);
    expect(pageWidth(801, 1)).toBe(900);
    expect(pageWidth(0, 0)).toBe(200);
  });

  it('opens at the page asked, else where the member was, inside the document', () => {
    expect(openingPage(3, 1, 6)).toBe(3);
    expect(openingPage(null, 4, 6)).toBe(4);
    expect(openingPage(9, 1, 6)).toBe(6);
    expect(openingPage(null, 2, null)).toBe(2);
    expect(openingPage(0, 1, 6)).toBe(1);
  });

  it('the page most in view, ties to the earlier', () => {
    expect(pageInView(new Map([[1, 0.2], [2, 0.8]]), 1)).toBe(2);
    expect(pageInView(new Map([[2, 0.5], [3, 0.5]]), 1)).toBe(2);
    expect(pageInView(new Map(), 4)).toBe(4);
  });

  it('PageUp, PageDown, Home and End', () => {
    expect(pageForKey('PageDown', 2, 6)).toBe(3);
    expect(pageForKey('PageDown', 6, 6)).toBe(6);
    expect(pageForKey('PageUp', 1, 6)).toBe(1);
    expect(pageForKey('Home', 4, 6)).toBe(1);
    expect(pageForKey('End', 1, 6)).toBe(6);
    expect(pageForKey('a', 1, 6)).toBeNull();
  });

  it('Files’ View for the kinds the viewer draws; Download only from Files and never a danger type', () => {
    for (const ok of ['a.pdf', 'B.PNG', 'c.jpeg', 'd.docx', 'e.xlsx', 'f.pptx', 'g.txt', 'h.md', 'i.csv']) expect(viewableName(ok)).toBe(true);
    for (const no of ['a.exe', 'b.zip', 'c.html', 'pdf', 'd.pdf.exe']) expect(viewableName(no)).toBe(false);
    const files = [{ path: 'Documents/a.pdf', gone: false, sourceKind: 'files' }];
    expect(downloadPath(doc(), files)).toBe('Documents/a.pdf');
    expect(downloadPath(doc(), [{ path: null, gone: false, sourceKind: 'courier' }])).toBeNull();
    expect(downloadPath(doc(), [{ path: 'x', gone: true, sourceKind: 'files' }])).toBeNull();
    expect(downloadPath(doc({ danger: 'program' }), files)).toBeNull();
  });
});

describe('words', () => {
  it('are the concept’s §20 words', () => {
    expect([W.needs, W.maybe, W.read, W.records, W.working]).toEqual(['Needs you', 'Maybe', 'Read later', 'Records', 'Working on']);
    expect([W.search('Lead'), W.end, W.emptyNeeds, W.lookInside, W.findEmpty]).toEqual(['Find a document, or ask Lead', 'That’s all for now.', 'Nothing needs you.', 'Look inside documents', 'Nothing like that on your desks.']);
    expect(emptyWords('records')).toBe('Receipts, statements and confirmations go here. Nothing yet.');
    expect([W.notNow, W.notImportant, W.sooner, W.done]).toEqual(['Not now', 'Not important', 'Sooner next time', 'Done']);
    // Asking is the desk's own agent's (the owner, Nov 15), by the name the member gave it.
    expect(W.askFirst('Lead')).toBe('To answer, Lead sends this document and your question to its AI, on Lead’s key or your credits.');
    expect([W.askAgent('Lead'), W.askAbout('Lead'), W.searchNoAgent]).toEqual(['Ask Lead', 'Ask Lead about this', 'Find a document']);
    expect(W.changedSince(pageList([3, 7]))).toBe('Pages 3 and 7 changed since you last looked.');
    expect(W.changedSince(pageList([3]))).toBe('Page 3 changed since you last looked.');
    expect(pageList([2, 4, 9])).toBe('Pages 2, 4 and 9');
    expect([W.sandbox, W.offline, W.restoreAsk, W.summaryFirst]).toEqual(['Open this when your desk can draw it.', 'Open this when you’re back online.', 'Restore this version?', 'My one-line notes can miss things. The document is always one tap away.']);
  });

  it('are calm: no exclamation marks, never “Maia Mode”', () => {
    const all = Object.values(W).map((v) => (typeof v === 'function' ? (v as (...a: unknown[]) => string)('x', 1) : v));
    for (const s of all) {
      expect(s).not.toMatch(/!/);
      expect(s).not.toMatch(/Maia Mode|shield/i);
    }
  });
});
