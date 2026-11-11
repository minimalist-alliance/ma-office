// The Browser's simple view (task 47) on `MockDeskLink`, whose `mockSimpleView.ts` plays the desk: its made-up pages and
// synthetic captures in the
 prototype's MDoc format (`tests/fixtures/captures/`: real pages' structure with
// made-up text and `.example` links). On by default, as it ships: client-config's `simpleView: { enabled: false }` is only a kill switch. The mock
// desk is a desk of today unless a test says it serves section 14 (`serves`), as `arrive` and `openOn` do.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SAMPLES = join(import.meta.dirname, '../fixtures/captures');

interface Rpc {
  m: string;
  p: Record<string, unknown>;
  options?: { idem?: string };
}
/** The mock desk's side of section 14 (`mockSimpleView.ts`): `acts` are `browser.minified.act`'s params as sent. */
interface SimpleControl {
  /** The desk's `deskd` serves section 14; false is a desk of today (every method and the topic `not_found`). */
  serves: boolean;
  /** How long `browser.minified.site.get`, the window's question among them, takes to answer. */
  siteDelayMs: number;
  sites: Record<string, string>;
  adblockOff: string[];
  noAdblockSwitch: boolean;
  refuseIslands: string[];
  islandDelayMs: number;
  noCrop: boolean;
  /** Every `act` with `action: 'media'`, as `{nodeId, ...value}`. */
  media: Record<string, unknown>[];
  retries: number;
  island: { key: string } | null;
  acts: Record<string, unknown>[];
  refuseActs: boolean;
  silent: boolean;
  /** How long a page takes to come after the tab gets there. */
  delayMs: number;
  sent: number;
  loadPage(url: string, page: unknown): void;
}
interface MockControl {
  rpc: Rpc[];
  refuse: Record<string, string>;
  input: { channel: string; bytes: number[] }[];
  framesDrawn: number;
  simple: SimpleControl;
  setTabs(tabs: unknown[]): void;
}

const mock = <T, A = undefined>(page: Page, fn: (c: MockControl, arg: A) => T, arg?: A): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__maDeskMock, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
const rpcs = (page: Page, method: string): Promise<Rpc[]> => mock(page, (c, m) => c.rpc.filter((r) => r.m === m), method);
const streamStates = (page: Page): Promise<string[]> => mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));
const lastStream = async (page: Page): Promise<string | undefined> => (await streamStates(page)).at(-1);
const acts = (page: Page): Promise<Record<string, unknown>[]> => mock(page, (c) => c.simple.acts);
const lastAct = async (page: Page): Promise<Record<string, unknown> | undefined> => (await acts(page)).at(-1);

const browserWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Browser/ });
const simpleView = (page: Page): Locator => page.getByTestId('simple-view');
const simplePage = (page: Page): Locator => page.getByTestId('simple-page');
const theSwitch = (page: Page): Locator => page.getByTestId('browser-simple');
const simplified = (page: Page): Locator => page.getByTestId('browser-simple-on');
const realPage = (page: Page): Locator => page.getByTestId('browser-simple-off');
const line = (page: Page): Locator => page.getByTestId('browser-simple-line');
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true } as const;

/** The desk serves the simplified view (section 14), as `deskd` will once its release is on the desk. */
const serve = (page: Page): Promise<void> =>
  mock(page, (c) => {
    c.simple.serves = true;
  });

/** Signed in, with the view on as it ships (no `simpleView` block), or off by its kill switch; on, the desk serves it. */
async function arrive(page: Page, on = true): Promise<void> {
  await page.request.post('/__harness', { data: { simpleView: on ? null : { enabled: false } } });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  if (on) await serve(page);
}

async function openBrowser(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(browserWindow(page)).toBeVisible();
}

/** The tab is at `url`, as the desk's tabs say. */
async function goTo(page: Page, url: string): Promise<void> {
  await mock(page, (c, u) => c.setTabs([{ tabId: 't1', url: u, title: new URL(u).hostname, loading: false, active: true, canGoBack: true, canGoForward: false }]), url);
}

async function openOn(page: Page, url: string): Promise<void> {
  await serve(page);
  await goTo(page, url);
  await openBrowser(page);
  await expect(simplePage(page)).toHaveAttribute('data-page', url);
}

/**
 * axe over what this task draws (the simplified view and the bar's switch and line), at WCAG 2.2 AA and best practice,
 * through devtools so the page's CSP doesn't apply. The window's tab strip has its own finding on `main` (a New tab
 * button inside its tablist), which isn't this task's.
 */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const include = ['.ma-window .sv', '.ma-window .br-mode', '.ma-window .br-line'].filter((sel) => document.querySelector(sel));
    const r = await w.axe.run({ include }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `test-results/shots/simple-${name}.png` });
}

/** Only the Browser window, for comparing with the Designer's sheets. */
async function windowShot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await browserWindow(page).screenshot({ path: `test-results/shots/simple-${name}.png` });
}

/** The prototype's capture of a real page, as the desk would send it. */
function sample(name: string): { url: string; doc: { meta: Record<string, unknown>; order: string[]; add: Record<string, unknown> } } {
  const raw = JSON.parse(readFileSync(join(SAMPLES, `${name}.doc.json`), 'utf8')) as { meta: Record<string, unknown>; order: string[]; add: Record<string, unknown> };
  // Two captures can share an address: each gets its own here.
  const url = new URL(String(raw.meta['url']));
  url.searchParams.set('sample', name);
  return { url: url.href, doc: { meta: raw.meta, order: raw.order, add: raw.add } };
}

async function loadSample(page: Page, name: string): Promise<string> {
  const s = sample(name);
  await mock(page, (c, a) => c.simple.loadPage(a.url, a.doc), s);
  return s.url;
}

interface Pacing {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over25: number;
  longFrames: number;
  scrolled: number;
}

/** Frame times while `drive` scrolls the page: rAF timestamps, and long animation frames, in the page itself. */
async function pacing(page: Page, drive: () => Promise<void>): Promise<Pacing> {
  await page.evaluate(() => {
    const w = window as unknown as { __svPace: { ts: number[]; loaf: number; on: boolean; y0: number } };
    const box = document.querySelector('[data-testid="simple-scroll"]') as HTMLElement;
    w.__svPace = { ts: [], loaf: 0, on: true, y0: box.scrollTop };
    try {
      new PerformanceObserver((l) => (w.__svPace.loaf += l.getEntries().filter((e) => e.duration > 50).length)).observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      // not in this browser
    }
    // This run's own loop: a loop from an earlier run stops with its own record, never feeding this one.
    const run = w.__svPace;
    const f = (t: number): void => {
      if (!run.on) return;
      run.ts.push(t);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await drive();
  return page.evaluate(() => {
    const w = window as unknown as { __svPace: { ts: number[]; loaf: number; on: boolean; y0: number } };
    w.__svPace.on = false;
    const ts = w.__svPace.ts;
    const iv: number[] = [];
    for (let i = 1; i < ts.length; i += 1) iv.push((ts[i] as number) - (ts[i - 1] as number));
    const s = [...iv].sort((a, b) => a - b);
    const q = (p: number): number => Math.round((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0) * 10) / 10;
    const dur = (ts.at(-1) ?? 0) - (ts[0] ?? 0);
    const box = document.querySelector('[data-testid="simple-scroll"]') as HTMLElement;
    return { frames: ts.length, fps: Math.round(((ts.length - 1) * 1000) / dur * 10) / 10, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(s.at(-1) ?? 0), over25: iv.filter((x) => x > 25).length, longFrames: w.__svPace.loaf, scrolled: Math.round(box.scrollTop - w.__svPace.y0) };
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the kill switch, simpleView: { enabled: false }: no switch, no simple view, no simple-view call, and the picture goes live as before', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page, false);
  await goTo(page, 'https://read.example/essay');
  await openBrowser(page);
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(page.getByTestId('browser-video')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await simpleView(page).count()).toBe(0);
  expect(await theSwitch(page).count()).toBe(0);
  await expect(page.getByRole('button', { name: /^Picture quality/ })).toBeVisible();
  expect(await streamStates(page)).not.toContain('warm');
  expect(await mock(page, (c) => c.rpc.filter((r) => r.m.startsWith('browser.minified')).length)).toBe(0);
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`${theme}: an article reads calm and clean, passes axe, and Simplified | Real page goes to the real page and back`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openOn(page, 'https://read.example/essay');
    // Simplified: the desk sends no picture, only the page's structure.
    await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
    await expect.poll(() => lastStream(page)).toBe('warm');
    // The stream starts as it always did, beside the question; once the desk says it serves the view, it goes warm.
    expect((await streamStates(page)).slice(1)).not.toContain('live');
    await expect(simplePage(page).getByRole('heading', { name: 'The quiet craft of keeping a desk' })).toBeVisible();
    // The site row: its name, Search and Menu, and what was hidden. Nothing else before the content.
    const site = page.getByTestId('simple-site');
    // Named by its registrable domain, from the page's origin, and the page's own name only second (T47O-3).
    await expect(page.getByTestId('simple-site-name')).toHaveText('read.example');
    await expect(site).toContainText('The Quiet Journal');
    await expect(site.getByRole('button', { name: 'Search' })).toBeVisible();
    await expect(site.getByRole('button', { name: 'Menu' })).toBeVisible();
    await expect(page.getByTestId('simple-hidden')).toHaveText('8 hidden');
    await expect(simplified(page)).toHaveAttribute('aria-checked', 'true');
    await expect(realPage(page)).toHaveAttribute('title', 'Show read.example as the real page. Remembered for this site.');
    // No picture to tune: the quality menu shows only beside Real page.
    await expect(page.getByRole('button', { name: /^Picture quality/ })).toHaveCount(0);
    await expect(line(page)).toHaveCount(0);
    await windowShot(page, `${theme}-article`);
    expect(await axe(page)).toEqual([]);

    // Further down: a table, a quote, code with its Copy; and at the end, link cards folded under the site's own name.
    await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 900));
    await windowShot(page, `${theme}-article-scrolled`);
    await page.getByTestId('simple-group').locator('summary').click();
    await expect(page.getByTestId('simple-cards')).toHaveAttribute('data-kind', 'link');
    await page.getByTestId('simple-group').scrollIntoViewIfNeeded();
    await windowShot(page, `${theme}-article-end`);

    // To the real page: remembered for the site, the real page scrolled to where the member was, then live, one line.
    const scrolls = async (): Promise<Record<string, unknown>[]> => (await acts(page)).filter((a) => a['action'] === 'scroll' && a['value'] === 'start');
    const before = (await scrolls()).length;
    await realPage(page).click();
    await expect.poll(() => lastStream(page)).toBe('live');
    await expect(simpleView(page)).toHaveCount(0);
    await expect(realPage(page)).toHaveAttribute('aria-checked', 'true');
    await expect(line(page)).toHaveText('Real page here from now on · Undo');
    await expect(page.getByRole('button', { name: /^Picture quality/ })).toBeVisible();
    expect((await rpcs(page, 'browser.minified.site.set')).map((r) => r.p)).toEqual([{ host: 'read.example', view: 'stream' }]);
    // The real page was scrolled to where the member was reading first (`act scroll`, `start`).
    expect(await scrolls()).toHaveLength(before + 1);
    await windowShot(page, `${theme}-real-page`);

    // Undo: back to Simplified, and the site's choice forgotten.
    await page.getByTestId('browser-simple-line-action').click();
    await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
    await expect.poll(() => lastStream(page)).toBe('warm');
    expect((await rpcs(page, 'browser.minified.site.set')).map((r) => r.p['view'])).toEqual(['stream', null]);
    await expect(line(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('the line after Real page goes by itself after 8 s, and waits while the pointer is on it', async ({ page }) => {
  test.setTimeout(60_000);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  // The live region is there before any line, so a line is announced once.
  await expect(page.getByTestId('browser-simple-line-box')).toHaveAttribute('aria-live', 'polite');
  await expect(line(page)).toHaveCount(0);
  await realPage(page).click();
  await expect(line(page)).toBeVisible();
  // The pointer on it holds the Undo (WCAG 2.2.1); off it, the whole 8 s again.
  await line(page).hover();
  await page.waitForTimeout(9_000);
  await expect(line(page)).toBeVisible();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(7_000);
  await expect(line(page)).toBeVisible();
  await expect(line(page)).toHaveCount(0, { timeout: 3_000 });
  await expect(realPage(page)).toHaveAttribute('aria-checked', 'true');
});

test('scrolling a long real page stays at the display rate, by wheel and by script', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await arrive(page);
  const url = await loadSample(page, 'encyclopedia-long');
  await openOn(page, url);
  await expect.poll(() => simplePage(page).getAttribute('data-blocks').then(Number)).toBeGreaterThan(100);
  await page.waitForTimeout(800); // the rest of the blocks, after the first viewport
  const box = await page.getByTestId('simple-scroll').boundingBox();
  if (!box) throw new Error('no scroller');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Wheel: as a member scrolls, in steps, about one per frame for 3 s.
  const wheel = await pacing(page, async () => {
    const end = Date.now() + 3_000;
    while (Date.now() < end) {
      await page.mouse.wheel(0, 80);
      await page.waitForTimeout(16);
    }
  });
  await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 0));
  // Script: 40 px every frame, the prototype's own measure, which lays out new blocks every frame.
  const script = await pacing(page, async () => {
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const el = document.querySelector('[data-testid="simple-scroll"]') as HTMLElement;
          const end = performance.now() + 3_000;
          const f = (t: number): void => {
            el.scrollBy(0, 40);
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) el.scrollTo(0, 0);
            if (t < end) requestAnimationFrame(f);
            else done();
          };
          requestAnimationFrame(f);
        }),
    );
  });
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/simple-pacing.json', JSON.stringify({ page: 'encyclopedia-long', wheel, script }, null, 1));
  console.log('simple view frame pacing', JSON.stringify({ wheel, script }));
  for (const r of [wheel, script]) {
    expect(r.scrolled).not.toBe(0);
    expect(r.p50).toBeLessThan(18); // 60 fps is 16.7 ms
    expect(r.over25 / r.frames).toBeLessThan(0.05);
  }
  expect(errors).toEqual([]);
});

test("the prototype's captured pages all render, with nothing from their sites fetched", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const offsite: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost') && !r.url().startsWith('data:') && !r.url().startsWith('blob:http://localhost')) offsite.push(r.url());
  });
  await arrive(page);
  const names = readdirSync(SAMPLES).filter((f) => f.endsWith('.doc.json')).map((f) => f.replace('.doc.json', ''));
  const urls: Record<string, string> = {};
  for (const name of names) urls[name] = await loadSample(page, name);
  await openBrowser(page);
  const counts: Record<string, number> = {};
  for (const name of names) {
    await goTo(page, urls[name] as string);
    await expect(simplePage(page)).toHaveAttribute('data-page', urls[name] as string);
    counts[name] = Number(await simplePage(page).getAttribute('data-blocks'));
    if (['news-article-3', 'search-results-2', 'docs-page-2', 'video-2'].includes(name)) await windowShot(page, `sample-${name}`);
  }
  console.log('blocks per sample page', JSON.stringify(counts));
  // Every page with content shows it; the two empty captures (the probe and NPR's front) show an empty page, calmly.
  for (const [name, n] of Object.entries(counts)) if (!/probe|npr-front/.test(name)) expect(n, name).toBeGreaterThan(0);
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('a video island: never by itself, plays on a press with its own controls, pauses, rests after 5 s, and one plays at a time', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://watch.example/clip');
  // Three islands; the ad-sized frame is dropped. Autoplay never starts one: nothing streams yet.
  await expect(page.getByTestId('simple-island')).toHaveCount(3);
  const first = page.getByTestId('simple-island').first();
  await expect(first).toHaveAttribute('data-phase', 'ready');
  await expect(first.locator('.sv-isl-dur')).toHaveText('18:40');
  // Finding 6: the letterbox sits 1 px inside the rounded edge, so a light poster's corner never shows a dark arc.
  expect(await first.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await first.evaluate((el) => [getComputedStyle(el, '::before').top, getComputedStyle(el, '::before').borderTopLeftRadius])).toEqual(['1px', '11px']);
  await page.waitForTimeout(500);
  expect(await rpcs(page, 'browser.minified.island')).toEqual([]);
  expect(await lastStream(page)).toBe('warm');
  await windowShot(page, 'island-ready');

  // Play: the crop first, then the element, then the picture.
  await first.getByRole('button', { name: 'Play A short film about light' }).click();
  await expect(first).toHaveAttribute('data-phase', 'playing');
  expect((await rpcs(page, 'browser.minified.island')).at(-1)?.p['islandId']).toBe('v1');
  await expect.poll(() => mock(page, (c) => c.simple.media.map((m) => m['verb']))).toEqual(['play']);
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect.poll(() => first.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth / v.videoHeight)).toBeCloseTo(16 / 9, 1);
  // Its controls on hover: they drive the element on the desk, never clicks by coordinates.
  await first.hover({ position: { x: 300, y: 150 } });
  await expect(first.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Captions' })).toBeVisible();
  await windowShot(page, 'island-playing');
  // The controls go 2 s after the pointer stops.
  await expect(first).toHaveClass(/ctl-on/);
  await page.waitForTimeout(2_400);
  await expect(first).not.toHaveClass(/ctl-on/);
  await first.hover({ position: { x: 320, y: 160 } });
  const inputBefore = await mock(page, (c) => c.input.length);
  await first.getByRole('slider', { name: 'Seek' }).fill('600');
  await expect.poll(async () => (await mock(page, (c) => c.simple.media)).at(-1)).toMatchObject({ nodeId: 'v1', verb: 'seek', time: 600 });
  await first.getByRole('button', { name: 'Captions' }).click();
  await expect.poll(async () => (await mock(page, (c) => c.simple.media)).at(-1)).toMatchObject({ verb: 'track', track: 0 });
  await first.focus();
  await page.keyboard.press('m');
  await expect.poll(async () => (await mock(page, (c) => c.simple.media)).at(-1)).toMatchObject({ verb: 'volume', muted: true });
  expect(await mock(page, (c) => c.input.length)).toBe(inputBefore);

  // Pause: the last frame holds; after 5 s nothing streams.
  await page.keyboard.press(' ');
  await expect(first).toHaveAttribute('data-phase', 'paused');
  await expect.poll(async () => (await mock(page, (c) => c.simple.media)).at(-1)?.['verb']).toBe('pause');
  await windowShot(page, 'island-paused');
  expect(await lastStream(page)).toBe('live');
  await expect.poll(() => lastStream(page), { timeout: 7_000 }).toBe('warm');
  expect(await mock(page, (c) => c.simple.island)).toBeNull();

  // Starting the second pauses the first: one at a time.
  await first.getByRole('button', { name: 'Play A short film about light' }).click();
  await expect(first).toHaveAttribute('data-phase', 'playing');
  const second = page.getByTestId('simple-island').nth(1);
  await second.scrollIntoViewIfNeeded();
  await second.getByRole('button', { name: 'Play Morning, slowly' }).click();
  await expect(second).toHaveAttribute('data-phase', 'playing');
  await expect(first).toHaveAttribute('data-phase', 'paused');
  expect((await rpcs(page, 'browser.minified.island')).at(-1)?.p['islandId']).toBe('v2');
  expect(errors).toEqual([]);
});

test('a desk that streams the whole screen rather than the crop: the island never shows it, and the video goes to the real page', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await mock(page, (c) => {
    c.simple.noCrop = true;
  });
  await openOn(page, 'https://watch.example/clip');
  const island = page.getByTestId('simple-island').first();
  await island.getByRole('button', { name: /^Play / }).click();
  // The stream goes live for the box, but no frame of the island's own shape comes: it never shows, and in 3 s the
  // real page plays it, with its line.
  await expect.poll(() => lastStream(page)).toBe('live');
  expect(await island.getAttribute('data-live')).toBeNull();
  await expect(simpleView(page)).toHaveCount(0, { timeout: 6_000 });
  await expect(line(page)).toContainText('This video plays on the real page');
  expect(errors).toEqual([]);
});

test('a playing island scrolled away becomes one chip, which pauses it or brings it back', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://watch.example/clip');
  const first = page.getByTestId('simple-island').first();
  await first.getByRole('button', { name: 'Play A short film about light' }).click();
  await expect(first).toHaveAttribute('data-phase', 'playing');
  await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 1400));
  const chip = page.getByTestId('simple-island-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('A short film about light');
  await windowShot(page, 'island-chip');
  await chip.getByRole('button', { name: 'Back to the video' }).click();
  await expect(chip).toHaveCount(0);
  await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 1400));
  await expect(chip).toBeVisible();
  await chip.getByRole('button', { name: 'Pause' }).click();
  await expect(chip).toHaveCount(0);
  await expect(first).toHaveAttribute('data-phase', 'paused');
  expect(errors).toEqual([]);
});

test("an island that can't play here: DRM says so at once, and a refused start goes to the real page with one line", async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://watch.example/clip');
  const drm = page.getByTestId('simple-island').nth(2);
  await drm.scrollIntoViewIfNeeded();
  await expect(drm).toHaveAttribute('data-phase', 'failed');
  await expect(drm).toContainText('This video only plays on the real page');
  await expect(drm).toContainText('The site wouldn’t let it play here.');
  await windowShot(page, 'island-cant-play');

  await mock(page, (c) => {
    c.simple.refuseIslands = ['v2'];
  });
  const second = page.getByTestId('simple-island').nth(1);
  await second.scrollIntoViewIfNeeded();
  await second.getByRole('button', { name: 'Play Morning, slowly' }).click();
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(simpleView(page)).toHaveCount(0);
  await expect(line(page)).toHaveText('This video plays on the real page');
  // The real page scrolled to the player first.
  expect((await acts(page)).filter((a) => a['action'] === 'scroll').at(-1)).toMatchObject({ nodeId: 'v2', value: 'start' });
  // Not the site's choice: the next page is simplified again.
  expect(await rpcs(page, 'browser.minified.site.set')).toEqual([]);
  expect(errors).toEqual([]);
});

test("the desk remembers the member's choice per site, and the office keeps none of it", async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  await realPage(page).click();
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(simpleView(page)).toHaveCount(0);

  // Another site: simplified, as ever.
  await goTo(page, 'https://search.example/?q=lamps');
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
  await expect.poll(() => lastStream(page)).toBe('warm');
  // Back to the first site, another page on it: the real page, without a press, and no line.
  await goTo(page, 'https://read.example/latest');
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(realPage(page)).toHaveAttribute('aria-checked', 'true');

  // A new window asks the desk again, and the desk still has it.
  await browserWindow(page).getByRole('button', { name: /^Close/ }).last().click();
  await expect(browserWindow(page)).toHaveCount(0);
  const asked = (await rpcs(page, 'browser.minified.site.get')).length;
  await openBrowser(page);
  await expect.poll(async () => (await rpcs(page, 'browser.minified.site.get')).length).toBeGreaterThan(asked);
  await expect(realPage(page)).toHaveAttribute('aria-checked', 'true');
  expect(await mock(page, (c) => c.simple.sites)).toEqual({ 'read.example': 'stream' });

  // Simplified again: the desk is asked for the page, and it comes.
  await simplified(page).click();
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/latest');
  expect(await mock(page, (c) => c.simple.sites)).toEqual({ 'read.example': 'simplified' });

  // Nothing about sites in this browser's storage (security review T47-9).
  const stored = await page.evaluate(async () => {
    const all: string[] = [];
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i += 1) all.push(`${s.key(i)}=${s.getItem(s.key(i) as string)}`);
    const dbs = (await indexedDB.databases()).map((d) => d.name ?? '');
    return { all: all.join('\n'), dbs };
  });
  expect(stored.all).not.toContain('read.example');
  expect(stored.all).not.toContain('search.example');
  expect(stored.dbs.filter((n) => /simple|site|mdoc/i.test(n))).toEqual([]);
  expect(errors).toEqual([]);
});

test('"8 hidden": rows that add up, trackers apart, and the real page for this page only', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  await page.getByTestId('simple-hidden').click();
  const pop = page.getByTestId('simple-hidden-popover');
  await expect(pop).toBeVisible();
  const rows = await pop.locator('li').allInnerTexts();
  expect(rows.map((r) => r.replace(/\s+/g, ' ').trim())).toEqual(['Ads 5', 'Cookie banner Answered “Reject all” for you 1', 'Newsletter pop-up 1', '“Recommended for you” 1']);
  await expect(pop).toContainText('Also blocked: 14 trackers');
  await windowShot(page, 'hidden-popover');
  expect(await axe(page)).toEqual([]);
  // The per-site switch (section 14's `browser.adblock.site.set`): on, as the head says when it has no `blocking`.
  await expect(pop.getByRole('switch', { name: 'Block ads and trackers' })).toHaveAttribute('aria-checked', 'true');
  await expect(pop).toContainText('On read.example');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await page.getByTestId('simple-hidden').click();
  await pop.getByRole('button', { name: 'Show the real page' }).click();
  await expect.poll(() => lastStream(page)).toBe('live');
  expect(await rpcs(page, 'browser.minified.site.set')).toEqual([]);
  expect(errors).toEqual([]);
});

test('the per-site ad switch: off and on again on the desk, the head follows, a site with nothing hidden keeps the control, and a desk without the switch hides it', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://qa.example/q/sorted-array');
  await page.getByTestId('simple-hidden').click();
  const pop = page.getByTestId('simple-hidden-popover');
  // The banner's own label for what the desk pressed (section 14's `done.label`), as text.
  await expect(pop).toContainText('Answered “Necessary cookies only” for you');
  const toggle = pop.getByRole('switch', { name: 'Block ads and trackers' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // A mutation with its own `idem`, naming the site; the desk keeps it, and the page's head says so.
  const sets = await rpcs(page, 'browser.adblock.site.set');
  expect(sets.map((r) => r.p)).toEqual([{ host: 'qa.example', on: false }]);
  expect(sets[0]?.options?.idem).toBeTruthy();
  expect(await mock(page, (c) => c.simple.adblockOff)).toEqual(['qa.example']);
  await page.waitForTimeout(200);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => mock(page, (c) => c.simple.adblockOff)).toEqual([]);
  await page.keyboard.press('Escape');
  // A site the member turned it off for, with nothing hidden: the control stays, so it can go back on.
  await mock(page, (c) => {
    c.simple.adblockOff.push('plain.example');
  });
  await goTo(page, 'https://plain.example/notes');
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://plain.example/notes');
  const control = page.getByTestId('simple-hidden');
  await expect(control).toHaveAccessibleName('Blocking off');
  await control.click();
  await expect(pop.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  expect(await axe(page)).toEqual([]);
  await windowShot(page, 'hidden-blocking-off');
  // A desk whose deskd has no switch yet: the press comes back, and the switch goes, never a control that does nothing.
  await mock(page, (c) => {
    c.simple.noAdblockSwitch = true;
  });
  await pop.getByRole('switch').click();
  await expect(pop.getByRole('switch')).toHaveCount(0);
  expect(await mock(page, (c) => c.simple.adblockOff)).toEqual(['plain.example']);
  expect(errors).toEqual([]);
});

test('on as it ships, on a desk of today (no section 14): the stream starts as on main, never behind the question, and the next window asks nothing', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  // The desk takes 2.5 s to answer the window's question: the picture must not wait for it.
  await mock(page, (c) => {
    c.simple.serves = false;
    c.simple.siteDelayMs = 2_500;
  });
  await goTo(page, 'https://read.example/essay');
  const t0 = Date.now();
  await openBrowser(page);
  await expect.poll(() => lastStream(page), { timeout: 2_000 }).toBe('live');
  const ms = Date.now() - t0;
  // The stream's start went out, and the picture plays, before the desk has answered.
  const frames = (): Promise<number> => page.getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(frames, { timeout: 2_000 }).toBeGreaterThan(0);
  expect(Date.now() - t0).toBeLessThan(2_500);
  expect(await rpcs(page, 'browser.minified.site.get')).toHaveLength(1);
  expect(await streamStates(page)).toEqual(['live']);
  await expect(page.getByRole('button', { name: /^Picture quality/ })).toBeVisible();
  await expect(theSwitch(page)).toHaveCount(0);
  // The answer, no: nothing changes, nothing is asked again, the stream never went warm.
  await page.waitForTimeout(2_600);
  await expect(page.getByTestId('browser-video')).toBeVisible();
  await expect(simpleView(page)).toHaveCount(0);
  expect(await streamStates(page)).toEqual(['live']);
  await expect(theSwitch(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Picture quality/ })).toBeVisible();
  const asked = (await rpcs(page, 'browser.minified.get')).length;
  expect(asked).toBeLessThanOrEqual(1);
  // Typing goes to the page as before: the stream isn't held once the desk has said no.
  await page.getByTestId('browser-video').click();
  await page.keyboard.type('a');
  await expect.poll(async () => (await mock(page, (c) => c.input.filter((x) => x.channel === 'keys').length)) > 0).toBe(true);
  // Another window on the same link: straight to the real page, with nothing asked again.
  await page.keyboard.press('Control+l');
  await browserWindow(page).getByRole('button', { name: /^Close/ }).first().click();
  await expect(browserWindow(page)).toHaveCount(0);
  await openBrowser(page);
  await expect.poll(() => lastStream(page)).toBe('live');
  await page.waitForTimeout(300);
  await expect(theSwitch(page)).toHaveCount(0);
  expect((await rpcs(page, 'browser.minified.get')).length).toBe(asked);
  expect(await rpcs(page, 'browser.minified.site.get')).toHaveLength(1);
  test.info().annotations.push({ type: 'live after open', description: `${ms} ms` });
  expect(errors).toEqual([]);
});

test('a picture the tab never painted drops with its frame: the cards stay, with no blank boxes (R65)', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await mock(page, (c) => {
    const simple = c.simple as unknown as { images: boolean; pages: Record<string, { head: { site: { icon?: string } } }> };
    simple.images = false;
    // The site's icon too: the real test desk's Wikipedia came with an icon the tab never had (Nov 9).
    simple.pages['https://shop.example/lamps']!.head.site.icon = 'img-shop-icon';
  });
  await openOn(page, 'https://shop.example/lamps');
  const cards = page.getByTestId('simple-cards');
  await expect(cards.locator('li')).toHaveCount(6);
  await expect.poll(() => cards.locator('.sv-card-img').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)).toBe(0);
  // Its slot in the site row gives way to the globe, never an empty gap before the name.
  await expect(page.getByTestId('simple-site').locator('.sv-fav svg')).toBeVisible();
  await expect(cards.getByRole('link', { name: 'Walnut reading lamp' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a desk that serves the view: the stream starts as ever beside the question, and the view comes when the desk says yes, keyboard rules and all', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await mock(page, (c) => {
    c.simple.siteDelayMs = 1_500;
  });
  await goTo(page, 'https://read.example/essay');
  const t0 = Date.now();
  await openBrowser(page);
  // Before the answer: the real page, live, as on a desk of today.
  await expect.poll(() => lastStream(page), { timeout: 1_400 }).toBe('live');
  expect(Date.now() - t0).toBeLessThan(1_500);
  await expect(simpleView(page)).toHaveCount(0);
  // The answer, yes: the view covers, the stream goes warm, and the stream takes no input from then on (T47O-2).
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/essay');
  await expect.poll(() => lastStream(page)).toBe('warm');
  expect(await streamStates(page)).toEqual(['live', 'warm']);
  await expect(page.locator('.br-surface')).toHaveAttribute('inert', '');
  await expect(theSwitch(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Picture quality/ })).toHaveCount(0);
  const before = await mock(page, (c) => c.input.length);
  await page.getByTestId('browser-address').click();
  await page.getByTestId('browser-address').press('Escape');
  await expect(page.getByTestId('simple-scroll')).toBeFocused();
  await page.keyboard.press('Space');
  expect(await mock(page, (c) => c.input.length)).toBe(before);
  expect(errors).toEqual([]);
});

test('cards stay cards: products with price and rating, results with snippets, videos with durations', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://shop.example/lamps');
  const cards = page.getByTestId('simple-cards');
  await expect(cards).toHaveAttribute('data-kind', 'product');
  await expect(cards.locator('li')).toHaveCount(6);
  await expect(cards.locator('li').first()).toContainText('$48.00');
  await expect(cards.locator('li').first().getByRole('img', { name: '4.6 out of 5' })).toBeVisible();
  // The site row in section 4's order, three at most, from the head's actions and the bar's own (the Designer's finding 2),
  // with a cart that has a count before Sign in (the Nov 9 re-review): Search, Menu, Cart 1. Sign in is in the site's menu.
  const site = page.getByTestId('simple-site');
  const acts = site.locator('.sv-sact');
  await expect(acts).toHaveCount(3);
  for (const [i, name] of ['Search', 'Menu', 'Cart 1'].entries()) await expect(acts.nth(i)).toHaveAccessibleName(name);
  await acts.nth(1).click();
  await expect(site.getByRole('group', { name: 'Menu' })).toContainText('Sign in');
  await expect(site.getByRole('group', { name: 'Menu' })).not.toContainText('Cart');
  await acts.nth(1).click();
  await windowShot(page, 'shop');
  expect(await axe(page)).toEqual([]);
  // R13 as the Designer called it: one badge, one delivery line, a condition only when it's bad, and no chips.
  await expect(cards.locator('li').nth(2)).toContainText('Best seller');
  await expect(cards.locator('li').nth(2)).toContainText('Free delivery tomorrow');
  await expect(cards.locator('li').nth(3).locator('.sv-card-bad')).toHaveText('Out of stock');
  await expect(cards.locator('.sv-tag', { hasText: 'In stock' })).toHaveCount(0);
  // Every act names what the member saw: the node, its fingerprint, its block and the document's rev (T47-2, T47O-1).
  await cards.locator('li').nth(1).getByRole('button', { name: 'Add to cart' }).click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'l1c', fp: 'fp-l1c', tabId: 't1', block: expect.any(String), rev: expect.any(Number) });
  await cards.getByRole('link', { name: 'Walnut reading lamp' }).click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'l1', fp: 'fp-l1' });
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://shop.example/lamps/1');

  await goTo(page, 'https://search.example/?q=lamps');
  await expect(page.getByTestId('simple-cards').first()).toHaveAttribute('data-kind', 'result');
  await expect(page.getByTestId('simple-cards').nth(1)).toHaveAttribute('data-kind', 'video');
  await expect(page.getByTestId('simple-cards').nth(1).locator('.sv-card-dur').first()).toHaveText('8:14');
  await windowShot(page, 'search');
  expect(errors).toEqual([]);
});

test('a thread keeps its nesting to three levels, and deeper replies fold', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://forum.example/t/primer');
  await expect(simplePage(page).locator('.sv-n1')).toHaveCount(2);
  await expect(simplePage(page).locator('.sv-n3')).toHaveCount(2);
  const fold = simplePage(page).locator('.sv-more-replies');
  await expect(fold).toHaveCount(1);
  await expect(fold.locator('summary')).toHaveText('More replies');
  await expect(fold.getByText('Will do. Thanks, both.')).toBeHidden();
  await fold.locator('summary').click();
  await expect(fold.getByText('Will do. Thanks, both.')).toBeVisible();
  await windowShot(page, 'forum');
  expect(errors).toEqual([]);
});

test('a listing\'s filter rail is one row: All filters, chips, then Sort, each the site\'s real control', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://shop.example/lamps');
  const row = page.getByTestId('simple-filters');
  await expect(row.getByRole('button', { name: /^All filters/ })).toHaveText('All filters14');
  await expect(row.locator('.sv-filters-chips > *')).toHaveCount(5);
  // An applied filter is a pressed chip; Sort comes last.
  await expect(row.getByRole('button', { name: 'Under $100' })).toHaveAttribute('aria-pressed', 'true');
  // Both boxes in one frame, once the fonts are in (Nunito's arrival moves them).
  const [sortX, chipsEnd] = await row.evaluate(async (el) => {
    await document.fonts.ready;
    const sort = el.querySelector('.sv-filters-sort')!.getBoundingClientRect();
    const chips = el.querySelector('.sv-filters-chips')!.getBoundingClientRect();
    return [sort.x, chips.x + chips.width];
  });
  expect(sortX).toBeGreaterThanOrEqual(chipsEnd - 1);
  await row.getByRole('button', { name: 'Brass' }).click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'fl4' });
  // By index, with the label the member saw, which the desk checks (section 14).
  await row.getByRole('combobox', { name: 'Sort' }).selectOption({ label: 'Sort: Price, low to high' });
  await expect.poll(() => lastAct(page)).toMatchObject({ action: 'select', nodeId: 'fs', value: { index: 1, label: 'Sort: Price, low to high' } });
  await row.getByRole('button', { name: /^All filters/ }).click();
  const all = row.getByRole('group', { name: 'All filters' });
  await expect(all.getByRole('heading')).toHaveText(['Delivery', 'Price', 'Material', 'Features']);
  await windowShot(page, 'filters-open');
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a thread: one vote control beside Reply on each name line, every arrow the real page\'s own', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://forum.example/t/primer');
  const lines = simplePage(page).locator('.sv-nameline');
  // Four with a vote; the two folded under "More replies" are name lines too, with nothing to press (item 11).
  await expect(lines).toHaveCount(6);
  await expect(simplePage(page).locator('.sv-more-replies .sv-nameline')).toHaveCount(2);
  await expect(simplePage(page).locator('.sv-more-replies .sv-nameline button')).toHaveCount(0);
  // The poster's own later comments say "OP" (R42); the post itself doesn't.
  await expect(simplePage(page).locator('.sv-op')).toHaveCount(2);
  await expect(lines.first().locator('.sv-op')).toHaveCount(0);
  const first = lines.first();
  await expect(first.getByRole('group', { name: 'Score 196' })).toBeVisible();
  // At the right of the name line, with Reply beside it.
  const lineBox = (await first.boundingBox())!;
  const voteBox = (await first.getByRole('group', { name: 'Score 196' }).boundingBox())!;
  expect(voteBox.x + voteBox.width).toBeGreaterThan(lineBox.x + lineBox.width - 4);
  await first.getByRole('button', { name: 'Upvote' }).click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'f1u' });
  await first.getByRole('button', { name: 'Reply' }).click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'f2' });
  await expect(lines.nth(1).getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Description and Comments are fold-out lines, a post shows its first comments, and long code folds at 12 lines', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://watch.example/clip');
  const folds = page.getByTestId('simple-fold');
  await expect(folds).toHaveCount(2);
  await expect(folds.nth(0).locator('summary')).toHaveText('Description · 12,400 views · 3 days ago');
  await expect(folds.nth(1).locator('summary')).toHaveText('Comments · 214');
  await expect(page.getByText('Comment 1. Lovely light')).toBeHidden();
  await folds.nth(1).locator('summary').click();
  await expect(page.getByText('Comment 1. Lovely light')).toBeVisible();
  await expect(page.getByTestId('simple-cards')).toHaveAttribute('data-kind', 'video');

  await goTo(page, 'https://qa.example/q/sorted-array');
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://qa.example/q/sorted-array');
  const code = simplePage(page).locator('.sv-code');
  await expect(code.locator('pre')).toHaveText(/^#include <algorithm>[\s\S]*data\[c\] = std::rand\(\) % 256;$/);
  expect((await code.locator('pre').innerText()).split('\n')).toHaveLength(12);
  await windowShot(page, 'qa');
  await code.getByRole('button', { name: 'Show all 33 lines' }).click();
  expect((await code.locator('pre').innerText()).split('\n')).toHaveLength(33);
  await expect(code.getByRole('button', { name: 'Show less' })).toBeVisible();
  // A post's first two comments, then the rest behind one line.
  const lead = page.getByTestId('simple-fold');
  await expect(lead).toContainText('Another observation');
  await expect(lead.locator('summary')).toHaveText('12 more comments');
  await expect(lead.getByText('A third comment, folded.')).toBeHidden();
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("a search engine's own answer is one folded card above the results, its sources as chips", async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://search.example/?q=lamps');
  const card = page.getByTestId('simple-answer');
  // The engine's own name for it, and the site as the office names it (T47O-3).
  await expect(card.locator('.sv-answer-name')).toHaveText('Wayfind Answer · search.example');
  await expect(card.getByRole('link', { name: /reviews\.example/ })).toBeVisible();
  const folded = (await card.locator('.sv-answer-body').boundingBox())!.height;
  await expect(card.getByRole('button', { name: 'Show more' })).toBeVisible();
  // Above the results.
  const cardBox = (await card.boundingBox())!;
  const firstResult = (await page.getByTestId('simple-cards').first().boundingBox())!;
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(firstResult.y);
  await windowShot(page, 'search-answer');
  await card.getByRole('button', { name: 'Show more' }).click();
  expect((await card.locator('.sv-answer-body').boundingBox())!.height).toBeGreaterThan(folded);
  await card.getByRole('link', { name: /reviews\.example/ }).click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'sa1' });
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a docs page has "In this article" beside it from 1100 px, which follows the member and marks the section in view (R58)', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://docs.example/api/sorted');
  const rail = page.getByTestId('simple-rail');
  await expect(rail).toHaveAccessibleName('In this article');
  await expect(rail.getByRole('button')).toHaveText(['Syntax', 'Parameters', 'Return value', 'Description', 'Examples']);
  await expect(rail.getByRole('button', { name: 'Syntax' })).toHaveAttribute('aria-current', 'location');
  await windowShot(page, 'docs');
  // A press scrolls this view to the section and gives it the focus; nothing goes to the real page.
  await rail.getByRole('button', { name: 'Parameters' }).click();
  await expect(simplePage(page).getByRole('heading', { name: 'Parameters' })).toBeFocused();
  await expect(rail.getByRole('button', { name: 'Parameters' })).toHaveAttribute('aria-current', 'location');
  expect((await acts(page)).filter((a) => a['action'] === 'click')).toEqual([]);
  // It follows: still at the top of the view after scrolling.
  const view = (await page.getByTestId('simple-scroll').boundingBox())!;
  const box = (await rail.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(box.y).toBeLessThan(view.y + 60);
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`${theme}: the real-page patterns, as the Designer drew them`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openOn(page, 'https://shop.example/lamps');
    await windowShot(page, `${theme}-shop`);
    for (const [url, name] of [
      ['https://search.example/?q=lamps', 'search'],
      ['https://watch.example/clip', 'video'],
      ['https://forum.example/t/primer', 'forum'],
      ['https://qa.example/q/sorted-array', 'qa'],
    ] as const) {
      await goTo(page, url);
      await expect(simplePage(page)).toHaveAttribute('data-page', url);
      await windowShot(page, `${theme}-${name}`);
      expect(await axe(page), `${theme} ${name}`).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test('the keyboard: the switch is one stop with arrows, "8 hidden" is a dialog that gives focus back, the chip goes back to the video', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  const group = page.getByRole('radiogroup', { name: 'View' });
  await expect(group.getByRole('radio')).toHaveCount(2);
  await simplified(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(realPage(page)).toHaveAttribute('aria-checked', 'true');
  await expect(realPage(page)).toBeFocused();
  await expect(simplified(page)).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowLeft');
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
  await expect(simplified(page)).toBeFocused();

  // "8 hidden": focus moves in, Esc closes it and gives focus back, and tabbing out closes it.
  const hidden = page.getByTestId('simple-hidden');
  await expect(hidden).toHaveAttribute('aria-haspopup', 'dialog');
  await hidden.focus();
  await page.keyboard.press('Enter');
  const pop = page.getByRole('dialog', { name: 'Hidden on this page' });
  await expect(pop).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(hidden).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(pop.getByRole('switch', { name: 'Block ads and trackers' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pop.getByRole('button', { name: 'Show the real page' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pop).toHaveCount(0);

  // Every stop in the view shows the ring.
  await simpleView(page).getByTestId('simple-scroll').focus();
  const bare: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest('.sv')) return 'outside';
      const has = (e: Element | null): boolean => !!e && getComputedStyle(e).outlineStyle !== 'none' && getComputedStyle(e).outlineWidth !== '0px';
      return has(el) || has(el.closest('.sv-card')) || has(el.closest('.sv-isl-track')) ? 'ring' : `${el.tagName}.${el.className}`;
    });
    if (ring !== 'ring' && ring !== 'outside') bare.push(ring);
  }
  expect(bare).toEqual([]);

  // The chip appears without taking focus, and Back to the video moves focus to the island.
  await goTo(page, 'https://watch.example/clip');
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://watch.example/clip');
  const first = page.getByTestId('simple-island').first();
  await first.getByRole('button', { name: /^Play A short film/ }).click();
  await expect(first).toHaveAttribute('data-phase', 'playing');
  await expect(first).toHaveAccessibleName('A short film about light, 18 minutes 40 seconds');
  await expect(first.getByTestId('simple-island-said')).toHaveText('Playing');
  await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 1400));
  const chip = page.getByTestId('simple-island-chip');
  await expect(chip).toBeVisible();
  await expect(chip.getByRole('button', { name: 'Back to the video' })).not.toBeFocused();
  await chip.getByRole('button', { name: 'Back to the video' }).click();
  await expect(first).toBeFocused();
  // Its keys work only inside it: Space pauses.
  await page.keyboard.press(' ');
  await expect(first).toHaveAttribute('data-phase', 'paused');
  await expect(first.getByTestId('simple-island-said')).toHaveText('Paused');
  expect(errors).toEqual([]);
});

test('reduced motion: Starting is a still label after 400 ms, with no spinner and no moving line', async ({ page }) => {
  const errors = watchConsole(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await arrive(page);
  await openOn(page, 'https://watch.example/clip');
  await mock(page, (c) => {
    c.simple.islandDelayMs = 2_500;
  });
  const first = page.getByTestId('simple-island').first();
  await first.getByRole('button', { name: /^Play A short film/ }).click();
  await expect(first).toHaveAttribute('data-phase', 'starting');
  await expect(first.locator('.sv-isl-startlabel')).toBeVisible();
  await expect(first.locator('.sv-isl-spin')).toBeHidden();
  await expect(first.locator('.sv-isl-load')).toBeHidden();
  // The island keeps its own box while it starts.
  const box = (await first.boundingBox())!;
  expect(Math.round(box.width / box.height * 100) / 100).toBeCloseTo(16 / 9, 1);
  await windowShot(page, 'island-starting-reduced');
  await expect(first).toHaveAttribute('data-phase', 'playing', { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test('reflow: at 200% and 400% nothing scrolls sideways, on every kind, and text spacing clips nothing', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const kinds = ['https://read.example/essay', 'https://search.example/?q=lamps', 'https://shop.example/lamps', 'https://watch.example/clip', 'https://forum.example/t/primer', 'https://qa.example/q/sorted-array'];
  // An 880 px window at 200% lays out at 440 px; a 1280 px one at 400% at 320 px.
  for (const width of [440, 320]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const errors = watchConsole(page);
    await harness(request, { simpleView: null });
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await openOn(page, kinds[0] as string);
    for (const url of kinds) {
      await goTo(page, url);
      await expect(simplePage(page)).toHaveAttribute('data-page', url);
      await page.waitForTimeout(200);
      const [sw, cw] = await page.getByTestId('simple-scroll').evaluate((el) => [el.scrollWidth, el.clientWidth]);
      expect(sw, `${url} at ${width}`).toBeLessThanOrEqual(cw);
    }
    // WCAG 1.4.12's spacing on the article and the shop: still nothing sideways, and the titles keep their words.
    // A constructed sheet, as a member's own spacing extension would add, since the CSP refuses a <style>.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.sv * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } .sv p { margin-bottom: 2em !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    for (const url of [kinds[0] as string, kinds[2] as string]) {
      await goTo(page, url);
      await expect(simplePage(page)).toHaveAttribute('data-page', url);
      await page.waitForTimeout(200);
      const [sw, cw] = await page.getByTestId('simple-scroll').evaluate((el) => [el.scrollWidth, el.clientWidth]);
      expect(sw, `${url} spaced at ${width}`).toBeLessThanOrEqual(cw);
    }
    await shot(page, `reflow-${width}-shop-spaced`);
    expect(errors).toEqual([]);
    await ctx.close();
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: axe over the simplified view's states`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openOn(page, 'https://watch.example/clip');
    const states: Record<string, string[]> = {};
    const first = page.getByTestId('simple-island').first();
    states['island ready'] = await axe(page);
    await first.getByRole('button', { name: /^Play A short film/ }).click();
    await expect(first).toHaveAttribute('data-phase', 'playing');
    await first.hover({ position: { x: 300, y: 150 } });
    states['island playing, controls up'] = await axe(page);
    await first.getByRole('button', { name: 'Pause' }).click();
    states['island paused'] = await axe(page);
    await first.getByRole('button', { name: /^Play A short film/ }).click();
    await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 1400));
    await expect(page.getByTestId('simple-island-chip')).toBeVisible();
    states['the chip'] = await axe(page);
    await page.getByTestId('simple-fold').nth(1).locator('summary').click();
    states['a fold open'] = await axe(page);
    await goTo(page, 'https://read.example/essay');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/essay');
    await page.getByTestId('simple-hidden').click();
    states['the hidden popover'] = await axe(page);
    await page.keyboard.press('Escape');
    await page.getByTestId('simple-site').getByRole('button', { name: 'Menu' }).click();
    states['the site menu open'] = await axe(page);
    await realPage(page).click();
    await expect(line(page)).toBeVisible();
    states['the real page with its line'] = await axe(page);
    await goTo(page, 'https://bank.example/');
    await expect(line(page)).toHaveText('This site is always the real page');
    states['a private site'] = await axe(page);
    await goTo(page, 'https://shop.example/signin');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://shop.example/signin');
    states['a sign-in dialog'] = await axe(page);
    await goTo(page, 'https://shop.example/lamps');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://shop.example/lamps');
    await page.getByTestId('simple-filters').getByRole('button', { name: /^All filters/ }).click();
    states['all filters open'] = await axe(page);
    for (const [name, found] of Object.entries(states)) expect(found, name).toEqual([]);
    // One h1, and no level skipped, on the article.
    await goTo(page, 'https://read.example/essay');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/essay');
    const levels = await simplePage(page).locator('h1, h2, h3, h4').evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i += 1) expect((levels[i] as number) - (levels[i - 1] as number)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

test('a sign-in is never an input here: "Sign in on (site)" shows the real page with one line, and the dialog is framed as the site\'s', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://shop.example/signin');
  const dialog = page.getByTestId('simple-dialog');
  await expect(dialog.first()).toContainText('From shop.example');
  await expect(page.getByTestId('simple-signin')).toHaveText('Sign in on shop.example');
  // No password, email or telephone field and no form for a password manager to see (T47-1).
  expect(await simpleView(page).locator('input[type=password], input[type=email], input[type=tel], form').count()).toBe(0);
  for (const input of await simpleView(page).locator('input:not([type=range]), textarea, select').all()) {
    await expect(input).toHaveAttribute('autocomplete', 'off');
    await expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(await input.getAttribute('name')).toBeNull();
    expect(await input.getAttribute('id')).toBeNull();
  }
  await windowShot(page, 'signin');

  // The cookie banner's own buttons act on the real page, and it goes.
  await dialog.first().getByRole('button', { name: 'Reject all' }).click();
  await expect(page.getByText('We use cookies')).toHaveCount(0);
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: 'c1' });

  // Sign in: the real page, for this page only, with the line. Nothing remembered for the site.
  await page.getByTestId('simple-signin').click();
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(simpleView(page)).toHaveCount(0);
  await expect(line(page)).toHaveText('Sign-in is always the real page');
  await windowShot(page, 'signin-real-page');
  expect(await rpcs(page, 'browser.minified.site.set')).toEqual([]);
  // Another page: simplified again, by itself, with no line.
  await goTo(page, 'https://shop.example/notebook-a5');
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
  await expect(line(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('"Use the real page" and "Sign in on" drawn inside a link press only themselves, never the link (T47V-1)', async ({ page }) => {
  const errors = watchConsole(page);
  const pickerPage = 'https://shop.example/t47v-picker';
  const signinPage = 'https://shop.example/t47v-signin';
  await arrive(page);
  await mock(page, (c, a) => {
    c.simple.loadPage(a.picker, { title: 'Pick a day', kind: 'page', blocks: [{ t: 'heading', level: 1, runs: ['Pick a day'] }, { t: 'para', runs: [{ r: 'link', node: 'v1', url: 'https://shop.example/calendar', runs: ['Calendar ', { r: 'field', node: 'v2', kind: 'date_choice', label: 'Date', value: '' }] }] }] });
    c.simple.loadPage(a.signin, { title: 'Your orders', kind: 'page', blocks: [{ t: 'heading', level: 1, runs: ['Your orders'] }, { t: 'heading', level: 2, runs: [{ r: 'link', node: 'v3', url: 'https://shop.example/account', runs: ['Your account ', { r: 'sensitive', kind: 'password', origin: 'https://shop.example' }] }] }] });
  }, { picker: pickerPage, signin: signinPage });
  // Clicks only: going to the real page scrolls it to where the member was reading (`act scroll`), which may be the link.
  const linkActs = async (): Promise<unknown[]> => (await acts(page)).filter((a) => a['action'] === 'click' && (a['nodeId'] === 'v1' || a['nodeId'] === 'v3'));

  // "Use the real page" inside a link: the real page, and nothing pressed on it.
  await openOn(page, pickerPage);
  const picker = simplePage(page).getByTestId('simple-picker');
  await expect(picker.locator('xpath=ancestor::*[@data-ref="v1"]')).toHaveCount(1);
  await picker.getByRole('button', { name: 'Date: use the real page' }).click();
  await expect(simpleView(page)).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await linkActs()).toEqual([]);

  // "Sign in on" inside a link: a middle click opens no desk tab, and a click goes to the real page with its line only.
  await goTo(page, signinPage);
  await expect(simplePage(page)).toHaveAttribute('data-page', signinPage);
  const signin = simplePage(page).getByTestId('simple-signin');
  await expect(signin.locator('xpath=ancestor::*[@data-ref="v3"]')).toHaveCount(1);
  await signin.click({ button: 'middle' });
  await signin.click();
  await expect(simpleView(page)).toHaveCount(0);
  await expect(line(page)).toHaveText('Sign-in is always the real page');
  await page.waitForTimeout(400);
  expect(await linkActs()).toEqual([]);
  expect(await rpcs(page, 'browser.tab.open')).toEqual([]);

  // The link itself still goes where it goes.
  await goTo(page, pickerPage);
  await expect(simplePage(page)).toHaveAttribute('data-page', pickerPage);
  await simplePage(page).getByText('Calendar').click();
  await expect.poll(linkActs).toEqual([expect.objectContaining({ action: 'click', nodeId: 'v1' })]);
  expect(errors).toEqual([]);
});

test('a hostile page is only ever text: no script, no link out, no image from the site, no office look-alike', async ({ page }) => {
  const errors = watchConsole(page);
  const offsite: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost') && !r.url().startsWith('data:') && !r.url().startsWith('blob:http://localhost')) offsite.push(r.url());
  });
  await arrive(page);
  await openOn(page, 'https://hostile.example/');
  const view = simpleView(page);
  await expect(view).toContainText('<script>window.__svPwned = 1</script>');
  expect(await page.evaluate(() => (window as unknown as { __svPwned?: number }).__svPwned)).toBeUndefined();
  expect(await view.locator('a[href], [href], script, iframe, object, embed, [style*="color:red"], .evil, #ma-root').count()).toBe(0);
  // Images only as blob URLs made here from the desk's bytes (T47-5, T47O-1).
  for (const img of await view.locator('img').all()) expect(await img.getAttribute('src')).toMatch(/^blob:http:\/\/localhost:\d+\//);
  // Only plain http(s) addresses are shown or opened.
  const urls = await view.locator('[data-url]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['url']));
  expect(urls).toEqual(['https://ok.example/%E2%80%AEgnp.exe', 'https://ok.example/']);
  // Bidi overrides and controls are gone from the text, and a block the schema refuses isn't drawn at all (T47O-1).
  await expect(view).toContainText('Right-to-left override: evil.example and a bell .');
  expect(await view.innerText()).not.toMatch(/[‪-‮\u0007]/);
  await expect(view).not.toContainText('A block the schema refuses.');
  // The page's claim about the office is framed as the page's, and its code field is a sign-in button.
  await expect(page.getByTestId('simple-dialog')).toContainText('From hostile.example');
  await expect(page.getByTestId('simple-signin')).toBeVisible();
  // A middle click opens a desk tab, never one here.
  await view.getByText('A plain link').click({ button: 'middle' });
  await expect.poll(async () => (await rpcs(page, 'browser.tab.open')).at(-1)?.p).toEqual({ url: 'https://ok.example/%E2%80%AEgnp.exe' });
  await windowShot(page, 'hostile');
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('typing is local at once, goes to the desk once a frame, keeps its focus through the echo, and Enter searches', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://search.example/?q=lamps');
  // On a results page the field is the page: open under the site row, with its clear ×, no Search in the row and no
  // second Search button (the Designer's brand review).
  const field = simpleView(page).getByRole('textbox', { name: 'Search' });
  await expect(page.getByTestId('simple-site').getByRole('button', { name: 'Search' })).toHaveCount(0);
  await expect(page.getByTestId('simple-site').getByRole('button', { name: 'Clear' })).toBeVisible();
  await field.click();
  await field.press('End');
  await page.keyboard.type(' brass', { delay: 5 });
  await expect(field).toHaveValue('lamps brass');
  await expect(field).toBeFocused();
  // Fewer messages than keys: once a frame, newest value only.
  const fills = (await acts(page)).filter((a) => a['action'] === 'fill');
  expect(fills.length).toBeGreaterThan(0);
  expect(fills.length).toBeLessThanOrEqual(6);
  await expect.poll(async () => (await acts(page)).filter((a) => a['action'] === 'fill').at(-1)?.['value']).toBe('lamps brass');
  // The page's echo changed the block around the field, and the field kept the member's focus.
  await page.waitForTimeout(150);
  await expect(field).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await lastAct(page)).toMatchObject({ action: 'press', value: 'Enter' });
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://search.example/?q=lamps%20brass');

  // The end of the list asks the real page for more, two viewports early.
  await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(async () => (await acts(page)).some((a) => a['action'] === 'scroll')).toBe(true);
  expect(errors).toEqual([]);
});

test('fields: a tick shows at once and goes to the desk, a choice is a select, a picker is the real page', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://form.example/book');
  const view = simpleView(page);
  // The member's own acts, apart from the view asking the real page for more as it scrolls (`scroll`).
  const own = async (): Promise<Record<string, unknown> | undefined> => (await acts(page)).filter((a) => a['action'] !== 'scroll').at(-1);
  await view.getByRole('checkbox', { name: 'Window seat' }).check();
  await expect.poll(own).toMatchObject({ action: 'check', nodeId: 'g4', value: true });
  await view.getByRole('combobox', { name: 'Guests' }).selectOption({ label: '4 guests' });
  await expect.poll(own).toMatchObject({ action: 'select', nodeId: 'g3', value: { index: 2, label: '4 guests' } });
  // A phone field is text with a phone keyboard, never `type=tel`.
  await expect(view.getByRole('textbox', { name: 'Phone' })).toHaveAttribute('inputmode', 'tel');
  await expect(view.getByRole('textbox', { name: 'Phone' })).toHaveAttribute('type', 'text');
  // A date picker doesn't simplify: its label, then "Use the real page" (T47O-1).
  await expect(view.getByRole('button', { name: 'Date: use the real page' })).toHaveText('Use the real page');
  await windowShot(page, 'form');
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a refused click says so in one line, with the real page one press away', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  await mock(page, (c) => {
    c.simple.refuseActs = true;
  });
  await simpleView(page).getByRole('link', { name: 'Attention' }).click();
  await expect(line(page)).toHaveText("That didn't work here · Use the real page");
  await page.getByTestId('browser-simple-line-action').click();
  await expect.poll(() => lastStream(page)).toBe('live');
  // Not a choice for the site.
  expect(await rpcs(page, 'browser.minified.site.set')).toEqual([]);
  expect(errors).toEqual([]);
});

test('a link goes through the real page, with its address shown as a browser would, and the new page starts at its top', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 300));
  const link = simpleView(page).getByRole('link', { name: 'close the rest' });
  // No `href` (T47-6), but it says where it goes, as its host in the bar's note slot (the Designer's section 13).
  await link.hover();
  await expect(page.getByTestId('browser-simple-link-host')).toHaveText('read.example');
  await expect(link).not.toHaveAttribute('href');
  // Its menu offers "Copy link"; Ctrl and a click, or Ctrl and Enter, open it in a new desk tab.
  await link.click({ button: 'right' });
  await expect(page.getByTestId('simple-link-menu').getByRole('menuitem', { name: 'Copy link' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('simple-link-menu')).toHaveCount(0);
  // The desk shows a tab it opens, so each time the test puts the essay back on screen.
  const back = async (): Promise<void> => {
    await goTo(page, 'https://read.example/essay');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/essay');
    await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 300));
  };
  await link.click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(async () => (await rpcs(page, 'browser.tab.open')).at(-1)?.p).toEqual({ url: 'https://read.example/notes/close' });
  await back();
  await link.focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await rpcs(page, 'browser.tab.open')).length).toBe(2);
  await back();
  expect((await acts(page)).filter((a) => a['action'] === 'click')).toEqual([]);
  // Enter alone, or a click, goes through the real page.
  await link.click();
  expect(await lastAct(page)).toMatchObject({ action: 'click', nodeId: expect.any(String) });
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/notes/close');
  expect(await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTop)).toBe(0);
  expect(errors).toEqual([]);
});

test("pages the desk can't simplify show as the real page with one line that says why, never a blank page", async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  const cases: [string, string, boolean][] = [
    ['https://bank.example/', 'This site is always the real page', false],
    ['https://map.example/', 'This page works best as the real page', false],
    ['https://check.example/', "The site wants to check you're human", false],
    ['https://login.example/', 'Sign-in is always the real page', false],
    ['https://pay.example/checkout', 'Payment is always the real page', false],
    ['https://terms.example/', 'The site asks you to agree to its terms', false],
    ['https://broken.example/', "Couldn't simplify this page · Try again", true],
  ];
  for (const [url, words, retry] of cases) {
    await goTo(page, url);
    await expect.poll(() => lastStream(page)).toBe('live');
    await expect(simpleView(page)).toHaveCount(0);
    await expect(line(page)).toHaveText(words);
    await expect(simplified(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(simplified(page)).toHaveAttribute('title', words.replace(' · Try again', ''));
    if (!retry) continue;
    await windowShot(page, 'line-couldnt');
    await page.getByTestId('browser-simple-line-action').click();
    await expect.poll(() => mock(page, (c) => c.simple.retries)).toBe(1);
  }
  await goTo(page, 'https://bank.example/');
  await windowShot(page, 'line-private');
  expect(await rpcs(page, 'browser.minified.site.set')).toEqual([]);
  expect(errors).toEqual([]);
});

// With the flag on, a desk whose deskd has no simplified view falls back cleanly: a deskd before section 14 answers every
// `browser.minified.*` method and the topic `not_found` (section 4's "No such method"), and one with its switch off
// answers `unavailable` with `{reason: "disabled"}`. Either way: the real page, no switch, no line, and no asking again.
const MINIFIED_METHODS = ['browser.minified.get', 'browser.minified.act', 'browser.minified.image', 'browser.minified.island', 'browser.minified.site.get', 'browser.minified.site.set'];
for (const [why, code, details] of [
  ['a deskd before section 14', 'not_found', {}],
  ['a deskd with its switch off', 'unavailable', { reason: 'disabled' }],
] as const) {
  test(`${why}, with the flag on: the real page, with no switch, no line, and nothing asked again`, async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page);
    await mock(page, (c, a) => {
      c.refuse['browser.minified'] = a.code;
      for (const m of a.methods) c.refuse[m] = a.code;
      (c as unknown as { refuseDetails: unknown }).refuseDetails = a.details;
    }, { code, details, methods: MINIFIED_METHODS });
    await goTo(page, 'https://read.example/essay');
    await openBrowser(page);
    await expect.poll(() => lastStream(page)).toBe('live');
    await expect(theSwitch(page)).toHaveCount(0);
    await expect(simpleView(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Picture quality/ })).toBeVisible();
    // Past the 1.5 s a page has: no "Couldn't simplify" line, since this desk has no simplified view at all.
    await page.waitForTimeout(2_000);
    await expect(line(page)).toHaveCount(0);
    // Another page: the same, and the desk isn't asked for a view again.
    const asked = (await mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.minified.get').length));
    await goTo(page, 'https://shop.example/lamps');
    await page.waitForTimeout(500);
    await expect(simpleView(page)).toHaveCount(0);
    await expect(theSwitch(page)).toHaveCount(0);
    expect(await mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.minified.get').length)).toBe(asked);
    // The stream starts warm while the desk is asked, as with any simplified page, and stays live once it has said no.
    expect(await lastStream(page)).toBe('live');
    expect(errors).toEqual([]);
  });
}

test('under the simplified view the keyboard never reaches the unseen real page: Enter or Escape in the address, then Space (T47O-2)', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openOn(page, 'https://read.example/essay');
  const address = page.getByTestId('browser-address');
  const scroll = page.getByTestId('simple-scroll');
  const keys = page.getByTestId('browser-keys');
  const before = await mock(page, (c) => c.input.length);
  // Enter in the address: the tab goes there, and the keyboard goes to the view's scroll region, never the stream.
  await address.click();
  await address.fill('https://qa.example/q/sorted-array');
  await address.press('Enter');
  await expect(scroll).toBeFocused();
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://qa.example/q/sorted-array');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.keyboard.type('typed');
  // Escape too.
  await address.click();
  await address.press('Escape');
  await expect(scroll).toBeFocused();
  const top = await scroll.evaluate((el) => el.scrollTop);
  await page.keyboard.press('Space');
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(top);
  // Nothing went to the desk's input, as keys or as text, and no "Typing goes to the page".
  expect(await mock(page, (c) => c.input.length)).toBe(before);
  expect(await rpcs(page, 'browser.text.insert')).toEqual([]);
  await expect(page.getByTestId('browser-focus-hint')).toHaveCount(0);
  // The stream's surface is inert: its keys can't take focus, and a key sent to them anyway goes nowhere.
  await expect(page.locator('.br-surface')).toHaveAttribute('inert', '');
  await keys.focus();
  await expect(keys).not.toBeFocused();
  await keys.dispatchEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true });
  await keys.dispatchEvent('paste', {});
  expect(await mock(page, (c) => c.input.length)).toBe(before);

  // On the real page the stream has the keyboard again.
  await realPage(page).click();
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(simpleView(page)).toHaveCount(0);
  await expect(page.locator('.br-surface')).not.toHaveAttribute('inert', '');
  await address.click();
  await address.press('Escape');
  await expect(keys).toBeFocused();
  await page.keyboard.press('a');
  await expect.poll(() => mock(page, (c) => c.input.length)).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('a page that sends nothing shows as the real page after 1.5 s with no line, and the switch asks again', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await mock(page, (c) => {
    c.simple.silent = true;
  });
  await goTo(page, 'https://read.example/essay');
  await openBrowser(page);
  const t0 = Date.now();
  await expect.poll(() => lastStream(page), { timeout: 5_000 }).toBe('live');
  expect(Date.now() - t0).toBeLessThan(4_000);
  // The real page is live from the start now, so the 1.5 s is waited for here: past it, the view steps aside.
  await expect(simplified(page)).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 });
  await expect(simpleView(page)).toHaveCount(0);
  // The Designer's Nov 9 re-review: no "Couldn't simplify" while the desk is still answering.
  await page.waitForTimeout(1_000);
  await expect(line(page)).toHaveCount(0);
  await expect(simplified(page)).not.toHaveAttribute('aria-disabled', 'true');
  await mock(page, (c) => {
    c.simple.silent = false;
  });
  await simplified(page).click();
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/essay');
  expect(errors).toEqual([]);
});

test("a slow desk: the real page stays with no line until it answers; its yes simplifies, and only its no says it couldn't", async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await mock(page, (c) => {
    c.simple.delayMs = 4_500;
  });
  await goTo(page, 'https://read.example/essay');
  await openBrowser(page);
  // The stream starts first, as ever (no added wait); past the view's 1.5 s the real page shows, with no line.
  await page.waitForTimeout(1_900);
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(simpleView(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await expect(simplePage(page)).toHaveAttribute('data-page', 'https://read.example/essay', { timeout: 6_000 });
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple');
  await expect(line(page)).toHaveCount(0);

  await goTo(page, 'https://broken.example/');
  await page.waitForTimeout(1_900);
  await expect.poll(() => lastStream(page)).toBe('live');
  await expect(simpleView(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await expect(line(page)).toHaveText("Couldn't simplify this page · Try again", { timeout: 6_000 });
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`${theme}, phone: one column, photos and the island edge to edge, the site row as icons`, async ({ browser, request }) => {
    const ctx = await browser.newContext({ ...PHONE, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const errors = watchConsole(page);
    await harness(request, { simpleView: null });
    await setTheme(page, theme);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await openOn(page, 'https://read.example/essay');
    // The count alone shows; "hidden" stays for screen readers, clipped, never removed.
    await expect(page.getByTestId('simple-hidden')).toHaveAccessibleName('8 hidden');
    expect((await page.getByTestId('simple-hidden').locator('.sv-wordy').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
    const win = (await browserWindow(page).boundingBox())!;
    const fig = (await simplePage(page).locator('.sv-figure').first().boundingBox())!;
    expect(Math.round(fig.width)).toBeGreaterThanOrEqual(Math.round(win.width) - 20);
    await shot(page, `phone-${theme}-article`);
    await page.getByTestId('simple-scroll').evaluate((el) => el.scrollTo(0, 700));
    await shot(page, `phone-${theme}-article-scrolled`);
    await goTo(page, 'https://watch.example/clip');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://watch.example/clip');
    await shot(page, `phone-${theme}-video`);
    await goTo(page, 'https://shop.example/lamps');
    await expect(simplePage(page)).toHaveAttribute('data-page', 'https://shop.example/lamps');
    // Two across on a phone (the Designer's brand review): photos large enough to judge.
    const cols = await page.getByTestId('simple-cards').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(cols).toBe(2);
    await shot(page, `phone-${theme}-shop`);
    for (const [url, name] of [
      ['https://search.example/?q=lamps', 'search'],
      ['https://forum.example/t/primer', 'forum'],
    ] as const) {
      await goTo(page, url);
      await expect(simplePage(page)).toHaveAttribute('data-page', url);
      await shot(page, `phone-${theme}-${name}`);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

for (const theme of THEMES) {
  test(`${theme}: Stack Overflow as deskd sends it: the row keeps Search, Menu and Log in, the vote is inline, and replies are compact (R75)`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openOn(page, 'https://so.example/q/sorted');
    const site = page.getByTestId('simple-site');
    // Section 4's order from both sources, never just "Log in".
    await expect(site.locator('.sv-sact')).toHaveCount(3);
    await expect(site.locator('.sv-sact').nth(0)).toHaveAccessibleName('Search');
    await expect(site.locator('.sv-sact').nth(1)).toHaveAccessibleName('Menu');
    await expect(site.locator('.sv-sact').nth(2)).toHaveAccessibleName('Log in');
    // The vote: one control, "27548", with no avatar and no pills.
    await expect(simplePage(page).getByRole('group', { name: 'Score 27548' })).toBeVisible();
    await expect(simplePage(page).locator('.sv-avatar')).toHaveCount(0);
    await expect(simplePage(page).locator('.sv-channel')).toHaveCount(0);
    // R27: three levels, the fourth folds.
    await expect(simplePage(page).locator('.sv-comment')).toHaveCount(4);
    await expect(simplePage(page).locator('.sv-more-replies .sv-comment')).toHaveCount(1);
    await expect(simplePage(page).locator('.sv-more-replies')).toHaveCount(1);
    // R75: a reply is 15/1.45 with 13 px meta and 10 px to the next; the question's own text keeps body type.
    const reply = simplePage(page).locator('.sv-comment.sv-n1');
    await expect(reply).toHaveCSS('font-size', '15px');
    await expect(reply).toHaveCSS('line-height', '21.75px');
    await expect(reply).toHaveCSS('padding-bottom', '10px');
    await expect(reply).toHaveCSS('padding-left', '14px');
    await expect(reply).toHaveCSS('content-visibility', 'visible');
    await expect(reply.locator('.sv-nameline')).toHaveCSS('font-size', '13px');
    await expect(reply.locator('.sv-comment-body')).toHaveCSS('margin-top', '6px');
    await expect(reply.locator('.sv-nameline-acts .sv-button')).toHaveCSS('height', '22px');
    await expect(simplePage(page).locator('.sv-n3').first()).toHaveCSS('padding-left', '42px');
    await expect(simplePage(page).locator('p.sv-p', { hasText: 'In this C++ code' })).toHaveCSS('font-size', '17.5px');
    await windowShot(page, `${theme}-p24`);
    expect(await axe(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
