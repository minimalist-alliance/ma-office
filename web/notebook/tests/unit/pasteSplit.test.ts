// A very large paste goes in several transactions, so no update on the wire is over the limit (spike TD-67, API.md section 13).
// Real Yjs updates from the real schema: what a desk's `collab` would carry.
import { Fragment, Node, Slice } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { notebookSchema } from '../../src/model/schema.ts';
import { estimateBytes, handleLargePaste, PASTE_PIECE_BYTES, pasteSlices, PASTE_SPLIT_BYTES, splitBlocks } from '../../src/ui/pasteSplit.ts';

const MiB = 1024 * 1024;
const schema = notebookSchema();
const paragraph = (text: string): Node => schema.nodes['paragraph']!.create(null, schema.text(text));
const listItem = (text: string): Node => schema.nodes['listItem']!.create(null, paragraph(text));

/** About `bytes` of plain ASCII, in paragraphs of about 2 KB, as a long document pasted. */
function pasted(bytes: number): Fragment {
  const nodes: Node[] = [];
  for (let i = 0, made = 0; made < bytes; i += 1) {
    const text = `Paragraph ${i}. ${'lorem ipsum dolor sit amet '.repeat(75)}`;
    nodes.push(paragraph(text));
    made += text.length;
  }
  return Fragment.fromArray(nodes);
}

const textOf = (f: Fragment): string => {
  let out = '';
  f.descendants((n) => {
    if (n.isText) out += n.text;
  });
  return out;
};

/** What goes on the wire for each piece: the update of its own transaction on one growing document. */
function updateSizes(pieces: Fragment[]): number[] {
  const doc = new Y.Doc();
  const sizes: number[] = [];
  doc.on('update', (u: Uint8Array) => sizes.push(u.length));
  pieces.forEach((f, i) => {
    prosemirrorToYXmlFragment(schema.nodes['doc']!.create(null, f), doc.getXmlFragment(`piece-${i}`));
  });
  return sizes;
}

describe('a paste under about 1 MiB', () => {
  it('goes as one transaction, as ProseMirror would', () => {
    const slice = new Slice(pasted(100 * 1024), 0, 0);
    expect(pasteSlices(slice)).toBeNull();
  });

  it('is left to ProseMirror', () => {
    const view = { state: EditorState.create({ schema }), dispatch: () => { throw new Error('nothing to dispatch'); } } as unknown as EditorView;
    expect(handleLargePaste(view, new Slice(pasted(1024), 0, 0))).toBe(false);
  });
});

describe('a paste over about 1 MiB', () => {
  it('is what would otherwise be over the 4 MiB a message can carry', () => {
    const whole = pasted(5 * MiB);
    expect(updateSizes([whole])[0]).toBeGreaterThan(4 * MiB);
  });

  it('goes in several transactions, each update well under 1 MiB and none over the limit, with all its text in order', () => {
    const content = pasted(5 * MiB);
    const slices = pasteSlices(new Slice(content, 0, 0)) as Slice[];
    expect(slices.length).toBeGreaterThanOrEqual(8);
    const sizes = updateSizes(slices.map((s) => s.content));
    expect(sizes).toHaveLength(slices.length);
    expect(Math.max(...sizes)).toBeLessThan(MiB);
    expect(textOf(Fragment.fromArray(slices.flatMap((s) => { const out: Node[] = []; s.content.forEach((n) => out.push(n)); return out; })))).toBe(textOf(content));
  });

  it('each piece is one transaction on the editor, and the document ends up with all of it', () => {
    let state = EditorState.create({ schema });
    let transactions = 0;
    const view = {
      get state() {
        return state;
      },
      dispatch(tr: Parameters<EditorState['apply']>[0]) {
        transactions += 1;
        state = state.apply(tr);
      },
    } as unknown as EditorView;
    const content = pasted(2 * MiB);
    const slices = pasteSlices(new Slice(content, 0, 0)) as Slice[];
    expect(handleLargePaste(view, new Slice(content, 0, 0))).toBe(true);
    expect(transactions).toBe(slices.length);
    expect(state.doc.textContent).toBe(textOf(content));
    // Blocks stay blocks: an empty line isn't left between pieces, beyond the one the document began with.
    expect(state.doc.childCount).toBeGreaterThanOrEqual(content.childCount);
    expect(state.doc.childCount).toBeLessThanOrEqual(content.childCount + 1);
  });

  it('keeps the size of what the first piece opens, so it still joins the line under the cursor', () => {
    const slices = pasteSlices(new Slice(pasted(2 * MiB), 1, 1)) as Slice[];
    expect(slices[0]?.openStart).toBe(1);
    expect(slices[0]?.openEnd).toBe(0);
    expect(slices.slice(1).every((s) => s.openStart === 0 && s.openEnd === 0)).toBe(true);
  });
});

describe('a single block too big for one piece', () => {
  it('one very long line becomes several lines of its kind, with its text whole', () => {
    const text = 'word '.repeat(600_000); // 3 MB in one paragraph, as a minified file pasted
    const block = schema.nodes['codeBlock']!.create(null, schema.text(text));
    const pieces = splitBlocks(Fragment.from(block));
    expect(pieces.length).toBeGreaterThan(3);
    pieces.forEach((f) => f.forEach((n) => expect(n.type.name).toBe('codeBlock')));
    expect(textOf(Fragment.fromArray(pieces.flatMap((f) => { const out: Node[] = []; f.forEach((n) => out.push(n)); return out; })))).toBe(text);
    expect(Math.max(...updateSizes(pieces))).toBeLessThan(MiB);
  });

  it('a list of thousands of items becomes several lists, with every item', () => {
    const items: Node[] = [];
    for (let i = 0; i < 40_000; i += 1) items.push(listItem(`item ${i} ${'x'.repeat(60)}`));
    const list = schema.nodes['bulletList']!.create(null, Fragment.fromArray(items));
    const pieces = splitBlocks(Fragment.from(list));
    expect(pieces.length).toBeGreaterThan(1);
    let count = 0;
    pieces.forEach((f) => f.forEach((n) => {
      expect(n.type.name).toBe('bulletList');
      count += n.childCount;
    }));
    expect(count).toBe(40_000);
    expect(Math.max(...updateSizes(pieces))).toBeLessThan(MiB);
  });

  it('a surrogate pair is never cut, as UTF-8 cannot hold half of one', () => {
    const emoji = '😀'; // two UTF-16 units, four UTF-8 bytes
    const text = emoji.repeat(200_000);
    const block = paragraph(text);
    const pieces = splitBlocks(Fragment.from(block), 64 * 1024);
    expect(pieces.length).toBeGreaterThan(5);
    for (const f of pieces) {
      const t = textOf(f);
      expect(t.length % 2).toBe(0);
      expect(t.startsWith(emoji)).toBe(true);
      expect(t.endsWith(emoji)).toBe(true);
    }
    expect(pieces.map(textOf).join('')).toBe(text);
  });

  it('multi-byte text still fits: the estimate counts bytes, not characters', () => {
    const text = '漢字'.repeat(200_000); // 1.2 MB in UTF-8, 400,000 UTF-16 units
    const block = paragraph(text);
    expect(estimateBytes(block)).toBeGreaterThan(1.2 * 1000 * 1000);
    const pieces = splitBlocks(Fragment.from(block));
    expect(Math.max(...updateSizes(pieces))).toBeLessThan(MiB);
  });

  it('a leaf has nothing to cut, and goes as it is', () => {
    const rule = schema.nodes['horizontalRule']!.create();
    const pieces = splitBlocks(Fragment.from(rule), 1);
    expect(pieces).toHaveLength(1);
  });
});

it('the constants say what the contract does', () => {
  expect(PASTE_SPLIT_BYTES).toBe(MiB);
  expect(PASTE_PIECE_BYTES).toBeLessThan(MiB);
});
