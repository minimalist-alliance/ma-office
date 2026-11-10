// Starts and stops the stand-in guild server for a test, on its own data directory.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PORT = Number(process.env['MA_CM_PORT'] ?? 5192);
export const UDP = PORT + 1;
export const BASE = `http://127.0.0.1:${PORT}`;
const BIN = process.env['COMMONS_SERVER'] ?? resolve(import.meta.dirname, '../../../server/bin/commons-server');
const WEB = resolve(import.meta.dirname, '../../dist');

export class Server {
  proc: ChildProcess | null = null;
  readonly data = mkdtempSync(join(tmpdir(), 'commons-e2e-'));
  log = '';

  async start(extra: string[] = []): Promise<void> {
    const p = spawn(BIN, ['-dev', '-addr', `127.0.0.1:${PORT}`, '-udp', `127.0.0.1:${UDP}`, '-web', WEB, '-data', this.data, ...extra], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = p;
    p.stdout?.on('data', (b: Buffer) => (this.log += b.toString()));
    p.stderr?.on('data', (b: Buffer) => (this.log += b.toString()));
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${BASE}/healthz`);
        if (r.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`commons-server didn't start:\n${this.log}`);
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    const done = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    await done;
  }

  async stats(): Promise<Record<string, unknown>> {
    return (await (await fetch(`${BASE}/stats`)).json()) as Record<string, unknown>;
  }

  cleanup(): void {
    rmSync(this.data, { recursive: true, force: true });
  }
}
