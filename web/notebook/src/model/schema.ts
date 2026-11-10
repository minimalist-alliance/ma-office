// The Notebook's document schema (design 5.1, ADR 0015): TipTap 3, MIT extensions only.
// This list has no DOM or React in it, so the same schema can run headless: in the tests here,
// and later in a desk-side service that applies agent edits to the real document model.
//
// Blocks: Title (h1), Heading (h2), Subheading (h3), Body (p), bulleted and numbered lists,
// nested checklists, quote, code block, horizontal rule. Marks: bold, italic, underline,
// strikethrough, inline code, highlight, link. Images and attachments wait for blob storage.
import { getSchema, type AnyExtension } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import StarterKit from '@tiptap/starter-kit';
import type { Schema } from '@tiptap/pm/model';

/** The Y.XmlFragment that holds a page's body inside its Y.Doc. TipTap's Collaboration default. */
export const DOC_FIELD = 'default';

/** Highlight colors are stored as names and mapped per theme (design 3.12). */
export const HIGHLIGHT_COLORS = ['yellow'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** Links never fetch anything. Only these schemes become links. */
export const LINK_PROTOCOLS = ['http', 'https', 'mailto'];

// Highlight renders data-color, never an inline style: the Desk app's CSP has no style-src 'unsafe-inline',
// and the color follows the theme through CSS.
const NamedHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-color') ?? 'yellow',
        renderHTML: (attrs: { color?: string }) => ({ 'data-color': attrs.color ?? 'yellow' }),
      },
    };
  },
});

/** Extensions shared by the live editor and headless use. The live editor adds Collaboration on top. */
export function schemaExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Yjs owns undo through Collaboration's UndoManager (design 5.3: history doesn't come from Yjs, undo does).
      undoRedo: false,
      // http, https and mailto are linkify's own schemes, so they aren't registered again here.
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        isAllowedUri: (url: string) => {
          const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
          return !scheme || LINK_PROTOCOLS.includes(scheme);
        },
      },
      // The drop cursor and gap cursor need a DOM; they're harmless headless.
    }),
    NamedHighlight.configure({ multicolor: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}

let cached: Schema | null = null;
export function notebookSchema(): Schema {
  cached ??= getSchema(schemaExtensions());
  return cached;
}

/** A ProseMirror JSON document. */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** A new page: an empty Title line, as the prototype starts one. */
export const BLANK_PAGE: PMNode = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] };
