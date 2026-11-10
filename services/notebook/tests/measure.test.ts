// `npm run measure`: the numbers in README.md, from the real bundle with docker/run's Node flags. Fake text only.
// Skipped unless MEASURE=1, as it takes a while and reads a shared machine's load into its results.
import { loadavg, cpus } from 'node:os';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until } from './helpers/deskd.ts';
import { fakeState, textOf, typeInto } from './helpers/docs.ts';
import { child, makeNotebook, tempDir, type Child } from './helpers/service.ts';

function rssMiB(pid: number): number {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return Math.round((Number(m?.[1] ?? 0) / 1024) * 10) / 10;
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe.runIf(process.env['MEASURE'] === '1')('measure', () => {
  it('ready, memory, store', async () => {
    const out: Record<string, unknown> = { node: process.version, arch: process.arch, cpu: cpus()[0]?.model, cores: cpus().length, load: loadavg()[0] };

    // Ready time: as the process measures it, on an existing database, 7 runs. The first makes the schema.
    const dir = tempDir();
    const readies: number[] = [];
    const exits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const c = child(dir);
      await c.ready;
      const m = /ready in (\d+) ms/.exec(c.logs.find((l) => l.includes('ready in')) ?? '');
      if (i > 0) readies.push(Number(m?.[1]));
      const t0 = performance.now();
      await c.kill('SIGTERM');
      exits.push(performance.now() - t0);
    }
    out['readyMs'] = { median: median(readies), min: Math.min(...readies), max: Math.max(...readies) };
    out['sigtermExitMsEmpty'] = Math.round(median(exits));

    // Memory at rest, and with the 100-page page open by 2 clients.
    const c: Child = child(dir, { DESK_NOTEBOOK_DEBUG: '1', DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '300', DESK_NOTEBOOK_STORE_MAX_MS: '1000' });
    await c.ready;
    const pid = c.proc.pid as number;
    await sleep(2000);
    out['rssAtRestMiB'] = rssMiB(pid);
    const s = new DeskdSession(c.socket);
    const { pageId } = await makeNotebook(s);
    const a = new Client(c.socket);
    const b = new Client(c.socket);
    const pa = a.open(pageId);
    const pb = b.open(pageId);
    await Promise.all([synced(pa), synced(pb)]);
    await sleep(1000);
    out['rssTwoClientsSmallPageMiB'] = rssMiB(pid);

    const state = fakeState(100);
    out['fixtureYjsBytes'] = state.length;
    Y.applyUpdate(pa.document, state);
    await until('b to have it', () => textOf(pb.document).includes('end-100'), 60_000);
    await until('the store', () => c.logs.some((l) => l.includes(' store page=')), 30_000);

    // One store of it, several times: a keystroke and the debounce after it.
    const stores: { ms: number; encodeMs: number; deriveMs: number; writeMs: number; ydoc: number; json: number }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const before = c.logs.length;
      typeInto(pa.document, 'x');
      await until('a store', () => c.logs.slice(before).some((l) => l.includes(' store page=')), 10_000);
      const line = c.logs.slice(before).find((l) => l.includes(' store page=')) ?? '';
      const f = (k: string): number => Number(new RegExp(`\\b${k}=([\\d.]+)`).exec(line)?.[1]);
      stores.push({ ms: f('ms'), encodeMs: f('encodeMs'), deriveMs: f('deriveMs'), writeMs: f('writeMs'), ydoc: f('ydoc'), json: f('json') });
    }
    const med = (k: keyof (typeof stores)[number]): number => median(stores.map((x) => x[k]));
    out['store100Pages'] = { runs: stores.length, totalMs: med('ms'), maxMs: Math.max(...stores.map((x) => x.ms)), encodeMs: med('encodeMs'), deriveMs: med('deriveMs'), writeMs: med('writeMs'), ydocBytes: med('ydoc'), jsonChars: med('json') };

    // Another client's keystroke to this one, in the 100-page page, through the socket and back.
    const latencies: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const mark = `m${i}|`;
      const t0 = performance.now();
      const seen = new Promise<void>((resolve) => {
        const on = (): void => {
          pb.document.off('update', on);
          resolve();
        };
        pb.document.on('update', on);
      });
      typeInto(pa.document, mark);
      await seen;
      latencies.push(performance.now() - t0);
      await sleep(2);
    }
    latencies.sort((x, y) => x - y);
    out['mergeMsInBigPage'] = { p50: Number(latencies[100]?.toFixed(2)), p99: Number(latencies[197]?.toFixed(2)) };

    await sleep(3000);
    out['rss100PagesTwoClientsMiB'] = rssMiB(pid);
    a.destroy();
    b.destroy();
    await until('the page to leave memory', async () => (await s.health()).open === 0, 15_000);
    await sleep(1000);
    out['rssAfterItLeftMiB'] = rssMiB(pid);

    // A store of a page near the ceiling, about 6 times the size, with RSS while it's open.
    {
      const { tabId } = await s.rpc('notebook.tree').then((t: { tabs: { id: string }[] }) => ({ tabId: t.tabs[0]?.id }));
      const big = (await s.rpc('notebook.page.create', { tabId })).page.id as string;
      const d = new Client(c.socket);
      const pd = d.open(big);
      await synced(pd);
      const bigState = fakeState(560, 7);
      out['nearCeilingYjsBytes'] = bigState.length;
      let before = c.logs.length;
      Y.applyUpdate(pd.document, bigState);
      await until('ack', () => !pd.hasUnsyncedChanges, 60_000);
      await until('the store', () => c.logs.slice(before).some((l) => l.includes(` store page=${big}`)), 30_000);
      const big3: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        before = c.logs.length;
        typeInto(pd.document, 'x');
        await until('a store', () => c.logs.slice(before).some((l) => l.includes(` store page=${big}`)), 15_000);
        const line = c.logs.slice(before).find((l) => l.includes(` store page=${big}`)) ?? '';
        big3.push(Number(/\bms=([\d.]+)/.exec(line)?.[1]));
      }
      out['storeNearCeilingMs'] = { runs: big3.length, median: median(big3), max: Math.max(...big3) };
      await sleep(2000);
      out['rssNearCeilingOpenMiB'] = rssMiB(pid);
      d.destroy();
      await until('it to leave', async () => (await s.health()).open === 0, 15_000);
    }

    // A cold open of it, and a stop with it open and unstored.
    const cold = new Client(c.socket);
    const t0 = performance.now();
    const pc = cold.open(pageId);
    await synced(pc, 60_000);
    out['coldOpenMs'] = Math.round(performance.now() - t0);
    typeInto(pc.document, 'y');
    await until('ack', () => !pc.hasUnsyncedChanges);
    cold.destroy();
    s.close();
    const t1 = performance.now();
    await c.kill('SIGTERM');
    out['sigtermExitMs100Pages'] = Math.round(performance.now() - t1);
    out['dbBytes'] = statSync(join(c.dataDir, 'notebook.db')).size;
    out['loadEnd'] = loadavg()[0];
    console.info(`MEASURE ${JSON.stringify(out)}`);
    process.stderr.write(`MEASURE ${JSON.stringify(out)}\n`);
    rmSync(dir, { recursive: true, force: true });
  }, 300_000);
});
