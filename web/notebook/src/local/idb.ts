// A small promise layer over IndexedDB: one database for the whole Notebook, shaped after
// design 5.4's tables. No library, so nothing here can reach the network.

export const DB_VERSION = 1;

export const STORES = {
  notebooks: 'notebooks',
  tabs: 'tabs',
  pages: 'pages',
  /** { id, text }: each page's plain text, for search. */
  texts: 'texts',
  /** { pageId, update }: a page's Yjs updates, appended; compacted to one row on open. */
  updates: 'updates',
  /** Version metadata, listed per page. */
  versions: 'versions',
  /** { id, doc }: a version's ProseMirror JSON, read only when it's opened. */
  versionDocs: 'versionDocs',
  activity: 'activity',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

export function openDb(name: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of [STORES.notebooks, STORES.tabs, STORES.pages, STORES.texts, STORES.versionDocs]) db.createObjectStore(s, { keyPath: 'id' });
      db.createObjectStore(STORES.updates, { autoIncrement: true }).createIndex('byPage', 'pageId');
      db.createObjectStore(STORES.versions, { keyPath: 'id' }).createIndex('byPage', 'pageId');
      db.createObjectStore(STORES.activity, { keyPath: ['pageId', 'day'] }).createIndex('byDay', 'day');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export async function getAll<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  return req(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function get<T>(db: IDBDatabase, store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return req(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function getAllByIndex<T>(db: IDBDatabase, store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return req(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(query) as IDBRequest<T[]>);
}

/** Writes several stores in one transaction. `fn` queues requests; the promise settles when they commit. */
export async function write(db: IDBDatabase, stores: StoreName[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const tx = db.transaction(stores, 'readwrite');
  const finished = done(tx);
  fn(tx);
  await finished;
}
