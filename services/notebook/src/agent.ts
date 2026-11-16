// The Agent's Notebook tools, on the desk's side (draft ADR "the Agent's tools and approvals" sections 2, 8, 15 and 17;
// services/deskd/docs/API.md section 18): a page as Markdown, an outline of the notebooks, an agent's edit of the live
// page, and its undo. deskd calls them on a connection of its own whose caller is the member the agent works for: the
// owner, or on a guild desk the member whose agent it is. So every rule is that member's, as for an edit they make
// themselves: their grants, the edit budget, a trashed page's rules and page_full. deskd's relay lists only the member's
// two (`agentEdits` and `agentUndo`) for clients; deskd has already had the member's approval for an edit by the time it
// calls.
//
//   notebook.page.markdown   {pageId, from?, max?} -> {pageId, title, markdown, from, next, length, trashed, untrusted}
//   notebook.outline         {tabId?, from?} -> {notebooks: [{notebookId, title, tabs: [{tabId, title, pages}]}], more}
//                            or {tabId, title, notebookId, pages: [{pageId, title, updatedAt}], from, next, untrusted}
//   notebook.page.marked     {pageIds} -> {marked: [pageId]}
//   notebook.page.agentEdit  {pageId | new: {tabId, title}, op, markdown, find?, agentName, key?, untrusted?, dryRun?,
//                            tab?} -> {pageId, title, op, versionId, editId, converted, untrusted, repeated?}
//                            (a dry run of an existing page also says its `tabId`)
//   notebook.page.agentEdits {pageId} -> {edits: [{editId, op, agent, at, versionId, undone}]}
//   notebook.page.agentUndo  {editId | key, agent?} -> {editId, pageId, op, undone: true}; the newest agent write on
//                            the page first: an older one while a newer isn't undone is `conflict` `{reason: "newer", editId}`
//
// `tab` (draft ADR §15, auto-approve): deskd's own record of the member's "without asking" switch for the Notebook, an
// edit made with no card. A new page must be in exactly that tab, and an append's page must be in it as the edit is made,
// inside the page's queue, so a page moved out since deskd looked is outside: `forbidden` `{reason: "place"}`, nothing
// done. Never with `replace_text`. `agent` on an undo: the edit must be that agent's (deskd's undo of an unasked edit).
//
// The untrusted mark (Security's ATN-M1): an edit from a run holding U (deskd's `untrusted`), or of a page that already
// holds marked text, keeps each block of text it made in `agent_marks` (`blockMarks`: the block's words and links,
// hashed), with the edit row, before the edit is made. A page that still holds one reads `untrusted`, and so does a tab
// whose listed pages include one, and deskd adds U to the run that reads it. The member's own change to that block's words
// or links ends the mark for it; moving it, recolouring it or bringing it back with a version doesn't. Marks go only with
// the page.
//
// The Markdown is exact both ways (pageMarkdown.ts writes, markdown.ts reads): what an agent reads, it can write back
// with nothing lost. An edit goes into the live Y.Doc through Hocuspocus's own document, as a direct connection's
// transaction, so every open editor sees it at once and merges with it: what the member is typing meanwhile is kept.
// It's built on a copy first, so on a guild desk it's judged and charged before anything is applied. One page's agent
// edits and undos take turns, so a second agent's edit is planned on the page as the first left it. A version with
// reason `pre_agent` is written before it, the day's activity row gets `agent:<agentName>` among its actors, and a row
// in `agent_edits` keeps what undoing it needs: the Yjs ids of the blocks it added and how they read then, or the
// relative positions of the text it put in and what that text replaced. Undo takes out exactly that, and only while
// it's unchanged; otherwise it says so, with the `pre_agent` version to go back to. Logs say page ids and the op, never
// text.
import { createHash, randomBytes } from 'node:crypto';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Node } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { actorOf, isGuild, mayModerate, type Caller } from './caller.ts';
import { type CollabContext } from './collab.ts';
import { badRequest, notFound, RpcError } from './errors.ts';
import { errName, log } from './log.ts';
import { fromMarkdown, plainText, readMarkdown, type Conversion } from './markdown.ts';
import { cleanDoc, derive, docState, DOC_FIELD, notebookSchema, updateChanges, writeDoc, type PMNode, type VersionMeta } from './model.ts';
import { OWNER_ACTOR } from './notebook.ts';
import { judge, type PageOwners, type Verdict } from './owners.ts';
import { pageMarkdown } from './pageMarkdown.ts';
import type { RpcDeps, RpcHandler } from './rpc.ts';
import { type EditBudget } from './settings.ts';

/** A read gives at most this many characters of Markdown; `next` says where the rest starts. */
export const READ_CHARS = 20_000;
/** The most Markdown one edit takes, as deskd's tool does. */
export const MAX_MARKDOWN = 65_536;
/** An agent's name is shown as text: this many characters at most. */
export const AGENT_NAME_MAX = 64;
/** A page's title is its first line; a tree row cuts it here. */
const TITLE_MAX = 500;
/** What an agent's edit adds to a day's activity actors, before its name: `agent:<name>`. */
export const AGENT_ACTOR = 'agent:';
/** An agent's edits are kept, for their undo, as long as every version is (model/history.ts's 30 days). */
export const KEEP_EDITS_MS = 30 * 86_400_000;
/** deskd's key for an edit (its approval's id), so a second call with it does nothing and an undo can find it. */
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
/** An outline's pages come this many at a time; its tabs stop at this many. */
export const OUTLINE_PAGES = 100;
export const OUTLINE_TABS = 1000;
/** Pages whose Markdown a read keeps for the next part's call. */
const READS_KEPT = 8;
/** A page's agent edits, newest first, at most this many. */
const EDITS_LISTED = 50;
/** Pages one `notebook.page.marked` asks about, at most: a search's hits. */
export const MARKED_MAX = 100;

type Params = Record<string, unknown>;
type Op = 'create' | 'append' | 'replace_text';
/** One run of a Y.XmlText's delta: text and its formatting, as Yjs keeps them. */
interface Run {
  insert: string;
  attributes?: Record<string, unknown>;
}
/** What undoing an edit needs. Null: it can't be undone in place (its `pre_agent` version still can). */
type Undo =
  // A new page: it goes to the Trash, if it's still as the agent made it.
  | { kind: 'page'; fingerprint: string }
  // Blocks added: each one's Yjs id and how it read then.
  | { kind: 'blocks'; ids: [number, number][]; hashes: string[] }
  // Text put in one block: where it starts and ends (relative positions, base64), what it was and what it replaced.
  | { kind: 'text'; start: string; end: string; inserted: Run[]; removed: Run[] }
  // A block replaced by others: theirs as for added blocks, and the block they replaced, as ProseMirror JSON.
  | { kind: 'block'; ids: [number, number][]; hashes: string[]; removed: PMNode }
  | null;

/** The rules rpc.ts holds for a member's own calls, which these keep to. */
export interface AgentRules {
  mayRead: (pageId: string, caller: Caller) => void;
  mayTrash: (pageId: string, caller: Caller) => void;
}

/** Out of a name or a title: controls and line breaks become spaces; format, bidi and invisible characters go. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const HIDDEN = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0100}-\u{e01ef}]/gu;

/** One line of plain text, cut to `max` characters (code points), not through a character. Empty if nothing's left. */
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(BREAKS, ' ').replace(HIDDEN, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('').trimEnd();
}

const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || !v || v.length > 128) throw badRequest(key);
  return v;
};
const absent = (p: Params, key: string): boolean => p[key] === undefined || p[key] === null;
const optCount = (p: Params, key: string, max: number): number | undefined => {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw badRequest(key);
  return v;
};
const optKey = (p: Params): string | null => {
  if (absent(p, 'key')) return null;
  const v = p['key'];
  if (typeof v !== 'string' || !KEY.test(v)) throw badRequest('key');
  return v;
};
const forbidden = (reason: 'grant' | 'budget'): RpcError => new RpcError('forbidden', { reason });
/** An edit with no card outside the member's switch's tab (draft ADR §15). */
const place = (): RpcError => new RpcError('forbidden', { reason: 'place' });
const conflict = (reason: string, more: Record<string, unknown> = {}): RpcError => new RpcError('conflict', { reason, ...more });
/** Thrown inside an undo's change when what the agent put there isn't as it left it. */
class Changed extends Error {}

const jsonOf = (doc: Y.Doc): PMNode => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(DOC_FIELD)) as PMNode;

function titleOf(doc: PMNode): string {
  const t = derive(doc).title;
  if (t.length <= TITLE_MAX) return t;
  return t.slice(0, (t.charCodeAt(TITLE_MAX - 1) & 0xfc00) === 0xd800 ? TITLE_MAX - 1 : TITLE_MAX);
}

/** Whether the editor can show this: the schema takes it as it is. */
function valid(doc: PMNode): boolean {
  try {
    Node.fromJSON(notebookSchema(), doc).check();
    return true;
  } catch {
    return false;
  }
}

/** A page body as the schema has it, defaults filled: the same page reads the same however it was stored. */
function fingerprint(doc: PMNode): string {
  try {
    return createHash('sha256').update(JSON.stringify(Node.fromJSON(notebookSchema(), doc).toJSON())).digest('base64url');
  } catch {
    return `unreadable:${randomBytes(9).toString('base64url')}`;
  }
}

/**
 * What an agent's text is known by when it's marked (Security's ATN-M1): each block of text's own words (a hard break as a
 * line break) and its links' addresses and titles, hashed. Not its kind, colour or place, so a block moved, recoloured,
 * made a heading or brought back by a version is still the same text; any change to its words or links is a new block.
 */
export function blockMarks(doc: PMNode | null, out = new Set<string>()): Set<string> {
  if (!doc) return out;
  const children = doc.content ?? [];
  if (children.some((c) => c.type === 'text' || c.type === 'hardBreak')) {
    let text = '';
    const links: string[] = [];
    for (const c of children) {
      if (c.type === 'hardBreak') text += '\n';
      if (c.type !== 'text') continue;
      text += c.text ?? '';
      for (const m of c.marks ?? []) {
        if (m.type !== 'link') continue;
        const link = `${String(m.attrs?.['href'] ?? '')}\u0000${String(m.attrs?.['title'] ?? '')}`;
        if (links[links.length - 1] !== link) links.push(link);
      }
    }
    if (text.trim() || links.length) out.add(createHash('sha256').update(JSON.stringify([text, links])).digest('base64url'));
    return out;
  }
  for (const c of children) blockMarks(c, out);
  return out;
}

/** The end of a read from `from`: at most `max` characters, at a line's end when one is in the second half. */
function cutAt(text: string, from: number, max: number): number {
  if (max === 0) return from;
  let end = Math.min(text.length, from + max);
  if (end >= text.length) return end;
  const line = text.lastIndexOf('\n', end - 1);
  if (line >= from + max / 2) return line + 1;
  if ((text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end -= 1;
  return end;
}

// ------------------------------------------------------------------ Yjs

/** A run of text inside one block (a Y.XmlText), as plain text: an embed counts one, as Yjs counts it. */
interface TextRun {
  node: Y.XmlText;
  plain: string;
}

function textRuns(parent: Y.XmlFragment | Y.XmlElement, out: TextRun[] = []): TextRun[] {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      const plain = (child.toDelta() as { insert: unknown }[]).map((op) => (typeof op.insert === 'string' ? op.insert : '￼')).join('');
      out.push({ node: child, plain });
    } else if (child instanceof Y.XmlElement) textRuns(child, out);
  }
  return out;
}

/** Up to two places `find` is, overlapping ones included: two is already too many. */
function occurrences(runs: TextRun[], find: string): { run: TextRun; at: number }[] {
  const out: { run: TextRun; at: number }[] = [];
  for (const run of runs) {
    let at = run.plain.indexOf(find);
    while (at >= 0) {
      out.push({ run, at });
      if (out.length > 1) return out;
      at = run.plain.indexOf(find, at + 1);
    }
  }
  return out;
}

/** `find` as the page's text when it was written as Markdown of one block: `## Plan`, `**done**`, `Plan\_v2`. */
function findAsText(find: string): string | null {
  const blocks = fromMarkdown(find).content ?? [];
  if (blocks.length !== 1) return null;
  const text = plainText(blocks[0] as PMNode).trim();
  return text && text !== find ? text : null;
}

/** A Y.XmlText's runs from `from` to `to`, cut where they cross. Null if an embed is in there. */
function sliceRuns(t: Y.XmlText, from: number, to: number): Run[] | null {
  const out: Run[] = [];
  let pos = 0;
  for (const op of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    const a = Math.max(from, pos);
    const b = Math.min(to, pos + len);
    if (a < b) {
      if (typeof op.insert !== 'string') return null;
      out.push(op.attributes ? { insert: op.insert.slice(a - pos, b - pos), attributes: op.attributes } : { insert: op.insert.slice(a - pos, b - pos) });
    }
    pos += len;
    if (pos >= to) break;
  }
  return out;
}

/** A value as JSON with its keys in order, so two runs' formatting compare. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Runs as one string per stretch of the same formatting. */
function runsKey(runs: Run[]): string {
  const merged: [string, string][] = [];
  for (const r of runs) {
    if (!r.insert) continue;
    const key = stable(r.attributes ?? {});
    const last = merged[merged.length - 1];
    if (last && last[0] === key) last[1] += r.insert;
    else merged.push([key, r.insert]);
  }
  return JSON.stringify(merged);
}

/** The formatting of the character at `index`, as Yjs keeps it: mark names to their attributes. */
function attributesAt(t: Y.XmlText, index: number): Record<string, unknown> {
  let pos = 0;
  for (const op of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    if (index < pos + len) return op.attributes ?? {};
    pos += len;
  }
  return {};
}

/** Blocks as the editor's binding has them (ydoc.ts), unattached, to go into another document. */
function elementsOf(doc: PMNode): Y.XmlElement[] {
  const scratch = new Y.Doc();
  try {
    writeDoc(scratch, doc);
    return scratch
      .getXmlFragment(DOC_FIELD)
      .toArray()
      .filter((e): e is Y.XmlElement => e instanceof Y.XmlElement)
      .map((e) => e.clone());
  } finally {
    scratch.destroy();
  }
}

/** One element as ProseMirror JSON. */
function elementJson(el: Y.XmlElement): PMNode | null {
  const scratch = new Y.Doc();
  try {
    scratch.getXmlFragment(DOC_FIELD).insert(0, [el.clone()]);
    return (jsonOf(scratch).content ?? [])[0] ?? null;
  } catch {
    return null;
  } finally {
    scratch.destroy();
  }
}

/** One textblock's text as Yjs runs, with each mark's attributes as the binding writes them. */
function runsOfBlock(block: PMNode): Run[] {
  const scratch = new Y.Doc();
  try {
    writeDoc(scratch, { type: 'doc', content: [block] });
    const el = scratch.getXmlFragment(DOC_FIELD).get(0);
    const text = el instanceof Y.XmlElement && el.length ? el.get(0) : null;
    return text instanceof Y.XmlText ? (text.toDelta() as Run[]).filter((r) => typeof r.insert === 'string') : [];
  } finally {
    scratch.destroy();
  }
}

/** The text it replaces keeps its formatting, with the Markdown's on top. Code takes no other mark in the schema. */
function mergeAttributes(at: Record<string, unknown>, own: Record<string, unknown> | undefined): Record<string, unknown> {
  const merged = { ...at, ...(own ?? {}) };
  return 'code' in merged ? { code: merged['code'] } : merged;
}

/** Markdown's blocks, checked against the schema with links held to http, https and mailto. */
function cleanBlocks(blocks: PMNode[]): PMNode[] {
  const cleaned = cleanDoc({ type: 'doc', content: blocks });
  if (!cleaned) throw badRequest('markdown');
  return cleaned.doc.content ?? [];
}

/** An element's Yjs id, once it's in a document. */
function idOfElement(el: Y.XmlElement): [number, number] {
  const id = (el._item as Y.Item).id;
  return [id.client, id.clock];
}

const hashOf = (el: Y.XmlElement): string => createHash('sha256').update(el.toString()).digest('base64url');

/** The element with this id, if it's there and not deleted. */
function elementAt(doc: Y.Doc, [client, clock]: [number, number]): Y.XmlElement | null {
  try {
    const item = Y.getItem(doc.store, Y.createID(client, clock));
    if (!(item instanceof Y.Item) || item.deleted) return null;
    const content = item.content;
    return content instanceof Y.ContentType && content.type instanceof Y.XmlElement ? content.type : null;
  } catch {
    return null;
  }
}

const relative = (t: Y.XmlText, index: number, assoc: number): string => Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, index, assoc))).toString('base64');
function absolute(doc: Y.Doc, rel: string): Y.AbsolutePosition | null {
  try {
    return Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(rel, 'base64')), doc);
  } catch {
    return null;
  }
}

/** An empty line with no color: the editor keeps one at a page's end. */
function isEmptyLine(el: unknown): boolean {
  if (!(el instanceof Y.XmlElement) || el.nodeName !== 'paragraph' || el.getAttribute('color')) return false;
  return el.toArray().every((c) => c instanceof Y.XmlText && c.length === 0);
}

/** Same kind of block, the same attributes but its color: the edit can be made in place, inside the block. */
function sameKind(el: Y.XmlElement, node: PMNode): boolean {
  if (!['paragraph', 'heading', 'codeBlock'].includes(node.type) || el.nodeName !== node.type) return false;
  if (el.length !== 1 || !(el.get(0) instanceof Y.XmlText)) return false;
  if (!(node.content ?? []).every((n) => n.type === 'text')) return false;
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    if (k === 'color') {
      if (v !== null && v !== undefined && el.getAttribute('color') !== v) return false;
      continue;
    }
    const has = el.getAttribute(k) as unknown;
    if ((v ?? null) !== (has ?? null) && !(k === 'level' && Number(v) === Number(has))) return false;
  }
  return true;
}

// ------------------------------------------------------------------ the edits, on a copy

/**
 * At the end of the page, before an empty last line: the editor keeps one there, so blocks after it would have every open
 * editor add another.
 */
function appendBlocks(copy: Y.Doc, blocks: PMNode[]): Undo {
  if (!blocks.length) throw badRequest('markdown');
  const fragment = copy.getXmlFragment(DOC_FIELD);
  const elements = elementsOf({ type: 'doc', content: cleanBlocks(blocks) });
  let at = fragment.length;
  if (at > 1 && isEmptyLine(fragment.get(at - 1))) at -= 1;
  fragment.insert(at, elements);
  return { kind: 'blocks', ids: elements.map(idOfElement), hashes: elements.map(hashOf) };
}

/**
 * Exactly one place in the page's text holds `find` (as written, or else as the text of one block of Markdown), inside
 * one block. Markdown that is one paragraph of text replaces it in place, keeping the formatting it replaces; empty
 * Markdown deletes it. A block of the same kind (a heading for a heading) takes its text in place too, the block's own
 * color kept, so what the member types in it meanwhile stays. Anything else (several blocks, a list, another kind)
 * takes the place of the block `find` is all of.
 */
function replaceText(copy: Y.Doc, blocks: PMNode[], find: string): Undo {
  const runs = textRuns(copy.getXmlFragment(DOC_FIELD));
  let hit: { run: TextRun; at: number } | null = null;
  let used = find;
  for (const f of [find, findAsText(find)]) {
    if (!f) continue;
    const found = occurrences(runs, f);
    if (found.length > 1) throw conflict('ambiguous');
    if (found.length === 1) {
      hit = found[0] as { run: TextRun; at: number };
      used = f;
      break;
    }
  }
  if (!hit) throw conflict('not_found');
  const t = hit.run.node;
  const first = blocks[0];
  const inline = blocks.length === 0 || (blocks.length === 1 && first?.type === 'paragraph' && (first.content ?? []).every((n) => n.type === 'text'));
  if (inline) {
    const runsIn = first ? runsOfBlock(cleanBlocks([first])[0] as PMNode) : [];
    const at = attributesAt(t, hit.at);
    const removed = sliceRuns(t, hit.at, hit.at + used.length);
    t.delete(hit.at, used.length);
    let pos = hit.at;
    for (const r of runsIn) {
      if (!r.insert) continue;
      t.insert(pos, r.insert, mergeAttributes(at, r.attributes));
      pos += r.insert.length;
    }
    const inserted = sliceRuns(t, hit.at, pos);
    return removed && inserted ? { kind: 'text', start: relative(t, hit.at, 0), end: relative(t, pos, -1), inserted, removed } : null;
  }
  const block = t.parent;
  if (!(block instanceof Y.XmlElement) || block.length !== 1 || hit.run.plain.trim() !== used.trim()) throw badRequest('whole_block');
  const parent = block.parent;
  if (!(parent instanceof Y.XmlFragment) && !(parent instanceof Y.XmlElement)) throw badRequest('whole_block');
  const cleaned = cleanBlocks(blocks);
  const only = cleaned.length === 1 ? (cleaned[0] as PMNode) : null;
  if (only && sameKind(block, only)) {
    const removed = sliceRuns(t, 0, t.length);
    t.delete(0, t.length);
    let pos = 0;
    for (const r of runsOfBlock(only)) {
      if (!r.insert) continue;
      t.insert(pos, r.insert, r.attributes ?? {});
      pos += r.insert.length;
    }
    const inserted = sliceRuns(t, 0, pos);
    return removed && inserted ? { kind: 'text', start: relative(t, 0, 0), end: relative(t, pos, -1), inserted, removed } : null;
  }
  const index = parent.toArray().indexOf(block);
  const elements = elementsOf({ type: 'doc', content: cleaned });
  // A list item's first block is a paragraph in this schema.
  if (parent instanceof Y.XmlElement && (parent.nodeName === 'listItem' || parent.nodeName === 'taskItem') && index === 0 && elements[0]?.nodeName !== 'paragraph') {
    throw badRequest('markdown');
  }
  if (!elements.length) throw badRequest('markdown');
  const was = elementJson(block);
  parent.delete(index, 1);
  parent.insert(index, elements);
  return was ? { kind: 'block', ids: elements.map(idOfElement), hashes: elements.map(hashOf), removed: was } : null;
}

/** Blocks the agent added, each still there, side by side and as it left them, and their parent and place. */
function unchangedBlocks(copy: Y.Doc, ids: [number, number][], hashes: string[]): { parent: Y.XmlFragment | Y.XmlElement; index: number } {
  const els = ids.map((id) => elementAt(copy, id));
  if (!els.length || els.some((e, i) => !e || hashOf(e) !== hashes[i])) throw new Changed();
  const parent = (els[0] as Y.XmlElement).parent;
  if (!(parent instanceof Y.XmlFragment) && !(parent instanceof Y.XmlElement)) throw new Changed();
  const children = parent.toArray();
  const index = children.indexOf(els[0] as Y.XmlElement);
  if (index < 0 || els.some((e, i) => children[index + i] !== e)) throw new Changed();
  return { parent, index };
}

/** The undo of an edit, on a copy. Throws `Changed` if what the agent put there isn't as it left it. */
function undoChange(copy: Y.Doc, undo: Exclude<Undo, null | { kind: 'page' }>): void {
  if (undo.kind === 'blocks' || undo.kind === 'block') {
    const { parent, index } = unchangedBlocks(copy, undo.ids, undo.hashes);
    parent.delete(index, undo.ids.length);
    if (undo.kind === 'block') {
      const back = elementsOf({ type: 'doc', content: cleanBlocks([undo.removed]) });
      if (!back.length) throw new Changed();
      parent.insert(index, back);
    }
    return;
  }
  const s = absolute(copy, undo.start);
  const e = absolute(copy, undo.end);
  if (!s || !e || s.type !== e.type || !(s.type instanceof Y.XmlText) || s.type._item?.deleted || e.index < s.index) throw new Changed();
  const t = s.type;
  const now = sliceRuns(t, s.index, e.index);
  if (!now || runsKey(now) !== runsKey(undo.inserted)) throw new Changed();
  t.delete(s.index, e.index - s.index);
  let pos = s.index;
  for (const r of undo.removed) {
    if (!r.insert) continue;
    t.insert(pos, r.insert, r.attributes ?? {});
    pos += r.insert.length;
  }
}

interface Planned<T> {
  update: Uint8Array;
  verdict: Verdict | null;
  titleBefore: string;
  titleAfter: string;
  made: T;
  /** The page before, or null when the schema couldn't read it. */
  before: PMNode | null;
  /** The blocks of text the change makes that the page didn't have (`blockMarks`). */
  fresh: string[];
}

interface EditRow {
  id: string;
  page_id: string;
  op: Op;
  agent: string;
  actor: string;
  edit_key: string | null;
  version_id: string | null;
  created_at: number;
  undo: string;
  undone_at: number | null;
  result: string;
  undone_by: string | null;
  untrusted: number;
}

export function agentMethods(deps: RpcDeps, table: Map<string, RpcHandler>, rules: AgentRules): [string, RpcHandler][] {
  const { db, notebook, pages, collab, owners, removals } = deps;
  const now = deps.now ?? Date.now;

  /** As rpc.ts's: a direct connection acts for the caller, on the owner's desk as before. */
  const contextOf = (caller: Caller): CollabContext => (isGuild(caller) ? { actor: actorOf(caller), caller } : { actor: OWNER_ACTOR });

  /** One page's agent edits and undos, one at a time, in the order they came. */
  const queues = new Map<string, Promise<void>>();
  function serial<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
    const before = queues.get(pageId) ?? Promise.resolve();
    const run = before.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(pageId, tail);
    void tail.then(() => {
      if (queues.get(pageId) === tail) queues.delete(pageId);
    });
    return run;
  }

  /**
   * A change, built on a copy of the page and checked as a member's own update is, with nothing applied: the schema,
   * page_full, a full disk, and on a guild desk who wrote what and the edit budget.
   */
  function plan<T>(pageId: string, live: Y.Doc, open: boolean, writers: PageOwners, change: (copy: Y.Doc) => T, caller: Caller, budget: EditBudget): Planned<T> {
    let before: PMNode | null = null;
    try {
      before = jsonOf(live);
    } catch {
      // A page the schema can't read: the edit is still judged, and the title is the stored one.
    }
    const wasValid = before !== null && valid(before);
    const copy = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
      // The body's root typed before anything looks at its items: until then their parent is a plain AbstractType.
      copy.getXmlFragment(DOC_FIELD);
      const sv = Y.encodeStateVector(copy);
      let made: T | undefined;
      copy.transact(() => {
        made = change(copy);
      });
      const update = Y.encodeStateAsUpdate(copy, sv);
      const after = jsonOf(copy);
      if (wasValid && !valid(after)) throw badRequest('markdown');
      // As a member's update is: past what a new client can sync is page_full (an open page by the page's own rule, a
      // closed one by its size after), and a disk that refuses edits refuses this.
      let full: boolean;
      if (open) full = pages.wouldOverflow(pageId, update);
      else {
        const size = Y.encodeStateAsUpdate(copy).length;
        full = !pages.fitsNewPage(size) && size > Y.encodeStateAsUpdate(live).length;
      }
      if (full) throw badRequest('page_full');
      if (pages.refuses(pageId) && updateChanges(update)) throw new RpcError('unavailable', { reason: 'storage_full' });
      let verdict: Verdict | null = null;
      if (isGuild(caller)) {
        const actor = actorOf(caller);
        try {
          verdict = judge(live, update, actor, writers);
        } catch (e) {
          // Never let through what couldn't be judged, as collab.ts doesn't.
          log('ERROR', `judging an agent edit failed page=${pageId} ${errName(e)}`);
          throw forbidden('grant');
        }
        if (verdict.impersonates) throw forbidden('grant');
        if (!mayModerate(caller) && !removals.fits(pageId, actor, verdict.cost, budget)) throw forbidden('budget');
      }
      const had = blockMarks(before);
      const fresh = [...blockMarks(after)].filter((m) => !had.has(m));
      return { update, verdict, titleBefore: before ? titleOf(before) : (notebook.page(pageId)?.title ?? ''), titleAfter: titleOf(after), made: made as T, before, fresh };
    } finally {
      copy.destroy();
    }
  }

  /** The day's activity row says an agent edited the page: `agent:<name>` among its actors. Never fails the edit. */
  function noteAgent(pageId: string, caller: Caller, agentName: string): void {
    const who = `${AGENT_ACTOR}${agentName}`;
    try {
      const at = now();
      const day = notebook.dayOf(at);
      db.tx(() => {
        const row = db.get<{ actors: string }>('SELECT actors FROM page_activity WHERE page_id = ? AND day = ?', pageId, day);
        if (row) {
          let actors: string[] = [];
          try {
            const parsed = JSON.parse(row.actors) as unknown;
            if (Array.isArray(parsed)) actors = parsed.filter((a): a is string => typeof a === 'string');
          } catch {
            // A damaged cell: start again with this.
          }
          if (!actors.includes(who)) db.run('UPDATE page_activity SET actors = ? WHERE page_id = ? AND day = ?', JSON.stringify([...actors, who]), pageId, day);
        } else {
          db.run(
            'INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, ?, 0, ?, ?, 0, 0, 0, ?)',
            pageId,
            day,
            at,
            at,
            JSON.stringify([actorOf(caller), who]),
          );
        }
      });
    } catch (e) {
      log('WARN', `noting an agent edit in activity failed page=${pageId} ${errName(e)}`);
    }
  }

  /**
   * The edit's row, for its undo and its key, and its marks: kept before the edit is made, so an edit is never made without
   * them (Security's ATN-I1 and ATN-M1). A failure here is `unavailable` `storage`, with nothing made.
   */
  function keepEdit(row: Omit<EditRow, 'undone_at' | 'undone_by'>, marks: string[]): void {
    try {
      db.tx(() => {
        db.run('DELETE FROM agent_edits WHERE created_at < ?', row.created_at - KEEP_EDITS_MS);
        db.run(
          'INSERT INTO agent_edits (id, page_id, op, agent, actor, edit_key, version_id, created_at, undo, undone_at, result, undone_by, untrusted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)',
          row.id,
          row.page_id,
          row.op,
          row.agent,
          row.actor,
          row.edit_key,
          row.version_id,
          row.created_at,
          row.undo,
          row.result,
          row.untrusted,
        );
        for (const fp of marks) db.run('INSERT OR IGNORE INTO agent_marks (page_id, fp, edit_id, created_at) VALUES (?, ?, ?, ?)', row.page_id, fp, row.id, row.created_at);
      });
    } catch (e) {
      log('ERROR', `keeping an agent edit failed page=${row.page_id} ${errName(e)}`);
      throw new RpcError('unavailable', { reason: 'storage' });
    }
  }

  /** An edit kept that then wasn't made: its row and marks go, so its key can run it again. */
  function forgetEdit(editId: string): void {
    try {
      db.tx(() => {
        db.run('DELETE FROM agent_marks WHERE edit_id = ?', editId);
        db.run('DELETE FROM agent_edits WHERE id = ?', editId);
      });
    } catch (e) {
      log('ERROR', `forgetting an agent edit that wasn't made failed ${errName(e)}`);
    }
  }

  /** The page's marked text, by its hash: all that an agent wrote from a run holding U, whether or not the page still has it. */
  const marksOf = (pageId: string): Set<string> => new Set(db.all<{ fp: string }>('SELECT fp FROM agent_marks WHERE page_id = ?', pageId).map((r) => r.fp));

  /**
   * Whether the page holds text an agent wrote from a run holding U: one of its blocks reads as a marked one does. The
   * member's own change to that block's words or links ends it; a version that brings the text back brings it back. A
   * page with marks whose body can't be read counts as holding one.
   */
  function holdsMark(pageId: string, blocks: Set<string> | null): boolean {
    const marks = marksOf(pageId);
    if (!marks.size) return false;
    if (!blocks) return true;
    for (const m of blocks) if (marks.has(m)) return true;
    return false;
  }

  /** Of these pages, those that hold marked text. Only pages with marks are opened. */
  function markedPages(pageIds: string[]): string[] {
    if (!pageIds.length) return [];
    const withMarks = new Set(db.all<{ page_id: string }>(`SELECT DISTINCT page_id FROM agent_marks WHERE page_id IN (${pageIds.map(() => '?').join(', ')})`, ...pageIds).map((r) => r.page_id));
    return pageIds.filter((id) => withMarks.has(id) && holdsMark(id, blocksNow(id)));
  }

  /** The current body's blocks of text (`blockMarks`), live if the page is open; null if it can't be read. */
  function blocksNow(pageId: string): Set<string> | null {
    const body = bodyNow(pageId);
    return body ? blockMarks(body) : null;
  }

  const newEditId = (): string => `ae-${randomBytes(12).toString('base64url')}`;

  /** A key deskd has sent before: that edit's answer again, and nothing done. */
  function repeated(key: string | null): Record<string, unknown> | null {
    if (!key) return null;
    const row = db.get<{ result: string }>('SELECT result FROM agent_edits WHERE edit_key = ?', key);
    if (!row) return null;
    try {
      return { ...(JSON.parse(row.result) as Record<string, unknown>), repeated: true };
    } catch {
      return null;
    }
  }

  function create(tabId: string, title: string, markdown: string, caller: Caller, agentName: string, dryRun: boolean, key: string | null, untrusted: boolean): Record<string, unknown> {
    const again = repeated(key);
    if (again) return again;
    const { doc: parsed, converted } = readMarkdown(markdown);
    const blocks = parsed.content ?? [];
    // The title is the page's first line, a Title. Markdown that starts with the same title doesn't say it twice.
    const lead = blocks[0];
    if (lead?.type === 'heading' && Number(lead.attrs?.['level']) === 1 && plainText(lead).trim() === title) blocks.shift();
    const body = cleanDoc({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }, ...blocks] });
    if (!body) throw badRequest('markdown');
    if (!db.get('SELECT id FROM tabs WHERE id = ?', tabId)) throw notFound();
    const made = docState(body.doc);
    if (!pages.fitsNewPage(made.state.length)) throw badRequest('page_full');
    if (dryRun) return { pageId: null, title, op: 'create', dryRun: true, converted, tabId };
    // On a guild desk the body is the member's, as an import's is: its client id goes in page_clients with the page.
    const owned = isGuild(caller)
      ? (page: { id: string }) => db.run('INSERT OR IGNORE INTO page_clients (page_id, client, member_id) VALUES (?, ?, ?)', page.id, made.client, actorOf(caller))
      : undefined;
    const page = notebook.addPage(tabId, null, { state: made.state, doc: body.doc, label: null }, actorOf(caller), owned);
    const editId = newEditId();
    const result = { pageId: page.id, title: page.title, op: 'create', versionId: null, editId, converted, untrusted };
    try {
      keepEdit(
        {
          id: editId,
          page_id: page.id,
          op: 'create',
          agent: agentName,
          actor: actorOf(caller),
          edit_key: key,
          version_id: null,
          created_at: now(),
          undo: JSON.stringify({ kind: 'page', fingerprint: fingerprint(body.doc) } satisfies Undo),
          result: JSON.stringify(result),
          untrusted: untrusted ? 1 : 0,
        },
        untrusted ? [...blockMarks(body.doc)] : [],
      );
    } catch (e) {
      // Nobody has the page yet: it goes, rather than stay with no mark, no undo and no key.
      try {
        db.tx(() => {
          notebook.purgePage(page.id);
          notebook.bumpRev();
        });
        notebook.announce();
      } catch (purge) {
        log('ERROR', `taking back an agent's page failed page=${page.id} ${errName(purge)}`);
      }
      throw e;
    }
    noteAgent(page.id, caller, agentName);
    log('INFO', `agent edit page=${page.id} op=create`);
    return result;
  }

  async function edit(pageId: string, op: Exclude<Op, 'create'>, markdown: string, find: string | null, caller: Caller, budget: EditBudget, agentName: string, dryRun: boolean, key: string | null, fromUntrusted: boolean, tab: string | null = null): Promise<Record<string, unknown>> {
    // An agent edits no page in the Trash, whoever it works for: the member brings it back first.
    const first = notebook.mustPage(pageId);
    if (first.deleted_at != null) throw conflict('trashed');
    if (tab !== null && first.tab_id !== tab) throw place();
    const { doc: parsed, converted } = readMarkdown(markdown);
    const blocks = parsed.content ?? [];
    const change = (copy: Y.Doc): Undo => (op === 'append' ? appendBlocks(copy, blocks) : replaceText(copy, blocks, find as string));
    if (dryRun) {
      const open = pages.open.get(pageId);
      const doc = open?.doc ?? new Y.Doc({ gc: true });
      try {
        if (!open) pages.readInto(pageId, doc);
        const planned = plan(pageId, doc, !!open, open ? owners.of(pageId) : owners.read(pageId), change, caller, budget);
        return { pageId, title: planned.titleBefore, op, dryRun: true, converted, tabId: first.tab_id };
      } finally {
        if (!open) doc.destroy();
      }
    }
    return serial(pageId, async () => {
      const again = repeated(key);
      if (again) return again;
      const actor = actorOf(caller);
      let conn: Awaited<ReturnType<typeof collab.openDirectConnection>>;
      try {
        conn = await collab.openDirectConnection(pageId, contextOf(caller));
      } catch (e) {
        if (!notebook.page(pageId)) throw notFound();
        throw e;
      }
      try {
        const live = conn.document;
        const row = notebook.page(pageId);
        if (!live || !row) throw notFound();
        if (row.deleted_at != null) throw conflict('trashed');
        // An edit with no card stays in the member's switch's tab: the page's tab now, in its queue (draft ADR §15).
        if (tab !== null && row.tab_id !== tab) throw place();
        // From here to the transaction nothing awaits, so the update is built on exactly the page it's applied to.
        const planned = plan(pageId, live, true, owners.of(pageId), change, caller, budget);
        // The page as it is now is a version first, so the member can go back to it.
        let stored = false;
        try {
          stored = pages.store(pageId, 'pre_agent', actor);
        } catch (e) {
          log('ERROR', `pre_agent version failed page=${pageId} ${errName(e)}`);
        }
        if (!stored) throw new RpcError('unavailable', { reason: 'storage' });
        const version = pages.versions(pageId).find((v) => v.reason === 'pre_agent');
        // Marked when the run held U, and when the page already held marked text: a run that read it would hold U, and
        // this one may have written over it without reading it.
        const untrusted = fromUntrusted || holdsMark(pageId, planned.before ? blockMarks(planned.before) : null);
        const editId = newEditId();
        const result = { pageId, title: planned.titleAfter, op, versionId: version?.id ?? null, editId, converted, untrusted };
        keepEdit(
          {
            id: editId,
            page_id: pageId,
            op,
            agent: agentName,
            actor,
            edit_key: key,
            version_id: version?.id ?? null,
            created_at: now(),
            undo: JSON.stringify(planned.made),
            result: JSON.stringify(result),
            untrusted: untrusted ? 1 : 0,
          },
          untrusted ? planned.fresh : [],
        );
        try {
          if (planned.verdict) {
            owners.record(pageId, actor, planned.verdict);
            if (!mayModerate(caller)) removals.charge(pageId, actor, planned.verdict.cost, budget);
          }
          await conn.transact((doc) => Y.applyUpdate(doc, planned.update));
        } catch (e) {
          forgetEdit(editId);
          throw e;
        }
        // onChange runs from a promise chain: let it, so the store below sees the edit.
        await nextTick();
        pages.storeQuietly(pageId);
        noteAgent(pageId, caller, agentName);
        log('INFO', `agent edit page=${pageId} op=${op}`);
        return result;
      } finally {
        await conn.disconnect();
      }
    });
  }

  /** The current body of a page, live if it's open. */
  function bodyNow(pageId: string): PMNode | null {
    const open = pages.open.get(pageId);
    try {
      if (open) return jsonOf(open.doc);
      return JSON.parse(pages.contentText(pageId)) as PMNode;
    } catch {
      return null;
    }
  }

  async function undo(row: EditRow, caller: Caller, budget: EditBudget, agent: string | null = null): Promise<Record<string, unknown>> {
    // deskd's undo of an unasked edit names its agent: another agent's edit is no such edit.
    if (agent !== null && row.agent !== agent) throw notFound();
    if (row.undone_at != null) throw conflict('undone');
    // On a guild desk: the member whose agent made it, or a moderator.
    if (isGuild(caller) && !mayModerate(caller) && row.actor !== actorOf(caller)) throw forbidden('grant');
    let spec: Undo;
    try {
      spec = JSON.parse(row.undo) as Undo;
    } catch {
      spec = null;
    }
    const changed = (): RpcError => conflict('changed', row.version_id ? { versionId: row.version_id } : {});
    if (!spec) throw changed();
    const page = notebook.page(row.page_id);
    if (!page) throw notFound();
    if (page.deleted_at != null) throw conflict('trashed');
    const done = (): Record<string, unknown> => {
      db.run('UPDATE agent_edits SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL', now(), actorOf(caller), row.id);
      log('INFO', `agent edit undone page=${row.page_id} op=${row.op}`);
      return { editId: row.id, pageId: row.page_id, op: row.op, undone: true };
    };
    // The newest first: an agent write is undone only once every later one on the page is, so each undo takes the page
    // back exactly to that write's pre_agent state (the test desk's release check, Nov 13: an append's Undo used to go
    // under a newer replace, which stayed). The answer names the newer edit, for the member's Undo of that one first.
    // After the grant and Trash checks, so a caller who may not undo hears that (Security's AAB-I4), and in the page's
    // queue for an edit inside the page, so it's read as the undo runs.
    const newestFirst = (): void => {
      const newer = db.get<{ id: string }>(
        'SELECT id FROM agent_edits WHERE page_id = ? AND undone_at IS NULL AND rowid > (SELECT rowid FROM agent_edits WHERE id = ?) ORDER BY rowid DESC LIMIT 1',
        row.page_id,
        row.id,
      );
      if (newer) throw conflict('newer', { editId: newer.id });
    };
    if (spec.kind === 'page') {
      rules.mayTrash(row.page_id, caller);
      newestFirst();
      const body = bodyNow(row.page_id);
      if (!body || fingerprint(body) !== spec.fingerprint) throw changed();
      notebook.trashPage(row.page_id, actorOf(caller));
      return done();
    }
    const kind = spec;
    return serial(row.page_id, async () => {
      const conn = await collab.openDirectConnection(row.page_id, contextOf(caller));
      try {
        const live = conn.document;
        if (!live) throw notFound();
        if (notebook.page(row.page_id)?.deleted_at != null) throw conflict('trashed');
        newestFirst();
        let planned: Planned<void>;
        try {
          planned = plan(row.page_id, live, true, owners.of(row.page_id), (copy) => undoChange(copy, kind), caller, budget);
        } catch (e) {
          if (e instanceof Changed) throw changed();
          throw e;
        }
        if (planned.verdict) {
          owners.record(row.page_id, actorOf(caller), planned.verdict);
          if (!mayModerate(caller)) removals.charge(row.page_id, actorOf(caller), planned.verdict.cost, budget);
        }
        await conn.transact((doc) => Y.applyUpdate(doc, planned.update));
        await nextTick();
        pages.storeQuietly(row.page_id);
        return done();
      } finally {
        await conn.disconnect();
      }
    });
  }

  const editRow = (p: Params): EditRow => {
    const key = optKey(p);
    const editId = absent(p, 'editId') ? null : idOf(p, 'editId');
    if (!editId === !key) throw badRequest(editId ? 'key' : 'editId');
    const row = editId ? db.get<EditRow>('SELECT * FROM agent_edits WHERE id = ?', editId) : db.get<EditRow>('SELECT * FROM agent_edits WHERE edit_key = ?', key);
    if (!row) throw notFound();
    return row;
  };

  /** pre_agent versions say whose edit came after them, and its id for its undo. */
  const withAgents = (versions: VersionMeta[]): VersionMeta[] => {
    const ids = versions.filter((v) => v.reason === 'pre_agent').map((v) => v.id);
    if (!ids.length) return versions;
    const byVersion = new Map<string, { id: string; agent: string; undone_at: number | null }>();
    for (const id of ids) {
      const r = db.get<{ id: string; agent: string; undone_at: number | null }>('SELECT id, agent, undone_at FROM agent_edits WHERE version_id = ?', id);
      if (r) byVersion.set(id, r);
    }
    return versions.map((v) => {
      const r = byVersion.get(v.id);
      return r ? { ...v, agent: r.agent, editId: r.id, undone: r.undone_at != null } : v;
    });
  };

  const content = table.get('notebook.page.content') as RpcHandler;
  /** The last few pages read, as Markdown, by the hash of the body they were written from. */
  const reads = new Map<string, { key: string; markdown: string; title: string; blocks: Set<string> }>();
  const versionList = table.get('notebook.version.list') as RpcHandler;
  const versionGet = table.get('notebook.version.get') as RpcHandler;

  return [
    [
      'notebook.page.markdown',
      (p, parts, caller, budget) => {
        const pageId = idOf(p, 'pageId');
        const from = optCount(p, 'from', Number.MAX_SAFE_INTEGER) ?? 0;
        const max = optCount(p, 'max', READ_CHARS) ?? READ_CHARS;
        // Through page.content, so the read rule is exactly its own: on a guild desk a trashed page is a moderator's.
        let json = '';
        let cursor: string | null = null;
        do {
          const r = content({ pageId, ...(cursor ? { cursor } : {}) }, parts, caller, budget) as { part: string; next: string | null };
          json += r.part;
          cursor = r.next;
        } while (cursor);
        // A long page is read in parts, each its own call: the page as it is now is written as Markdown once.
        const key = createHash('sha256').update(json).digest('base64url');
        let made = reads.get(pageId);
        if (made?.key !== key) {
          const doc = JSON.parse(json) as PMNode;
          made = { key, markdown: pageMarkdown(doc), title: titleOf(doc), blocks: blockMarks(doc) };
          reads.delete(pageId);
          reads.set(pageId, made);
          while (reads.size > READS_KEPT) reads.delete(reads.keys().next().value as string);
        }
        const { markdown, title, blocks } = made;
        if (from > markdown.length) throw badRequest('from');
        const end = cutAt(markdown, from, max);
        return {
          pageId,
          title,
          markdown: markdown.slice(from, end),
          from,
          next: end < markdown.length ? end : null,
          length: markdown.length,
          trashed: notebook.page(pageId)?.deleted_at != null,
          // Text an agent wrote from a run holding U is still on the page: deskd adds U to the run that reads it.
          untrusted: holdsMark(pageId, blocks),
        };
      },
    ],
    [
      'notebook.outline',
      (p) => {
        if (absent(p, 'tabId')) {
          if (!absent(p, 'from')) throw badRequest('from');
          // Every notebook and its tabs in the member's order, each with how many pages it has: the way to a tab for a new page.
          const notebooks = db.all<{ id: string; title: string }>('SELECT id, title FROM notebooks WHERE deleted_at IS NULL ORDER BY sort_key, created_at');
          const counts = new Map(db.all<{ tab_id: string; n: number }>('SELECT tab_id, COUNT(*) AS n FROM pages WHERE deleted_at IS NULL GROUP BY tab_id').map((r) => [r.tab_id, r.n]));
          let left = OUTLINE_TABS;
          let more = false;
          const out = notebooks.map((n) => {
            const tabs = db.all<{ id: string; title: string }>('SELECT id, title FROM tabs WHERE notebook_id = ? ORDER BY sort_key, created_at', n.id);
            const shown = tabs.slice(0, Math.max(0, left));
            if (shown.length < tabs.length) more = true;
            left -= shown.length;
            return { notebookId: n.id, title: n.title, tabs: shown.map((t) => ({ tabId: t.id, title: t.title, pages: counts.get(t.id) ?? 0 })) };
          });
          return { notebooks: out, more };
        }
        const tabId = idOf(p, 'tabId');
        const tab = db.get<{ id: string; title: string; notebook_id: string }>('SELECT id, title, notebook_id FROM tabs WHERE id = ?', tabId);
        if (!tab) throw notFound();
        const from = optCount(p, 'from', Number.MAX_SAFE_INTEGER) ?? 0;
        const rows = db.all<{ id: string; title: string; updated_at: number }>(
          `SELECT id, title, updated_at FROM pages WHERE tab_id = ? AND deleted_at IS NULL ORDER BY sort_key, created_at LIMIT ${OUTLINE_PAGES + 1} OFFSET ?`,
          tabId,
          from,
        );
        const shown = rows.slice(0, OUTLINE_PAGES);
        return {
          tabId,
          title: tab.title,
          notebookId: tab.notebook_id,
          pages: shown.map((r) => ({ pageId: r.id, title: r.title, updatedAt: r.updated_at })),
          from,
          next: rows.length > OUTLINE_PAGES ? from + OUTLINE_PAGES : null,
          // A page's title is its first line, which an agent may have written from a run holding U.
          untrusted: markedPages(shown.map((r) => r.id)).length > 0,
        };
      },
    ],
    [
      'notebook.page.agentEdit',
      (p, _parts, caller, budget) => {
        const op = p['op'];
        if (op !== 'create' && op !== 'append' && op !== 'replace_text') throw badRequest('op');
        const markdown = p['markdown'];
        if (typeof markdown !== 'string') throw badRequest('markdown');
        if (markdown.length > MAX_MARKDOWN) throw new RpcError('too_large', { reason: 'markdown' });
        const agentName = cleanLine(p['agentName'], AGENT_NAME_MAX);
        if (!agentName) throw badRequest('agentName');
        if (!absent(p, 'dryRun') && typeof p['dryRun'] !== 'boolean') throw badRequest('dryRun');
        const dryRun = p['dryRun'] === true;
        // deskd's own copy of the run's taint: true when the run read untrusted content (Security's ATN-M1).
        if (!absent(p, 'untrusted') && typeof p['untrusted'] !== 'boolean') throw badRequest('untrusted');
        const untrusted = p['untrusted'] === true;
        const key = optKey(p);
        // deskd's record of the switch's tab, for an edit made with no card (draft ADR §15).
        const tab = absent(p, 'tab') ? null : idOf(p, 'tab');
        if (tab !== null && op === 'replace_text') throw badRequest('tab');
        if (op === 'create') {
          if (!absent(p, 'pageId')) throw badRequest('pageId');
          if (!absent(p, 'find')) throw badRequest('find');
          const made = p['new'];
          if (!isObj(made)) throw badRequest('new');
          const tabId = idOf(made, 'tabId');
          if (tab !== null && tabId !== tab) throw place();
          const title = cleanLine(made['title'], TITLE_MAX);
          if (!title) throw badRequest('title');
          return create(tabId, title, markdown, caller, agentName, dryRun, key, untrusted);
        }
        if (!absent(p, 'new')) throw badRequest('new');
        const pageId = idOf(p, 'pageId');
        let find: string | null = null;
        if (op === 'replace_text') {
          const f = p['find'];
          if (typeof f !== 'string' || !f || f.length > MAX_MARKDOWN) throw badRequest('find');
          find = f;
        } else {
          if (!absent(p, 'find')) throw badRequest('find');
          if (!markdown.trim()) throw badRequest('markdown');
        }
        return edit(pageId, op, markdown, find, caller, budget, agentName, dryRun, key, untrusted, tab);
      },
    ],
    [
      'notebook.page.agentEdits',
      (p, _parts, caller) => {
        const pageId = idOf(p, 'pageId');
        notebook.mustPage(pageId);
        rules.mayRead(pageId, caller);
        const rows = db.all<EditRow>(`SELECT * FROM agent_edits WHERE page_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ${EDITS_LISTED}`, pageId, now() - KEEP_EDITS_MS);
        return {
          edits: rows.map((r) => ({ editId: r.id, op: r.op, agent: r.agent, at: r.created_at, versionId: r.version_id, undone: r.undone_at != null })),
        };
      },
    ],
    [
      'notebook.page.agentUndo',
      (p, _parts, caller, budget) => {
        const agent = absent(p, 'agent') ? null : cleanLine(p['agent'], AGENT_NAME_MAX);
        if (agent === '') throw badRequest('agent');
        return undo(editRow(p), caller, budget, agent);
      },
    ],
    [
      // For deskd's search: which of these pages hold text an agent wrote from a run holding U. Pages the caller can't
      // read aren't said.
      'notebook.page.marked',
      (p, _parts, caller) => {
        const ids = p['pageIds'];
        if (!Array.isArray(ids) || ids.length > MARKED_MAX || !ids.every((id) => typeof id === 'string' && KEY.test(id))) throw badRequest('pageIds');
        const readable = (ids as string[]).filter((id) => {
          if (!notebook.page(id)) return false;
          try {
            rules.mayRead(id, caller);
            return true;
          } catch {
            return false;
          }
        });
        return { marked: markedPages([...new Set(readable)]) };
      },
    ],
    // Versions before an agent's edit say whose it was and how to undo it.
    [
      'notebook.version.list',
      (p, parts, caller, budget) => {
        const r = versionList(p, parts, caller, budget) as { versions: VersionMeta[] };
        return { ...r, versions: withAgents(r.versions) };
      },
    ],
    [
      'notebook.version.get',
      (p, parts, caller, budget) => {
        const r = versionGet(p, parts, caller, budget) as { meta: VersionMeta | null };
        return r.meta ? { ...r, meta: withAgents([r.meta])[0] } : r;
      },
    ],
  ];
}

export type { Conversion };
