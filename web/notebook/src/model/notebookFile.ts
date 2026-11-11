// The Notebook's own file (ADR 0091): pages as ProseMirror JSON with their labels, so colors, labels and everything else
// on a page leave and come back exactly. Markdown and HTML (`export.ts`) are for reading elsewhere; this is for moving
// notes between notebooks and desks. Pure.
//
// The shape, version 1:
//   { "format": "ma-notebook", "version": 1, "exportedAt": "<ISO time>",
//     "palette": { "amber": { "name", "highlight", "text", "callout", "label" }, ... },   // optional, what each looked like
//     "pages": [ { "title", "label": "green" | null, "createdAt", "updatedAt", "doc": { "type": "doc", ... } } ] }
// Readers keep what they don't know: a field added later never bumps `version`, and only a change an older reader would get
// wrong does, which that reader then refuses rather than guess.
import { Node, type Schema } from '@tiptap/pm/model';
import { COLOR_BLOCK_TYPES, DEFAULT_HIGHLIGHT, isPaletteId, LEGACY_HIGHLIGHT, nearestPaletteId, type PaletteColors, type PaletteId, type PaletteRole } from './colors.ts';
import { safeHref } from './export.ts';
import { notebookSchema, type PMNode } from './schema.ts';
import type { PageRec } from './types.ts';

export const NOTEBOOK_FILE_FORMAT = 'ma-notebook';
export const NOTEBOOK_FILE_VERSION = 1;
/** `Plan.notebook.json`: a JSON file anything can open. */
export const NOTEBOOK_FILE_EXT = 'notebook.json';
/** More pages than this in one file is refused, as no export makes one. */
export const MAX_FILE_PAGES = 5000;
/** Nesting deeper than this is refused: the editor's own lists stop long before. */
const MAX_DEPTH = 100;

export interface NotebookFilePage {
  title: string;
  label: PaletteId | null;
  createdAt?: number;
  updatedAt?: number;
  doc: PMNode;
  [key: string]: unknown;
}

export interface NotebookFile {
  format: typeof NOTEBOOK_FILE_FORMAT;
  version: number;
  exportedAt: string;
  palette?: PaletteColors;
  pages: NotebookFilePage[];
  [key: string]: unknown;
}

/** A page ready for `NotebookBackend.importPage`: its body, cleaned and checked against the schema, and its label. */
export interface ImportedPage {
  doc: PMNode;
  label: PaletteId | null;
  /** As the file says. The page's title is still its first line, as for any page. */
  title: string;
}

export interface ParsedNotebookFile {
  pages: ImportedPage[];
  /** Pages left out, as their body isn't something the editor can show. */
  skipped: number;
  /** Colors that weren't one of the six names: mapped to the nearest, or dropped. */
  mapped: number;
  /** The file's top-level fields this reader doesn't use, as they were. */
  extra: Record<string, unknown>;
}

export type NotebookFileProblem = 'json' | 'format' | 'version' | 'too_many';

export class NotebookFileError extends Error {
  override name = 'NotebookFileError';
  constructor(readonly reason: NotebookFileProblem) {
    super(
      {
        json: "That file isn't a notebook file.",
        format: "That file isn't a notebook file.",
        version: 'That file was made by a newer Notebook.',
        too_many: 'That file has more pages than can be brought in at once.',
      }[reason],
    );
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pages as the notebook file has them. `palette` is what each id looks like now, for readers elsewhere. */
export function toNotebookFile(pages: readonly { rec: Pick<PageRec, 'title' | 'label' | 'createdAt' | 'updatedAt'>; doc: PMNode }[], o: { palette?: PaletteColors; now?: number } = {}): string {
  const file: NotebookFile = {
    format: NOTEBOOK_FILE_FORMAT,
    version: NOTEBOOK_FILE_VERSION,
    exportedAt: new Date(o.now ?? Date.now()).toISOString(),
    ...(o.palette ? { palette: o.palette } : {}),
    pages: pages.map(({ rec, doc }) => ({ title: rec.title, label: rec.label ?? null, createdAt: rec.createdAt, updatedAt: rec.updatedAt, doc })),
  };
  return `${JSON.stringify(file)}\n`;
}

interface CleanOptions {
  palette?: PaletteColors | undefined;
  schema?: Schema | undefined;
}

const COLOR_BLOCKS = new Set<string>(COLOR_BLOCK_TYPES);

/**
 * A page body from outside, made safe for the editor: node and mark types the schema doesn't have are taken out (a node's
 * children stay in its place, a mark's text stays), a link that isn't http, https or mailto loses its link, and colors that
 * aren't one of the six names are mapped to the nearest with `palette`, or dropped. Attributes it doesn't know are kept. Null if
 * what's left isn't a document the schema accepts.
 */
export function cleanDoc(doc: unknown, o: CleanOptions = {}): { doc: PMNode; mapped: number } | null {
  const schema = o.schema ?? notebookSchema();
  let mapped = 0;
  const color = (v: unknown, role: PaletteRole): PaletteId | null => {
    if (v === undefined || v === null) return null;
    if (isPaletteId(v)) return v;
    mapped += 1;
    return typeof v === 'string' && o.palette ? nearestPaletteId(v, o.palette, role) : null;
  };
  const mark = (m: unknown): PMNode['marks'] => {
    if (!isObj(m) || typeof m['type'] !== 'string' || !schema.marks[m['type']]) return [];
    const type = m['type'];
    const attrs = isObj(m['attrs']) ? { ...m['attrs'] } : undefined;
    if (type === 'highlight') {
      const c = attrs?.['color'];
      return [{ type, attrs: { ...attrs, color: c === LEGACY_HIGHLIGHT ? c : (color(c, 'highlight') ?? DEFAULT_HIGHLIGHT) } }];
    }
    if (type === 'textColor') {
      const c = color(attrs?.['color'], 'text');
      return c ? [{ type, attrs: { ...attrs, color: c } }] : [];
    }
    // A link from outside goes only where a link typed in the editor may (http, https, mailto); otherwise its text stays plain.
    if (type === 'link' && !safeHref(attrs?.['href'])) return [];
    return [{ type, ...(attrs ? { attrs } : {}) }];
  };
  const node = (n: unknown, depth: number): PMNode[] => {
    if (!isObj(n) || typeof n['type'] !== 'string' || depth > MAX_DEPTH) return [];
    const kids = (): PMNode[] => (Array.isArray(n['content']) ? n['content'].flatMap((c) => node(c, depth + 1)) : []);
    if (n['type'] === 'text') {
      const text = n['text'];
      if (typeof text !== 'string' || !text) return [];
      const marks = Array.isArray(n['marks']) ? n['marks'].flatMap((m) => mark(m) ?? []) : [];
      return [{ type: 'text', text, ...(marks.length ? { marks } : {}) }];
    }
    if (!schema.nodes[n['type']] || n['type'] === 'doc') return kids();
    const attrs = isObj(n['attrs']) ? { ...n['attrs'] } : undefined;
    if (attrs && 'color' in attrs && COLOR_BLOCKS.has(n['type'])) attrs['color'] = color(attrs['color'], 'callout');
    const content = Array.isArray(n['content']) ? kids() : undefined;
    return [{ type: n['type'], ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) }];
  };
  if (!isObj(doc) || doc['type'] !== 'doc' || !Array.isArray(doc['content'])) return null;
  const blocks = doc['content'].flatMap((c) => node(c, 1));
  // An empty page (a Y.Doc with nothing in it reads so) is one empty line, as the editor shows it.
  const out: PMNode = { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
  try {
    Node.fromJSON(schema, out).check();
  } catch {
    return null;
  }
  return { doc: out, mapped };
}

/** A notebook file's pages, cleaned. Throws `NotebookFileError` for something that isn't one, or is from a newer Notebook. */
export function parseNotebookFile(text: string, o: CleanOptions = {}): ParsedNotebookFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new NotebookFileError('json');
  }
  if (!isObj(v) || v['format'] !== NOTEBOOK_FILE_FORMAT || !Array.isArray(v['pages'])) throw new NotebookFileError('format');
  const version = v['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new NotebookFileError('format');
  if (version > NOTEBOOK_FILE_VERSION) throw new NotebookFileError('version');
  if (v['pages'].length > MAX_FILE_PAGES) throw new NotebookFileError('too_many');
  const out: ParsedNotebookFile = { pages: [], skipped: 0, mapped: 0, extra: {} };
  for (const p of v['pages'] as unknown[]) {
    const cleaned = isObj(p) ? cleanDoc(p['doc'], o) : null;
    if (!isObj(p) || !cleaned) {
      out.skipped += 1;
      continue;
    }
    out.mapped += cleaned.mapped;
    const raw = p['label'];
    let label: PaletteId | null = null;
    if (isPaletteId(raw)) label = raw;
    else if (raw !== undefined && raw !== null) {
      out.mapped += 1;
      label = typeof raw === 'string' && o.palette ? nearestPaletteId(raw, o.palette, 'label') : null;
    }
    out.pages.push({ doc: cleaned.doc, label, title: typeof p['title'] === 'string' ? p['title'] : '' });
  }
  for (const [k, val] of Object.entries(v)) if (!['format', 'version', 'exportedAt', 'palette', 'pages'].includes(k)) out.extra[k] = val;
  return out;
}
