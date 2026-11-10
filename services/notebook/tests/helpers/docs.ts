// Page bodies for tests: fake text only.
import { Node } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { DOC_FIELD, notebookSchema, type PMNode } from '../../src/model.ts';

export const doc = (...blocks: PMNode[]): PMNode => ({ type: 'doc', content: blocks });
export const h1 = (text: string): PMNode => ({ type: 'heading', attrs: { level: 1 }, content: text ? [{ type: 'text', text }] : [] });
export const p = (text: string): PMNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
export const task = (text: string, checked = false): PMNode => ({
  type: 'taskList',
  content: [{ type: 'taskItem', attrs: { checked }, content: [p(text)] }],
});

/** Replaces a page body the way an editor would, through the page's Y.Doc. */
export function setBody(y: Y.Doc, json: PMNode): void {
  y.transact(() => {
    prosemirrorToYXmlFragment(Node.fromJSON(notebookSchema(), json), y.getXmlFragment(DOC_FIELD));
  });
}

export const bodyOf = (y: Y.Doc): PMNode => yXmlFragmentToProsemirrorJSON(y.getXmlFragment(DOC_FIELD)) as PMNode;

/** Appends text at the end of the page's last paragraph, as typing does. Adds a paragraph if it has none. */
export function typeInto(y: Y.Doc, text: string): void {
  const fragment = y.getXmlFragment(DOC_FIELD);
  y.transact(() => {
    let last = fragment.length ? fragment.get(fragment.length - 1) : null;
    if (!(last instanceof Y.XmlElement) || last.nodeName !== 'paragraph') {
      last = new Y.XmlElement('paragraph');
      fragment.insert(fragment.length, [last as Y.XmlElement]);
    }
    const el = last as Y.XmlElement;
    let t = el.length ? el.get(el.length - 1) : null;
    if (!(t instanceof Y.XmlText)) {
      t = new Y.XmlText();
      el.insert(el.length, [t as Y.XmlText]);
    }
    (t as Y.XmlText).insert((t as Y.XmlText).length, text);
  });
}

/** All text of a page, in order. */
export function textOf(y: Y.Doc): string {
  const walk = (n: PMNode): string => (n.text ?? '') + (n.content ?? []).map(walk).join('');
  return walk(bodyOf(y));
}

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud ' +
  'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur ' +
  'excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

/** The spike's "100-page page": headings, paragraphs, lists, checklists and marks of fake text, from a fixed seed. */
export function fakePages(pages: number, seed = 42): PMNode {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const runs = (n: number): PMNode[] => {
    const out: PMNode[] = [];
    let plain = '';
    for (let i = 0; i < n; i += 1) {
      const w = WORDS[Math.floor(rnd() * WORDS.length)] as string;
      const r = rnd();
      const mark = r < 0.03 ? 'bold' : r < 0.06 ? 'italic' : r < 0.07 ? 'highlight' : null;
      if (!mark) {
        plain += (plain ? ' ' : '') + w;
      } else {
        if (plain) out.push({ type: 'text', text: `${plain} ` });
        plain = '';
        out.push({ type: 'text', text: w, marks: [{ type: mark }] });
        if (i < n - 1) plain = '';
      }
    }
    if (plain) out.push({ type: 'text', text: plain });
    return out;
  };
  const blocks: PMNode[] = [];
  for (let page = 1; page <= pages; page += 1) {
    blocks.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Page ${page}` }] });
    for (let i = 0; i < 4; i += 1) blocks.push({ type: 'paragraph', content: runs(100) });
    blocks.push({ type: 'bulletList', content: Array.from({ length: 4 }, () => ({ type: 'listItem', content: [{ type: 'paragraph', content: runs(12) }] })) });
    blocks.push({ type: 'taskList', content: Array.from({ length: 3 }, (_, i) => ({ type: 'taskItem', attrs: { checked: i === 0 }, content: [{ type: 'paragraph', content: runs(10) }] })) });
  }
  blocks.push(p(`end-${pages}`));
  return doc(...blocks);
}

/** Its Yjs state, as a client would have made it. */
export function fakeState(pages: number, seed = 42): Uint8Array {
  const y = prosemirrorJSONToYDoc(notebookSchema(), fakePages(pages, seed), DOC_FIELD);
  const state = Y.encodeStateAsUpdate(y);
  y.destroy();
  return state;
}
