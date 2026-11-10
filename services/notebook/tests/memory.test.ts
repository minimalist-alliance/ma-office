// `npm run memory`: docker/run's memory cap, for real, on the worst thing the service can be asked to hold: pages near
// the ceiling, open in two clients, typed in and stored. A user systemd scope gives the same cgroup limits as Docker's
// --memory and --memory-swap. Skipped unless MEMORY=1, and it needs a user bus. Fake text only.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until } from './helpers/deskd.ts';
import { fakeState, textOf, typeInto } from './helpers/docs.ts';
import { child, makeNotebook, tempDir } from './helpers/service.ts';

const uid = process.getuid?.() ?? 1000;
const userEnv = { XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
const CAP = process.env['MEMORY_CAP'] ?? '320M';
const FLAGS = (process.env['MEMORY_FLAGS'] ?? '').split(' ').filter(Boolean);
const PAGES = Number(process.env['MEMORY_PAGES'] ?? 1);
/** Printed pages in each page: 560 is near the ceiling. */
const SIZE = Number(process.env['MEMORY_SIZE'] ?? 560);
/** Updates each page is built from. The editor splits a paste over about 1 MiB, so a real page never comes as one. */
const CHUNKS = Number(process.env['MEMORY_CHUNKS'] ?? 6);
const EXTRA_ENV: Record<string, string> = Object.fromEntries((process.env['MEMORY_ENV'] ?? '').split(' ').filter(Boolean).map((kv) => kv.split('=') as [string, string]));

function proc(pid: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const m = /^(VmHWM|VmRSS|RssAnon|RssFile):\s+(\d+) kB/.exec(line);
    if (m) out[m[1] as string] = Math.round(Number(m[2]) / 102.4) / 10;
  }
  return out;
}

describe.runIf(process.env['MEMORY'] === '1')('under docker/run\'s memory cap', () => {
  it('holds pages near the ceiling', async () => {
    const wrapper = ['systemd-run', '--user', '--scope', '--quiet', '-p', `MemoryMax=${CAP}`, '-p', 'MemorySwapMax=0'];
    const probe = spawnSync(wrapper[0] as string, [...wrapper.slice(1), 'true'], { env: { ...process.env, ...userEnv } });
    expect(probe.status).toBe(0);

    const dir = tempDir();
    const c = child(dir, { ...userEnv, ...EXTRA_ENV, DESK_NOTEBOOK_DEBUG: '1', DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '200', DESK_NOTEBOOK_STORE_MAX_MS: '1000' }, FLAGS, wrapper);
    await c.ready;
    const pid = c.proc.pid as number;
    const out: Record<string, unknown> = { cap: CAP, flags: FLAGS, env: EXTRA_ENV, pages: PAGES, printedPagesEach: SIZE, chunks: CHUNKS };
    const clients: Client[] = [];
    const client = (): Client => {
      const x = new Client(c.socket);
      clients.push(x);
      return x;
    };
    const s = new DeskdSession(c.socket);
    let died: unknown = null;
    void c.exited.then((e) => {
      died = e;
    });
    let peakAnon = 0;
    const sampler = setInterval(() => {
      if (died) return;
      try {
        peakAnon = Math.max(peakAnon, proc(pid)['RssAnon'] ?? 0);
      } catch {
        // Gone.
      }
    }, 50);
    out['atRest'] = proc(pid);
    try {
      const { tabId, pageId } = await makeNotebook(s);
      const ids = [pageId];
      for (let i = 1; i < PAGES; i += 1) ids.push((await s.rpc('notebook.page.create', { tabId })).page.id as string);
      for (const [i, id] of ids.entries()) {
        const a = client().open(id);
        const b = client().open(id);
        await Promise.all([synced(a), synced(b)]);
        const each = Math.ceil(SIZE / CHUNKS);
        for (let k = 0; k < CHUNKS; k += 1) {
          Y.applyUpdate(a.document, fakeState(each, (i + 1) * 100 + k));
          await until('ack', () => !a.hasUnsyncedChanges, 60_000, 50);
        }
        await until('the other client', () => textOf(b.document).includes(`end-${each}`), 60_000, 100);
        for (let k = 0; k < 5; k += 1) {
          const before = c.logs.length;
          typeInto(a.document, 'x');
          await until('a store', () => c.logs.slice(before).some((l) => l.includes(` store page=${id}`)), 30_000, 20);
        }
        await s.rpc('notebook.version.save', { pageId: id });
        let cursor: string | undefined;
        do {
          const r: { next: string | null } = await s.rpc('notebook.page.content', { pageId: id, ...(cursor ? { cursor } : {}) });
          cursor = r.next ?? undefined;
        } while (cursor);
        const third = client().open(id);
        await synced(third, 120_000);
        out['lastPage'] = { page: i + 1, ...proc(pid), memory: (await s.health()).memory };
      }
      await sleep(1000);
      out['survived'] = died === null;
      out['end'] = died === null ? { ...proc(pid), memory: (await s.health()).memory } : null;
    } catch (e) {
      out['survived'] = false;
      out['error'] = (e as Error).message;
    } finally {
      clearInterval(sampler);
      out['peakAnonMiB'] = peakAnon;
      out['died'] = died;
      out['fatal'] = c.logs.filter((l) => /FATAL|heap limit|Allocation failed/.test(l)).map((l) => l.slice(0, 160));
      out['stores'] = c.logs.filter((l) => l.includes(' store page=')).length;
      for (const x of clients) x.destroy();
      s.close();
      if (died === null) await c.kill('SIGKILL');
      // Whatever happened, the next start, under the same cap, has every page and can open each by itself.
      const again = child(dir, { ...userEnv, ...EXTRA_ENV }, FLAGS, wrapper);
      await again.ready;
      const check = new DeskdSession(again.socket);
      const tree = await check.rpc('notebook.tree');
      const reopened: number[] = [];
      for (const page of tree.pages as { id: string }[]) {
        const r = new Client(again.socket);
        const p = r.open(page.id);
        await synced(p, 60_000);
        reopened.push(textOf(p.document).length);
        r.destroy();
        await until('it to leave', async () => (await check.health()).open === 0, 30_000, 50);
      }
      out['afterRestart'] = { charsPerPage: reopened, recovered: again.logs.filter((l) => l.includes('recovered pages')).map((l) => l.slice(25, 80)), ...proc(again.proc.pid as number) };
      check.close();
      await again.kill('SIGTERM');
      process.stderr.write(`MEMORY ${JSON.stringify(out)}\n`);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out['survived']).toBe(true);
  }, 600_000);
});
