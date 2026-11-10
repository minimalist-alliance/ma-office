// The service as a whole: what start and stop do, in order.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { createCollab } from './collab.ts';
import { Db, SCHEMA_VERSION } from './db.ts';
import { errName, log } from './log.ts';
import { Members } from './members.ts';
import { Notebook } from './notebook.ts';
import { Owners, Removals } from './owners.ts';
import { DEFAULT_PAGES_OPTIONS, Pages } from './pages.ts';
import { Readable } from './readable.ts';
import { methods } from './rpc.ts';
import { SocketServer } from './socket.ts';

const HOUSEKEEPING_MS = 6 * 3_600_000;

export interface ServiceOptions {
  dataDir: string;
  socketPath: string;
  version: string;
  now?: () => number;
  commitMs?: number;
  storeDebounceMs?: number;
  storeMaxWaitMs?: number;
  sessionIdleMs?: number;
  intervalMs?: number;
  readableDebounceMs?: number;
  pageFullBytes?: number;
  debugStores?: boolean;
}

export interface Service {
  db: Db;
  notebook: Notebook;
  pages: Pages;
  collab: Hocuspocus;
  readable: Readable;
  socket: SocketServer;
  /** What guild members without `moderate` have removed of others' content lately, per page. */
  removals: Removals;
  /** Stores every open page, flushes, checkpoints the WAL. After it the process can exit. */
  stop(): Promise<void>;
}

export async function startService(o: ServiceOptions): Promise<Service> {
  mkdirSync(o.dataDir, { recursive: true });
  const now = o.now ?? DEFAULT_PAGES_OPTIONS.now;
  const db = new Db(join(o.dataDir, 'notebook.db'));
  let readable: Readable | null = null;
  let socket: SocketServer | null = null;
  const notebook = new Notebook(db, {
    now,
    onTreeChange: () => {
      readable?.treeChanged();
      socket?.treeChanged();
    },
  });
  const pages = new Pages(db, notebook, {
    ...DEFAULT_PAGES_OPTIONS,
    now,
    commitMs: o.commitMs ?? DEFAULT_PAGES_OPTIONS.commitMs,
    sessionIdleMs: o.sessionIdleMs ?? DEFAULT_PAGES_OPTIONS.sessionIdleMs,
    intervalMs: o.intervalMs ?? DEFAULT_PAGES_OPTIONS.intervalMs,
    pageFullBytes: o.pageFullBytes ?? DEFAULT_PAGES_OPTIONS.pageFullBytes,
    debugStores: o.debugStores ?? DEFAULT_PAGES_OPTIONS.debugStores,
    onStored: () => undefined,
    onContentChange: (pageId) => readable?.pageChanged(pageId),
  });

  // What the last process left in the log goes into the pages, and old things go, before anyone can connect.
  const recovered = pages.recover();
  if (recovered) log('INFO', `recovered pages=${recovered} from the log`);
  const kept = pages.housekeeping();
  if (kept.purged || kept.pruned) log('INFO', `housekeeping purged=${kept.purged} pruned=${kept.pruned}`);

  const owners = new Owners(db);
  const members = new Members(db, now);
  const removals = new Removals(now);
  const collab = createCollab(pages, notebook, owners, removals, { storeDebounceMs: o.storeDebounceMs ?? 2000, storeMaxWaitMs: o.storeMaxWaitMs ?? 10_000 });
  readable = new Readable(o.dataDir, db, { debounceMs: o.readableDebounceMs ?? 30_000, rev: () => notebook.rev });
  socket = new SocketServer({
    path: o.socketPath,
    methods: methods({ db, notebook, pages, collab, owners, members, removals }),
    collab,
    members,
    rev: () => notebook.rev,
    health: () => {
      const count = db.get<{ n: number }>('SELECT count(*) AS n FROM pages')?.n ?? 0;
      const m = process.memoryUsage();
      return {
        ok: true,
        version: o.version,
        schema: SCHEMA_VERSION,
        pages: count,
        open: pages.open.size,
        sessions: socket?.sessionCount ?? 0,
        memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers },
      };
    },
  });
  await socket.listen();
  readable.start();

  const housekeeping = setInterval(() => {
    try {
      const r = pages.housekeeping();
      if (r.purged || r.pruned) log('INFO', `housekeeping purged=${r.purged} pruned=${r.pruned}`);
    } catch (e) {
      log('ERROR', `housekeeping failed ${errName(e)}`);
    }
  }, HOUSEKEEPING_MS);
  housekeeping.unref();

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(housekeeping);
      // In this order: the sessions go first, so nothing changes under the stores that follow.
      socket?.close();
      await new Promise((r) => setImmediate(r));
      try {
        pages.storeAll();
      } catch (e) {
        log('ERROR', `final store failed ${errName(e)}`);
      }
      try {
        readable?.flush();
      } catch (e) {
        log('WARN', `final readable export failed ${errName(e)}`);
      }
      readable?.stop();
      pages.closed = true;
      db.checkpointAndClose();
    })();
    return stopping;
  };

  return { db, notebook, pages, collab, readable, socket, removals, stop };
}
