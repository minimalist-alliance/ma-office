// Reflow at 400 % (WCAG 1.4.10): 1280 x 800 zoomed to 400 % is a 320 x 200 CSS px viewport, and 1024 wide is 256. The chrome
// (top bar, bottom bar, the account menu and its panels, the bell, the circles, Maia, the settings modal) reads without
// scrolling sideways. The canvas and an app's own content are two-dimensional and exempt.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['REFLOW_SHOTS'];

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

interface Out { doc: number; vw: number; wide: string[] }

/** What pokes out of the viewport sideways, other than the canvas, an app's content and anything hidden. */
async function measure(page: Page, frames = false): Promise<Out> {
  return page.evaluate((frames) => {
    const vw = document.documentElement.clientWidth;
    const wide: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      // `frames`: a window's own frame and bars are measured too; only its picture (the page, a canvas) is content.
      if (el.closest(frames ? 'canvas, video, .proxy-layer, .thumb-tabs, svg, [aria-hidden="true"]' : 'canvas, .proxy-layer, .ma-window-body, .ma-window .content, svg, [aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed' && cs.opacity === '0') continue;
      if (r.right > vw + 1 || r.left < -1) {
        let sc: HTMLElement | null = el.parentElement;
        let clipped = false;
        while (sc) { const o = getComputedStyle(sc).overflowX; if (o !== 'visible') { const pr = sc.getBoundingClientRect(); if (pr.right <= vw + 1 && pr.left >= -1) { clipped = true; break; } } sc = sc.parentElement; }
        if (clipped && getComputedStyle(el.parentElement!).overflowX === 'visible') clipped = false;
        wide.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}[${Math.round(r.left)},${Math.round(r.right)}]${clipped ? ' (in a scroller)' : ''}`);
      }
    }
    return { doc: document.documentElement.scrollWidth, vw, wide: wide.slice(0, 12) };
  }, frames);
}

interface Scene {
  name: string;
  /** What the harness is told before sign-in. */
  patch?: Record<string, unknown>;
  path?: string;
  open: (page: Page) => Promise<void>;
}
const account = (p: Page) => p.getByRole('button', { name: 'Account', exact: true });
const MAIA = { maia: { enabled: true } };
const SCENES: Scene[] = [
  { name: 'bars', open: async () => undefined },
  { name: 'account', open: async (p) => { await account(p).click(); await expect(p.getByRole('dialog', { name: 'Account' })).toBeVisible(); } },
  {
    name: 'settings',
    open: async (p) => {
      await account(p).click();
      await p.getByRole('button', { name: 'Account settings', exact: true }).click();
      await expect(p.getByRole('dialog').first()).toBeVisible();
    },
  },
  { name: 'bell', open: async (p) => { await p.getByRole('button', { name: /^Notifications/ }).click(); await expect(p.getByRole('dialog', { name: 'Notifications' })).toBeVisible(); } },
  { name: 'shield', open: async (p) => { await p.getByRole('button', { name: 'Privacy shield' }).click(); } },
  { name: 'bandwidth', open: async (p) => { await p.getByRole('button', { name: /bandwidth/i }).first().click(); await expect(p.locator('.bw-panel')).toBeVisible(); } },
  { name: 'maia-bubble', patch: MAIA, open: async (p) => { await expect(p.locator('.maia-launcher')).toBeVisible(); } },
  { name: 'maia-panel', patch: MAIA, open: async (p) => { await p.locator('.maia-launcher').click(); await expect(p.getByRole('dialog', { name: 'Maia' })).toBeVisible(); } },
  { name: 'setup', patch: { setupCircle: null, files: { enabled: true }, membership: { status: 'active', tier: 'officer' } }, open: async (p) => { await account(p).click(); await p.getByTestId('menu-setup').click(); await expect(p.getByRole('region', { name: 'Set up your office' })).toBeVisible(); } },
  { name: 'shortcuts', open: async (p) => { await account(p).click(); await p.getByRole('button', { name: /shortcuts/i }).click(); } },
  {
    // The Apps sheet (ADR 0054): the whole screen on a phone, its rows and its detail reading without scrolling sideways.
    name: 'apps-sheet',
    open: async (p) => {
      await p.evaluate(() => {
        const m = (window as unknown as { __maDeskMock: { apps: { available: boolean; push(): void } } }).__maDeskMock.apps;
        m.available = true;
        m.push();
      });
      // A phone-sized screen has no desk menu, so the sheet opens on a larger one, then the screen shrinks under it.
      const size = p.viewportSize()!;
      await p.setViewportSize({ width: 1280, height: 800 });
      await p.waitForTimeout(600);
      const desk = p.locator('.proxy-layer [id^="proxy-d-"]').first();
      await desk.focus();
      await p.keyboard.press('.');
      await p.getByRole('menu', { name: 'Desk' }).getByRole('menuitem', { name: 'Apps', exact: true }).click();
      await expect(p.getByTestId('dapp-row-com.minimalistalliance.bible')).toBeVisible();
      await p.setViewportSize(size);
    },
  },
  { name: 'notice', patch: { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: { enabled: true, officerMonthlyUsd: 100 } }, path: '/', open: async (p) => { await expect(p.getByRole('link', { name: 'See membership' })).toBeVisible(); } },
];

for (const width of [320, 256]) {
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    for (const { name, patch, path, open } of SCENES) {
      test(`${width} px, ${theme}: ${name} reflows`, async ({ page, request }) => {
        if (patch) await harness(request, patch);
        await setTheme(page, theme);
        await page.setViewportSize({ width, height: 200 });
        await signIn(page, path ?? '/?fixture=one');
        await canvasPainted(page);
        await open(page);
        await page.waitForTimeout(400);
        const m = await measure(page);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-${theme}-${name}.png` });
        expect(m.doc, JSON.stringify(m)).toBeLessThanOrEqual(m.vw);
        expect(m.wide, JSON.stringify(m)).toEqual([]);
        // Her sheet covers the top bar's edge at 256 px by design (it is a sheet), which axe's target-size rule counts as overlap.
        if (['bars', 'account', 'notice'].includes(name) || (name === 'maia-panel' && width === 320)) {
          await page.evaluate((src) => { (0, eval)(src); }, AXE);
          const res = await page.evaluate(async () => {
            const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
            return r.violations.filter((v) => v.id !== 'color-contrast').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
          });
          expect(res).toEqual([]);
        }
      });
    }
  }
}

// The bandwidth circle drew a ring inside its own outlined disc, two rings in Zen and Dark. One ring now, as in Light.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the bandwidth circle shows one ring, the disc has no outline of its own`, async ({ page }) => {
    await setTheme(page, theme);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    const btn = page.getByRole('button', { name: /bandwidth/i }).first();
    await expect(btn).toBeVisible();
    expect(await btn.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
    expect(await btn.locator('circle').count()).toBeGreaterThanOrEqual(1);
    if (SHOTS) {
      const b = (await btn.boundingBox())!;
      await page.screenshot({ path: `${SHOTS}/ring-${theme}.png`, clip: { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 } });
    }
  });
}


// The Browser's and the Agent's window frames and bars (not the page's picture, which is content): title bar, tab row, address
// bar and its right group; the Agent's head, list, panels, approval card, key and free-model cards, and composer.
const FRAME_SCENES: Scene[] = [];
async function openFromTile(p: Page, app: 'Browser' | 'Agent'): Promise<void> {
  const tile = p.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: new RegExp(`^${app}`) });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(p.getByRole('dialog', { name: new RegExp(app) })).toBeVisible();
}
/** The agent list: open through its button, which is `aria-expanded`, until it is (a press before the window is ready is lost). */
async function openRail(p: Page): Promise<void> {
  const row = p.getByTestId('agent-scout');
  const toggle = p.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => {
    if (await row.isVisible()) return true;
    if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    return row.isVisible();
  }, { timeout: 10_000 }).toBe(true);
}
FRAME_SCENES.push(
  { name: 'browser', open: async (p) => { await openFromTile(p, 'Browser'); await p.getByTestId('browser-address').waitFor(); } },
  {
    name: 'browser-tabs',
    open: async (p) => {
      await openFromTile(p, 'Browser');
      await p.evaluate(() => (window as unknown as { __maDeskMock: { setTabs(t: unknown[]): void } }).__maDeskMock.setTabs([
        { tabId: 't1', url: 'https://example.org/a-very-long-address/that/keeps/going?with=a&long=query&string=yes', title: 'A page with a really long title that goes on and on', loading: false, active: true, canGoBack: true, canGoForward: true },
        { tabId: 't2', url: 'https://example.com/', title: 'Second', loading: true, active: false, canGoBack: false, canGoForward: false },
        { tabId: 't3', url: 'https://example.net/', title: 'Third tab', loading: false, active: false, canGoBack: false, canGoForward: false },
      ]));
      await expect(p.getByTestId('browser-tab')).toHaveCount(3);
    },
  },
  {
    name: 'browser-starting',
    open: async (p) => {
      await p.evaluate(() => { (window as unknown as { __maDeskMock: { browserStartMs: number } }).__maDeskMock.browserStartMs = 60_000; });
      await openFromTile(p, 'Browser');
      await p.getByTestId('browser-address').fill('example.com/typed-while-it-starts');
      await expect(p.getByTestId('browser-panel')).toHaveAttribute('data-panel', 'starting');
    },
  },
  // Site sign-ins (#11). At 320 x 256 the window is a phone on its side (under 700 x 480), so the key and Extensions both fold
  // into More; 'bar' is the same width taller, where the key shows in the bar and Extensions is in More; 'menu' and 'panel'
  // are More's rows with a manager installed, and the Passwords and sign-ins panel.
  {
    name: 'browser-signins-bar',
    path: '/?fixture=one&signIns=bitwarden',
    open: async (p) => {
      await openFromTile(p, 'Browser');
      await expect(p.getByTestId('browser-panel')).toHaveCount(0);
      await p.setViewportSize({ width: p.viewportSize()!.width, height: 700 });
      await expect(p.getByTestId('browser-key')).toBeVisible();
    },
  },
  {
    name: 'browser-signins-menu',
    path: '/?fixture=one&signIns=bitwarden',
    open: async (p) => {
      await openFromTile(p, 'Browser');
      await expect(p.getByTestId('browser-panel')).toHaveCount(0);
      await p.getByRole('button', { name: 'More', exact: true }).click();
      await expect(p.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Bitwarden by Bitwarden Inc.' })).toBeVisible();
    },
  },
  {
    name: 'browser-signins-panel',
    path: '/?fixture=one&signIns=bitwarden&signInsStop=1',
    open: async (p) => {
      await openFromTile(p, 'Browser');
      await expect(p.getByTestId('browser-panel')).toHaveCount(0);
      await p.getByRole('button', { name: 'More', exact: true }).click();
      await p.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: /Passwords and sign-ins/ }).click();
      await expect(p.getByTestId('passwords-panel')).toBeVisible();
    },
  },
  { name: 'agent-key', path: '/?fixture=one&speed=fast', open: async (p) => { await openFromTile(p, 'Agent'); await expect(p.getByTestId('key-setup')).toBeVisible(); } },
  {
    name: 'agent-thread',
    path: '/?fixture=one&speed=fast',
    open: async (p) => {
      await openFromTile(p, 'Agent');
      await p.getByTestId('key-input').fill('sk-ant-TEST-not-a-real-key-canary-0000-abcd');
      await p.getByTestId('key-submit').click();
      await expect(p.getByTestId('composer-input')).toBeVisible();
      await p.getByTestId('composer-input').fill('A long message to see that the composer wraps and the send button stays in sight at this width');
    },
  },
  {
    name: 'agent-approval',
    path: '/?fixture=one&speed=fast&agentFixture=tools',
    open: async (p) => {
      await openFromTile(p, 'Agent');
      await openRail(p);
      await p.getByTestId('agent-scout').click();
      await expect(p.getByTestId('approval')).toBeVisible();
    },
  },
  {
    name: 'agent-list',
    path: '/?fixture=one&speed=fast&agentFixture=tools',
    open: async (p) => {
      await openFromTile(p, 'Agent');
      await openRail(p);
      await expect(p.getByTestId('agent-scout')).toBeVisible();
    },
  },
);
for (const tab of ['settings', 'memory', 'usage', 'keys', 'activity', 'messages']) {
  FRAME_SCENES.push({
    name: `agent-${tab}`,
    path: '/?fixture=one&speed=fast&agentFixture=tools',
    open: async (p) => {
      await openFromTile(p, 'Agent');
      const t = p.getByTestId(`tab-${tab}`);
      await expect(t).toBeVisible();
      await t.click();
      await expect(p.getByTestId('drawer')).toBeVisible();
    },
  });
}
// A free member's time ring in the Browser's head, which covers the bar's (walk L13), and its panel open there.
const DAY = 86_400_000;
const START = Math.floor(Date.now() / DAY) * DAY;
const iso = (t: number): string => new Date(t).toISOString();
const usage = (limitGb: number) => ({ usedBytes: 2e8, usedGb: 0.2, limitGb, startsAt: iso(START), resetsAt: iso(START + 7 * DAY) });
const FREE_MEMBER = {
  membership: { status: 'active', tier: 'free', ageBand: 'adult', adultFrom: null, parent: null },
  fleet: [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' }],
  bandwidth: {
    tier: 'free', week: usage(3), month: usage(10), state: 'ok', limitedBy: null, warnAtPct: 80, enforced: true, paused: false, resumesAt: null,
    asOf: iso(Date.now()), pollAfterSeconds: 60,
    browserTime: { usedSeconds: 19 * 60, limitSeconds: 45 * 60, startsAt: iso(START), resetsAt: iso(START + DAY) },
  },
};
FRAME_SCENES.push(
  { name: 'browser-free-ring', patch: FREE_MEMBER, path: '/', open: async (p) => { await openFromTile(p, 'Browser'); await p.getByTestId('free-meter-window-button').waitFor(); } },
  {
    name: 'browser-free-ring-panel',
    patch: FREE_MEMBER,
    path: '/',
    open: async (p) => {
      await openFromTile(p, 'Browser');
      await p.getByTestId('free-meter-window-button').click();
      await expect(p.getByTestId('free-meter-panel')).toBeVisible();
    },
  },
);
FRAME_SCENES.push({
  name: 'agent-free',
  path: '/?fixture=one&speed=fast',
  open: async (p) => { await openFromTile(p, 'Agent'); await expect(p.getByTestId('free-card')).toBeVisible(); },
});

for (const width of [320, 256]) {
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    for (const { name, path, patch, open } of FRAME_SCENES) {
      test(`${width} px, ${theme}: the ${name} window reflows`, async ({ page, request }) => {
        if (patch) await harness(request, patch);
        await setTheme(page, theme);
        // 1280 x 1024 at 400 %: WCAG's 320 x 256.
        await page.setViewportSize({ width, height: 256 });
        await signIn(page, path ?? '/?fixture=one');
        await canvasPainted(page);
        await open(page);
        await page.waitForTimeout(500);
        const m = await measure(page, true);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-${theme}-${name}.png` });
        expect(m.doc, JSON.stringify(m)).toBeLessThanOrEqual(m.vw);
        expect(m.wide, JSON.stringify(m)).toEqual([]);
      });
    }
  }
}

// The audit's own case (task 09 finding 6; ma-platform docs/audits/a11y-platform-report.md): a 1440 x 900 window at 400 %
// is 360 x 225 CSS px, and with three desks the scope switch is in the top bar, which the one-desk scenes above never show.
// Full screen and Account ran off the right edge then; now nothing scrolls sideways and every control in both bars is on
// screen and takes a press where it's drawn. Under 400 px high that's short-viewport mode (below), where the scope switch
// is one menu button and the zoom one button.
interface Control { name: string; on: boolean; pressable: boolean; by: string }
async function barControls(page: Page): Promise<Control[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return [...document.querySelectorAll<HTMLElement>('.topbar :is(button, a, input), .bottombar :is(button, a, input)')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
          on: r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
          pressable: !!hit && el.contains(hit),
          by: hit && !el.contains(hit) ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}` : '',
        };
      });
  });
}
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`360 x 225, ${theme}, three desks (the audit's 400 %): nothing scrolls sideways, every bar control is on screen and takes a press`, async ({ page }) => {
    await setTheme(page, theme);
    await page.setViewportSize({ width: 360, height: 225 });
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await page.waitForTimeout(400);
    const m = await measure(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/360x225-${theme}-three-desks.png` });
    expect(m.doc, JSON.stringify(m)).toBeLessThanOrEqual(m.vw);
    expect(m.wide, JSON.stringify(m)).toEqual([]);
    const controls = await barControls(page);
    expect(controls.map((c) => c.name)).toEqual(expect.arrayContaining(['Scope: All', 'Privacy shield', 'Full screen', 'Account', 'Previous desk', 'Next desk']));
    expect(controls.map((c) => c.name)).toContainEqual(expect.stringMatching(/^Zoom \d+%$/));
    expect(controls.filter((c) => !c.on || !c.pressable), JSON.stringify(controls)).toEqual([]);
  });
}

// ---------------------------------------------------------------- short-viewport mode (finding 6, the Product Designer's spec)
// Under 400 CSS px high each bar is one 44 px row. Top: the mark and one scope menu button on the left; the shield, full
// screen, the bell and the account on the right at 36 px with 4 px gaps. Bottom: the desk switch, the zoom's one button
// (its popover holds −, + and Fit) and the circles. At 320 x 200 the desks keep 96 px between the bars, at 360 x 225 120.
const THEMES = ['light', 'dusk', 'dark'] as ThemeId[];
const SHORT = [{ width: 320, height: 200, canvas: 96 }, { width: 360, height: 225, canvas: 120 }] as const;
type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const rect = (page: Page, sel: string): Promise<Rect> => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON() as Rect);
const rects = (page: Page, sel: string): Promise<Rect[]> => page.locator(sel).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as Rect));
const zoomLevel = async (page: Page): Promise<number> => Number((await page.locator('.zoom-label').first().textContent())!.replace('%', ''));
const mid = (r: Rect): number => r.top + r.height / 2;
/** A press on the canvas in the top bar's gap, between the scope's button and the shield: outside both menus. */
async function pressAway(page: Page): Promise<void> {
  const [scope, shield] = [await rect(page, '.scope-menu .chip-btn'), await rect(page, '.top-actions .icon-btn')];
  await page.mouse.click((scope.right + shield.left) / 2, 22);
}
/** The camera's own level, as the zoom's label should say it (`__maDesk`, the e2e build's read-only hook). */
const cameraLevel = (page: Page): Promise<string> => page.evaluate(() => `${Math.round((window as unknown as { __maDesk: { camera: { cam: { s: number } } } }).__maDesk.camera.cam.s * 100)}%`);
async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate((src) => { (0, eval)(src); }, AXE);
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
    return r.violations.filter((v) => v.id !== 'color-contrast').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function arriveThree(page: Page, size: { width: number; height: number }, theme: ThemeId = 'light'): Promise<void> {
  await setTheme(page, theme);
  await page.setViewportSize(size);
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await page.waitForTimeout(400);
}

// The audit's 1280 x 800 at 400 %: the top bar's icons sat on the desk switch, so Previous desk and Next desk took no press.
test('320 x 200, three desks: the bars don\'t overlap, and every bar control takes a press', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 200 });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await page.waitForTimeout(400);
  expect((await barControls(page)).filter((c) => !c.on || !c.pressable)).toEqual([]);
  const [top, bottom] = await page.evaluate(() => ['.topbar', '.bottombar'].map((s) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect));
  expect(top!.bottom).toBeLessThanOrEqual(bottom!.top);
});

for (const { width, height, canvas } of SHORT) {
  for (const theme of THEMES) {
    test(`short-viewport mode, ${width} x ${height}, ${theme}: a 44 px row each, ${canvas} px of desks between, every control takes a press, the menus on screen`, async ({ page }) => {
      await arriveThree(page, { width, height }, theme);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}x${height}-${theme}.png` });
      const top = await rect(page, '.topbar');
      const bottom = await rect(page, '.bottombar');
      expect(top.top).toBe(0);
      expect(top.height).toBe(44);
      // The bottom bar's row is 44 px, 8 px above and below it.
      expect(bottom.bottom).toBe(height);
      expect(bottom.height).toBe(60);
      expect(bottom.top - top.bottom).toBeGreaterThanOrEqual(canvas);

      // Top: the mark, the scope's one button, then the four, 36 px each, 4 px apart, all on the bar's one row.
      await expect(page.getByRole('radiogroup', { name: 'Scope' })).toHaveCount(0);
      const mark = await rect(page, '.home-mark');
      const scope = await rect(page, '.scope-menu .chip-btn');
      const four = await rects(page, '.top-actions > * > .icon-btn, .top-actions > .icon-btn');
      expect(four.map((r) => [r.width, r.height])).toEqual([[36, 36], [36, 36], [36, 36], [36, 36]]);
      expect(four.slice(1).map((r, i) => r.left - four[i]!.right)).toEqual([4, 4, 4]);
      expect(mark.right).toBeLessThanOrEqual(scope.left);
      expect(scope.right).toBeLessThanOrEqual(four[0]!.left);
      expect(four[3]!.right).toBeLessThanOrEqual(width - 16);
      for (const r of [mark, scope, ...four]) expect(Math.abs(mid(r) - 22)).toBeLessThanOrEqual(1);

      // Bottom: the desk switch, the zoom's button, then the circle, side by side on one row.
      const nav = await rect(page, '.desk-nav');
      const zoom = await rect(page, '.zoom-menu .chip-btn');
      const ring = await rect(page, '[data-testid="bandwidth-button"]');
      expect(nav.right).toBeLessThanOrEqual(zoom.left);
      expect(zoom.right).toBeLessThanOrEqual(ring.left);
      for (const r of [nav, zoom, ring]) expect(Math.abs(mid(r) - (height - 30))).toBeLessThanOrEqual(1);

      const m = await measure(page);
      expect(m.doc, JSON.stringify(m)).toBeLessThanOrEqual(m.vw);
      expect(m.wide, JSON.stringify(m)).toEqual([]);
      const controls = await barControls(page);
      expect(controls.filter((c) => !c.on || !c.pressable), JSON.stringify(controls)).toEqual([]);

      // Each popover opens on screen, clear of the other bar's controls, and scrolls nothing sideways.
      await page.getByRole('button', { name: 'Scope: All' }).click();
      const list = page.getByRole('menu', { name: 'Scope' });
      await expect(list).toBeVisible();
      await page.waitForTimeout(150);
      const l = await rect(page, '#scope-list');
      expect(l.top).toBeGreaterThanOrEqual(top.bottom - 1);
      expect(l.bottom).toBeLessThanOrEqual(height);
      expect(l.left).toBeGreaterThanOrEqual(0);
      expect(l.right).toBeLessThanOrEqual(width);
      expect((await measure(page)).wide).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}x${height}-${theme}-scope-menu.png` });
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);

      await page.getByRole('button', { name: /^Zoom \d+%$/ }).click();
      const pop = page.getByRole('dialog', { name: 'Zoom' });
      await expect(pop).toBeVisible();
      await page.waitForTimeout(150);
      const p = await rect(page, '#zoom-pop');
      expect(p.bottom).toBeLessThanOrEqual(bottom.top + 8);
      expect(p.top).toBeGreaterThanOrEqual(top.bottom);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.right).toBeLessThanOrEqual(width);
      expect((await measure(page)).wide).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}x${height}-${theme}-zoom.png` });
    });
  }
}

test('short-viewport mode: the scope menu opens, the arrows move, Enter picks, Esc and Tab shut it, and the keyboard goes back to its button', async ({ page }) => {
  await arriveThree(page, { width: 360, height: 225 });
  // On a desk, so an Esc that reached the office would leave it for the overview.
  await focusCanvas(page);
  await page.keyboard.press('1');
  const home = page.getByRole('button', { name: 'Your office, show all desks' });
  await expect(home).toBeVisible();

  const btn = page.getByRole('button', { name: 'Scope: All' });
  await expect(btn).toHaveAttribute('aria-haspopup', 'menu');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Scope' });
  await expect(menu).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const items = menu.getByRole('menuitemradio');
  await expect(items).toHaveText(['Personal', 'Work', 'Guild', 'All']);
  expect(await items.evaluateAll((els) => els.map((el) => el.getAttribute('aria-checked')))).toEqual(['false', 'false', 'false', 'true']);
  // The check shows on the current one only.
  expect(await items.evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector('svg')!).visibility))).toEqual(['hidden', 'hidden', 'hidden', 'visible']);
  await expect(items.nth(3)).toBeFocused();
  for (const [key, at] of [['ArrowDown', 0], ['ArrowDown', 1], ['ArrowUp', 0], ['ArrowUp', 3], ['Home', 0], ['End', 3], ['ArrowUp', 2], ['ArrowUp', 1]] as const) {
    await page.keyboard.press(key);
    await expect(items.nth(at), `${key} to ${at}`).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  const work = page.getByRole('button', { name: 'Scope: Work' });
  await expect(work).toBeFocused();
  await expect(work).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.desk-nav-label')).toContainText('Work');

  // Space opens it too, on the current one; Esc shuts it, gives the keyboard back, and goes no further.
  await page.getByRole('button', { name: 'Scope: Work' }).focus();
  await page.keyboard.press('Space');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const all = page.getByRole('button', { name: 'Scope: All' });
  await expect(all).toBeFocused();
  await focusCanvas(page);
  await page.keyboard.press('1');
  await expect(home).toBeVisible();
  await all.focus();
  await page.keyboard.press('Enter');
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute('aria-expanded', 'false');
  await expect(home, 'the Esc was the menu\'s, not the office\'s').toBeVisible();

  // Tab shuts it too, the keyboard on its button; and a press outside shuts it.
  await page.keyboard.press('Space');
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(all).toBeFocused();
  await all.click();
  await expect(menu).toBeVisible();
  await pressAway(page);
  await expect(menu).toHaveCount(0);

  // With the mouse: a press picks, and the keyboard is back on the button.
  await all.click();
  await menu.getByRole('menuitemradio', { name: 'Guild' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Scope: Guild' })).toBeFocused();
});

/** Fit, from the canvas's own `0`, and the level it settles at: the overview's (the office opens on a desk's). Settled is
 * the camera still between two looks and the label saying its level, which it's written once the camera stops. */
async function fitLevel(page: Page): Promise<number> {
  await focusCanvas(page);
  await page.keyboard.press('0');
  let last = '';
  await expect.poll(async () => {
    const cam = await cameraLevel(page);
    const still = cam === last && `${await zoomLevel(page)}%` === cam;
    last = cam;
    return still;
  }, { intervals: [150] }).toBe(true);
  return zoomLevel(page);
}

test('short-viewport mode: the zoom button opens −, + and Fit in that order; each works, so do their keys, and Esc gives the keyboard back', async ({ page }) => {
  await arriveThree(page, { width: 360, height: 225 });
  const fit = await fitLevel(page);
  const btn = page.getByRole('button', { name: /^Zoom \d+%$/ });
  await expect(btn).toHaveAccessibleName(`Zoom ${fit}%`);
  await expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);

  await btn.focus();
  await page.keyboard.press('Enter');
  const pop = page.getByRole('dialog', { name: 'Zoom' });
  await expect(pop).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const buttons = pop.getByRole('button');
  expect(await buttons.evaluateAll((els) => els.map((el) => [el.getAttribute('aria-label'), el.getAttribute('title')]))).toEqual([
    ['Zoom out', 'Zoom out ( − )'],
    ['Zoom in', 'Zoom in ( + )'],
    ['Fit the desk', 'Fit ( 0 )'],
  ]);
  await expect(buttons.nth(0)).toBeFocused();

  // The buttons, from the keyboard: −, then Right to + and Fit, which wrap round.
  await page.keyboard.press('Enter');
  await expect.poll(() => zoomLevel(page)).toBeLessThan(fit);
  await page.keyboard.press('ArrowRight');
  await expect(buttons.nth(1)).toBeFocused();
  // A second press once the first has landed: one during its move starts from where the camera is then.
  await page.keyboard.press('Enter');
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await page.keyboard.press('Enter');
  await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fit);
  await page.keyboard.press('ArrowRight');
  await expect(buttons.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await page.keyboard.press('ArrowRight');
  await expect(buttons.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(buttons.nth(2)).toBeFocused();
  await expect(btn).toHaveAccessibleName(`Zoom ${fit}%`);

  // Their keys, the canvas's own, while the popover has the keyboard: + and =, − and _, then 0.
  for (const [key, more] of [['+', true], ['=', true], ['-', false], ['_', false]] as const) {
    const at = await zoomLevel(page);
    await page.keyboard.press(key);
    if (more) await expect.poll(() => zoomLevel(page), key).toBeGreaterThan(at);
    else await expect.poll(() => zoomLevel(page), key).toBeLessThan(at);
  }
  await page.keyboard.press('-');
  await expect.poll(() => zoomLevel(page)).not.toBe(fit);
  await page.keyboard.press('0');
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await expect(pop, 'it stays open for another press').toBeVisible();

  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');

  // With the mouse: +, then Fit; a second press on the button shuts it; a press outside shuts it.
  await btn.click();
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fit);
  await pop.getByRole('button', { name: 'Fit the desk' }).click();
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await btn.click();
  await expect(pop).toHaveCount(0);
  await btn.click();
  await expect(pop).toBeVisible();
  await pressAway(page);
  await expect(pop).toHaveCount(0);
});

test('short-viewport mode: the canvas\'s keys still work, and only while it has the keyboard', async ({ page }) => {
  await arriveThree(page, { width: 360, height: 225 });
  const fit = await fitLevel(page);
  const label = page.locator('.desk-nav-label');
  await expect(label).toContainText('Personal');
  // On the bars' buttons, + and ] are nothing (the canvas-focus rule, `shell/canvasFocus.ts`).
  for (const name of [/^Zoom \d+%$/, /^Scope: All$/]) {
    await page.getByRole('button', { name }).focus();
    await page.keyboard.press('+');
    await page.keyboard.press(']');
  }
  await page.waitForTimeout(400);
  expect(await zoomLevel(page)).toBe(fit);
  await expect(label).toContainText('Personal');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Zoom' })).toHaveCount(0);

  await focusCanvas(page);
  await page.keyboard.press('+');
  await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fit);
  await page.keyboard.press('0');
  await expect.poll(() => zoomLevel(page)).toBe(fit);
  await page.keyboard.press(']');
  await expect(label).toContainText('Work');
  await page.keyboard.press('[');
  await expect(label).toContainText('Personal');
  await page.keyboard.press('\\');
  await expect(page.getByRole('button', { name: 'Privacy shield' })).toHaveAttribute('aria-pressed', 'true');
});

test('short-viewport mode starts under 400 px high and nowhere else, and follows the window as it changes', async ({ page }) => {
  await arriveThree(page, { width: 360, height: 400 });
  await expect(page.getByRole('radiogroup', { name: 'Scope' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Zoom' })).toBeVisible();
  await expect(page.locator('.scope-menu, .zoom-menu')).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 399 });
  await expect(page.getByRole('button', { name: 'Scope: All' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Scope' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Zoom' })).toHaveCount(0);
  expect((await rect(page, '.topbar')).height).toBe(44);
  await expect.poll(async () => (await page.locator('.zoom-menu .zoom-label').textContent()) === (await cameraLevel(page))).toBe(true);
  // Back over 400: the zoom group's own level is written as it comes back, not left at its first "100%".
  await page.setViewportSize({ width: 360, height: 400 });
  await expect(page.getByRole('radiogroup', { name: 'Scope' })).toBeVisible();
  await expect.poll(async () => (await page.locator('.zoom-ctl .zoom-label').textContent()) === (await cameraLevel(page))).toBe(true);
});

test('1440 x 900, three desks: as before, the segmented scope switch, the zoom group, and the bars at their heights', async ({ page }) => {
  await arriveThree(page, { width: 1440, height: 900 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1440x900-light.png` });
  await expect(page.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio')).toHaveText(['Personal', 'Work', 'Guild', 'All']);
  const group = page.getByRole('group', { name: 'Zoom' });
  expect(await group.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(['Zoom out', 'Zoom in', 'Fit the desk']);
  await expect(group.locator('.zoom-label')).toHaveText(/^\d+%$/);
  await expect(page.locator('.scope-menu, .zoom-menu, .chip-btn')).toHaveCount(0);
  expect((await rect(page, '.topbar')).height).toBe(66);
  expect((await rect(page, '.bottombar')).height).toBe(70);
  expect((await rects(page, '.top-actions .icon-btn')).map((r) => r.width)).toEqual([38, 38, 38, 38]);
});

// At every size the top bar's group takes no press of its own: a press in a gap between its controls goes through to the
// desks under it (at 320 x 200 its row lay over the desk switch). Upright on a phone it wraps, from the right.
for (const size of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 360, height: 225 }, { width: 320, height: 200 }]) {
  test(`${size.width} x ${size.height}: the top bar's group of buttons lets a press through, only its controls take one`, async ({ page }) => {
    await arriveThree(page, size);
    const r = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>('.top-actions')!;
      const kids = [...wrap.children].map((k) => k.getBoundingClientRect());
      const box = wrap.getBoundingClientRect();
      let free = 0;
      let eaten = 0;
      for (let x = Math.ceil(box.left) + 0.5; x < box.right; x += 1) {
        for (let y = Math.ceil(box.top) + 0.5; y < box.bottom; y += 2) {
          // A pixel clear of every control (a hit test rounds to the pixel, so one at a control's edge is the control's).
          if (kids.some((k) => x >= k.left - 1 && x <= k.right + 1 && y >= k.top - 1 && y <= k.bottom + 1)) continue;
          free += 1;
          const hit = document.elementFromPoint(x, y);
          if (hit && wrap.contains(hit)) eaten += 1;
        }
      }
      return { wrap: getComputedStyle(wrap).pointerEvents, kids: [...new Set([...wrap.children].map((k) => getComputedStyle(k).pointerEvents))], free, eaten };
    });
    expect(r.wrap).toBe('none');
    expect(r.kids).toEqual(['auto']);
    expect(r.free).toBeGreaterThan(0);
    expect(r.eaten).toBe(0);
  });
}

// With a finger (a phone on its side, and 400 % on a touch screen) the 36 px buttons take a whole 44 px press each, round
// them and invisibly, as the bars' buttons already did; so do the two chips and the desk switch's arrows.
for (const viewport of [{ width: 734, height: 343 }, { width: 360, height: 225 }]) {
  test.describe(`short-viewport mode with a finger, ${viewport.width} x ${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test('every bar button takes a 44 px press, the top bar\'s still drawn at 36', async ({ page }) => {
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await page.waitForTimeout(400);
      // As `touch.shell.spec.ts` measures a target: from its centre out along each axis, a pixel at a time, as a press lands.
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('.top-actions button, .bottombar .chip-btn, .topbar .chip-btn, .desk-nav button')) {
          const b = el.getBoundingClientRect();
          const [cx, cy] = [b.left + b.width / 2, b.top + b.height / 2];
          const on = (x: number, y: number): boolean => {
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
            const h = document.elementFromPoint(x, y);
            return !!h && el.contains(h);
          };
          let [l, r, t, d] = [0, 0, 0, 0];
          while (l < 30 && on(cx - l - 1, cy)) l++;
          while (r < 30 && on(cx + r + 1, cy)) r++;
          while (t < 30 && on(cx, cy - t - 1)) t++;
          while (d < 30 && on(cx, cy + d + 1)) d++;
          if (l + r + 1 < 44 || t + d + 1 < 44) out.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim()} ${l + r + 1}x${t + d + 1}`);
        }
        return out;
      });
      expect(small).toEqual([]);
      expect((await rects(page, '.top-actions > * > .icon-btn, .top-actions > .icon-btn')).map((r) => r.width)).toEqual([36, 36, 36, 36]);
      expect((await measure(page)).wide).toEqual([]);
    });
  });
}
