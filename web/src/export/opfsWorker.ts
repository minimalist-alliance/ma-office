// The archive's working file, sealed (`seal.ts`), in this browser's private storage, written in place through a sync access handle: unlike
// a writable stream, whose bytes wait in a temporary file until it's closed, what's written here is in the file at
// once, so a reload or a closed tab finds it there. Sync access handles exist only in workers. One file at a time,
// and holding it locks it, so a second tab can't write the same download.
interface SyncHandle {
  read(b: Uint8Array, o: { at: number }): number;
  write(b: Uint8Array, o: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}

type Msg =
  | { id: number; op: 'open'; name: string; keep: boolean }
  | { id: number; op: 'write'; at: number; bytes: ArrayBuffer }
  | { id: number; op: 'read'; at: number; len: number }
  | { id: number; op: 'truncate'; size: number }
  | { id: number; op: 'flush' }
  | { id: number; op: 'close' };

const scope = self as unknown as { onmessage: (e: MessageEvent<Msg>) => void; postMessage(m: unknown): void };
let handle: SyncHandle | null = null;

async function run(m: Msg): Promise<number | ArrayBuffer | undefined> {
  if (m.op === 'open') {
    const dir = await navigator.storage.getDirectory();
    const file = await dir.getFileHandle(m.name, { create: true });
    handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
    if (!m.keep) handle.truncate(0);
    return handle.getSize();
  }
  if (!handle) throw new DOMException('the file is not open', 'InvalidStateError');
  switch (m.op) {
    case 'write': {
      const bytes = new Uint8Array(m.bytes);
      for (let done = 0; done < bytes.length; ) done += handle.write(bytes.subarray(done), { at: m.at + done });
      return undefined;
    }
    case 'read': {
      const out = new Uint8Array(m.len);
      let got = 0;
      while (got < m.len) {
        const n = handle.read(out.subarray(got), { at: m.at + got });
        if (n <= 0) break;
        got += n;
      }
      return out.buffer.slice(0, got);
    }
    case 'truncate':
      handle.truncate(m.size);
      return undefined;
    case 'flush':
      handle.flush();
      return undefined;
    case 'close':
      handle.flush();
      handle.close();
      handle = null;
      return undefined;
    default:
      return undefined;
  }
}

// One at a time, in order: each message waits for the one before it.
let queue: Promise<unknown> = Promise.resolve();
scope.onmessage = (e) => {
  const m = e.data;
  queue = queue.then(() =>
    run(m).then(
      (result) => (scope as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage({ id: m.id, ok: true, result }, result instanceof ArrayBuffer ? [result] : []),
      (err: unknown) => scope.postMessage({ id: m.id, ok: false, name: err instanceof DOMException ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) }),
    ),
  );
};
