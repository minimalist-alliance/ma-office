// Hocuspocus, with no server of its own: connections come from the socket through a small adapter (socket.ts), and
// these hooks are where its documents meet storage.
import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { applyAwarenessUpdate } from 'y-protocols/awareness';
import { actorOf, isGuild, mayModerate, OWNER_CALLER, type Caller } from './caller.ts';
import { errName, log } from './log.ts';
import { OWNER_ACTOR, type Notebook } from './notebook.ts';
import { updateChanges } from './model.ts';
import { judge, UnreadableUpdate, type Owners, type Removals } from './owners.ts';
import { type Pages } from './pages.ts';
import { DEFAULT_EDIT_BUDGET, type EditBudget } from './settings.ts';

export const PAGE_FULL = 'page_full';
/** The close reason for an update refused because the desk can't write to its disk and has too much waiting. */
export const STORAGE_FULL = 'storage_full';
/** The close reason for an update refused on a guild desk: it deletes another member's text, or writes as them. */
export const FORBIDDEN = 'forbidden';
/** The reason Hocuspocus closes a document with when something throws while it handles a message. */
export const RESET = 'Reset Connection';
/** Sync steps carrying document updates. Step 0 is only a state vector. */
const STEP_2 = 1;
const UPDATE = 2;

export interface CollabOptions {
  storeDebounceMs: number;
  storeMaxWaitMs: number;
}

/**
 * Who is on one socket connection, as its hello and `caller` frames say. Each collab message is stamped with the caller
 * as it was when the message arrived, so a `caller` frame applies to the messages after it and to none before, though
 * Hocuspocus handles a message some ticks after it arrives.
 */
export class Who {
  private readonly stamps = new WeakMap<Uint8Array, Caller>();

  /** The edit budget deskd last sent for this connection: the default until it does. Applies to the checks after it. */
  budget: EditBudget = DEFAULT_EDIT_BUDGET;

  constructor(public caller: Caller) {}

  stamp(data: Uint8Array): void {
    if (this.caller.kind === 'guild_member' && !this.stamps.has(data)) this.stamps.set(data, this.caller);
  }

  callerFor(data: Uint8Array): Caller {
    return this.stamps.get(data) ?? this.caller;
  }
}

/** Hocuspocus's context for a connection: `who` on the socket's, `caller` on a direct connection's. */
export interface CollabContext {
  actor: string;
  who?: Who;
  caller?: Caller;
}

/** The caller of the message a connection is handling now. Hocuspocus handles one at a time per connection. */
const handling = new WeakMap<object, Caller>();

/** Who an update came from, from the origin it was applied with. */
function actorFrom(origin: unknown): string {
  const o = origin as { actor?: unknown; context?: { actor?: unknown } } | null | undefined;
  const a = o?.actor ?? o?.context?.actor;
  return typeof a === 'string' ? a : OWNER_ACTOR;
}

/** Keys of a presence `user` that name or identify someone. A guild member's client doesn't get to set any of them. */
const IDENTITY_KEY = /name|id$|^id|mail|handle|login|account|member|user|avatar|image|photo|badge|role|label|title|nick|sub$|uid|role/i;

/**
 * A guild member's presence state as everyone else may see it: `user.name` and `user.memberId` are the verified
 * caller's, any other identity-looking field of `user` is dropped, and everything else (colour, cursor, selection) stays.
 * Returns the same object, changed. A state that isn't an object is left alone (it's a removal or garbage Yjs ignores).
 */
export function sanitizeAwareness(state: unknown, caller: Caller): void {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  const s = state as Record<string, unknown>;
  const given = s['user'];
  const user: Record<string, unknown> = {};
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    for (const [k, v] of Object.entries(given)) if (!IDENTITY_KEY.test(k)) user[k] = v;
  }
  user['name'] = caller.name ?? 'Member';
  user['memberId'] = caller.memberId;
  if (caller.avatarUrl) user['avatarUrl'] = caller.avatarUrl; // verified by parseCaller; a client's own is dropped above
  s['user'] = user;
}

/**
 * A `caller` frame changed this connection's name: put it into the presence states already stored for the connection's
 * clients, and tell everyone. Each is an awareness update one clock ahead of the client's own, applied with the
 * connection as its origin, which Hocuspocus broadcasts as it does a client's own. (The client's next update at that
 * clock is ignored by the document's awareness; the one after, and its 15 s heartbeat, are not.)
 */
export function renameAwareness(collab: Hocuspocus, who: Who): void {
  const caller = who.caller;
  if (!isGuild(caller)) return;
  for (const document of collab.documents.values()) {
    for (const connection of document.getConnections()) {
      if ((connection.context as CollabContext | undefined)?.who !== who) continue;
      const entries: Array<[number, number, Record<string, unknown>]> = [];
      for (const id of document.getClients(connection)) {
        const state = document.awareness.getStates().get(id);
        if (!state) continue;
        const next = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
        sanitizeAwareness(next, caller);
        entries.push([id, (document.awareness.meta.get(id)?.clock ?? 0) + 1, next]);
      }
      if (!entries.length) continue;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, entries.length);
      for (const [id, clock, state] of entries) {
        encoding.writeVarUint(e, id);
        encoding.writeVarUint(e, clock);
        encoding.writeVarString(e, JSON.stringify(state));
      }
      applyAwarenessUpdate(document.awareness, encoding.toUint8Array(e), { source: 'connection', connection });
    }
  }
}

export function createCollab(pages: Pages, notebook: Notebook, owners: Owners, removals: Removals, opts: CollabOptions): Hocuspocus {
  /**
   * A guild member's update, before it's applied: refused whole if it would take a member without `moderate` past the
   * budget for removing other members' content on this page, or writes as another member; otherwise its writers are
   * made durable and its cost charged, then it may be applied.
   */
  const admit = (pageId: string, doc: Y.Doc, update: Uint8Array, caller: Caller, budget: EditBudget): void => {
    const memberId = caller.memberId as string;
    let verdict;
    try {
      verdict = judge(doc, update, memberId, owners.of(pageId));
    } catch (e) {
      if (e instanceof UnreadableUpdate) {
        log('WARN', `damaged update page=${pageId} bytes=${update.length}`);
        throw { code: 4205, reason: RESET };
      }
      // Never let through what couldn't be judged. Only this page closes, so the client reopens it on a fresh Y.Doc and
      // doesn't send the same update again, as it would after a reset.
      log('ERROR', `judging an update failed page=${pageId} bytes=${update.length} ${errName(e)}`);
      throw { code: 4403, reason: FORBIDDEN };
    }
    const limited = !mayModerate(caller);
    if (verdict.impersonates || (limited && !removals.fits(pageId, memberId, verdict.cost, budget))) {
      log('INFO', `refused page=${pageId} cost=${verdict.cost} used=${removals.used(pageId, memberId, budget.windowMs)} impersonates=${verdict.impersonates}`);
      throw { code: 4403, reason: FORBIDDEN };
    }
    try {
      owners.record(pageId, memberId, verdict);
    } catch (e) {
      log('ERROR', `keeping writers failed page=${pageId} ${errName(e)}`);
      throw { code: 4500, reason: RESET };
    }
    if (limited) removals.charge(pageId, memberId, verdict.cost, budget);
  };

  return new Hocuspocus({
    name: 'desk-notebook',
    quiet: true,
    debounce: opts.storeDebounceMs,
    maxDebounce: opts.storeMaxWaitMs,
    // Only deskd can reach the socket, and it closes the connection when the session ends. Nothing here idles out.
    timeout: 2_147_483_647,
    yDocOptions: { gc: true, gcFilter: () => true },

    // deskd has already authenticated the session; the token means nothing here. The check is that the page exists,
    // so a provider can't make rows for a page nobody created. And on a guild desk a trashed page opens only for a
    // moderator until the purge (authz-5), as `notebook.page.content` holds it: the caller is the connection's, as of now.
    async onAuthenticate({ documentName, context }) {
      const row = notebook.page(documentName);
      if (!row) throw { reason: 'not_found' };
      const ctx = context as CollabContext | undefined;
      const caller = ctx?.who?.caller ?? ctx?.caller ?? OWNER_CALLER;
      if (row.deleted_at != null && isGuild(caller) && !mayModerate(caller)) throw { reason: FORBIDDEN };
    },
    async onLoadDocument({ documentName, document }) {
      pages.load(documentName, document);
    },
    async onChange({ documentName, update, transactionOrigin }) {
      try {
        pages.change(documentName, update, actorFrom(transactionOrigin));
      } catch (e) {
        log('ERROR', `queueing an update failed page=${documentName} ${errName(e)}`);
      }
    },
    // Before an update is applied: the one place a page can refuse growth and keep what it has. Throwing here closes
    // this document on this connection and nothing else, and the reason reaches the provider's `close` event.
    // Which caller this message came from: the one it was stamped with when it arrived.
    async beforeHandleMessage({ connection, update, context }) {
      const who = (context as CollabContext | undefined)?.who;
      if (who) handling.set(connection, who.callerFor(update));
    },
    // Presence: before an awareness update is stored and relayed, the caller's own name and member id replace whatever the
    // client put in `user`. Hocuspocus hands the decoded states over to be changed in place and re-encodes them for the
    // document's awareness, so what every other client receives, and any client that joins later, is the rewritten one.
    async beforeHandleAwareness({ connection, context, states }) {
      const caller = (connection && handling.get(connection)) ?? (context as CollabContext | undefined)?.who?.caller ?? OWNER_CALLER;
      if (!isGuild(caller)) return;
      for (const state of states.values()) sanitizeAwareness(state, caller);
    },
    async beforeSync({ documentName, document, type, payload, connection, context }) {
      if (type !== STEP_2 && type !== UPDATE) return;
      if (pages.wouldOverflow(documentName, payload)) {
        log('WARN', `page full page=${documentName} update=${payload.length}`);
        throw { code: 4413, reason: PAGE_FULL };
      }
      // The disk isn't taking writes and what waits in memory has passed its limit: refuse, so nothing more is shown saved.
      if (pages.refuses(documentName) && updateChanges(payload)) throw { code: 4507, reason: STORAGE_FULL };
      const caller = handling.get(connection) ?? (context as CollabContext | undefined)?.who?.caller ?? OWNER_CALLER;
      if (isGuild(caller)) admit(documentName, document, payload, caller, (context as CollabContext | undefined)?.who?.budget ?? DEFAULT_EDIT_BUDGET);
      // y-protocols catches whatever Yjs throws, logs it, and lets Hocuspocus tell the client it was applied. So the
      // update is applied here first, where a throw can be seen. y-protocols' own apply that follows then changes nothing.
      // The origin carries who sent it, for onChange.
      try {
        Y.applyUpdate(document, payload, { source: 'connection', connection, actor: actorOf(caller) });
      } catch (e) {
        log('WARN', `damaged update page=${documentName} bytes=${payload.length} ${errName(e)}`);
        throw { code: 4205, reason: RESET };
      }
    },
    async onStoreDocument({ documentName }) {
      pages.storeQuietly(documentName);
    },
    // The last connection left. This is the end of an editing session, and this store may write its version.
    async beforeUnloadDocument({ documentName }) {
      pages.endSession(documentName);
    },
    async afterUnloadDocument({ documentName }) {
      pages.forget(documentName);
      owners.forget(documentName);
    },
  });
}
