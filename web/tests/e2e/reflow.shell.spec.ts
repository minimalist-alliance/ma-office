// Reflow at 400 % (WCAG 1.4.10): 1280 x 800 zoomed to 400 % is a 320 x 200 CSS px viewport, and 1024 wide is 256. The chrome
// (top bar, bottom bar, the account menu and its panels, the bell, the circles, Maia, the settings modal) reads without
// scrolling sideways. The canvas and an app's own content are two-dimensional and exempt.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

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
FRAME_SCENES.push({
  name: 'agent-free',
  path: '/?fixture=one&speed=fast',
  open: async (p) => { await openFromTile(p, 'Agent'); await expect(p.getByTestId('free-card')).toBeVisible(); },
});

for (const width of [320, 256]) {
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    for (const { name, path, open } of FRAME_SCENES) {
      test(`${width} px, ${theme}: the ${name} window reflows`, async ({ page }) => {
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
