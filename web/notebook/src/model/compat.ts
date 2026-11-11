// Which editors may write to a page (ADR 0091, "The guard"). An editor projects Yjs through its own schema, so one older
// than a page's content drops what it doesn't know as soon as it edits: a block's color, on every block of the page. On a
// guild's shared Notebook one stale tab would strip it for everyone. So an editor says its schema when it opens a page,
// and the desk refuses changes from one older than what the page holds. Pure.
import * as Y from 'yjs';
import { DOC_FIELD } from './schema.ts';

/**
 * The page schema this build writes. 1: before colors (no `textColor`, no block `color`). 2: ADR 0091's colors. Raise it
 * whenever an older editor would drop something new, and teach `holdsNewerThan` what that is.
 */
export const NOTEBOOK_SCHEMA = 2;

/** The close reason a provider gets when the desk refuses its changes for being older than the page: reload, then edit. */
export const RELOAD_REASON = 'reload';

/** What the Desk app sends as a provider's token. deskd has already checked the session, so it says only this. */
export function collabToken(schema: number = NOTEBOOK_SCHEMA): string {
  return `schema=${schema}`;
}

const SCHEMA_IN_TOKEN = /(?:^|[\s;,])schema=(\d{1,4})(?:$|[\s;,])/;

/** The schema a provider's token says. A token that says none is from an editor before the guard: schema 1. */
export function schemaOfToken(token: unknown): number {
  const m = typeof token === 'string' ? SCHEMA_IN_TOKEN.exec(token) : null;
  return m ? Number(m[1]) : 1;
}

/** Whether a token says a schema at all: an app from before the guard doesn't, and knows only `page_full` as a refusal. */
export function tokenSaysSchema(token: unknown): boolean {
  return typeof token === 'string' && SCHEMA_IN_TOKEN.test(token);
}

/** A Y.XmlText with any run of `textColor` in it. Reads the formatting items, so no text is built. */
function hasTextColor(text: Y.XmlText): boolean {
  for (let n = text._start; n; n = n.right) {
    if (!n.deleted && n.content instanceof Y.ContentFormat && n.content.key === 'textColor' && n.content.value !== null) return true;
  }
  return false;
}

/** Whether a page holds anything an editor of `schema` would drop when it edits. Walks the page's elements once. */
export function holdsNewerThan(doc: Y.Doc, schema: number): boolean {
  if (schema >= NOTEBOOK_SCHEMA) return false;
  // Schema 1 doesn't know a block's `color` or the `textColor` mark.
  const walk = (type: Y.XmlFragment | Y.XmlElement, depth: number): boolean => {
    if (depth > 200) return false;
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement) {
        const color = child.getAttribute('color');
        if (color !== undefined && color !== null) return true;
        if (walk(child, depth + 1)) return true;
      } else if (child instanceof Y.XmlText && hasTextColor(child)) return true;
    }
    return false;
  };
  return walk(doc.getXmlFragment(DOC_FIELD), 0);
}

/** Whether a Yjs update would change anything: an editor's empty SyncStep2 at open doesn't. */
export function updateChanges(update: Uint8Array): boolean {
  try {
    const { structs, ds } = Y.decodeUpdate(update);
    return structs.length > 0 || ds.clients.size > 0;
  } catch {
    return true; // damaged: the normal path refuses it
  }
}
