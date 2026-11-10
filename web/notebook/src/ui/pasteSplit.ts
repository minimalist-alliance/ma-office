// A very large paste goes in several transactions (spike TD-67, API.md section 13). One transaction is one Yjs update and one
// message on the wire, and a message over 4 MiB can't be sent: on a desk it would close the whole session, Browser included.
// So a paste over about 1 MiB is cut at block boundaries, and each piece is one transaction of well under that.
//
// A single block over the limit (a list of thousands of items, a very long line) becomes several blocks of its kind: nothing
// is lost, and one list numbers again from its own start. Text is never cut inside a surrogate pair, which UTF-8 can't hold.
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

/** The contract's "about 1 MiB": what a paste may be and still go in one transaction. */
export const PASTE_SPLIT_BYTES = 1024 * 1024;
/** Each piece, in the estimate below. Its update carries markup too, so this leaves room under the limit. */
export const PASTE_PIECE_BYTES = 512 * 1024;

const encoder = new TextEncoder();

/** Bytes of a Yjs update for this, roughly: its text in UTF-8, and a little for every node and mark around it. */
export function estimateBytes(node: PMNode): number {
  if (node.isText) return encoder.encode(node.text ?? '').length + 24 + node.marks.length * 32;
  let total = 32 + JSON.stringify(node.attrs).length;
  node.forEach((child) => {
    total += estimateBytes(child);
  });
  return total;
}

function fragmentBytes(f: Fragment): number {
  let total = 0;
  f.forEach((n) => {
    total += estimateBytes(n);
  });
  return total;
}

/** Where to cut `text` near `at`, never inside a surrogate pair. */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

function splitText(node: PMNode, maxBytes: number): PMNode[] {
  const text = node.text ?? '';
  // Three UTF-8 bytes a UTF-16 unit at most, so this many units always fit.
  const step = Math.max(1, Math.floor(maxBytes / 3));
  const out: PMNode[] = [];
  let at = 0;
  while (at < text.length) {
    const end = at + step >= text.length ? text.length : safeCut(text, at + step);
    out.push(node.cut(at, end));
    at = end;
  }
  return out;
}

/** A node over the limit as several of its kind, each under it. A leaf can't be cut, and goes as it is. */
function splitNode(node: PMNode, maxBytes: number): PMNode[] {
  if (node.isText) return splitText(node, maxBytes);
  if (!node.childCount) return [node];
  const out: PMNode[] = [];
  let group: PMNode[] = [];
  let size = 0;
  const flush = (): void => {
    if (group.length) out.push(node.copy(Fragment.fromArray(group)));
    group = [];
    size = 0;
  };
  node.forEach((child) => {
    const bytes = estimateBytes(child);
    for (const piece of bytes > maxBytes ? splitNode(child, maxBytes) : [child]) {
      const pieceBytes = piece === child ? bytes : estimateBytes(piece);
      if (size && size + pieceBytes > maxBytes) flush();
      group.push(piece);
      size += pieceBytes;
    }
  });
  flush();
  return out;
}

/** The fragment's blocks, in order, in groups of at most `maxBytes`. Its text is the same, in the same order. */
export function splitBlocks(content: Fragment, maxBytes: number = PASTE_PIECE_BYTES): Fragment[] {
  const out: Fragment[] = [];
  let group: PMNode[] = [];
  let size = 0;
  const flush = (): void => {
    if (group.length) out.push(Fragment.fromArray(group));
    group = [];
    size = 0;
  };
  content.forEach((block) => {
    const bytes = estimateBytes(block);
    for (const piece of bytes > maxBytes ? splitNode(block, maxBytes) : [block]) {
      const pieceBytes = piece === block ? bytes : estimateBytes(piece);
      if (size && size + pieceBytes > maxBytes) flush();
      group.push(piece);
      size += pieceBytes;
    }
  });
  flush();
  return out;
}

/** The pieces of a paste as the slices to insert, or null if it's small enough to go as one. */
export function pasteSlices(slice: Slice, limitBytes: number = PASTE_SPLIT_BYTES, pieceBytes: number = PASTE_PIECE_BYTES): Slice[] | null {
  if (fragmentBytes(slice.content) <= limitBytes) return null;
  const groups = splitBlocks(slice.content, pieceBytes);
  if (groups.length < 2) return null;
  // The first piece opens as the paste did, so its first line joins the line under the cursor. Nothing after that is open:
  // each goes after the last, at the cursor the last one left.
  return groups.map((content, i) => new Slice(content, i === 0 ? slice.openStart : 0, 0));
}

/** ProseMirror's `handlePaste`: true if it took the paste. Each piece is its own transaction, so its own message. */
export function handleLargePaste(view: EditorView, slice: Slice): boolean {
  const slices = pasteSlices(slice);
  if (!slices) return false;
  for (const piece of slices) view.dispatch(view.state.tr.replaceSelection(piece).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
  return true;
}
