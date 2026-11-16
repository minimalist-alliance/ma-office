// Stills of the office's glass under the theme sliders (release 6.11, `theme/tune/glass.ts`), for the brand review: the office
// with the account menu open and a row of app tiles in sight, at the five settings (Blue/Contrast 0/0, 0/100, 100/0, 100/100 and
// the default 100/50) in Light, Zen and Dark, at 1x on a desktop, on the mock desk. With each, every word and icon on a glass
// element measured on the rendered surface as `officeglass.contrast.shell.spec.ts` does it (the ink hidden, `bare-*.png`, and
// `inks-*.json` with each box and colour), for `glass-contrast.py` beside the shots. Skipped unless GLASS_SLIDER_SHOTS names a
// folder:
//   GLASS_SLIDER_SHOTS=/abs/dir MA_PW_PORT=4731 npx playwright test --project=shell themeSliders.glass.shots
// `GLASS_SLIDER_ONLY=default` takes the default setting alone (for the pixel proof against another bundle).
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const OUT = process.env['GLASS_SLIDER_SHOTS'] ?? '';
const ONLY = (process.env['GLASS_SLIDER_ONLY'] ?? '').split(',').filter(Boolean);
test.skip(!OUT, 'GLASS_SLIDER_SHOTS names the folder');
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
test.setTimeout(90_000);

const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const THEMES: [ThemeId, string][] = [['light', 'light'], ['dusk', 'zen'], ['dark', 'dark']];
const SETTINGS = [
  { name: 'default', blue: 100, contrast: 50 },
  { name: 'b0-c0', blue: 0, contrast: 0 },
  { name: 'b0-c100', blue: 0, contrast: 100 },
  { name: 'b100-c0', blue: 100, contrast: 0 },
  { name: 'b100-c100', blue: 100, contrast: 100 },
].filter((s) => !ONLY.length || ONLY.includes(s.name));
const it = (desk: string, app: string, x: number, y: number) => ({ id: `${desk}:${app}`, app, x, y, w: 76, h: 76 });
const LAYOUT = {
  desks: {
    [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 584, h: 236, style: 'white-oak', items: ['browser', 'files', 'notebook', 'agent', 'todo'].map((a, k) => it(PERSONAL, a, 24 + 92 * k, 24)) },
    [WORK]: { id: WORK, x: 0, y: 296, w: 584, h: 236, style: 'plain', items: ['browser', 'files', 'notebook'].map((a, k) => it(WORK, a, 24 + 92 * k, 24)) },
  },
  z: [PERSONAL, WORK],
};

type Ink = { shot: string; what: string; kind: 'text' | 'icon'; color: string; x: number; y: number; w: number; h: number; large: boolean };

/** Every word and icon on a glass element on screen, then hidden, and the bare screen (officeglass.contrast's way, at 1x). */
async function measure(page: Page, shot: string): Promise<Ink[]> {
  const found = await page.evaluate((s) => {
    const out: Ink[] = [];
    const hosts = [...document.querySelectorAll<HTMLElement>('.ma-glass, .mark-pop')].filter((e) => e.getClientRects().length > 0);
    const seen = new Set<Element>();
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
  await page.screenshot({ path: `${OUT}/contrast/bare-${shot}.png` });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement | SVGElement>('.ma-glass, .ma-glass *, .mark-pop, .mark-pop *')) {
      el.style.removeProperty('color');
      el.style.removeProperty('text-shadow');
      el.style.removeProperty('visibility');
    }
  });
  return found;
}

/** The ease (200 ms), the rest and the tiles' one raster, then the glass's backdrops in idle time: nothing changes for 1.5 s. */
async function quiet(page: Page): Promise<void> {
  let n = '';
  await expect.poll(async () => {
    const was = n;
    n = await page.evaluate(() => {
      const h = (window as unknown as { __maDesk: { tileRasters?(): number; glassLensStats(): { count: number } } }).__maDesk;
      return `${h.tileRasters?.() ?? 0}/${h.glassLensStats().count}/${document.documentElement.style.cssText.length}`;
    });
    return n === was;
  }, { intervals: [500, 500, 500] }).toBe(true);
}

for (const [theme, label] of THEMES) {
  for (const setting of SETTINGS) {
    test(`${label}, ${setting.name}`, async ({ page }) => {
      mkdirSync(`${OUT}/contrast`, { recursive: true });
      await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
      await page.addInitScript((d) => {
        if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v2', d);
      }, JSON.stringify(LAYOUT));
      await setTheme(page, theme);
      await harness(page.request, { reset: true });
      await harness(page.request, {
        fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }],
        files: { enabled: true },
        // Platform's setting for the member (the harness's `appearance.mjs`): the default sends none, as for anyone who never moved them.
        ...(setting.name === 'default' ? {} : { appearanceDocs: { [ME]: { blue: setting.blue, contrast: setting.contrast, updatedAt: '2026-11-16T12:00:00Z' } } }),
      });
      await signIn(page, '/?widgets=none');
      await canvasPainted(page);
      if (setting.name !== 'default') await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ma-glass-body-dense'))).toMatch(/^radial-gradient/);
      await page.mouse.move(1000, 890);
      const shot = `${label}-${setting.name}`;
      // The menu shut first: the office alone, the shot that's compared pixel for pixel with another bundle's at the default
      // (6.11 changed the menu's foot, so only the office is the same).
      await quiet(page);
      await page.screenshot({ path: `${OUT}/${shot}-closed.png` });
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await expect(page.locator('#account-panel')).toBeVisible();
      await page.mouse.move(1000, 890);
      await quiet(page);
      await page.screenshot({ path: `${OUT}/${shot}.png` });
      const inks = await measure(page, shot);
      writeFileSync(`${OUT}/contrast/inks-${shot}.json`, JSON.stringify(inks, null, 1));
    });
  }
}
