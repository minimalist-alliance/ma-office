// TD-128: the Browser's simplified view (task 47, ADR 0046) on a few real pages, timed on a temporary test desk through the real Desk
// app as a member gets it (the client-config switch left on). rt-simple.mjs (web/tests/real-desk) proves the view on the shared test
// desk as desk-1; this times it on W3's desk: for each page, typed into the window's address bar, how long after Enter the view shows
// (or the real page with the desk's reason), how long `browser.minified.get` took on the desk, the desk's CPU from Enter to 5 s after
// the view, and then 10 s of scrolling inside the view (drawn by the client, so its frame rate is the client's) with the desk's CPU.
// It reads method names, error codes, `view`, fallback reasons and timings off `rpc`, never a document. Nothing is signed in to or
// typed into any page. SIMPLE_SITES (comma list) and SIMPLE_ROUNDS (default 3). Writes simple-<SIMPLE_LABEL>.json beside numbers.json.
// Skips unless W3_DESK and SIMPLE_LABEL are set. A staging DeskKind=test desk only, as every W3 spec.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { watch } from '../tests/lib';
import { cpuBetween, sleep } from '../tests/streamlib';
import { BrowserWin, TestDesk, W3_ON, W3_SKIP, appVersion, channelHook, clientLoad, installProbe, loadW3User, pickDesk, signIn, w3Input } from './w3lib';

test.skip(!W3_ON || !process.env.SIMPLE_LABEL, W3_SKIP);
test.setTimeout(90 * 60_000);

const SITES = (process.env.SIMPLE_SITES ?? 'https://en.wikipedia.org/wiki/Branch_predictor,https://text.npr.org/,https://html.duckduckgo.com/html/?q=branch+prediction,https://en.wikipedia.org/wiki/Typography').split(',');

/** rt-simple.mjs' probe, cut down: the time each `browser.minified.*` and `browser.stream.set` took, its answer, `view` and fallback reason. */
function minifiedProbe() {
  const w = window as unknown as Record<string, unknown>;
  const seen = { sent: [] as Record<string, unknown>[], replies: [] as Record<string, unknown>[] };
  w.__w3simple = seen;
  const asked = new Map<string, { m: string; at: number; state?: string }>();
  const text = (b: Uint8Array) => new TextDecoder().decode(b.subarray(12));
  const WATCH = /^(browser\.minified\.[a-z.]+|browser\.stream\.set)$/;
  const proto = RTCPeerConnection.prototype;
  const create = proto.createDataChannel;
  proto.createDataChannel = function (this: RTCPeerConnection, label: string, init?: RTCDataChannelInit) {
    const dc = create.call(this, label, init);
    if (label !== 'rpc') return dc;
    const send = dc.send.bind(dc);
    dc.send = ((d: ArrayBuffer | ArrayBufferView) => {
      try {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        if (bytes.byteLength > 12 && bytes[1] === 7) {
          const body = text(bytes);
          const m = /"m":"([a-z.]+)"/.exec(body)?.[1];
          if (m && WATCH.test(m)) {
            const e: { m: string; at: number; state?: string } = { m, at: performance.now() };
            if (m === 'browser.stream.set') e.state = JSON.parse(body).p?.state;
            seen.sent.push(e);
            asked.set(String(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4)), e);
          }
        }
      } catch { /* never in the way */ }
      return send(d as ArrayBuffer);
    }) as typeof dc.send;
    dc.addEventListener('message', (ev) => {
      try {
        const b = new Uint8Array(ev.data as ArrayBuffer);
        const key = String(new DataView(ev.data as ArrayBuffer).getUint32(4));
        const e = asked.get(key);
        if ((b[1] === 8 || b[1] === 9) && e) {
          asked.delete(key);
          const r: Record<string, unknown> = { m: e.m, state: e.state, at: performance.now(), ms: Math.round(performance.now() - e.at) };
          try {
            const j = JSON.parse(text(b));
            r.answer = b[1] === 8 ? 'ok' : j.code;
            if (b[1] === 9) r.reason = j.details?.reason ?? null;
            if (b[1] === 8 && typeof j.view === 'string') r.view = j.view;
            if (b[1] === 8 && j.fallback?.reason) r.fallback = `${j.fallback.reason}${j.fallback.cause ? `/${j.fallback.cause}` : ''}`;
            if (b[1] === 8 && Array.isArray(j.doc?.blocks)) r.blocks = j.doc.blocks.length;
          } catch { r.answer = b[1] === 8 ? 'ok (long)' : 'error'; }
          seen.replies.push(r);
        }
      } catch { /* a piece of a long frame */ }
    });
    return dc;
  } as typeof create;
}

test('the simplified view on real pages', async ({ browser }) => {
  const inp = w3Input();
  const label = process.env.SIMPLE_LABEL!;
  const rounds = Number(process.env.SIMPLE_ROUNDS ?? 3);
  const dir = join(inp.out, inp.label);
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report: any = { label, rounds, startedAt: new Date().toISOString(), sites: SITES, visits: [], notes: [] };
  const save = () => writeFileSync(join(dir, `simple-${label}.json`), JSON.stringify(report, null, 2));

  const desk = await TestDesk.resolve(inp.deskId!);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(channelHook);
  await context.addInitScript(minifiedProbe);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const w = watch(page);
  await signIn(context, page, loadW3User(inp), inp.url);
  const deskId = await pickDesk(page, w, inp);
  await page.evaluate(installProbe);
  const bw = new BrowserWin(page, deskId);
  report.desk = { instance: desk.instance, type: desk.type, ami: desk.ami, info: await desk.info() };
  report.client = { chrome: browser.version(), appVersion: await appVersion(page), load: clientLoad() };
  save();

  const probe = () => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __w3simple: unknown }).__w3simple)));
  const state = () => page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    return {
      view: q('[data-testid="simple-view"]')?.getAttribute('data-view') ?? null,
      page: q('[data-testid="simple-page"]')?.getAttribute('data-page') ?? null,
      blocks: Number(q('[data-testid="simple-page"]')?.getAttribute('data-blocks') ?? 0),
      switch: q('[data-testid="browser-simple"]') ? (q('[data-testid="browser-simple-on"]')?.getAttribute('aria-checked') === 'true' ? 'Simplified' : 'Real page') : null,
      line: q('[data-testid="browser-simple-line"]')?.textContent ?? null,
    };
  });
  /** 10 s of scrolling inside the view, at the kit's 1200 px/s, reversing every 4 s: the client's rAF, frames and gaps. */
  const scrollView = () => page.evaluate(async () => {
    const el = document.querySelector('[data-testid="simple-scroll"]') as HTMLElement | null;
    if (!el) return null;
    return await new Promise<Record<string, number>>((res) => {
      const t0 = performance.now(); let last = t0, frames = 0, gapMax = 0, longFrames = 0; const y0 = el.scrollTop; let moved = 0, py = el.scrollTop;
      const per: number[] = []; let secStart = t0, secFrames = 0;
      const step = (now: number) => {
        const g = now - last; if (frames) { if (g > gapMax) gapMax = g; if (g > 25) longFrames++; }
        const dy = Math.round(g * 1.2) * (((now - t0) % 8000) < 4000 ? 1 : -1);
        last = now; frames++; secFrames++;
        el.scrollBy(0, dy); moved += Math.abs(el.scrollTop - py); py = el.scrollTop;
        if (now - secStart >= 1000) { per.push((secFrames * 1000) / (now - secStart)); secStart = now; secFrames = 0; }
        if (now - t0 < 10_000) requestAnimationFrame(step); else res({ seconds: (now - t0) / 1000, fps: (frames * 1000) / (now - t0), p5: [...per].sort((a, b) => a - b)[Math.floor(per.length * 0.05)] ?? 0, min: Math.min(...per), gapMaxMs: gapMax, longFrames, movedPx: moved, y0, scrollHeight: el.scrollHeight });
      };
      requestAnimationFrame(step);
    });
  });

  try {
    await bw.open();
    await bw.waitPicture(300_000);
    await bw.waitTabs(300_000);
    await bw.newTab();
    await sleep(3000);
    const p0 = await probe();
    const site0 = p0.replies.find((r: { m: string }) => r.m === 'browser.minified.site.get');
    report.serves = site0 ? { answer: site0.answer, reason: site0.reason ?? null, ms: site0.ms } : 'not asked yet';
    save();
    if (site0 && site0.answer !== 'ok') { report.notes.push(`deskd answers ${site0.answer} to browser.minified.site.get: no simplified view on this desk`); return; }

    for (let round = 1; round <= rounds; round++) {
      for (const url of SITES) {
        const host = new URL(url).hostname;
        const before = (await state()).page;
        const repliesBefore = (await probe()).replies.length;
        const cpu0 = await desk.cpu();
        await bw.address.click();
        await bw.address.fill(url);
        const t0 = Date.now();
        await page.keyboard.press('Enter');
        let shown: Record<string, unknown> | null = null;
        while (Date.now() - t0 < 30_000 && !shown) {
          const s = await state().catch(() => null);
          if (s?.view === 'simple' && s.blocks > 0 && s.page && s.page !== before && new URL(s.page).hostname === host) shown = { ...s, ms: Date.now() - t0, as: 'simplified' };
          else if (s?.switch === 'Real page' && s.line && !/Couldn.t simplify/.test(s.line) && Date.now() - t0 > 1500) shown = { ...s, ms: Date.now() - t0, as: 'real page' };
          else await sleep(100);
        }
        await sleep(5000);
        const cpu1 = await desk.cpu();
        const pr = await probe();
        const replies = pr.replies.slice(repliesBefore);
        const gets = replies.filter((r: { m: string }) => r.m === 'browser.minified.get');
        const visit: Record<string, unknown> = {
          round, host, url, afterEnter: shown ?? { as: 'nothing in 30 s' }, deskGet: gets.map((g: Record<string, unknown>) => ({ ms: g.ms, answer: g.answer, view: g.view, fallback: g.fallback, blocks: g.blocks })),
          streamAsked: pr.sent.filter((e: { m: string; at: number }) => e.m === 'browser.stream.set').slice(-3).map((e: { state: string }) => e.state),
          deskCpuToViewPlus5s: cpuBetween(cpu0, cpu1), clientLoad: clientLoad().loadavg1m, at: new Date().toISOString(),
        };
        if (shown?.as === 'simplified') {
          const c0 = await desk.cpu();
          visit.scroll = await scrollView();
          const c1 = await desk.cpu();
          visit.deskCpuWhileScrolling = cpuBetween(c0, c1);
          visit.units = await desk.units().then((u) => ({ stream: u.stream, browser: u.units['desk-browser']?.active, deskStream: u.units['desk-stream']?.active })).catch(() => null);
        }
        report.visits.push(visit);
        save();
        console.log(`[simple] round ${round} ${host}: ${(shown?.as as string) ?? 'nothing'} ${shown?.ms ?? ''} ms`);
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.methods = [...new Set(((await probe().catch(() => ({ replies: [] }))).replies as { m: string; answer: string; reason?: string }[]).map((r) => `${r.m} ${r.answer}${r.reason ? `/${r.reason}` : ''}`))];
    await bw.address.fill('https://example.com/').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(2000);
    await bw.closeOwnTab().catch(() => {});
    await bw.close().catch(() => {});
    save();
    await context.close();
  }
  expect(report.visits.length + report.notes.length).toBeGreaterThan(0);
});
