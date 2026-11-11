// Page bodies into a Y.Doc without going through the editor's schema (ADR 0091), so attributes and marks this build doesn't
// know are kept. Used for a new page's body (a duplicate, an import), never to change a page someone has open: an open page's
// changes go through the editor's binding, which merges.
import type { Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { DOC_FIELD, notebookSchema, type PMNode } from './schema.ts';

type YAttrs = Record<string, unknown>;

/** A node's attributes as the editor's binding writes them: every default filled in, then what the JSON says, nulls left out. */
function attrsOf(schema: Schema, node: PMNode): YAttrs {
  const type = schema.nodes[node.type];
  let defaults: YAttrs = {};
  try {
    defaults = type ? { ...type.create(null).attrs } : {};
  } catch {
    // A type with a required attribute: only what the JSON says.
  }
  const out: YAttrs = { ...defaults, ...(node.attrs ?? {}) };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out;
}

function markAttrs(schema: Schema, m: NonNullable<PMNode['marks']>[number]): YAttrs {
  const type = schema.marks[m.type];
  let defaults: YAttrs = {};
  try {
    defaults = type ? { ...type.create(null).attrs } : {};
  } catch {
    // As above.
  }
  return { ...defaults, ...(m.attrs ?? {}) };
}

function elementOf(schema: Schema, node: PMNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type);
  for (const [k, v] of Object.entries(attrsOf(schema, node))) el.setAttribute(k, v as never);
  el.insert(0, childrenOf(schema, node.content ?? []));
  return el;
}

/** Runs of text go in one Y.XmlText each, with each mark as a formatting attribute, as the binding has them. */
function childrenOf(schema: Schema, content: PMNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  let run: PMNode[] = [];
  const flush = (): void => {
    if (!run.length) return;
    const t = new Y.XmlText();
    t.applyDelta(
      run.map((r) => {
        const attributes: YAttrs = {};
        for (const m of r.marks ?? []) attributes[m.type] = markAttrs(schema, m);
        return Object.keys(attributes).length ? { insert: r.text ?? '', attributes } : { insert: r.text ?? '' };
      }),
    );
    out.push(t);
    run = [];
  };
  for (const c of content) {
    if (c.type === 'text') run.push(c);
    else {
      flush();
      out.push(elementOf(schema, c));
    }
  }
  flush();
  return out;
}

/** Writes `doc`'s blocks at the end of the page body in `ydoc` (an empty one, for a new page). */
export function writeDoc(ydoc: Y.Doc, doc: PMNode, schema: Schema = notebookSchema()): void {
  const fragment = ydoc.getXmlFragment(DOC_FIELD);
  ydoc.transact(() => fragment.insert(fragment.length, childrenOf(schema, doc.content ?? []).filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)));
}

/** What a new page starts from: its Yjs state, and the client id it's written under (whose it is, on a guild's desk). */
export interface NewState {
  state: Uint8Array;
  client: number;
}

/** A new Y.Doc holding `doc`, as the update a new page starts from. */
export function docState(doc: PMNode, schema?: Schema): NewState {
  const y = new Y.Doc();
  try {
    writeDoc(y, doc, schema);
    return { state: Y.encodeStateAsUpdate(y), client: y.clientID };
  } finally {
    y.destroy();
  }
}

/** A copy of a page's body, exactly as Yjs has it (every mark and attribute, known or not), under a new client id. */
export function copyState(source: Y.Doc): NewState {
  const y = new Y.Doc();
  try {
    const from = source.getXmlFragment(DOC_FIELD);
    const to = y.getXmlFragment(DOC_FIELD);
    y.transact(() => to.insert(0, from.toArray().map((t) => t.clone() as Y.XmlElement | Y.XmlText)));
    return { state: Y.encodeStateAsUpdate(y), client: y.clientID };
  } finally {
    y.destroy();
  }
}
