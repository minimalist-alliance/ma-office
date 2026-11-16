// The frame budget (contract 3.2, ADR 0054's addendum of Nov 12, `src/deskapps/host/budget.ts`): only a view's own time is
// counted against it. The shell runs Chrome's headless shell, which keeps a sandboxed frame on the office's thread (as Chrome on
// Android, Firefox and Safari do), so a busy view really does hold the office here; one test runs Chrome itself, where the frame
// has a process of its own (`deskapps.budget.chrome.shell.spec.ts`, (b2)). (a) a busy office with a well-behaved view open: no
// pause (it paused on `main`); (b) a view that busy-loops is paused, with Resume; (c) at 4x CPU the real Bible view open 20 s
// while the office pans: no pause; (d) without Long Animation Frames only a hang counts.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BIBLE, busyOffice, busyView, diags, harness, office, openTile, PAUSED, READY, TALLY, threadOf, viewFrame } from './budget.helpers';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('(a) a busy office never pauses a well-behaved view: 20 s of the office\'s own 80 ms frames', async ({ page, request }) => {
  test.setTimeout(60_000);
  const errors = await office(page, request, [TALLY]);
  await openTile(page, TALLY);
  const view = page.frameLocator(READY);
  await view.getByRole('button', { name: 'Count one more' }).click();
  await expect(view.locator('#count')).toHaveText('1');
  await page.waitForTimeout(1300); // the office idle: no input for a second
  const frames = await busyOffice(page, 80, 200, 20_000);
  expect(frames).toBeGreaterThan(40);
  await expect(page.locator(PAUSED)).toHaveCount(0);
  await expect(page.locator(READY)).toBeVisible();
  await view.getByRole('button', { name: 'Count one more' }).click();
  await expect(view.locator('#count')).toHaveText('2');
  const d = await diags(page);
  expect(d.filter((x) => x.what === 'paused')).toEqual([]);
  console.log(`(a) ${frames} office frames of 80 ms; frames counted against the view: ${JSON.stringify(d.filter((x) => x.what === 'long frame').map((x) => x.detail))}`);
  expect(errors).toEqual([]);
});

test('(b) a view that busy-loops 100 ms a frame on the office\'s thread is paused within the budget; Resume brings it back', async ({ page, request }) => {
  const errors = await office(page, request, [TALLY]);
  await openTile(page, TALLY);
  const view = page.frameLocator(READY);
  await view.getByRole('button', { name: 'Count one more' }).click();
  await expect(view.locator('#count')).toHaveText('1');
  // The headless shell keeps the frame on the office's thread, and the probe says so.
  await expect.poll(() => threadOf(page), { timeout: 8000 }).toBe('shared');
  await page.waitForTimeout(1300);
  const started = Date.now();
  await busyView(await viewFrame(page), 100, 8000);
  await expect(page.locator(PAUSED)).toContainText('Paused to keep your desk smooth', { timeout: 5000 });
  const tookMs = Date.now() - started;
  await expect(page.locator('[data-testid="deskapp-frame"]')).toHaveCount(0);
  const paused = (await diags(page)).filter((x) => x.what === 'paused');
  expect(paused).toHaveLength(1);
  expect(paused[0]!.detail['view']).toBe(TALLY);
  expect(Number(paused[0]!.detail['lastViewMs'])).toBeGreaterThan(50);
  console.log(`(b) paused ${tookMs} ms after the view began; ${JSON.stringify(paused[0]!.detail)}`);
  await page.getByTestId('deskapp-resume').click();
  await expect(page.locator(READY)).toBeVisible();
  await expect(view.locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});

/** The real Bible view (`apps/bible/view`), its manifest's methods and window, and Genesis 1 (BSB) as canned answers. */
function realBible(): Record<string, unknown> {
  const root = new URL('../../../apps/bible/', import.meta.url);
  const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
  const manifest = JSON.parse(read('ma-app.json')) as { methods: unknown[]; views: { window: Record<string, number> } };
  const { width, height, minWidth, minHeight } = manifest.views.window;
  const rows = read('texts/bsb/bsb.tsv').split('\n').map((l) => l.split('\t'));
  const last = new Map<string, number[]>();
  for (const r of rows) {
    if (r[0] !== 'V') continue;
    const v = last.get(r[1]!) ?? [];
    const ch = Number(r[2]);
    v[ch - 1] = Math.max(v[ch - 1] ?? 0, Number.parseInt(r[3]!, 10));
    last.set(r[1]!, v);
  }
  const books = read('texts/bsb/books.tsv').trim().split('\n').map((l, i) => {
    const [id, name, chapters] = l.split('\t');
    return { id, name, testament: i < 39 ? 'ot' : 'nt', chapters: Number(chapters), verses: last.get(id!) ?? [] };
  });
  const items: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (r[1] !== 'GEN' || r[2] !== '1') continue;
    if (r[0] === 'H') items.push({ kind: 'heading', level: r[4], text: r[5] });
    if (r[0] === 'V') items.push({ kind: 'verse', verse: Number(r[3]), text: r[5], ...(r[4]!.includes('p') ? { p: true } : {}), ...(r[4]!.includes('q') ? { q: true } : {}), ...(r[4]!.includes('b') ? { b: true } : {}) });
    if (r[0] === 'F') {
      const verse = [...items].reverse().find((x) => x['kind'] === 'verse');
      if (verse) verse['notes'] = [...((verse['notes'] as unknown[]) ?? []), { at: Number(r[4]), text: r[5] }];
    }
  }
  const translations = [{ code: 'bsb', name: 'Berean Standard Bible', abbreviation: 'BSB', edition: '2023', publicDomain: true, default: true }];
  const prefs = { textSize: 18, oneVersePerLine: false, footnotes: true, highlightColor: 'amber', place: null };
  return {
    files: { 'view/index.html': read('view/index.html'), 'view/view.js': read('view/view.js'), 'view/view.css': read('view/view.css') },
    methods: manifest.methods,
    window: { width, height, minWidth, minHeight },
    answers: {
      'bible.state': { available: true, translations, defaultTranslation: 'bsb', translation: 'bsb', books, prefs },
      'bible.info': { translations, defaultTranslation: 'bsb' },
      'bible.books': { translation: 'bsb', books },
      'bible.chapter': { translation: 'bsb', book: 'GEN', bookName: 'Genesis', chapter: 1, items, prev: null, next: { book: 'GEN', chapter: 2 }, marks: [] },
      'bible.marks.chapter': { marks: [] },
      'bible.marks.list': { marks: [], total: 0, cursor: null },
      'bible.prefs.get': prefs,
      'bible.prefs.set': prefs,
    },
  };
}

test('(c) at 4x CPU the real Bible view, open 20 s while the office pans once, is never paused', async ({ page, request }) => {
  test.setTimeout(90_000);
  const errors = await office(page, request, [BIBLE], { bible: realBible() });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    const w = window as unknown as { __loaf: number[] };
    w.__loaf = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__loaf.push(Math.round(e.duration));
    }).observe({ type: 'long-animation-frame' });
  });
  const opened = Date.now();
  await openTile(page, BIBLE);
  const view = page.frameLocator(READY);
  await expect(view.locator('#chHead')).toHaveText('Genesis 1', { timeout: 15_000 });
  await expect(view.locator('.v[data-v="31"]')).toHaveCount(1);
  // Reading: a while at rest, the office panned once (a sideways wheel over bare canvas), then at rest again.
  await page.waitForTimeout(6000);
  const spot = await page.evaluate(() => {
    for (const [x, y] of [[40, 450], [1400, 450], [720, 870], [40, 860], [1400, 860], [720, 120]] as const) {
      if (document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y };
    }
    return null;
  });
  expect(spot).not.toBeNull();
  const camX = (): Promise<number> => page.evaluate(() => (window as unknown as { __maDesk: { camera: { cam: { x: number } } } }).__maDesk.camera.cam.x);
  const before = await camX();
  await page.mouse.move(spot!.x, spot!.y);
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(60, 0);
    await page.waitForTimeout(30);
  }
  await expect.poll(camX).not.toBe(before);
  await page.waitForTimeout(Math.max(0, 20_000 - (Date.now() - opened)));
  await expect(page.locator(PAUSED)).toHaveCount(0);
  await expect(page.locator(READY)).toBeVisible();
  await expect(view.locator('#chHead')).toHaveText('Genesis 1');
  const loaf = await page.evaluate(() => (window as unknown as { __loaf: number[] }).__loaf);
  const d = await diags(page);
  console.log(`(c) office long frames at 4x: ${loaf.length}, longest ${Math.max(0, ...loaf)} ms, over 1 s: ${loaf.filter((x) => x > 1000).length}; budget: ${JSON.stringify(d.map((x) => [x.what, x.detail['viewMs'] ?? x.detail['thread']]))}`);
  expect(d.filter((x) => x.what === 'paused')).toEqual([]);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  expect(errors).toEqual([]);
});

test.describe('without Long Animation Frames (Firefox, Safari)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const types = PerformanceObserver.supportedEntryTypes.filter((t) => t !== 'long-animation-frame');
      Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', { get: () => types });
    });
  });

  test('(d) the office\'s own long frames and a 700 ms stall never pause; a view that hangs 1.3 s twice is paused', async ({ page, request }) => {
    test.setTimeout(60_000);
    const errors = await office(page, request, [TALLY]);
    await openTile(page, TALLY);
    await page.waitForTimeout(2500); // past the view's startup, and the office idle
    await busyOffice(page, 80, 150, 6000);
    await busyOffice(page, 700, 0, 1);
    await page.waitForTimeout(1200);
    await expect(page.locator(PAUSED)).toHaveCount(0);
    expect((await diags(page)).filter((x) => x.what === 'hang')).toEqual([]);
    const f = await viewFrame(page);
    for (let i = 0; i < 2; i += 1) {
      await f.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => {
        const until = performance.now() + 1300;
        while (performance.now() < until) { /* the view hangs */ }
        done();
      })));
      await page.waitForTimeout(1500);
    }
    await expect(page.locator(PAUSED)).toContainText('Paused to keep your desk smooth');
    const paused = (await diags(page)).filter((x) => x.what === 'paused');
    expect(paused).toHaveLength(1);
    expect(Number(paused[0]!.detail['lastGapMs'])).toBeGreaterThan(1000);
    await page.getByTestId('deskapp-resume').click();
    await expect(page.locator(READY)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
