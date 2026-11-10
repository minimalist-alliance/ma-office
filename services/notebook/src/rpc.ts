// The contract's method table: one function per `notebook.*`, each checking its own params.
import { setImmediate as nextTick } from 'node:timers/promises';
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { actorOf, isGuild, mayModerate, type Caller } from './caller.ts';
import { type CollabContext } from './collab.ts';
import { type Db } from './db.ts';
import { badRequest, notFound, RpcError } from './errors.ts';
import { log } from './log.ts';
import { type Members } from './members.ts';
import { DOC_FIELD, TAB_COLORS, type ActivityRow, type TabColor, type VersionMeta } from './model.ts';
import { MAX_NAME, OWNER_ACTOR, type Notebook, type PageRow } from './notebook.ts';
import { holdsOthersText, judge, type Owners, type Removals } from './owners.ts';
import { type Pages } from './pages.ts';
import { type EditBudget } from './settings.ts';
import { search, MAX_LIMIT } from './search.ts';
import { validZone } from './zones.ts';

/** A page's or version's JSON comes in parts of at most this many bytes of UTF-8. */
export const PART_BYTES = 512 * 1024;
/** And quoting it inside a reply must still fit REQ/RES's 1 MiB. */
const PART_QUOTED_BYTES = 1000 * 1024;

type Params = Record<string, unknown>;

const idOf = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || !v || v.length > 128) throw badRequest(key);
  return v;
};
const optId = (p: Params, key: string): string | undefined => (p[key] === undefined || p[key] === null ? undefined : idOf(p, key));
const name = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || v.length > MAX_NAME) throw badRequest(key);
  return v;
};
const optName = (p: Params, key: string): string | undefined => (p[key] === undefined || p[key] === null ? undefined : name(p, key));
const color = (p: Params, key: string): TabColor => {
  const v = p[key];
  if (typeof v !== 'string' || !(TAB_COLORS as readonly string[]).includes(v)) throw badRequest(key);
  return v as TabColor;
};
const day = (p: Params, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(key);
  return v;
};
const optDay = (p: Params, key: string): string | undefined => (p[key] === undefined || p[key] === null ? undefined : day(p, key));
const optIndex = (p: Params, key: string): number | undefined => {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw badRequest(key);
  return v;
};
const optCursor = (p: Params): string | undefined => {
  const v = p['cursor'];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > 400) throw badRequest('cursor');
  return v;
};

/** The longest slice from `start` that fits both limits and doesn't split a surrogate pair. */
export function cutPart(text: string, start: number): number {
  let end = Math.min(text.length, start + PART_BYTES);
  for (;;) {
    if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end -= 1;
    const part = text.slice(start, end);
    const raw = Buffer.byteLength(part);
    const quoted = Buffer.byteLength(JSON.stringify(part));
    if (raw <= PART_BYTES && quoted <= PART_QUOTED_BYTES) return end;
    const shrink = Math.min(PART_BYTES / raw, PART_QUOTED_BYTES / quoted) * 0.95;
    end = start + Math.max(1, Math.floor((end - start) * shrink));
  }
}

const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOTS_PER_SESSION = 4;

/** Part 2 of a page being typed in must still fit part 1, so a long read holds one snapshot of its text. */
export class Parts {
  private snapshots = new Map<string, { key: string; text: string; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  read(key: string, cursor: string | undefined, text: () => string): { part: string; next: string | null } {
    let token: string;
    let start: number;
    let full: string;
    if (cursor === undefined) {
      full = text();
      start = 0;
      token = '';
    } else {
      const m = /^([0-9a-z]+):(\d+)$/.exec(cursor);
      const snap = m ? this.snapshots.get(m[1] as string) : undefined;
      start = m ? Number(m[2]) : 0;
      if (!m || !snap || snap.key !== key || start > snap.text.length) throw badRequest('cursor');
      token = m[1] as string;
      full = snap.text;
    }
    const end = cutPart(full, start);
    if (end >= full.length) {
      if (token) this.drop(token);
      return { part: full.slice(start), next: null };
    }
    if (!token) {
      this.seq += 1;
      token = this.seq.toString(36);
      if (this.snapshots.size >= SNAPSHOTS_PER_SESSION) this.drop(this.snapshots.keys().next().value as string);
      const timer = setTimeout(() => this.drop(token), SNAPSHOT_TTL_MS);
      timer.unref();
      this.snapshots.set(token, { key, text: full, timer });
    }
    return { part: full.slice(start, end), next: `${token}:${end}` };
  }

  private drop(token: string): void {
    const s = this.snapshots.get(token);
    if (s) clearTimeout(s.timer);
    this.snapshots.delete(token);
  }

  clear(): void {
    for (const t of [...this.snapshots.keys()]) this.drop(t);
  }
}

export interface RpcDeps {
  db: Db;
  notebook: Notebook;
  pages: Pages;
  collab: Hocuspocus;
  owners: Owners;
  members: Members;
  removals: Removals;
}

/** `caller` is who sent the request, as of that frame. */
export type RpcHandler = (p: Params, parts: Parts, caller: Caller, budget: EditBudget) => unknown;

const LOCAL_CONTEXT = { actor: 'user' };

/** In the form deskd relays unchanged. */
const forbidden = (): RpcError => new RpcError('forbidden', { reason: 'grant' });

export function methods(deps: RpcDeps): Map<string, RpcHandler> {
  const { db, notebook, pages, collab, owners, members, removals } = deps;

  /** A direct connection's context: who it acts for, on the owner's desk as before. */
  const contextOf = (caller: Caller): CollabContext => (isGuild(caller) ? { actor: actorOf(caller), caller } : LOCAL_CONTEXT);
  const nameOf = (actor: string): string | null => (actor === OWNER_ACTOR ? null : members.name(actor));
  /** On a guild desk, records say who: the member's id stays in `actor`, and their name comes with it. */
  const withName = <T extends VersionMeta | null>(caller: Caller, meta: T): T => (meta && isGuild(caller) ? { ...meta, actorName: nameOf(meta.actor) } : meta);
  const withNames = (caller: Caller, rows: ActivityRow[]): ActivityRow[] => (isGuild(caller) ? rows.map((r) => ({ ...r, actorNames: r.actors.map(nameOf) })) : rows);
  const creator = (row: PageRow): Record<string, unknown> => {
    const by = row.created_by === OWNER_ACTOR ? null : row.created_by;
    return { createdBy: by, createdByName: by ? members.name(by) : null };
  };

  /**
   * Trash deletes, in 30 days. Without `moderate` a member may trash only a page they made, with no text in it that
   * another member wrote: otherwise the purge would delete theirs.
   */
  const mayTrash = (pageId: string, caller: Caller): void => {
    if (!isGuild(caller) || mayModerate(caller)) return;
    const row = notebook.mustPage(pageId);
    if (row.deleted_at != null) return;
    if (row.created_by !== caller.memberId) throw forbidden();
    const open = pages.open.get(pageId);
    if (open) {
      if (holdsOthersText(open.doc, caller.memberId as string, owners.of(pageId))) throw forbidden();
      return;
    }
    const doc = new Y.Doc({ gc: true });
    try {
      pages.readInto(pageId, doc);
      if (holdsOthersText(doc, caller.memberId as string, owners.read(pageId))) throw forbidden();
    } finally {
      doc.destroy();
    }
  };

  const table: [string, RpcHandler][] = [
    ['notebook.tree', (p, _parts, caller) => notebook.tree(optCursor(p), isGuild(caller) ? creator : undefined)],
    ['notebook.notebook.create', (p, _parts, caller) => notebook.createNotebook(optName(p, 'title'), actorOf(caller))],
    [
      'notebook.notebook.rename',
      (p) => {
        notebook.renameNotebook(idOf(p, 'id'), name(p, 'title'));
        return {};
      },
    ],
    [
      'notebook.tab.create',
      (p, _parts, caller) => {
        const notebookId = idOf(p, 'notebookId');
        const title = optName(p, 'title');
        const c = p['color'] === undefined || p['color'] === null ? undefined : color(p, 'color');
        return notebook.createTab(notebookId, { ...(title !== undefined ? { title } : {}), ...(c ? { color: c } : {}) }, actorOf(caller));
      },
    ],
    [
      'notebook.tab.rename',
      (p) => {
        notebook.renameTab(idOf(p, 'id'), name(p, 'title'));
        return {};
      },
    ],
    [
      'notebook.tab.recolor',
      (p) => {
        notebook.recolorTab(idOf(p, 'id'), color(p, 'color'));
        return {};
      },
    ],
    ['notebook.tab.addAtPage', (p) => ({ tab: notebook.addTabAtPage(idOf(p, 'pageId'), optName(p, 'title')) })],
    [
      'notebook.page.create',
      (p, _parts, caller) => {
        const after = optId(p, 'after');
        return { page: notebook.createPage(idOf(p, 'tabId'), after ? { after } : {}, actorOf(caller)) };
      },
    ],
    [
      'notebook.page.move',
      (p) => {
        notebook.movePage(idOf(p, 'pageId'), idOf(p, 'tabId'), optIndex(p, 'index'));
        return {};
      },
    ],
    [
      'notebook.page.trash',
      (p, _parts, caller) => {
        const pageId = idOf(p, 'pageId');
        mayTrash(pageId, caller);
        notebook.trashPage(pageId);
        return {};
      },
    ],
    [
      'notebook.page.restore',
      (p) => {
        notebook.restorePage(idOf(p, 'pageId'));
        return {};
      },
    ],
    [
      'notebook.page.content',
      (p, parts) => {
        const pageId = idOf(p, 'pageId');
        return parts.read(`page:${pageId}`, optCursor(p), () => pages.contentText(pageId));
      },
    ],
    ['notebook.version.list', (p, _parts, caller) => ({ versions: pages.versions(idOf(p, 'pageId')).map((v) => withName(caller, v)) })],
    [
      'notebook.version.get',
      (p, parts, caller) => {
        const versionId = idOf(p, 'versionId');
        const cursor = optCursor(p);
        const meta: VersionMeta | null = pages.versionMetaById(versionId);
        if (!meta) {
          if (cursor !== undefined) throw badRequest('cursor');
          return { meta: null, part: '', next: null };
        }
        const { part, next } = parts.read(`version:${versionId}`, cursor, () => pages.versionText(versionId)?.text ?? '');
        return { meta: withName(caller, meta), part, next };
      },
    ],
    [
      'notebook.version.save',
      async (p, _parts, caller) => {
        const pageId = idOf(p, 'pageId');
        const reason = p['reason'] ?? 'manual';
        if (reason !== 'manual' && reason !== 'pre_agent') throw badRequest('reason');
        if (!notebook.page(pageId)) return { version: null };
        const conn = await collab.openDirectConnection(pageId, contextOf(caller));
        try {
          pages.store(pageId, reason, actorOf(caller));
          return { version: withName(caller, pages.versions(pageId)[0] ?? null) };
        } finally {
          await conn.disconnect();
        }
      },
    ],
    [
      'notebook.version.restore',
      async (p, _parts, caller, budget) => {
        const pageId = idOf(p, 'pageId');
        const versionId = idOf(p, 'versionId');
        const v = pages.versionText(versionId);
        if (!v || v.meta.pageId !== pageId || !notebook.page(pageId)) throw notFound();
        if (isGuild(caller)) return restoreAsMember(pageId, v.text, caller, budget);
        const conn = await collab.openDirectConnection(pageId, LOCAL_CONTEXT);
        try {
          // What's on the page now gets a version first, so a restore never loses text.
          pages.store(pageId, pages.dirty(pageId) ? 'session' : undefined);
          const node = pages.nodeOf(v.text);
          if (pages.restoreWouldOverflow(pageId, node, v.text.length)) throw badRequest('page_full');
          await conn.transact((doc) => {
            prosemirrorToYXmlFragment(node, doc.getXmlFragment(DOC_FIELD));
          });
          // onChange runs from a promise chain: let it, so the store below sees the edit.
          await nextTick();
          pages.store(pageId, 'restore');
          return {};
        } finally {
          await conn.disconnect();
        }
      },
    ],
    ['notebook.version.asOf', (p) => ({ versionId: pages.versionAsOf(idOf(p, 'pageId'), day(p, 'day')) })],
    ['notebook.activity', (p, _parts, caller) => ({ rows: withNames(caller, notebook.activity(day(p, 'fromDay'), day(p, 'toDay'))) })],
    ['notebook.activity.days', () => ({ days: notebook.activeDays() })],
    [
      'notebook.search',
      (p) => {
        const query = p['query'];
        if (typeof query !== 'string' || query.length > 4096) throw badRequest('query');
        const limit = p['limit'];
        if (limit !== undefined && limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) throw badRequest('limit');
        const notebookId = optId(p, 'notebookId');
        const tabId = optId(p, 'tabId');
        const fromDay = optDay(p, 'fromDay');
        const toDay = optDay(p, 'toDay');
        return {
          hits: search(db, query, {
            ...(notebookId ? { notebookId } : {}),
            ...(tabId ? { tabId } : {}),
            ...(fromDay ? { fromDay } : {}),
            ...(toDay ? { toDay } : {}),
            ...(typeof limit === 'number' ? { limit } : {}),
          }),
        };
      },
    ],
    [
      'notebook.settings.set',
      (p, _parts, caller) => {
        // deskd checks this too; the desk's own copy of the rule costs nothing.
        if (isGuild(caller) && caller.role !== 'lead' && !caller.grants.includes('manage_spaces')) throw forbidden();
        const zone = p['timeZone'];
        if (!validZone(zone)) throw badRequest('time_zone');
        notebook.setTimeZone(zone);
        return {};
      },
    ],
  ];

  /**
   * A restore on a guild desk: the change it makes is built on a copy, under a client id of its own, and judged and
   * charged as any member's update is. Text the version brings back is the restoring member's from now on. Without
   * `moderate` it's refused if what it would remove of other members' text since would pass the budget.
   */
  async function restoreAsMember(pageId: string, versionText: string, caller: Caller, budget: EditBudget): Promise<Record<string, never>> {
    const actor = actorOf(caller);
    const conn = await collab.openDirectConnection(pageId, contextOf(caller));
    try {
      const live = conn.document;
      if (!live) throw notFound();
      const node = pages.nodeOf(versionText);
      if (pages.restoreWouldOverflow(pageId, node, versionText.length)) throw badRequest('page_full');
      const copy = new Y.Doc({ gc: true });
      let update: Uint8Array;
      try {
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
        const before = Y.encodeStateVector(copy);
        copy.transact(() => prosemirrorToYXmlFragment(node, copy.getXmlFragment(DOC_FIELD)));
        update = Y.encodeStateAsUpdate(copy, before);
      } finally {
        copy.destroy();
      }
      const verdict = judge(live, update, actor, owners.of(pageId));
      const limited = !mayModerate(caller);
      if (verdict.impersonates || (limited && !removals.fits(pageId, actor, verdict.cost, budget))) {
        log('INFO', `restore refused page=${pageId} cost=${verdict.cost}`);
        throw forbidden();
      }
      // What's on the page now gets a version first, so a restore never loses text.
      pages.store(pageId, pages.dirty(pageId) ? 'session' : undefined);
      owners.record(pageId, actor, verdict);
      if (limited) removals.charge(pageId, actor, verdict.cost, budget);
      await conn.transact((doc) => Y.applyUpdate(doc, update));
      // onChange runs from a promise chain: let it, so the store below sees the edit.
      await nextTick();
      pages.store(pageId, 'restore', actor);
      return {};
    } finally {
      await conn.disconnect();
    }
  }

  return new Map(table);
}

export { RpcError };
