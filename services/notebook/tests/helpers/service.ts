// The service, in this process with a fake clock, or as the real bundle in a child process.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService, type Service, type ServiceOptions } from '../../src/service.ts';
import { DeskdSession, until } from './deskd.ts';

export const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const bundle = join(serviceDir, 'dist/desk-notebook.mjs');

/** Short on purpose: Unix socket paths are limited to 107 bytes. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nb-'));
}

export interface Harness {
  dir: string;
  socket: string;
  service: Service;
  session(): DeskdSession;
  stop(): Promise<void>;
  restart(extra?: Partial<ServiceOptions>): Promise<Service>;
  clean(): Promise<void>;
}

export async function harness(extra: Partial<ServiceOptions> = {}, existingDir?: string): Promise<Harness> {
  const dir = existingDir ?? tempDir();
  const socket = join(dir, 'n.sock');
  const options: ServiceOptions = { dataDir: join(dir, 'data'), socketPath: socket, version: 'test', readableDebounceMs: 5, ...extra };
  const sessions: DeskdSession[] = [];
  const h: Harness = {
    dir,
    socket,
    service: await startService(options),
    session() {
      const s = new DeskdSession(socket);
      sessions.push(s);
      return s;
    },
    async stop() {
      for (const s of sessions.splice(0)) s.close();
      await h.service.stop();
    },
    async restart(more = {}) {
      await h.stop();
      h.service = await startService({ ...options, ...more });
      return h.service;
    },
    async clean() {
      await h.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export interface Child {
  proc: ChildProcess;
  dir: string;
  dataDir: string;
  socket: string;
  logs: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready: Promise<void>;
  kill(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The real bundle, with the flags docker/run gives it. */
export function child(dir: string, env: Record<string, string> = {}, nodeFlags: string[] = [], wrapper: string[] = []): Child {
  const dataDir = join(dir, 'data');
  const socket = join(dir, 'n.sock');
  const command = [...wrapper, process.execPath, '--max-old-space-size=192', '--disable-warning=ExperimentalWarning', ...nodeFlags, bundle];
  const proc = spawn(command[0] as string, command.slice(1), {
    env: { PATH: process.env['PATH'] ?? '', DESK_NOTEBOOK_DATA_DIR: dataDir, DESK_NOTEBOOK_SOCKET: socket, DESK_NOTEBOOK_VERSION: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  let resolveReady: () => void;
  let rejectReady: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const onLine = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line) continue;
      logs.push(line);
      if (line.includes(' ready in ')) resolveReady();
    }
  };
  proc.stdout?.on('data', onLine);
  proc.stderr?.on('data', onLine);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    proc.once('exit', (code, signal) => {
      rejectReady(new Error(`exited before ready: ${logs.join('\n')}`));
      res({ code, signal });
    });
  });
  ready.catch(() => undefined);
  return {
    proc,
    dir,
    dataDir,
    socket,
    logs,
    exited,
    ready,
    kill(signal) {
      proc.kill(signal);
      return exited;
    },
  };
}

export async function makeNotebook(s: DeskdSession): Promise<{ notebookId: string; tabId: string; pageId: string }> {
  const r = await s.rpc('notebook.notebook.create', { title: 'Work' });
  return { notebookId: r.notebook.id, tabId: r.tab.id, pageId: r.page.id };
}

export { until };
