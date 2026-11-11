// The Agent's Notebook tools, on the desk's side (draft ADR "the Agent's tools and approvals" sections 2 and 8;
// services/deskd/docs/API.md section 18): a page as Markdown, and an agent's edit of the live page. deskd calls them on a
// connection of its own whose caller is the member the agent works for: the owner, or on a guild desk the member whose
// agent it is. So every rule is that member's, as for an edit they make themselves: their grants, the edit budget, a
// trashed page's rules and page_full. deskd's relay doesn't list these, so no client reaches them; deskd has already
// had the member's approval for an edit by the time it calls.
//
//   notebook.page.markdown   {pageId, from?, max?} -> {pageId, title, markdown, from, next, length, trashed}
//   notebook.page.agentEdit  {pageId | new: {tabId, title}, op, markdown, find?, agentName, dryRun?}
//                            -> {pageId, title, op, versionId}
//
// An edit goes into the live Y.Doc through Hocuspocus's own document, as a direct connection's transaction, so every
// open editor sees it at once and merges with it. It's built on a copy first, so on a guild desk it's judged and
// charged before anything is applied, as restoreAsMember's is. A version with reason `pre_agent` is written before it,
// and the day's activity row gets `agent:<agentName>` among its actors. Logs say page ids and the op, never text.
import { setImmediate as nextTick } from 'node:timers/promises';
import { Node } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { actorOf, isGuild, mayModerate, type Caller } from './caller.ts';
import { type CollabContext } from './collab.ts';
import { badRequest, notFound, RpcError } from './errors.ts';
import { errName, log } from './log.ts';
import { fromMarkdown, plainText } from './markdown.ts';
import { cleanDoc, derive, docState, DOC_FIELD, notebookSchema, toMarkdown, updateChanges, writeDoc, type PMNode } from './model.ts';
import { OWNER_ACTOR } from './notebook.ts';
import { judge, type PageOwners, type Verdict } from './owners.ts';
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

type Params = Record<string, unknown>;
type Op = 'create' | 'append' | 'replace_text';

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
const forbidden = (reason: 'grant' | 'budget'): RpcError => new RpcError('forbidden', { reason });
const conflict = (reason: string): RpcError => new RpcError('conflict', { reason });

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

/** One paragraph's text as Yjs runs, with each mark's attributes as the binding writes them. */
function runsOf(paragraph: PMNode): { insert: string; attributes?: Record<string, unknown> }[] {
  const scratch = new Y.Doc();
  try {
    writeDoc(scratch, { type: 'doc', content: [paragraph] });
    const el = scratch.getXmlFragment(DOC_FIELD).get(0);
    const text = el instanceof Y.XmlElement && el.length ? el.get(0) : null;
    return text instanceof Y.XmlText ? (text.toDelta() as { insert: string; attributes?: Record<string, unknown> }[]).filter((r) => typeof r.insert === 'string') : [];
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

/** At the end of the page. */
function append(copy: Y.Doc, blocks: PMNode[]): void {
  if (!blocks.length) throw badRequest('markdown');
  writeDoc(copy, { type: 'doc', content: cleanBlocks(blocks) });
}

/**
 * Exactly one place in the page's text holds `find` (as written, or else as the text of one block of Markdown), inside
 * one block. Markdown that is one paragraph of text replaces it in place, keeping the formatting it replaces; empty
 * Markdown deletes it. Anything else (several blocks, a list, a heading) takes the place of the block `find` is all of.
 */
function replaceText(copy: Y.Doc, blocks: PMNode[], find: string): void {
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
    const runsIn = first ? runsOf(cleanBlocks([first])[0] as PMNode) : [];
    const at = attributesAt(t, hit.at);
    t.delete(hit.at, used.length);
    let pos = hit.at;
    for (const r of runsIn) {
      if (!r.insert) continue;
      t.insert(pos, r.insert, mergeAttributes(at, r.attributes));
      pos += r.insert.length;
    }
    return;
  }
  const block = t.parent;
  if (!(block instanceof Y.XmlElement) || block.length !== 1 || hit.run.plain.trim() !== used.trim()) throw badRequest('whole_block');
  const parent = block.parent;
  if (!(parent instanceof Y.XmlFragment) && !(parent instanceof Y.XmlElement)) throw badRequest('whole_block');
  const index = parent.toArray().indexOf(block);
  const elements = elementsOf({ type: 'doc', content: cleanBlocks(blocks) });
  // A list item's first block is a paragraph in this schema.
  if (parent instanceof Y.XmlElement && (parent.nodeName === 'listItem' || parent.nodeName === 'taskItem') && index === 0 && elements[0]?.nodeName !== 'paragraph') {
    throw badRequest('markdown');
  }
  parent.delete(index, 1);
  parent.insert(index, elements);
}

interface Planned {
  update: Uint8Array;
  verdict: Verdict | null;
  titleBefore: string;
  titleAfter: string;
}

export function agentMethods(deps: RpcDeps, table: Map<string, RpcHandler>): [string, RpcHandler][] {
  const { db, notebook, pages, collab, owners, removals } = deps;
  const now = deps.now ?? Date.now;

  /** As rpc.ts's: a direct connection acts for the caller, on the owner's desk as before. */
  const contextOf = (caller: Caller): CollabContext => (isGuild(caller) ? { actor: actorOf(caller), caller } : { actor: OWNER_ACTOR });

  /**
   * The edit, built on a copy of the page and checked as a member's own update is, with nothing applied: the schema,
   * page_full, a full disk, and on a guild desk who wrote what and the edit budget.
   */
  function plan(pageId: string, live: Y.Doc, open: boolean, writers: PageOwners, op: Exclude<Op, 'create'>, blocks: PMNode[], find: string | null, caller: Caller, budget: EditBudget): Planned {
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
      const sv = Y.encodeStateVector(copy);
      copy.transact(() => (op === 'append' ? append(copy, blocks) : replaceText(copy, blocks, find as string)));
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
      return { update, verdict, titleBefore: before ? titleOf(before) : (notebook.page(pageId)?.title ?? ''), titleAfter: titleOf(after) };
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

  function create(tabId: string, title: string, markdown: string, caller: Caller, agentName: string, dryRun: boolean): Record<string, unknown> {
    const blocks = fromMarkdown(markdown).content ?? [];
    // The title is the page's first line, a Title. Markdown that starts with the same title doesn't say it twice.
    const lead = blocks[0];
    if (lead?.type === 'heading' && Number(lead.attrs?.['level']) === 1 && plainText(lead).trim() === title) blocks.shift();
    const body = cleanDoc({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }, ...blocks] });
    if (!body) throw badRequest('markdown');
    if (!db.get('SELECT id FROM tabs WHERE id = ?', tabId)) throw notFound();
    const made = docState(body.doc);
    if (!pages.fitsNewPage(made.state.length)) throw badRequest('page_full');
    if (dryRun) return { pageId: null, title, op: 'create', dryRun: true };
    // On a guild desk the body is the member's, as an import's is: its client id goes in page_clients with the page.
    const owned = isGuild(caller)
      ? (page: { id: string }) => db.run('INSERT OR IGNORE INTO page_clients (page_id, client, member_id) VALUES (?, ?, ?)', page.id, made.client, actorOf(caller))
      : undefined;
    const page = notebook.addPage(tabId, null, { state: made.state, doc: body.doc, label: null }, actorOf(caller), owned);
    noteAgent(page.id, caller, agentName);
    log('INFO', `agent edit page=${page.id} op=create`);
    return { pageId: page.id, title: page.title, op: 'create', versionId: null };
  }

  async function edit(pageId: string, op: Exclude<Op, 'create'>, markdown: string, find: string | null, caller: Caller, budget: EditBudget, agentName: string, dryRun: boolean): Promise<Record<string, unknown>> {
    // An agent edits no page in the Trash, whoever it works for: the member brings it back first.
    if (notebook.mustPage(pageId).deleted_at != null) throw conflict('trashed');
    const blocks = fromMarkdown(markdown).content ?? [];
    if (dryRun) {
      const open = pages.open.get(pageId);
      const doc = open?.doc ?? new Y.Doc({ gc: true });
      try {
        if (!open) pages.readInto(pageId, doc);
        const planned = plan(pageId, doc, !!open, open ? owners.of(pageId) : owners.read(pageId), op, blocks, find, caller, budget);
        return { pageId, title: planned.titleBefore, op, dryRun: true };
      } finally {
        if (!open) doc.destroy();
      }
    }
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
      // From here to the transaction nothing awaits, so the update is built on exactly the page it's applied to.
      const planned = plan(pageId, live, true, owners.of(pageId), op, blocks, find, caller, budget);
      // The page as it is now is a version first, so the member can go back to it.
      let stored = false;
      try {
        stored = pages.store(pageId, 'pre_agent', actor);
      } catch (e) {
        log('ERROR', `pre_agent version failed page=${pageId} ${errName(e)}`);
      }
      if (!stored) throw new RpcError('unavailable', { reason: 'storage' });
      const version = pages.versions(pageId).find((v) => v.reason === 'pre_agent');
      if (planned.verdict) {
        owners.record(pageId, actor, planned.verdict);
        if (!mayModerate(caller)) removals.charge(pageId, actor, planned.verdict.cost, budget);
      }
      await conn.transact((doc) => Y.applyUpdate(doc, planned.update));
      // onChange runs from a promise chain: let it, so the store below sees the edit.
      await nextTick();
      pages.storeQuietly(pageId);
      noteAgent(pageId, caller, agentName);
      log('INFO', `agent edit page=${pageId} op=${op}`);
      return { pageId, title: planned.titleAfter, op, versionId: version?.id ?? null };
    } finally {
      await conn.disconnect();
    }
  }

  const content = table.get('notebook.page.content') as RpcHandler;

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
        const doc = JSON.parse(json) as PMNode;
        const markdown = toMarkdown(doc);
        if (from > markdown.length) throw badRequest('from');
        const end = cutAt(markdown, from, max);
        return {
          pageId,
          title: titleOf(doc),
          markdown: markdown.slice(from, end),
          from,
          next: end < markdown.length ? end : null,
          length: markdown.length,
          trashed: notebook.page(pageId)?.deleted_at != null,
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
        if (op === 'create') {
          if (!absent(p, 'pageId')) throw badRequest('pageId');
          if (!absent(p, 'find')) throw badRequest('find');
          const made = p['new'];
          if (!isObj(made)) throw badRequest('new');
          const tabId = idOf(made, 'tabId');
          const title = cleanLine(made['title'], TITLE_MAX);
          if (!title) throw badRequest('title');
          return create(tabId, title, markdown, caller, agentName, dryRun);
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
        return edit(pageId, op, markdown, find, caller, budget, agentName, dryRun);
      },
    ],
  ];
}
