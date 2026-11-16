// Documents' wire readers (deskd API.md §25, `DocsMethods.java`): lenient, so a desk that sends less or more never breaks the
// window, and strict about what's shown: hidden characters out, lengths cut, danger never viewable, ids well formed.
import { describe, expect, it } from 'vitest';
import { parseDocRef, plain, readChanges, readCounts, readDetail, readDoc, readEvent, readList, readPage, readQuestions, readRules, readText, readTidy, readToast } from './wire';

const ID = 'd_01JC0000000000000000000001';
const doc = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  kind: 'attachment',
  type: 'pdf',
  title: '12 Nov · Rosa Ortiz · Contract',
  origName: 'Contract v3 final (1).pdf',
  size: 182044,
  place: 'needs',
  maybe: false,
  reason: { code: 'changed', text: 'Page 3 changed' },
  dueAt: null,
  from: { name: 'Rosa Ortiz', personKey: 'pk_3f9a12c04b7e8d51' },
  arrivedAt: 1763100000000,
  changedAt: 1763190000000,
  changedBy: { kind: 'person', name: 'Rosa Ortiz' },
  state: 'new',
  copies: 2,
  versions: 3,
  changedPages: [3],
  lastPage: 1,
  pageCount: 6,
  viewable: true,
  danger: null,
  untrusted: true,
  sensitive: false,
  summary: null,
  source: { kind: 'courier', label: 'Email from Rosa Ortiz · Contract' },
  ...o,
});

describe('a document', () => {
  it('reads §25’s example whole', () => {
    expect(readDoc(doc())).toMatchObject({ id: ID, type: 'pdf', place: 'needs', maybe: false, reason: { code: 'changed', text: 'Page 3 changed' }, from: { name: 'Rosa Ortiz', personKey: 'pk_3f9a12c04b7e8d51' }, changedPages: [3], pageCount: 6, viewable: true, copies: 2, versions: 3 });
  });

  it('drops one without a well-formed id or a title', () => {
    expect(readDoc(doc({ id: 'd_short' }))).toBeNull();
    expect(readDoc(doc({ id: 'c_01JC0000000000000000000001' }))).toBeNull();
    expect(readDoc(doc({ title: '' }))).toBeNull();
    expect(readDoc(null)).toBeNull();
    expect(readDoc('d_01JC0000000000000000000001')).toBeNull();
  });

  it('takes safe defaults for what’s missing or odd', () => {
    const d = readDoc({ id: ID, title: 'Notes', place: 'garden', type: 'exe', kind: 7, state: 'odd', changedPages: [0, 2, 2, 'x', 3.5, 600] })!;
    expect(d).toMatchObject({ place: 'records', type: 'other', kind: 'file', state: 'seen', changedPages: [2], lastPage: 1, pageCount: null, from: null, summary: null, untrusted: true });
    expect(d.viewable).toBe(false);
  });

  it('a danger word is never viewable, whatever the desk says', () => {
    expect(readDoc(doc({ danger: 'program', viewable: true }))!.viewable).toBe(false);
    expect(readDoc(doc({ type: 'other', viewable: true }))!.viewable).toBe(false);
  });

  it('Maybe only in Needs you', () => {
    expect(readDoc(doc({ maybe: true }))!.maybe).toBe(true);
    expect(readDoc(doc({ maybe: true, place: 'read' }))!.maybe).toBe(false);
  });

  it('takes hidden characters out of desk text, and cuts it to its length', () => {
    const d = readDoc(doc({ title: `12 Nov · Ro‮sa · ${'x'.repeat(80)}`, reason: { code: 'from', text: 'From​ Rosa' } }))!;
    expect(d.title).not.toContain('‮');
    expect([...d.title].length).toBeLessThanOrEqual(60);
    expect(d.reason.text).toBe('From Rosa');
    expect(plain('a\u0000b⁦c')).toBe('a b c');
  });

  it('a sensitive one keeps code’s fixed words; a person key must be well formed', () => {
    const d = readDoc(doc({ sensitive: true, sensitiveText: 'A letter from Rosa Ortiz. Open to read.', from: { name: 'Rosa', personKey: 'rosa@example.org' } }))!;
    expect(d.sensitiveText).toBe('A letter from Rosa Ortiz. Open to read.');
    expect(d.from).toEqual({ name: 'Rosa', personKey: null });
    expect(readDoc(doc({ sensitiveText: 'x' }))!.sensitiveText).toBeNull();
  });

  it('reads the reader’s summary, keeping only what’s checked', () => {
    const d = readDoc(doc({ summary: { line: 'The payment date moved to 1 December (p. 3).', what: 'contract', asks: ['sign', 'SHOUT', 3], due: null, pages: { sign: 6, pay: 0, x: 'y' }, changeLine: 'Rosa moved it.' } }))!;
    expect(d.summary).toEqual({ line: 'The payment date moved to 1 December (p. 3).', what: 'contract', asks: ['sign'], due: null, pages: { sign: 6 }, changeLine: 'Rosa moved it.' });
  });
});

describe('lists and the rest', () => {
  it('reads a list with its counts and the end words', () => {
    const l = readList({ items: [doc(), { id: 'bad' }], counts: { needs: 2, maybe: 1, read: 'x', records: -4 }, cursor: '50', more: true, end: 'That’s all for now.' });
    expect(l.items).toHaveLength(1);
    expect(l.counts).toEqual({ needs: 2, maybe: 1, read: 0, records: 0, working: 0 });
    expect(l).toMatchObject({ cursor: '50', more: true, end: 'That’s all for now.' });
    expect(readList(null)).toEqual({ items: [], counts: { needs: 0, maybe: 0, read: 0, records: 0, working: 0 }, cursor: null, more: false, end: null });
    expect(readCounts({ needs: 1.7 }).needs).toBe(1);
  });

  it('reads a document’s detail: copies with their paths, versions, Also in', () => {
    const d = readDetail({
      doc: doc(),
      copies: [{ id: 'c_01JC0000000000000000000001', sourceKind: 'files', label: 'Files · Documents/Contract.pdf', arrivedAt: 1, gone: false, path: 'Documents/Contract.pdf' }, { id: 'x' }],
      copiesText: '2 copies: Mail, Files',
      versions: [
        { id: 'v_01JC0000000000000000000002', at: 2, by: 'pk_3f9a12c04b7e8d51', byName: 'Rosa Ortiz', milestone: 'received', milestoneText: 'Received from Rosa Ortiz', pagesChanged: [3], current: true, restorable: true },
        { id: 'v_01JC0000000000000000000001', at: 1, by: 'member', milestone: null, milestoneText: null, current: false, restorable: true },
      ],
      links: [{ kind: 'thread', ref: 'ch', label: 'Your thread with Rosa' }],
    })!;
    expect(d.copies).toEqual([{ id: 'c_01JC0000000000000000000001', sourceKind: 'files', label: 'Files · Documents/Contract.pdf', arrivedAt: 1, gone: false, path: 'Documents/Contract.pdf' }]);
    expect(d.copiesText).toBe('2 copies: Mail, Files');
    // The current version is never restorable, whatever the desk says.
    expect(d.versions.map((v) => [v.milestoneText, v.current, v.restorable])).toEqual([['Received from Rosa Ortiz', true, false], [null, false, true]]);
    // An older desk with no `alsoIn` shows its links there.
    expect(d.alsoIn.map((l) => l.label)).toEqual(['Your thread with Rosa']);
    expect(readDetail({ doc: { id: 'nope' } })).toBeNull();
  });

  it('reads text as plain sections or pages, never markup', () => {
    const t = readText({ type: 'docx', sections: [{ kind: 'h', text: 'Plan' }, { kind: 'p', text: '<b>hi</b>' }, { kind: 'script', text: 'x' }, { kind: 'table', text: 'Costs', rows: [['a', 1], 'x'] }] });
    expect(t.sections.map((s) => s.kind)).toEqual(['h', 'p', 'table']);
    // Markup stays text: React draws it as characters, never as HTML.
    expect(t.sections[1]!.text).toBe('<b>hi</b>');
    expect(t.sections[2]!.rows).toEqual([['a', ''], []]);
    expect(readText({ type: 'pdf', pages: [{ n: 1, text: 'one\ntwo' }, { n: 0, text: 'x' }] }).pages).toEqual([{ n: 1, text: 'one\ntwo' }]);
    expect(readText({ type: 'pdf', pages: [], unread: 'no_text' }).unread).toBe('no_text');
  });

  it('reads a page’s head, its boxes kept inside the page', () => {
    const h = readPage({ transferId: 4, size: 10, sha256: 'a'.repeat(64), format: 'png', width: 800, height: 1131, pageCount: 6, lines: [{ b: [0.1, 0.2, 0.5, 0.02], changed: true }, { b: [0.9, 0.99, 0.5, 0.5] }, { b: [1, 2] }] })!;
    expect(h).toMatchObject({ transferId: 4, format: 'png', width: 800, height: 1131, pageCount: 6 });
    expect(h.lines).toHaveLength(2);
    expect(h.lines[0]).toEqual({ b: [0.1, 0.2, 0.5, 0.02], changed: true });
    expect(h.lines[1]!.b[2]).toBeCloseTo(0.1);
    expect(h.lines[1]!.b[3]).toBeCloseTo(0.01);
    expect(readPage({ transferId: 'x', size: 1, sha256: 'a'.repeat(64) })).toBeNull();
    expect(readPage({ transferId: 1, size: 1, sha256: 'nothex' })).toBeNull();
    expect(readPage({ transferId: 1, size: 1, sha256: 'a'.repeat(64), format: 'gif' })!.format).toBe('jpeg');
  });

  it('reads changes, questions, rules, toasts and tidy', () => {
    expect(readChanges({ pages: [3, 7], line: 'Pages 3 and 7 changed', changeLine: 'Rosa moved the date.' })).toEqual({ pages: [3, 7], line: 'Pages 3 and 7 changed', changeLine: 'Rosa moved the date.', paragraphs: [] });
    const qs = readQuestions({ questions: [{ id: 'q_firstsort', kind: 'firstsort', text: 'I sorted 312 documents. 4 might need you.', choices: [{ id: 'show', label: 'Show me' }, { id: 'later', label: 'Later' }] }, { id: 'q_x', text: 'No choices', choices: [] }] });
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ id: 'q_firstsort', choices: [{ id: 'show', label: 'Show me' }, { id: 'later', label: 'Later' }] });
    expect(readRules({ rules: [{ id: 'r_01JC0000000000000000000001', text: 'Invoices from Northwind → Records', effect: 'records', madeBy: 'tap' }, { id: 'bad', text: 'x' }] })).toHaveLength(1);
    expect(readToast({ toast: { text: 'Held until 5:00 pm', undo: 'u_01JC0000000000000000000001' } })).toEqual({ text: 'Held until 5:00 pm', undo: 'u_01JC0000000000000000000001' });
    expect(readToast({ toast: { text: 'Done', undo: 'javascript:x' } })).toEqual({ text: 'Done', undo: null });
    expect(readToast({})).toBeNull();
    expect(readTidy({ copies: 2, downloads: 1, bytes: 3, items: [{}, {}], text: 'Tidy up? …' })).toEqual({ copies: 2, downloads: 1, bytes: 3, items: 2, text: 'Tidy up? …' });
    expect(readTidy({ items: [] }).text).toBeNull();
  });

  it('reads the topic: ids and counts only; null ids is “read everything”', () => {
    expect(readEvent({ type: 'changed', rev: 9, ids: [ID, 'x'], counts: { needs: 1 } })).toEqual({ type: 'changed', rev: 9, ids: [ID], counts: { needs: 1, maybe: 0, read: 0, records: 0, working: 0 } });
    expect(readEvent({ type: 'changed', rev: 9, ids: null }).ids).toBeNull();
  });

  it('parses Maia’s document refs, and nothing else', () => {
    expect(parseDocRef(ID)).toEqual({ docId: ID, page: null });
    expect(parseDocRef(`${ID}#p3`)).toEqual({ docId: ID, page: 3 });
    for (const bad of [`${ID}#p0`, `${ID}#p1000`, `https://x/${ID}`, `${ID}?p=3`, 'd_x', null, 3]) expect(parseDocRef(bad)).toBeNull();
  });
});
