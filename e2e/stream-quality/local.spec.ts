// A dry run of the kit with no desk (SQ_LOCAL=1): the dev stack from desk-rtc/README.md (this tree's desk-rtc, gateway-shim and
// fake-deskd from desk-rtc/dist/amd64, as web/tests/e2e/rtcStack.ts runs them) and web's FakeDeskStream (ffmpeg's H.264 and Opus,
// 1280x800 at 30 fps), driven by the same client, init script and page code as the desk run. It proves the injection end to end
// against the real desk-rtc: the kept `keys` channel, QUALITY out, the 0x82 replies, `level <name>` reaching desk-stream, and the
// sampler and arithmetic. FakeDeskStream doesn't follow `level`, so a size change can't show here; that's the desk run's job.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { DeskClient, FIXTURE_HTML, installClient, sleep } from '../tests/streamlib';
import { FakeDeskStream } from '../../web/tests/e2e/fakeDeskStream';
import { LEVEL, type Tick, installSq, keepKeys, rates } from './sqlib';

test.skip(process.env.SQ_LOCAL !== '1', 'SQ_LOCAL is not set: the local dry run (README.md here).');

const BIN = resolve(import.meta.dirname, '../../desk-rtc/dist/amd64');
const DESK_ID = 'd-dev0000000000';
const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => done(typeof a === 'object' && a ? a.port : 0)); }); });

test('local dry run: QUALITY through the real desk-rtc, replies, level lines, sampler', async ({ browser }) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync('/tmp/ma-sq-local-');
  const logs = join(import.meta.dirname, 'results', 'local');
  mkdirSync(logs, { recursive: true });
  const procs: ChildProcess[] = [];
  const run = (name: string, args: string[]) => { const p = spawn(join(BIN, name), args, { stdio: ['ignore', 'pipe', 'pipe'] }); const l = createWriteStream(join(logs, `${name}.log`)); p.stdout!.pipe(l); p.stderr!.pipe(l); procs.push(p); return p; };
  const shimPort = await freePort(), rtcPort = await freePort();
  const api = `http://127.0.0.1:${shimPort}`;
  run('gateway-shim', ['--addr', `127.0.0.1:${shimPort}`]);
  await sleep(500);
  run('desk-rtc', ['--socket', join(dir, 'rtc.sock'), '--data-dir', join(dir, 'rtc-data'), '--bind', '127.0.0.1', '--port', String(rtcPort), '--stream-socket', join(dir, 'stream.sock'), '--stream-user', userInfo().username]);
  await sleep(500);
  run('fake-deskd', ['--rtc-sock', join(dir, 'rtc.sock'), '--api', api, '--public-ip', '127.0.0.1']);
  const stream = new FakeDeskStream(join(dir, 'stream.sock'));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let fixture: Server | null = null;
  try {
    await expect.poll(async () => { try { return ((await (await fetch(`${api}/dev/state`)).json()) as { ready: boolean }).ready; } catch { return false; } }, { timeout: 20_000 }).toBe(true);
    await stream.start();
    await context.addInitScript(keepKeys);
    const page = await context.newPage();
    // A real loopback server, not page.route: Chrome's Local Network Access checks treat a fulfilled response as public and then
    // refuse its WebSocket to 127.0.0.1 (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS).
    const pagePort = await freePort();
    fixture = createHttpServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FIXTURE_HTML); }).listen(pagePort, '127.0.0.1');
    await page.goto(`http://127.0.0.1:${pagePort}/`);
    await page.evaluate(installClient);
    const client = new DeskClient(page, 'unused', 'local');
    const fp = await client.c<string>('identity');
    const c = await (await fetch(`${api}/v1/desks/${DESK_ID}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'owner', start: false, clientDtlsFingerprint: fp }) })).json() as { deskToken: string; gateway: string; deskIdentity: { fingerprintsSha256: string[] } };
    const opened = await client.c<{ ok: boolean; step?: string; message?: string }>('open', { deskId: DESK_ID, deskToken: c.deskToken, gateway: c.gateway, identity: c.deskIdentity.fingerprintsSha256 });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(await page.evaluate(installSq), 'the init script kept keys').toBe(true);
    const SQ = <T>(fn: string, arg?: unknown) => page.evaluate(([f, a]) => (window as unknown as Record<string, Record<string, (x: unknown) => unknown>>).SQ[f as string](a), [fn, arg] as const) as Promise<T>;

    const live = await client.c<{ firstCbMs: number | null }>('firstFrame', { state: 'live', waitMs: 15_000 });
    expect(live.firstCbMs, 'a frame decoded after live').not.toBeNull();
    await sleep(1500);
    const onView = await SQ<{ level: number }[]>('replies');
    console.log('[local] replies on viewing', JSON.stringify(onView));
    expect(onView.at(-1)?.level, 'desk-rtc told a new viewer the level: High').toBe(LEVEL.high);

    const lines = () => stream.lines.filter((l) => l.line.startsWith('level ')).map((l) => l.line);
    const seen: Record<string, unknown> = {};
    // 1280x800 throughout: FakeDeskStream doesn't follow `level`. Low still expects 1280x720, to prove a size that never comes
    // times out cleanly.
    for (const [name, size] of [['low', [1280, 720]], ['medium', [1280, 800]], ['max', [1280, 800]], ['high', [1280, 800]]] as const) {
      const before = lines().length;
      const sw = await SQ<{ sent: boolean; replyMs: number | null; firstKeyframeMs: number | null; firstFrameAtNewSizeMs: number | null; sizeChanges: boolean; reply: { level: number; flags: number; limit: number } }>('switchTo', { level: LEVEL[name], expect: size, waitMs: name === 'low' ? 1500 : 3000 });
      await sleep(700); // desk-rtc's 500 ms pace
      seen[name] = { ...sw, linesToDeskStream: lines().slice(before) };
      console.log(`[local] ${name}`, JSON.stringify(seen[name]).slice(0, 300));
      expect(sw.sent).toBe(true);
      expect(sw.replyMs, `${name}: a 0x82 reply naming the level`).not.toBeNull();
      expect(sw.reply.level).toBe(LEVEL[name]);
      expect(sw.reply.flags, 'no limit, no other viewer').toBe(0);
      expect(sw.firstKeyframeMs, 'a keyframe after the switch (FakeDeskStream sends one a second)').not.toBeNull();
      expect(lines().slice(before), `${name}: desk-stream heard it`).toContain(`level ${name}`);
      if (name === 'low') expect(sw.firstFrameAtNewSizeMs, 'a size that never comes is null, not a hang').toBeNull();
    }
    const ticks = await SQ<Tick[]>('segment', { seconds: 3 });
    const r = rates(ticks);
    console.log('[local] rates', JSON.stringify(r).slice(0, 600));
    expect(r.size).toBe('1280x800');
    expect(r.decodedFps).toBeGreaterThan(20);
    expect(r.videoGBh).toBeGreaterThan(0);
    expect(r.audioGBh).toBeGreaterThan(0);
    expect(r.transportGBh).toBeGreaterThan(r.videoGBh);
    await client.c('closeSession');
  } finally {
    await context.close();
    fixture?.close();
    stream.stop();
    for (const p of procs) p.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
