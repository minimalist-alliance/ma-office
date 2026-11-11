// The Notebook's document schema (design 5.1, ADR 0015): TipTap 3, MIT extensions only.
// This list has no DOM or React in it, so the same schema can run headless: in the tests here,
// and later in a desk-side service that applies agent edits to the real document model.
//
// Blocks: Title (h1), Heading (h2), Subheading (h3), Body (p), bulleted and numbered lists,
// nested checklists, quote, code block, horizontal rule. Marks: bold, italic, underline,
// strikethrough, inline code, highlight, text color, link. Blocks take a color (ADR 0091).
// Images and attachments wait for blob storage.
import { Extension, getSchema, Mark, type AnyExtension } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import StarterKit from '@tiptap/starter-kit';
import type { ParseRule, Schema } from '@tiptap/pm/model';
import { NotebookColorCommands } from './commands.ts';
import { COLOR_BLOCK_TYPES, DEFAULT_HIGHLIGHT, isPaletteId, LEGACY_HIGHLIGHT, paletteId, type PaletteId } from './colors.ts';

/** The Y.XmlFragment that holds a page's body inside its Y.Doc. TipTap's Collaboration default. */
export const DOC_FIELD = 'default';

/** Links never fetch anything. Only these schemes become links. */
export const LINK_PROTOCOLS = ['http', 'https', 'mailto'];

export interface SchemaOptions {
  /**
   * Maps a pasted color from elsewhere (a CSS value) to a color's name, or null to drop it: the UI passes one built from its palette
   * (`nearestPaletteId`). Without it, only our own names are taken from pasted HTML. It changes parsing only, never the schema.
   */
  nearestColor?: (css: string, role: 'highlight' | 'text') => PaletteId | null;
}

/** An element's own inline style property, read without a DOM's CSSOM (headless parsing has none). */
function styleOf(el: HTMLElement, prop: string): string | null {
  const raw = el.getAttribute('style');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const at = part.indexOf(':');
    if (at > 0 && part.slice(0, at).trim().toLowerCase() === prop) return part.slice(at + 1).trim();
  }
  return null;
}

// Highlight colors are colors' names (`colors.ts`), mapped per theme in CSS. Pages from before them hold `yellow`, which is
// kept as it is and reads as amber, the default (`highlightId`).
// Highlight renders data-color, never an inline style: the Desk app's CSP has no style-src 'unsafe-inline',
// and the color follows the theme through CSS.
const NamedHighlight = (o: SchemaOptions) =>
  Highlight.extend({
    addAttributes() {
      return {
        color: {
          default: DEFAULT_HIGHLIGHT,
          // Our own (a name, or the old `yellow`), else a foreign mark's background through the UI's palette, else the default.
          parseHTML: (el: HTMLElement) => {
            const own = el.getAttribute('data-color');
            if (own === LEGACY_HIGHLIGHT || isPaletteId(own)) return own;
            const bg = styleOf(el, 'background-color') ?? styleOf(el, 'background');
            return (bg && o.nearestColor?.(bg, 'highlight')) || DEFAULT_HIGHLIGHT;
          },
          renderHTML: (attrs: { color?: string }) => ({ 'data-color': attrs.color ?? DEFAULT_HIGHLIGHT }),
        },
      };
    },
    parseHTML() {
      const rules: ParseRule[] = [{ tag: 'mark' }];
      // Another app's highlight is a span with a background (Google Docs, Word). Mapped only when the UI says how.
      if (o.nearestColor) {
        const near = o.nearestColor;
        rules.push({ style: 'background-color', getAttrs: (v: string) => (near(v, 'highlight') ? { color: near(v, 'highlight') } : false) });
      }
      return rules;
    },
  });

/** Text color: a color's name on a run of text, as `<span data-text-color>`. */
const TextColor = (o: SchemaOptions) =>
  Mark.create({
    name: 'textColor',
    addAttributes() {
      return {
        color: {
          default: null,
          parseHTML: (el: HTMLElement) => paletteId(el.getAttribute('data-text-color')) ?? (o.nearestColor && styleOf(el, 'color') ? o.nearestColor(styleOf(el, 'color') as string, 'text') : null),
          renderHTML: (attrs: { color?: string | null }) => (attrs.color ? { 'data-text-color': attrs.color } : {}),
        },
      };
    },
    parseHTML() {
      const rules: ParseRule[] = [{ tag: 'span[data-text-color]', getAttrs: (el: HTMLElement) => (isPaletteId(el.getAttribute('data-text-color')) ? null : false) }];
      if (o.nearestColor) {
        const near = o.nearestColor;
        rules.push({ style: 'color', getAttrs: (v: string) => (near(v, 'text') ? { color: near(v, 'text') } : false) });
      }
      return rules;
    },
    renderHTML({ HTMLAttributes }) {
      return ['span', HTMLAttributes, 0];
    },
  });

/** A block's color: `color` on the blocks in COLOR_BLOCK_TYPES, as `data-block-color`. A block Enter makes starts without it. */
const BlockColor = Extension.create({
  name: 'blockColor',
  addGlobalAttributes() {
    return [
      {
        types: [...COLOR_BLOCK_TYPES],
        attributes: {
          color: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => paletteId(el.getAttribute('data-block-color')),
            renderHTML: (attrs: { color?: string | null }) => (attrs.color ? { 'data-block-color': attrs.color } : {}),
          },
        },
      },
    ];
  },
});

/** Extensions shared by the live editor and headless use. The live editor adds Collaboration on top. */
export function schemaExtensions(o: SchemaOptions = {}): AnyExtension[] {
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
    NamedHighlight(o).configure({ multicolor: false }),
    TextColor(o),
    TaskList,
    TaskItem.configure({ nested: true }),
    BlockColor,
    NotebookColorCommands,
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
