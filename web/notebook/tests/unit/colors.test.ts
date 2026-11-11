// Notebook colors as data (ADR 0091): the schema's marks and attributes, the commands, legacy pages, sync and undo through
// Yjs, export to Markdown and HTML, and the notebook file's round trip. Fake text only.
import { Node } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection, type Command } from '@tiptap/pm/state';
import { prosemirrorJSONToYDoc, prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_HIGHLIGHT, highlightId, nearestPaletteId, PALETTE_IDS, paletteId, parseCssColor, type PaletteColors } from '../../src/model/colors.ts';
import { blockAt, blockColorCommand, clearFormattingCommand, colorMarkCommand, colorsAt } from '../../src/model/commands.ts';
import { derive } from '../../src/model/derive.ts';
import { toHtmlDocument, toMarkdown } from '../../src/model/export.ts';
import { cleanDoc, NotebookFileError, parseNotebookFile, toNotebookFile } from '../../src/model/notebookFile.ts';
import { DOC_FIELD, notebookSchema, schemaExtensions, type PMNode } from '../../src/model/schema.ts';
import { filterByLabels, labelOf, sortByLabel } from '../../src/model/tree.ts';
import { copyState, docState } from '../../src/model/ydoc.ts';
import { getSchema } from '@tiptap/core';

const schema = notebookSchema();
const t = (text: string, ...marks: PMNode['marks'] & object): PMNode => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });
const hl = (color: string) => ({ type: 'highlight', attrs: { color } });
const tc = (color: string) => ({ type: 'textColor', attrs: { color } });

/** A palette for files and pasted colors, as ui/palette.ts will give one. Values are fake and light. */
const tone = (highlight: string, text: string, name: string) => ({ name, highlight, text, callout: highlight, label: text });
const PALETTE: PaletteColors = {
  blue: tone('#CFE3F7', '#2F5B8F', 'Blue'),
  green: tone('#D5EBDD', '#2E6B47', 'Green'),
  amber: tone('#F6E7A6', '#7A5B00', 'Amber'),
  rose: tone('#F4D6DA', '#9A3B48', 'Rose'),
  violet: tone('#E2DBF3', '#5B4699', 'Violet'),
  slate: tone('#E6E8EB', '#4A5260', 'Slate'),
};

/** A document from JSON, checked as the editor would. */
const pm = (json: PMNode): Node => {
  const n = Node.fromJSON(schema, json);
  n.check();
  return n;
};

/** A state over `json` with the selection from `from` to `to`. */
function stateOf(json: PMNode, from: number, to = from): EditorState {
  const d = pm(json);
  return EditorState.create({ schema, doc: d, selection: TextSelection.create(d, from, to) });
}

function apply(state: EditorState, command: Command): EditorState {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  expect(ok).toBe(true);
  return next;
}

/** Page JSON through Yjs as the editor's binding stores it, and back, as a desk reads it. */
function throughYjs(json: PMNode): PMNode {
  const y = prosemirrorJSONToYDoc(schema, json, DOC_FIELD);
  const out = yXmlFragmentToProsemirrorJSON(y.getXmlFragment(DOC_FIELD)) as PMNode;
  y.destroy();
  return out;
}

const marksOf = (json: PMNode): unknown[] => {
  const out: unknown[] = [];
  const walk = (n: PMNode): void => {
    if (n.type === 'text') out.push({ text: n.text, marks: n.marks ?? [] });
    for (const c of n.content ?? []) walk(c);
  };
  walk(json);
  return out;
};

describe('colors by name', () => {
  it("only the tabs' six names are colors; the old yellow and no color read as amber, the default highlight", () => {
    expect(PALETTE_IDS).toEqual(['blue', 'green', 'amber', 'rose', 'violet', 'slate']);
    expect(DEFAULT_HIGHLIGHT).toBe('amber');
    expect(paletteId('green')).toBe('green');
    for (const bad of ['c1', 'yellow', '#ffee00', 'red', 'Blue', '', 3, null, undefined, { c: 1 }]) expect(paletteId(bad)).toBeNull();
    expect(highlightId('yellow')).toBe(DEFAULT_HIGHLIGHT);
    expect(highlightId(undefined)).toBe(DEFAULT_HIGHLIGHT);
    expect(highlightId('rose')).toBe('rose');
    expect(highlightId('teal')).toBeNull();
  });

  it('foreign colors map to the nearest name for their role, and plain ones to none', () => {
    expect(parseCssColor('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseCssColor('rgba(1, 2, 3, 0)')).toBeNull();
    expect(parseCssColor('transparent')).toBeNull();
    expect(parseCssColor('url(x)')).toBeNull();
    expect(nearestPaletteId('#FFF000', PALETTE, 'highlight')).toBe('amber');
    expect(nearestPaletteId('#2F5B90', PALETTE, 'text')).toBe('blue');
    expect(nearestPaletteId('rgb(160, 60, 70)', PALETTE, 'text')).toBe('rose');
    // Every run another app pastes has these: a white page, black text. Neither is a choice.
    expect(nearestPaletteId('#ffffff', PALETTE, 'highlight')).toBeNull();
    expect(nearestPaletteId('#000000', PALETTE, 'text')).toBeNull();
    expect(nearestPaletteId('rgb(32, 33, 36)', PALETTE, 'text')).toBeNull();
  });
});

describe('the schema', () => {
  it('stores highlight, text color and block colors as ids, through Yjs and back', () => {
    const json = doc(
      { type: 'heading', attrs: { level: 1, color: 'blue' }, content: [t('Plan')] },
      p(t('red ', tc('rose')), t('both', tc('rose'), hl('green')), t(' marked', hl('green'))),
      { type: 'blockquote', attrs: { color: 'violet' }, content: [p(t('A callout'))] },
      { type: 'bulletList', content: [{ type: 'listItem', attrs: { color: 'slate' }, content: [p(t('Item'))] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false, color: 'blue' }, content: [p(t('Task'))] }] },
      { type: 'codeBlock', attrs: { language: null, color: 'green' }, content: [t('code')] },
    );
    pm(json);
    const back = throughYjs(json);
    expect(back.content?.[0]?.attrs).toMatchObject({ level: 1, color: 'blue' });
    expect(back.content?.[2]?.attrs).toMatchObject({ color: 'violet' });
    expect(back.content?.[3]?.content?.[0]?.attrs).toMatchObject({ color: 'slate' });
    expect(back.content?.[4]?.content?.[0]?.attrs).toMatchObject({ color: 'blue', checked: false });
    expect(back.content?.[5]?.attrs).toMatchObject({ color: 'green' });
    expect(marksOf(back)).toEqual([
      { text: 'Plan', marks: [] },
      { text: 'red ', marks: [tc('rose')] },
      { text: 'both', marks: expect.arrayContaining([tc('rose'), hl('green')]) },
      { text: ' marked', marks: [hl('green')] },
      { text: 'A callout', marks: [] },
      { text: 'Item', marks: [] },
      { text: 'Task', marks: [] },
      { text: 'code', marks: [] },
    ]);
    // Derived text, search and titles don't see colors.
    expect(derive(back).text).toBe(derive({ ...json }).text);
  });

  it('a new block from Enter starts uncolored', () => {
    const attr = schema.nodes['paragraph']?.spec.attrs?.['color'];
    expect(attr).toMatchObject({ default: null });
    const ext = schemaExtensions().find((e) => e.name === 'blockColor');
    const global = (ext?.config.addGlobalAttributes as () => { attributes: Record<string, { keepOnSplit: boolean }> }[]).call({} as never);
    expect(global[0]?.attributes['color']?.keepOnSplit).toBe(false);
  });

  it('renders ids as data attributes, never styles, and reads only ids back from our own HTML', () => {
    const spec = (name: string) => schema.marks[name]?.spec;
    const el = (attrs: Record<string, string>) => ({ getAttribute: (k: string) => attrs[k] ?? null }) as unknown as HTMLElement;
    const textRule = spec('textColor')?.parseDOM?.[0] as { getAttrs: (e: HTMLElement) => unknown };
    expect(textRule.getAttrs(el({ 'data-text-color': 'green' }))).toEqual({ color: 'green' });
    expect(textRule.getAttrs(el({ 'data-text-color': '#ff0000' }))).toBe(false);
    const highlightColor = (spec('highlight')?.attrs?.['color'] as { default: string }).default;
    expect(highlightColor).toBe('amber');
    // With the UI's palette, another app's colored span maps to the nearest id; without it, it's dropped.
    const withPalette = getSchema(schemaExtensions({ nearestColor: (css, role) => nearestPaletteId(css, PALETTE, role) }));
    const styleRule = withPalette.marks['textColor']?.spec.parseDOM?.find((r) => 'style' in r) as { getAttrs: (v: string) => unknown };
    expect(styleRule.getAttrs('#9A3B48')).toEqual({ color: 'rose' });
    expect(styleRule.getAttrs('#000000')).toBe(false);
    expect(schema.marks['textColor']?.spec.parseDOM?.some((r) => 'style' in r)).toBe(false);
  });
});

describe('a legacy page', () => {
  /** A page as the editor stored it before colors: no textColor mark, no color attributes, the one yellow highlight. */
  const legacy = doc({ type: 'heading', attrs: { level: 1 }, content: [t('Old notes')] }, p(t('kept '), t('bright', { type: 'highlight', attrs: { color: 'yellow' } })), {
    type: 'bulletList',
    content: [{ type: 'listItem', content: [p(t('one'))] }],
  });

  it('opens in the editor as it was, its yellow kept as stored and read as the default', () => {
    const y = prosemirrorJSONToYDoc(getSchema(schemaExtensions().filter((e) => e.name !== 'blockColor' && e.name !== 'textColor')), legacy, DOC_FIELD);
    // The editor's own projection, with today's schema.
    const node = yXmlFragmentToProseMirrorRootNode(y.getXmlFragment(DOC_FIELD), schema);
    node.check();
    expect(node.child(1).child(1).marks[0]?.attrs).toEqual({ color: 'yellow' });
    expect(node.child(0).attrs['color']).toBeNull();
    const state = EditorState.create({ schema, doc: node, selection: TextSelection.create(node, 17, 23) });
    expect(colorsAt(state)).toEqual({ highlight: 'amber', textColor: null, block: null });
    // Nothing is rewritten on open: the stored value is still the old one.
    expect(JSON.stringify(yXmlFragmentToProsemirrorJSON(y.getXmlFragment(DOC_FIELD)))).toContain('"yellow"');
    y.destroy();
  });

  it('exports as before', () => {
    expect(toMarkdown(legacy)).toBe('# Old notes\n\nkept <mark>bright</mark>\n\n- one\n');
  });
});

describe('commands', () => {
  const page = doc(
    { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
    p(t('alpha beta '), t('gamma', { type: 'link', attrs: { href: 'https://example.org' } }), t(' delta', { type: 'bold' })),
    { type: 'blockquote', content: [p(t('quoted')), p(t('second'))] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('first'))] }, { type: 'listItem', content: [p(t('next'))] }] },
    { type: 'codeBlock', attrs: { language: null }, content: [t('x = 1')] },
  );
  // Positions: "Title" 1-6; paragraph 8..; "alpha" starts at 8.

  it('highlights and colors the selection, replaces a color, and removes it with null', () => {
    let s = stateOf(page, 8, 13);
    s = apply(s, colorMarkCommand('highlight', 'green'));
    s = apply(s, colorMarkCommand('textColor', 'violet'));
    expect(colorsAt(s)).toMatchObject({ highlight: 'green', textColor: 'violet' });
    s = apply(s, colorMarkCommand('highlight', 'blue'));
    expect(colorsAt(s).highlight).toBe('blue');
    s = apply(s, colorMarkCommand('textColor', null));
    expect(colorsAt(s)).toMatchObject({ highlight: 'blue', textColor: null });
    const json = s.doc.toJSON() as PMNode;
    expect(marksOf(json)[1]).toEqual({ text: 'alpha', marks: [hl('blue')] });
  });

  it('on an empty selection sets what is typed next', () => {
    let s = stateOf(page, 10);
    s = apply(s, colorMarkCommand('textColor', 'slate'));
    expect(colorsAt(s).textColor).toBe('slate');
    s = s.apply(s.tr.insertText('new'));
    expect(JSON.stringify(s.doc.toJSON())).toContain('{"type":"text","marks":[{"type":"textColor","attrs":{"color":"slate"}}],"text":"new"}');
  });

  it('says mixed across different colors, and refuses anything but an id', () => {
    let s = stateOf(page, 8, 13);
    s = apply(s, colorMarkCommand('highlight', 'green'));
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 8, 18)));
    expect(colorsAt(s).highlight).toBe('mixed');
    for (const bad of ['teal', '#ff0000', 'yellow']) expect(colorMarkCommand('highlight', bad as never)(s)).toBe(false);
    expect(blockColorCommand(8, 'red' as never)(s)).toBe(false);
  });

  it('clear formatting takes every mark but links', () => {
    let s = stateOf(page, 8, 30);
    s = apply(s, colorMarkCommand('highlight', 'green'));
    s = apply(s, colorMarkCommand('textColor', 'rose'));
    s = apply(s, clearFormattingCommand());
    expect(marksOf(s.doc.toJSON() as PMNode).slice(1, 4)).toEqual([
      { text: 'alpha beta ', marks: [] },
      { text: 'gamma', marks: [{ type: 'link', attrs: expect.objectContaining({ href: 'https://example.org' }) }] },
      { text: ' delta', marks: [] },
    ]);
  });

  it('a code block takes no text color', () => {
    const code = page.content?.findIndex((b) => b.type === 'codeBlock') as number;
    const start = pm(page).content.child(0).nodeSize; // only to make sure positions are what they look like
    expect(start).toBe(7);
    let s = stateOf(page, 0);
    let pos = 0;
    s.doc.forEach((_node, off, i) => {
      if (i === code) pos = off + 1;
    });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, pos, pos + 5)));
    s = apply(s, colorMarkCommand('textColor', 'rose'));
    expect(JSON.stringify(s.doc.toJSON())).not.toContain('textColor');
  });

  it('colors the block at a position: a paragraph, a quote whole, a list item on its own', () => {
    let s = stateOf(page, 0);
    expect(blockAt(s, 10)?.node.type.name).toBe('paragraph');
    const quoteInner = 8 + s.doc.child(1).nodeSize + 2;
    expect(blockAt(s, quoteInner)?.node.type.name).toBe('blockquote');
    const listInner = 7 + s.doc.child(1).nodeSize + s.doc.child(2).nodeSize + 3;
    expect(blockAt(s, listInner)?.node.type.name).toBe('listItem');
    s = apply(s, blockColorCommand(quoteInner, 'violet'));
    s = apply(s, blockColorCommand(listInner, 'slate'));
    const json = s.doc.toJSON() as PMNode;
    expect(json.content?.[2]?.attrs).toEqual({ color: 'violet' });
    expect(json.content?.[2]?.content?.[0]?.attrs?.['color']).toBeNull();
    expect(json.content?.[3]?.content?.[0]?.attrs).toEqual({ color: 'slate' });
    expect(json.content?.[3]?.content?.[1]?.attrs?.['color']).toBeNull();
    // A node selection of a top-level block colors it.
    const sel = s.apply(s.tr.setSelection(NodeSelection.create(s.doc, 7)));
    expect(blockAt(sel, sel.selection.from)?.node.type.name).toBe('paragraph');
    // Out of range or on a rule: nothing.
    expect(blockAt(s, -1)).toBeNull();
    expect(blockAt(s, 10_000)).toBeNull();
  });

  it('with no position, colors every block the selection touches, and null uncolors them', () => {
    let s = stateOf(page, 0);
    const end = s.doc.content.size - 2;
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 3, end)));
    s = apply(s, blockColorCommand(null, 'blue'));
    const json = s.doc.toJSON() as PMNode;
    expect(json.content?.map((b) => b.attrs?.['color'] ?? null)).toEqual(['blue', 'blue', 'blue', null, 'blue']);
    expect(json.content?.[3]?.content?.map((li) => li.attrs?.['color'])).toEqual(['blue', 'blue']);
    expect(colorsAt(s).block).toBe('blue');
    s = apply(s, blockColorCommand(null, null));
    expect(JSON.stringify(s.doc.toJSON())).not.toContain('"blue"');
  });
});

describe('sync and undo, through Yjs as the editor does', () => {
  /** What the editor's binding does with a changed document: reconcile it into the page's Y.Doc. */
  function edit(y: Y.Doc, command: Command, from: number, to = from): void {
    const node = yXmlFragmentToProseMirrorRootNode(y.getXmlFragment(DOC_FIELD), schema);
    const state = EditorState.create({ schema, doc: node, selection: TextSelection.create(node, from, to) });
    const next = apply(state, command);
    y.transact(() => prosemirrorToYXmlFragment(next.doc, y.getXmlFragment(DOC_FIELD)), 'editor');
  }

  it("another editor of the page sees the colors, and undo takes them back for both", () => {
    const a = prosemirrorJSONToYDoc(schema, doc({ type: 'heading', attrs: { level: 1 }, content: [t('Shared')] }, p(t('one two three'))), DOC_FIELD);
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
    b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    const undo = new Y.UndoManager(a.getXmlFragment(DOC_FIELD), { trackedOrigins: new Set(['editor']), captureTimeout: 0 });

    edit(a, colorMarkCommand('highlight', 'green'), 9, 12);
    edit(a, blockColorCommand(10, 'slate'), 10);
    edit(a, colorMarkCommand('textColor', 'blue'), 13, 16);
    const seen = yXmlFragmentToProsemirrorJSON(b.getXmlFragment(DOC_FIELD)) as PMNode;
    expect(seen.content?.[1]?.attrs).toMatchObject({ color: 'slate' });
    expect(marksOf(seen).slice(1)).toEqual([
      { text: 'one', marks: [hl('green')] },
      { text: ' ', marks: [] },
      { text: 'two', marks: [tc('blue')] },
      { text: ' three', marks: [] },
    ]);
    // The text itself is untouched by colors: no character was deleted or written again.
    expect(derive(seen).text).toBe('Shared\none two three');

    undo.undo();
    let back = yXmlFragmentToProsemirrorJSON(b.getXmlFragment(DOC_FIELD)) as PMNode;
    expect(JSON.stringify(back)).not.toContain('textColor');
    undo.undo();
    back = yXmlFragmentToProsemirrorJSON(b.getXmlFragment(DOC_FIELD)) as PMNode;
    expect(back.content?.[1]?.attrs?.['color'] ?? null).toBeNull();
    undo.redo();
    back = yXmlFragmentToProsemirrorJSON(b.getXmlFragment(DOC_FIELD)) as PMNode;
    expect(back.content?.[1]?.attrs).toMatchObject({ color: 'slate' });
    a.destroy();
    b.destroy();
  });
});

describe('export', () => {
  const colored = doc(
    { type: 'heading', attrs: { level: 1 }, content: [t('Plan')] },
    p(t('see '), t('this', hl('green')), t(' and '), t('that', tc('rose'))),
    { type: 'blockquote', attrs: { color: 'violet' }, content: [p(t('callout'))] },
  );

  it('Markdown keeps a highlight as <mark>, and with a palette draws colors as inline HTML', () => {
    expect(toMarkdown(colored)).toBe('# Plan\n\nsee <mark>this</mark> and that\n\n> callout\n');
    expect(toMarkdown(colored, { palette: PALETTE })).toBe(
      `# Plan\n\nsee <mark style="background-color: ${PALETTE.green.highlight}">this</mark> and <span style="color: ${PALETTE.rose.text}">that</span>\n\n> callout\n`,
    );
  });

  it('HTML carries the ids and a stylesheet for them, and nothing but a hex color from a palette', () => {
    const html = toHtmlDocument(colored, 'Plan', 'body{}', { palette: PALETTE });
    expect(html).toContain('<mark data-color="green">this</mark>');
    expect(html).toContain('<span data-text-color="rose">that</span>');
    expect(html).toContain('<blockquote data-block-color="violet">');
    expect(html).toContain(`mark[data-color="green"]{background:${PALETTE.green.highlight}}`);
    expect(html).toContain(`[data-text-color="rose"]{color:${PALETTE.rose.text}}`);
    const hostile = { ...PALETTE, green: { ...PALETTE.green, highlight: 'red}body{display:none' } };
    expect(toHtmlDocument(colored, 'Plan', 'body{}', { palette: hostile })).not.toContain('display:none');
    expect(toHtmlDocument(colored, 'Plan', 'body{}')).not.toContain('[data-text-color=');
  });
});

describe('the notebook file', () => {
  const page = doc(
    { type: 'heading', attrs: { level: 1, color: 'blue' }, content: [t('Trip')] },
    p(t('pack ', hl('green')), t('light', tc('slate')), t(' old', hl('yellow'))),
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true, color: 'green' }, content: [p(t('Passport'))] }] },
  );
  const rec = { title: 'Trip', label: 'rose' as const, createdAt: 1, updatedAt: 2 };

  it('round-trips text, colors and labels exactly, through export, import and Yjs', () => {
    const stored = throughYjs(page);
    const text = toNotebookFile([{ rec, doc: stored }, { rec: { ...rec, title: 'Plain', label: null }, doc: throughYjs(doc(p(t('plain')))) }], { palette: PALETTE, now: 0 });
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: 'ma-notebook', version: 1, exportedAt: '1970-01-01T00:00:00.000Z', palette: PALETTE });
    const parsed = parseNotebookFile(text, { palette: PALETTE });
    expect(parsed.skipped).toBe(0);
    expect(parsed.mapped).toBe(0);
    expect(parsed.pages.map((x) => x.label)).toEqual(['rose', null]);
    expect(parsed.pages[0]?.doc).toEqual(stored);
    // Into a new page's Y.Doc and read back as a desk does: the same.
    const y = new Y.Doc();
    Y.applyUpdate(y, docState(parsed.pages[0]?.doc as PMNode).state);
    expect(yXmlFragmentToProsemirrorJSON(y.getXmlFragment(DOC_FIELD))).toEqual(stored);
    yXmlFragmentToProseMirrorRootNode(y.getXmlFragment(DOC_FIELD), schema).check();
    y.destroy();
  });

  it('keeps what it does not know: attributes and fields; drops unknown marks and node types, keeping their text', () => {
    const future = {
      format: 'ma-notebook',
      version: 1,
      exportedAt: '2027-01-01T00:00:00Z',
      shelf: { kept: true },
      pages: [
        {
          title: 'Later',
          label: 'amber',
          pinned: true,
          doc: doc(
            { type: 'paragraph', attrs: { color: 'green', indent: 2 }, content: [t('glow', { type: 'sparkle', attrs: {} }), t(' text', hl('blue'))] },
            { type: 'callout', attrs: { icon: 'x' }, content: [p(t('inside'))] },
          ),
        },
      ],
    };
    const parsed = parseNotebookFile(JSON.stringify(future));
    expect(parsed.extra).toEqual({ shelf: { kept: true } });
    expect(parsed.pages[0]?.doc).toEqual(doc({ type: 'paragraph', attrs: { color: 'green', indent: 2 }, content: [t('glow'), t(' text', hl('blue'))] }, p(t('inside'))));
    const y = new Y.Doc();
    Y.applyUpdate(y, docState(parsed.pages[0]?.doc as PMNode).state);
    expect((y.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement).getAttribute('indent')).toBe(2);
    y.destroy();
  });

  it('maps foreign colors to the nearest id with a palette, or drops them; refuses what is not a notebook file', () => {
    const foreign = JSON.stringify({
      format: 'ma-notebook',
      version: 1,
      pages: [{ title: 'x', label: '#9A3B48', doc: doc({ type: 'paragraph', attrs: { color: '#D5EBDD' }, content: [t('a', tc('#2F5B8F')), t('b', hl('rgb(246, 231, 166)'))] }) }],
    });
    const mapped = parseNotebookFile(foreign, { palette: PALETTE });
    expect(mapped.pages[0]?.label).toBe('rose');
    expect(mapped.pages[0]?.doc).toEqual(doc({ type: 'paragraph', attrs: { color: 'green' }, content: [t('a', tc('blue')), t('b', hl('amber'))] }));
    expect(mapped.mapped).toBe(4);
    const dropped = parseNotebookFile(foreign);
    expect(dropped.pages[0]?.label).toBeNull();
    expect(dropped.pages[0]?.doc).toEqual(doc({ type: 'paragraph', attrs: { color: null }, content: [t('a'), t('b', hl('amber'))] }));

    expect(() => parseNotebookFile('not json')).toThrow(NotebookFileError);
    expect(() => parseNotebookFile('{"format":"other","pages":[]}')).toThrow(/isn't a notebook file/);
    expect(() => parseNotebookFile('{"format":"ma-notebook","version":2,"pages":[]}')).toThrow(/newer Notebook/);
    // A page the editor couldn't show is left out, and counted.
    const bad = parseNotebookFile(JSON.stringify({ format: 'ma-notebook', version: 1, pages: [{ doc: { type: 'doc', content: [{ type: 'bulletList', content: [p(t('not an item'))] }] } }, { doc: 'no' }, 3] }));
    expect(bad).toMatchObject({ pages: [], skipped: 3 });
    // A link from outside goes only where the editor's own may.
    const links = cleanDoc(doc(p(t('bad', { type: 'link', attrs: { href: 'javascript:alert(1)' } }), t(' good', { type: 'link', attrs: { href: 'https://example.org' } }))));
    expect(links?.doc.content?.[0]?.content).toEqual([t('bad'), t(' good', { type: 'link', attrs: { href: 'https://example.org' } })]);
    // An empty page comes in as one empty line, as the editor would show it.
    expect(cleanDoc({ type: 'doc', content: [] })).toEqual({ doc: { type: 'doc', content: [{ type: 'paragraph' }] }, mapped: 0 });
  });
});

describe('a duplicate', () => {
  it('copies the body exactly as Yjs has it, unknown marks and attributes too, under a new client id', () => {
    const y = new Y.Doc();
    const el = new Y.XmlElement('paragraph');
    el.setAttribute('color', 'green');
    el.setAttribute('future', 'kept');
    const text = new Y.XmlText();
    el.insert(0, [text]);
    y.getXmlFragment(DOC_FIELD).insert(0, [el]);
    text.insert(0, 'hello', { textColor: { color: 'rose' }, sparkle: {} });
    const copy = copyState(y);
    expect(copy.client).not.toBe(y.clientID);
    const z = new Y.Doc();
    Y.applyUpdate(z, copy.state);
    expect(yXmlFragmentToProsemirrorJSON(z.getXmlFragment(DOC_FIELD))).toEqual(yXmlFragmentToProsemirrorJSON(y.getXmlFragment(DOC_FIELD)));
    expect([...Y.decodeStateVector(Y.encodeStateVector(z)).keys()]).toEqual([copy.client]);
    y.destroy();
    z.destroy();
  });
});

describe('labels in the page list', () => {
  const pages = [
    { id: 'a', label: 'green' as const },
    { id: 'b' },
    { id: 'c', label: 'amber' as const },
    { id: 'd', label: 'teal' as never },
    { id: 'e', label: 'green' as const },
    { id: 'f', label: null },
  ];
  it('reads a label, filters and sorts by it; a value it does not know is none', () => {
    expect(pages.map(labelOf)).toEqual(['green', null, 'amber', null, 'green', null]);
    expect(filterByLabels(pages, ['green']).map((x) => x.id)).toEqual(['a', 'e']);
    expect(filterByLabels(pages, []).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(sortByLabel(pages).map((x) => x.id)).toEqual(['a', 'e', 'c', 'b', 'd', 'f']);
  });
});

describe('as TipTap commands', () => {
  it('editor.commands has setTextColor, clearFormatting and setBlockColor, and chains them', async () => {
    const { Editor } = await import('@tiptap/core');
    const editor = new Editor({ element: null, extensions: schemaExtensions(), content: doc(p(t('one two'))) });
    editor.commands.setTextSelection({ from: 1, to: 4 });
    expect(editor.chain().setTextColor('green').setHighlight({ color: 'blue' }).run()).toBe(true);
    expect(editor.commands.setBlockColor(2, 'violet')).toBe(true);
    let json = editor.getJSON() as PMNode;
    expect(json.content?.[0]?.attrs).toMatchObject({ color: 'violet' });
    expect(marksOf(json)[0]).toEqual({ text: 'one', marks: expect.arrayContaining([tc('green'), hl('blue')]) });
    expect(editor.commands.clearFormatting()).toBe(true);
    json = editor.getJSON() as PMNode;
    expect(JSON.stringify(json)).not.toContain('textColor');
    expect(editor.commands.setTextColor('nope' as never)).toBe(false);
    editor.destroy();
  });
});

describe("the guard's model (ADR 0091)", () => {
  it('a token says the schema; one that says none is from before the guard', async () => {
    const { collabToken, NOTEBOOK_SCHEMA, schemaOfToken, tokenSaysSchema } = await import('../../src/model/compat.ts');
    expect(NOTEBOOK_SCHEMA).toBe(2);
    expect(collabToken()).toBe('schema=2');
    expect(schemaOfToken(collabToken())).toBe(2);
    expect(schemaOfToken('desk schema=3')).toBe(3);
    for (const old of ['desk', 'x', '', 'schema=', 'noschema=2', undefined, 7]) {
      expect(schemaOfToken(old)).toBe(1);
      expect(tokenSaysSchema(old)).toBe(false);
    }
    expect(tokenSaysSchema('schema=1')).toBe(true);
  });

  it('a page holds what schema 1 would drop when it has a block color or a text color, and nothing else counts', async () => {
    const { holdsNewerThan, updateChanges } = await import('../../src/model/compat.ts');
    const at = (json: PMNode) => prosemirrorJSONToYDoc(schema, json, DOC_FIELD);
    const plain = at(doc(p(t('old', hl('yellow'))), p(t('hl', hl('rose')))));
    const block = at(doc(p(t('a')), { type: 'blockquote', content: [{ type: 'paragraph', attrs: { color: 'blue' }, content: [t('deep')] }] }));
    const text = at(doc(p(t('a', tc('violet')))));
    expect(holdsNewerThan(plain, 1)).toBe(false);
    expect(holdsNewerThan(block, 1)).toBe(true);
    expect(holdsNewerThan(text, 1)).toBe(true);
    expect(holdsNewerThan(block, 2)).toBe(false);
    // Taken off again, it no longer counts.
    const xml = text.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement;
    (xml.get(0) as Y.XmlText).format(0, 1, { textColor: null });
    expect(holdsNewerThan(text, 1)).toBe(false);
    expect(updateChanges(new Uint8Array([0, 0]))).toBe(false);
    expect(updateChanges(Y.encodeStateAsUpdate(block))).toBe(true);
    for (const y of [plain, block, text]) y.destroy();
  });
});
