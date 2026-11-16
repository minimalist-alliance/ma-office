// The office's chrome in glass, measured on the rendered surface (the office glass's record, `docs/sub-status/office-glass.md`):
// every word and icon on a glass element, against the pixels under it with the word or icon taken away, in Light on Plain and in
// Light, Zen and Dark on White oak, with the desk's menu, the bell's panel and the mark's menu open in turn, and (release 6.10)
// the account menu open, on its own and with each of its sections open (the owner, with everything it can hold). It writes each
// screen with the ink hidden (`bare-*.png`, at 2x) and every word's and icon's box and colour (`inks.json`); `contrast.py` in the
// design draft reads them. Skipped unless OFFICE_GLASS_CONTRAST names the folder:
//   OFFICE_GLASS_CONTRAST=/abs/dir MA_PW_PORT=5181 npx playwright test --project=shell officeglass.contrast
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, openMenuSection, setTheme, signIn, type ThemeId } from './helpers';

const OUT = process.env['OFFICE_GLASS_CONTRAST'] ?? '';
test.skip(!OUT, 'OFFICE_GLASS_CONTRAST names the folder');
test.use({ deviceScaleFactor: 2 });
test.setTimeout(120_000);

const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const SCENES: { name: string; theme: ThemeId; style: string }[] = [
  { name: 'light-plain', theme: 'light', style: 'plain' },
  { name: 'light-oak', theme: 'light', style: 'white-oak' },
  { name: 'zen-oak', theme: 'dusk', style: 'white-oak' },
  { name: 'dark-oak', theme: 'dark', style: 'white-oak' },
];
const it = (desk: string, app: string, x: number, y: number) => ({ id: `${desk}:${app}`, app, x, y, w: 76, h: 76 });
const layout = (style: string) => ({
  desks: {
    [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 584, h: 236, style, items: ['browser', 'files', 'notebook', 'agent', 'documents'].map((a, k) => it(PERSONAL, a, 24 + 92 * k, 24)) },
    [WORK]: { id: WORK, x: 624, y: 36, w: 584, h: 236, style, items: ['browser', 'files', 'notebook'].map((a, k) => it(WORK, a, 24 + 92 * k, 24)) },
  },
  z: [PERSONAL, WORK],
});
const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

type Ink = { shot: string; what: string; kind: 'text' | 'icon'; color: string; x: number; y: number; w: number; h: number; large: boolean };

/** Every word and icon on a glass element now on screen, then hidden (the CSSOM, as the CSP allows), and the bare screen shot. */
async function measure(page: Page, shot: string, inks: Ink[]): Promise<void> {
  const found = await page.evaluate((s) => {
    const out: Ink[] = [];
    const hosts = [...document.querySelectorAll<HTMLElement>('.ma-glass, .mark-pop')].filter((e) => e.getClientRects().length > 0);
    const seen = new Set<Element>();
    // The account menu scrolls inside its plate, under its pinned header: only what shows whole in what it shows is measured.
    const menu = document.getElementById('account-panel');
    const head = menu?.querySelector('.menu-me');
    for (const host of hosts) {
      for (const el of [host, ...host.querySelectorAll<HTMLElement | SVGElement>('*')]) {
        if (seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
        if (menu && menu.contains(el)) {
          const m = menu.getBoundingClientRect();
          const top = head && !head.contains(el) ? head.getBoundingClientRect().bottom : m.top;
          if (r.top < top - 0.5 || r.bottom > m.bottom + 0.5) continue;
        }
        const name = `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().split(/\s+/).join('.')}`;
        if (el instanceof SVGSVGElement) {
          out.push({ shot: s, what: name, kind: 'icon', color: cs.color, x: r.x, y: r.y, w: r.width, h: r.height, large: false });
          continue;
        }
        if (el instanceof SVGElement) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
        if (!own) continue;
        // Words on a chip of their own (the bell's count, the scope's chosen segment) sit on that solid chip, not on the glass.
        // A ground with the glass's own layers over an opaque colour (the account menu's, inside its plate) is the glass.
        let chip = false;
        for (let p: Element | null = el; p && p !== host; p = p.parentElement) {
          const ps = getComputedStyle(p);
          const bg = ps.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
          if ((bg.length === 3 || (bg.length === 4 && bg[3] === 1)) && ps.backgroundImage === 'none') chip = true;
        }
        if (chip) continue;
        const size = parseFloat(cs.fontSize);
        const bold = Number(cs.fontWeight) >= 700;
        out.push({ shot: s, what: `${name}: ${(el.textContent ?? '').trim().slice(0, 40)}`, kind: 'text', color: cs.color, x: r.x, y: r.y, w: r.width, h: r.height, large: size >= 24 || (bold && size >= 18.66) });
      }
    }
    for (const host of hosts) {
      for (const el of [host, ...host.querySelectorAll<HTMLElement | SVGElement>('*')]) {
        el.style.setProperty('color', 'transparent', 'important');
        el.style.setProperty('text-shadow', 'none', 'important');
        if (el instanceof SVGSVGElement) el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    return out;
  }, shot);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/bare-${shot}.png` });
  inks.push(...found);
  // Put the ink back for the next view.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement | SVGElement>('.ma-glass, .ma-glass *, .mark-pop, .mark-pop *')) {
      el.style.removeProperty('color');
      el.style.removeProperty('text-shadow');
      el.style.removeProperty('visibility');
    }
  });
}

for (const scene of SCENES) {
  test(`contrast on the glass: ${scene.name}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
    await page.addInitScript((d) => {
      if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', d);
    }, JSON.stringify(layout(scene.style)));
    await setTheme(page, scene.theme);
    await harness(page.request, { reset: true });
    await harness(page.request, {
      fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }],
      notifications: { items: [
        { id: 'n1', type: 'forum.reply', title: 'Ada replied in Quiet mornings', body: 'Same here.', link: '/forums/t/q', actor: { name: 'Ada' }, createdAt: at(4), updatedAt: at(4) },
        { id: 'n2', type: 'desk.ready', title: 'Your Work desk is ready', link: '/', createdAt: at(50), updatedAt: at(50), readAt: at(40) },
      ] },
    });
    await signIn(page, '/?speed=fast&versionEveryMs=300');
    await canvasPainted(page);
    await harness(page.request, { releaseVersion: '2099.01.01-0000000' });
    await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    const inks: Ink[] = [];
    // The bars, the notice and a desk's menu.
    const work = (await page.getByRole('button', { name: /^Work desk,/ }).boundingBox())!;
    await page.mouse.click(work.x + work.width * 0.6, work.y + work.height * 0.7, { button: 'right' });
    await expect(page.locator('.menu.desk-menu')).toBeVisible();
    await page.mouse.move(2, 400);
    await measure(page, `${scene.name}-menu`, inks);
    await page.keyboard.press('Escape');
    // The bell's panel.
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.locator('.bell-panel').getByText('Ada replied in Quiet mornings')).toBeVisible();
    await page.mouse.move(2, 400);
    await measure(page, `${scene.name}-bell`, inks);
    await page.keyboard.press('Escape');
    // The mark's menu.
    await page.locator('.home-mark-btn').evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('#mark-menu')).toBeVisible();
    await page.waitForTimeout(400);
    await page.mouse.move(640, 700);
    await measure(page, `${scene.name}-mark`, inks);
    writeFileSync(`${OUT}/inks-${scene.name}.json`, JSON.stringify(inks, null, 1));
  });

  // The account menu and its button (release 6.10): the owner with everything the menu can hold (About this desk, Maia's row,
  // the shared sign-in's line, a card that expires soon), its first view, then each section open in turn.
  test(`contrast on the glass: ${scene.name}, the account menu`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route(/^https:\/\/id\.localhost\//, (route) => {
      const req = route.request();
      const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (new URL(req.url()).pathname === '/v1/sso/session') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"shared":true}' });
      return route.fulfill({ status: 204, headers: cors });
    });
    await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
    await page.addInitScript((d) => {
      if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', d);
    }, JSON.stringify(layout(scene.style)));
    await setTheme(page, scene.theme);
    await harness(page.request, { reset: true });
    await harness(page.request, {
      fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }],
      roles: ['owner'],
      configExtra: { maiaMode: { enabled: false, listed: true } },
      meMaiaMode: { enabled: true },
      sso: { origin: 'https://id.localhost' },
      age: 'adult',
      membership: { status: 'active', tier: 'officer', badge: 'officer', ageBand: 'adult', adultFrom: null, parent: null, cardExpiresSoon: { month: 11, year: 2099, last4: '4242' } },
    });
    await signIn(page, '/?speed=fast');
    await canvasPainted(page);
    // Maia's gate is open, so the first load asks how the office opens: Esc answers it with the default.
    await page.waitForFunction(() => performance.getEntriesByName('ma:office-ready').length > 0);
    if (await page.getByRole('group', { name: 'Open your office in' }).count()) {
      await page.keyboard.press('Escape');
      await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    }
    await page.waitForTimeout(1500);
    const inks: Ink[] = [];
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await expect(page.locator('#account-panel')).toBeVisible();
    await page.mouse.move(2, 400);
    await page.waitForTimeout(400);
    await measure(page, `${scene.name}-acct`, inks);
    const opened: Record<string, string> = { 'menu-appearance': 'theme-tune', 'menu-maia': 'menu-maia-mode', 'about-toggle': 'about-desk' };
    for (const [row, shows] of Object.entries(opened)) {
      await openMenuSection(page, row as Parameters<typeof openMenuSection>[1]);
      await expect(page.getByTestId(shows).first()).toBeVisible();
      await page.mouse.move(2, 400);
      await page.waitForTimeout(700); // the scroll into view glides
      await measure(page, `${scene.name}-acct-${row}`, inks);
    }
    writeFileSync(`${OUT}/inks-${scene.name}-acct.json`, JSON.stringify(inks, null, 1));
  });
}
