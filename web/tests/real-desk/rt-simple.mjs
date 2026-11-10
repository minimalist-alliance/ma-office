// The Browser's simplified view (task 47) on the real test desk as desk-1, with this checkout's own bundle in place of
// staging's (`dist/release`, served by page.route at the app's own origin, so sign-in, CSP and the gateway are the real ones),
// in full Chromium for H.264. Hold ~/work/.test-desk.lock. Never wakes anything: the desk must be running.
//
// For each of a few public, document-like pages (SITES, or the defaults below: an encyclopedia article, a Q&A page, a news
// article found from a text-only front page, a plain search), typed into the window's address bar as a member would:
// whether the view showed, how long after Enter, and how long after the window opened again on it, with the stream's first
// frame timed beside it (the desk is asked beside the stream, never ahead of it); a window shot of each; and whether
// "Show the real page" (the hidden control's, for this page only, never remembered) brings the picture back. Then a page the
// desk says no to (a missing article, `http_error`): the stream starts and plays as before. Nothing is signed in and nothing
// is typed into any page. It reads only method names, error codes, `view`, fallback reasons and versions off `rpc`, never a
// document. At the end the tab goes back to the address it had, and the window closes. The desk's site memory is untouched:
// "Show the real page" doesn't write it, and the switch is never pressed.
//
//   npm run build:release && flock ~/work/.test-desk.lock timeout 45m nice -n 15 node tests/real-desk/rt-simple.mjs
//   MA_EXPECT_VERSION=2026.11.09-abc1234 … node tests/real-desk/rt-simple.mjs   # staging's own bundle, once it's there
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALLOWED, events, getDesk, log, openSession, S, shutdown, wait, waitPanel } from './rt-lib.mjs';

const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-simple/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const EXPECTED = process.env.MA_EXPECT_VERSION ?? null;
const release = EXPECTED ? { version: EXPECTED } : JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
const SITES = (process.env.SITES ?? 'https://en.wikipedia.org/wiki/Branch_predictor,https://stackoverflow.com/questions/11227809,npr,https://html.duckduckgo.com/html/?q=branch+prediction').split(',');
const NO_PAGE = process.env.NO_PAGE ?? 'https://en.wikipedia.org/wiki/Ma_desk_test_no_such_article_7q3';

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const note = (name, detail) => {
  results.push({ name, ok: null, detail });
  log(`NOTE ${name}: ${detail}`);
};
const until = async (fn, ms, every = 150) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await wait(every);
  }
  return null;
};

/** Names, codes, `view`, fallback reasons and versions on `rpc`; never a document or a value. CSP violations too. */
function simpleProbe() {
  const w = window;
  const seen = (w.__rtSimple = { sent: [], replies: [], violations: [] });
  document.addEventListener('securitypolicyviolation', (e) => seen.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
  const asked = new Map();
  const text = (bytes) => new TextDecoder().decode(bytes.subarray(12));
  const WATCH = /^(browser\.minified\.[a-z.]+|browser\.stream\.set|desk\.status\.get)$/;
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(d) {
    try {
      if (this.label === 'rpc' && d?.byteLength > 12) {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
        const body = text(bytes);
        const m = /"m":"([a-z.]+)"/.exec(body)?.[1];
        if (bytes[1] === 7 && m && WATCH.test(m)) {
          const entry = { m, at: performance.now() };
          if (m === 'browser.stream.set') entry.state = JSON.parse(body).p?.state;
          seen.sent.push(entry);
          asked.set(`${this.__pc}:${id}`, entry);
        }
      }
    } catch {
      /* never in the way */
    }
    return send.call(this, d);
  };
  const Native = w.RTCPeerConnection;
  let pcs = 0;
  w.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      this.__n = ++pcs;
    }
    createDataChannel(label, init) {
      const dc = super.createDataChannel(label, init);
      dc.__pc = this.__n;
      if (label !== 'rpc') return dc;
      dc.addEventListener('message', (e) => {
        try {
          const bytes = new Uint8Array(e.data);
          const kind = bytes[1];
          const key = `${dc.__pc}:${new DataView(e.data).getUint32(4)}`;
          const entry = asked.get(key);
          if ((kind === 8 || kind === 9) && entry) {
            asked.delete(key);
            const r = { m: entry.m, state: entry.state, ms: Math.round(performance.now() - entry.at) };
            try {
              const b = JSON.parse(text(bytes));
              r.answer = kind === 8 ? 'ok' : b.code;
              if (kind === 9) r.reason = b.details?.reason ?? null;
              if (kind === 8 && typeof b.view === 'string') r.view = b.view;
              if (kind === 8 && b.fallback?.reason) r.fallback = `${b.fallback.reason}${b.fallback.cause ? `/${b.fallback.cause}` : ''}`;
              if (entry.m === 'desk.status.get' && kind === 8) Object.assign(r, { deskd: b.deskdVersion, rtc: b.rtcVersion });
            } catch {
              r.answer = kind === 8 ? 'ok (long)' : 'error';
            }
            seen.replies.push(r);
          }
        } catch {
          /* a piece of a long frame */
        }
      });
      return dc;
    }
  };
}

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 40 * 60 * 1000);
watchdog.unref();

await openSession({
  browserKind: 'full',
  onContext: async (ctx) => {
    await ctx.addInitScript(simpleProbe);
    if (EXPECTED) return;
    await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
    await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
      const file = `${DIST}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
    });
  },
});
const p = S.page;
const probe = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__rtSimple)));
const report = { bundle: release.version, desk: null, probe: null, sites: [], results };
S.beforeExit = () => {
  try {
    writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
  } catch {
    /* the log has it all */
  }
};

const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
const mainAsset = release.entry ? release.entry.split('/').pop() : null;
step('bundle', EXPECTED ? Boolean(loaded?.includes(`/v/${EXPECTED}/`)) : Boolean(mainAsset && loaded?.endsWith(mainAsset)), `${release.version}`);
const desk = await getDesk();
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}, and focusing it would wake it`);
  await shutdown(1, 'desk not running');
}
await btn.focus();
await p.keyboard.press('Enter');
step('the link is open', await waitPanel(/online/, 60_000));

const win = () => p.getByRole('dialog', { name: 'Browser' }).first();
const video = p.locator('video.br-video');
const address = p.getByTestId('browser-address');
const view = p.getByTestId('simple-view');
const page = p.getByTestId('simple-page');
const frames = () => video.evaluate((v) => (v.videoWidth > 0 ? (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) : 0)).catch(() => 0);
const winShot = async (name) => {
  await wait(400);
  await win().screenshot({ path: `${OUT}${name}.png` }).catch((e) => log('shot failed', name, e.message.slice(0, 80)));
};
/** The window opened from the desk's tile, timed: its first stream frame and the view, each from the press. */
async function openWindow(waitView = true) {
  const proxy = p.locator(`[id="proxy-${ALLOWED}:browser"]`);
  await proxy.focus();
  const sentBefore = (await probe()).sent.length;
  const t0 = Date.now();
  const pt0 = await p.evaluate(() => performance.now());
  await p.keyboard.press('Enter');
  await win().waitFor({ state: 'visible', timeout: 15_000 });
  let frameMs = null;
  let viewMs = null;
  await until(async () => {
    if (frameMs === null && (await frames()) > 0) frameMs = Date.now() - t0;
    if (viewMs === null && (await page.getAttribute('data-blocks', { timeout: 200 }).catch(() => null)) > 0 && (await view.getAttribute('data-view', { timeout: 200 }).catch(() => null)) === 'simple') viewMs = Date.now() - t0;
    return frameMs !== null && (viewMs !== null || !waitView);
  }, 30_000);
  if (!waitView) {
    // Long enough for a view that shouldn't come to have come.
    await wait(4000);
    if ((await view.getAttribute('data-view', { timeout: 200 }).catch(() => null)) === 'simple') viewMs = Date.now() - t0;
  }
  // The stream as the window asked for it: live first, as on main, then warm once the view covers.
  const stream = (await probe()).sent.slice(sentBefore).filter((e) => e.m === 'browser.stream.set').map((e) => `${e.state} at ${Math.round(e.at - pt0)} ms`);
  return { frameMs, viewMs, stream };
}
async function closeWindow() {
  await p.getByRole('button', { name: 'Close Browser' }).click({ timeout: 4000 }).catch(() => p.keyboard.press('Escape'));
  await until(async () => (await p.getByRole('dialog', { name: 'Browser' }).count()) === 0, 8000);
}
/** What the window shows now: the view's state, the switch, the line, and what the site row says. Words of the office only. */
const state = () =>
  p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      view: q('[data-testid="simple-view"]')?.getAttribute('data-view') ?? null,
      page: q('[data-testid="simple-page"]')?.getAttribute('data-page') ?? null,
      blocks: Number(q('[data-testid="simple-page"]')?.getAttribute('data-blocks') ?? 0),
      switch: q('[data-testid="browser-simple"]') ? (q('[data-testid="browser-simple-on"]')?.getAttribute('aria-checked') === 'true' ? 'Simplified' : 'Real page') : null,
      line: q('[data-testid="browser-simple-line"]')?.textContent ?? null,
      row: [...document.querySelectorAll('[data-testid="simple-site"] .sv-sact')].map((e) => e.getAttribute('aria-label')),
      hidden: q('[data-testid="simple-hidden"]')?.textContent?.trim() ?? null,
    };
  });
async function go(url) {
  await address.click();
  await address.fill(url);
  const t0 = Date.now();
  await p.keyboard.press('Enter');
  return t0;
}

// ----- the window, as it opens on whatever the desk's tab shows now
const opened = await openWindow();
const startUrl = await address.inputValue();
const pr0 = await probe();
const asked = pr0.replies.find((r) => r.m === 'browser.minified.site.get');
report.probe = asked ? { answer: asked.answer, reason: asked.reason ?? null, ms: asked.ms } : null;
const status = pr0.replies.find((r) => r.m === 'desk.status.get' && r.deskd);
report.desk = status ? { deskd: status.deskd, rtc: status.rtc } : null;
log('on the desk:', JSON.stringify(report.desk), 'asked whether it serves the view:', JSON.stringify(report.probe));
step('the stream starts as the window opens, beside the question', opened.stream[0]?.startsWith('live') && opened.frameMs !== null, `stream ${opened.stream.join(', ')}; first frame ${opened.frameMs} ms after the press`);
const serves = asked?.answer === 'ok';
if (!serves) {
  note('section 14', `this deskd answers ${asked?.answer ?? 'nothing'} to browser.minified.site.get: no view on this desk, so the sites below aren't tried`);
  await closeWindow();
  await shutdown(0, 'no section 14');
}

// ----- each page
for (const raw of SITES) {
  let url = raw;
  if (raw === 'npr') {
    // A current news article: the first story on NPR's text-only front page, read from the view's own link.
    const t0 = await go('https://text.npr.org/');
    await until(async () => (await state()).page?.includes('text.npr.org'), 30_000);
    await wait(1500);
    url = await p.evaluate(() => [...document.querySelectorAll('[data-testid="simple-page"] [role="link"][data-url]')].map((a) => a.getAttribute('data-url')).find((u) => /text\.npr\.org\/(nx-)?[0-9a-z-]{6,}/.test(u ?? '')) ?? null);
    note('npr front page', `simplified ${Date.now() - t0} ms after Enter; first story ${url ? 'found' : 'not found'}`);
    if (!url) continue;
  }
  const host = new URL(url).hostname;
  const tag = host.replace(/^(www|en|html)\./, '').split('.')[0];
  const site = { url, host };
  report.sites.push(site);
  const before = (await state()).page;
  const t0 = await go(url);
  let interim = null;
  const shown = await until(async () => {
    const s = await state();
    if (s.view === 'simple' && s.blocks > 0 && s.page && s.page !== before && new URL(s.page).hostname === host) return { ...s, ms: Date.now() - t0 };
    // The desk said no, with its reason in the line. "Couldn't simplify" is the view's own word while the desk is slow to decide.
    if (s.switch === 'Real page' && s.line && /Couldn.t simplify/.test(s.line)) interim ??= { line: s.line, ms: Date.now() - t0 };
    else if (s.switch === 'Real page' && s.line) return { ...s, ms: Date.now() - t0, real: true };
    return null;
  }, 30_000);
  site.afterEnter = shown ? { ms: shown.ms, view: shown.real ? 'real page' : 'simplified', switch: shown.switch, line: shown.line, row: shown.row, hidden: shown.hidden, interim } : { view: 'nothing in 30 s', interim };
  const pr = await probe();
  const got = pr.replies.filter((r) => r.m === 'browser.minified.get').at(-1);
  site.desk = got ? { view: got.view ?? null, fallback: got.fallback ?? null, answer: got.answer, ms: got.ms } : null;
  step(`${tag}: the view shows after Enter, or the real page with the desk's reason`, site.afterEnter.view !== 'nothing in 30 s', JSON.stringify({ ...site.afterEnter, desk: site.desk }));
  await wait(1500);
  await winShot(`${tag}-${site.afterEnter.view === 'simplified' ? 'simplified' : 'real-page-by-desk'}`);
  // The window opened again on the same page.
  await closeWindow();
  const again = await openWindow();
  site.reopen = again;
  const liveFirst = again.stream[0]?.startsWith('live');
  if (site.afterEnter.view === 'simplified') step(`${tag}: opened again, the stream is asked live first and the view comes beside it`, liveFirst && again.viewMs !== null, `stream ${again.stream.join(', ')}; first frame ${again.frameMs ?? 'none before the view covered'} ms, view ${again.viewMs} ms after the press`);
  else step(`${tag}: opened again, the stream starts as before`, liveFirst && again.frameMs !== null && again.viewMs === null, `stream ${again.stream.join(', ')}; first frame ${again.frameMs} ms after the press; no view`);
  // "Show the real page", for this page only.
  const control = p.getByTestId('simple-hidden');
  if (await control.count()) {
    await control.click();
    await p.getByTestId('simple-hidden-popover').getByRole('button', { name: 'Show the real page' }).click({ timeout: 5000 });
    const t1 = Date.now();
    const f0 = await frames();
    const real = await until(async () => {
      const s = await state();
      return s.switch === 'Real page' && (await frames()) > f0 + 5 ? Date.now() - t1 : null;
    }, 20_000);
    site.realPage = real === null ? 'no picture in 20 s' : `${real} ms to a playing picture`;
    step(`${tag}: "Show the real page" brings the picture back`, real !== null, site.realPage);
    await winShot(`${tag}-real-page`);
  } else note(`${tag}: "Show the real page"`, 'no hidden control on this page (nothing was hidden)');
}

// ----- a page the desk says no to: the stream starts and plays as before
{
  await go(NO_PAGE);
  await wait(6000);
  const s = await state();
  const f0 = await frames();
  await wait(2000);
  const f1 = await frames();
  const pr = await probe();
  const got = pr.replies.filter((r) => r.m === 'browser.minified.get').at(-1);
  report.noPage = { switch: s.switch, view: s.view, line: s.line, desk: got ? { view: got.view ?? null, fallback: got.fallback ?? null } : null, frames: [f0, f1] };
  step('a page the desk says no to is the real page, and the picture plays', s.view !== 'simple' && f1 > f0, JSON.stringify(report.noPage));
  await winShot('no-page-real');
  await closeWindow();
  const again = await openWindow(false);
  step('opened again on it, the stream starts as before', again.stream[0]?.startsWith('live') && again.frameMs !== null && again.viewMs === null, `stream ${again.stream.join(', ')}; first frame ${again.frameMs} ms after the press; no view`);
}

// ----- back to where the tab was, and the window closed
// Back where the tab was; a tab with no address of its own (a new tab) gets the plainest page there is.
await go(/^https?:\/\//.test(startUrl) ? startUrl : 'https://example.com/');
await wait(3000);
await closeWindow();
const end = await probe();
report.streamStates = end.sent.filter((e) => e.m === 'browser.stream.set').map((e) => e.state);
report.methods = [...new Set(end.replies.map((r) => `${r.m} ${r.answer}${r.reason ? `/${r.reason}` : ''}`))];
step('no CSP violations', end.violations.length === 0, JSON.stringify(end.violations));
const consoleProblems = events.filter((e) => e.k === 'console').length;
step('no console errors or warnings', consoleProblems === 0, `${consoleProblems}`);
const failed = results.filter((r) => r.ok === false).length;
log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
await shutdown(failed === 0 ? 0 : 1, 'done');
