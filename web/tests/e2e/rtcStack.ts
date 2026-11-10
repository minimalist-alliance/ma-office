// The dev stack from desk-rtc/README.md, on its own ports and paths, for the specs that use a real desk-rtc.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';

const RTC_DIR = resolve('../desk-rtc');
const BIN = join(RTC_DIR, 'dist/amd64');
export const DESK_ID = 'd-dev0000000000';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? done(addr.port) : fail(new Error('no port'))));
    });
  });
}

export function buildTools(): void {
  const env = { ...process.env, CGO_ENABLED: '0', PATH: `${join(homedir(), '.local/go/bin')}:${process.env['PATH']}` };
  for (const tool of ['desk-rtc', 'gateway-shim', 'fake-deskd']) {
    execFileSync('go', ['build', '-p', '1', '-o', join(BIN, tool), `./cmd/${tool}`], { cwd: RTC_DIR, env, stdio: 'inherit' });
  }
}

/** Other sessions use this machine too, so everything here has its own port and path. */
export class Stack {
  private readonly dir = mkdtempSync(join(tmpdir().length < 60 ? tmpdir() : '/tmp', 'ma-rtc-'));
  private readonly procs = new Map<string, ChildProcess>();
  private shimPort = 0;
  private rtcPort = 0;

  /** `streams`: desk-rtc listens for a `desk-stream` too, from this test's own user. */
  constructor(
    private readonly evidence: string,
    private readonly streams = false,
  ) {}

  get api(): string {
    return `http://127.0.0.1:${this.shimPort}`;
  }

  get streamSocket(): string {
    return join(this.dir, 'stream.sock');
  }

  private run(name: string, args: string[]): ChildProcess {
    const log = createWriteStream(join(this.evidence, `${name}.log`), { flags: 'a' });
    const proc = spawn(join(BIN, name), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.pipe(log);
    proc.stderr.pipe(log);
    this.procs.set(name, proc);
    return proc;
  }

  async start(): Promise<void> {
    this.shimPort = await freePort();
    this.rtcPort = await freePort();
    this.run('gateway-shim', ['--addr', `127.0.0.1:${this.shimPort}`]);
    await this.startDesk();
  }

  /** desk-rtc and deskd. fake-deskd exits when rtc.sock drops, as a desk restart would do. */
  async startDesk(): Promise<void> {
    const sock = join(this.dir, 'rtc.sock');
    const stream = this.streams ? ['--stream-socket', this.streamSocket, '--stream-user', userInfo().username] : [];
    this.run('desk-rtc', ['--socket', sock, '--data-dir', join(this.dir, 'rtc-data'), '--bind', '127.0.0.1', '--port', String(this.rtcPort), ...stream]);
    await this.startDeskd();
  }

  /** deskd alone, as a rollout restarts it: desk-rtc and the instance stay up. */
  async startDeskd(): Promise<void> {
    this.run('fake-deskd', ['--rtc-sock', join(this.dir, 'rtc.sock'), '--api', this.api, '--public-ip', '127.0.0.1']);
    await expect.poll(async () => (await this.state()).ready, { timeout: 20_000 }).toBe(true);
  }

  async stopDeskd(): Promise<void> {
    await this.kill('fake-deskd', 'SIGTERM');
  }

  async state(): Promise<{ ready: boolean; sessions: string[] }> {
    try {
      return (await (await fetch(`${this.api}/dev/state`)).json()) as { ready: boolean; sessions: string[] };
    } catch {
      return { ready: false, sessions: [] };
    }
  }

  private async kill(name: string, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    const proc = this.procs.get(name);
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const gone = new Promise((done) => proc.once('exit', done));
    proc.kill(signal);
    await gone;
  }

  async killDesk(): Promise<void> {
    await this.kill('desk-rtc');
    await this.kill('fake-deskd');
  }

  signalRtc(signal: 'SIGSTOP' | 'SIGCONT'): void {
    this.procs.get('desk-rtc')?.kill(signal);
  }

  async stop(): Promise<void> {
    for (const name of this.procs.keys()) await this.kill(name);
    rmSync(this.dir, { recursive: true, force: true });
  }
}
