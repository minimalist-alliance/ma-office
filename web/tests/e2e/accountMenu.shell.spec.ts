// The account menu's shape (`chrome/AccountPanel.tsx`; the owner, Nov 16: "Vertically, that menu should never extend more than
// 60% of the page. Configs and options should be tucked in expansions or modals."). Never taller than 60 % of the viewport and
// its first view whole without scrolling, at 1440x900, 1024x768, 390x844 and 640x360 (short-viewport mode: two columns), in
// Light, Zen and Dark, for a member and for the owner with everything the menu can hold; each tucked section a disclosure
// (aria-expanded, aria-controls, a group named by its row), one open at a time, still within 60 %; Keyboard shortcuts a modal
// over the menu (focus in, Tab kept in, Esc closes it and only it, focus back on its row, a second Esc closes the menu); axe
// on the first view, each open section and the modal. Since release 6.8's brand review (the coordinator's calls, Nov 16): with
// each section open, at each size and theme, the member's header is whole (pinned at the top, nothing over it) and nothing at
// the top is cut mid-line; a section scrolls the menu only as far as it needs, at once under reduced motion. Since release
// 6.11 (the owner, Nov 16, on 6.10's split button: "This is weird and unnecessary. Just let me sign out"), Sign out is one
// plain row at the foot, past the divider, drawn as Account settings is, in glass and under reduced transparency, with no
// Sign out everywhere (the account's own, in Account settings) and no line under it; axe on the foot at every size. Stills:
// `accountMenu.shots.shell.spec.ts`.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'short', width: 640, height: 360 },
] as const;
/**
 * Everything the menu can hold at once: the owner (About this desk), Maia's gate open (her row), the age rules on (Report a
 * safety concern), the shared sign-in (since 6.11 Sign out has no line for it), and a card that expires soon (the header's
 * fourth line).
 */
const RICH = {
  roles: ['owner'],
  configExtra: { maiaMode: { enabled: false, listed: true } },
  meMaiaMode: { enabled: true },
  sso: { origin: 'https://id.localhost' },
  age: 'adult',
  // `age` gives the membership too; this one keeps its adult band (or the age rules would close Maia's gate) and adds the card.
  membership: { status: 'active', tier: 'officer', badge: 'officer', ageBand: 'adult', adultFrom: null, parent: null, cardExpiresSoon: { month: 11, year: 2099, last4: '4242' } },
};
const CONFIGS = [
  { name: 'a member', patch: {} },
  { name: 'the owner, with everything', patch: RICH },
] as const;

const panel = (page: Page) => page.locator('#account-panel');

/** The shared sign-in's origin (`sso` in RICH) is a stand-in nobody serves here: answer it as `sso.shell.spec.ts` does. */
async function standInSso(page: Page): Promise<void> {
  await page.route(/^https:\/\/id\.localhost\//, (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (new URL(req.url()).pathname === '/v1/sso/session') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"shared":true}' });
    return route.fulfill({ status: 204, headers: cors });
  });
}

/**
 * With Maia's gate open, the first load asks once how the office opens (`maiamode/chooser.ts`), over an inert office: Esc
 * answers it with the default, as `maiaMode.shell.spec.ts` does. Nothing to answer for anyone else.
 */
async function answerChooser(page: Page): Promise<void> {
  const ask = page.getByRole('group', { name: 'Open your office in' });
  await page.waitForFunction(() => performance.getEntriesByName('ma:office-ready').length > 0);
  if (!(await ask.count())) return;
  await page.keyboard.press('Escape');
  await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('#ma-root')).not.toHaveAttribute('inert', '');
}

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(150); // the popovers chunk's fonts and the avatar settle
}

interface Box { height: number; top: number; bottom: number; vh: number; scrolls: boolean; wide: boolean }
const measure = (page: Page): Promise<Box> =>
  panel(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { height: r.height, top: r.top, bottom: r.bottom, vh: window.innerHeight, scrolls: el.scrollHeight > el.clientHeight + 1, wide: el.scrollWidth > el.clientWidth + 1 };
  });

async function axe(page: Page, sel: string): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE);
  return page.evaluate(async (s) => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document.querySelector(s), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, sel);
}

/**
 * After a section opens: the menu's glide over and what loads into it (the sliders' engine, the background, Maia's rows) in,
 * so the scroll and the panel have both kept still for 12 frames, 2.5 s at most.
 */
const settle = (page: Page): Promise<void> =>
  panel(page).evaluate(
    (el) =>
      new Promise<void>((done) => {
        const t0 = performance.now();
        let last = '';
        let still = 0;
        const tick = (): void => {
          const now = `${el.scrollTop}/${el.scrollHeight}`;
          still = now === last ? still + 1 : 0;
          last = now;
          if ((still >= 12 && performance.now() - t0 > 200) || performance.now() - t0 > 2500) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

interface Top { head: string | null; cut: string[]; scrollTop: number; need: number; hidden: number }
/**
 * The top of the menu as a member sees it. `head`: what's wrong with the member's header, if anything (it must sit wholly
 * inside the menu with its top on the menu's, and be what's drawn at its avatar and its name: nothing over it). `cut`: every
 * line the top edge cuts through, where a line is a control or an element with nothing inside it, and the top edge is the
 * pinned header's foot over its own column, else the menu's own edge. `need`: how far the open section's foot was past the
 * menu's padding at its foot before any scroll (0 or less: it fitted); `hidden`, how much of it is past the menu's edge now.
 */
const top = (page: Page, controls: string): Promise<Top> =>
  panel(page).evaluate((menu, id) => {
    const box = menu.getBoundingClientRect();
    const inner = box.top + menu.clientTop;
    const head = menu.querySelector<HTMLElement>('.menu-me');
    let headWrong: string | null = null;
    const h = head?.getBoundingClientRect();
    if (head && h) {
      if (Math.abs(h.top - inner) > 0.5) headWrong = `header top ${h.top} not the menu's ${inner}`;
      else if (h.bottom > box.bottom) headWrong = `header foot ${h.bottom} past the menu's ${box.bottom}`;
      for (const sel of ['.avatar', '.menu-who']) {
        const r = head.querySelector(sel)!.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!at || !head.contains(at)) headWrong ??= `${sel} covered by ${at?.outerHTML.slice(0, 60)}`;
      }
    }
    const LINE = 'button, a, input, select, textarea, [role="radiogroup"], [role="switch"], [role="slider"]';
    const cut: string[] = [];
    const walk = (el: Element): void => {
      for (const c of el.children) {
        if (c === head || !(c instanceof HTMLElement)) continue;
        if (!(c.matches(LINE) || c.childElementCount === 0)) {
          walk(c);
          continue;
        }
        const r = c.getBoundingClientRect();
        if (r.height < 2) continue;
        const over = h && r.left < h.right - 0.5 && r.right > h.left + 0.5;
        const clip = over ? h.bottom : inner;
        if (r.top < clip - 0.5 && r.bottom > clip + 0.5) cut.push(`${c.tagName.toLowerCase()}.${c.className} "${(c.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.top)}..${Math.round(r.bottom)} at ${Math.round(clip)}`);
      }
    };
    walk(menu);
    const foot = inner + menu.clientHeight - parseFloat(getComputedStyle(menu).paddingBottom);
    const p = document.getElementById(id)!.getBoundingClientRect();
    return { head: headWrong, cut, scrollTop: menu.scrollTop, need: p.bottom + menu.scrollTop - foot, hidden: p.bottom - (inner + menu.clientHeight) };
  }, controls);

/** The menu's tucked sections' rows, as there are for this member: Appearance always, Maia and About. */
async function rows(page: Page): Promise<string[]> {
  const ids = ['menu-appearance', 'menu-maia', 'about-toggle'];
  const there: string[] = [];
  for (const id of ids) if (await page.getByTestId(id).count()) there.push(id);
  return there;
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const size of SIZES) {
  for (const theme of THEMES) {
    for (const config of CONFIGS) {
      test(`${size.name} ${size.width}x${size.height}, ${theme}, ${config.name}: never over 60 %, the first view whole`, async ({ page, request }) => {
        const errors = watchConsole(page);
        await harness(request, config.patch);
        await standInSso(page);
        await setTheme(page, theme);
        await page.setViewportSize({ width: size.width, height: size.height });
        await signIn(page, '/?fixture=three');
        await canvasPainted(page);
        await answerChooser(page);
        await openMenu(page);
        const first = await measure(page);
        expect(first.height, JSON.stringify(first)).toBeLessThanOrEqual(first.vh * 0.6 + 0.5);
        expect(first.bottom, JSON.stringify(first)).toBeLessThanOrEqual(first.vh);
        expect(first.wide, JSON.stringify(first)).toBe(false);
        // Designed to fit: nothing in the first view scrolls, the richest menu at the smallest size included.
        expect(first.scrolls, JSON.stringify(first)).toBe(false);
        // The first view: the member, the theme, the rows, Account settings, Sign out. Nothing tucked is drawn.
        await expect(panel(page).getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
        await expect(panel(page).getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
        await expect(panel(page).getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
        for (const hidden of ['theme-tune', 'background-picker', 'shortcuts', 'menu-maia-mode', 'about-desk']) await expect(page.getByTestId(hidden)).toHaveCount(0);

        // Each section, one at a time: still within 60 %, its row in view, the others shut; the header whole and nothing at the
        // top cut mid-line; scrolled only if it didn't fit.
        const there = await rows(page);
        expect(there.length).toBe(config.name === 'a member' ? 1 : 3);
        for (const id of there) {
          const row = page.getByTestId(id);
          await row.click();
          await expect(row).toHaveAttribute('aria-expanded', 'true');
          const controls = await row.getAttribute('aria-controls');
          await expect(page.locator(`#${controls}`)).toBeVisible();
          await expect(page.locator(`#${controls}`)).toHaveAttribute('role', 'group');
          for (const other of there.filter((o) => o !== id)) await expect(page.getByTestId(other)).toHaveAttribute('aria-expanded', 'false');
          await settle(page);
          const open = await measure(page);
          expect(open.height, `${id} ${JSON.stringify(open)}`).toBeLessThanOrEqual(open.vh * 0.6 + 0.5);
          expect(open.wide, `${id} ${JSON.stringify(open)}`).toBe(false);
          await expect(row).toBeInViewport();
          const t = await top(page, controls!);
          expect(t.head, `${id}: the header`).toBeNull();
          expect(t.cut, `${id}: cut at the top`).toEqual([]);
          // Scrolled only if it didn't fit; and then into view, unless all of it already shows (in the menu's foot padding,
          // where landing on whole lines can leave it rather than hide a line under the header).
          if (t.need <= 0.5) expect(t.scrollTop, `${id}: it fitted, so no scroll`).toBe(0);
          else if (t.scrollTop === 0) expect(t.hidden, `${id}: not scrolled, so all of it shows ${JSON.stringify(t)}`).toBeLessThanOrEqual(0.5);
          await row.click();
          await expect(row).toHaveAttribute('aria-expanded', 'false');
          await expect(page.locator(`#${controls}`)).toHaveCount(0);
        }
        // The modal: the whole list in a dialog over the menu, which keeps its shape under it.
        await panel(page).getByRole('button', { name: 'Keyboard shortcuts' }).click();
        const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
        await expect(dialog).toBeVisible();
        const d = await dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight };
        });
        expect(d.top).toBeGreaterThanOrEqual(0);
        expect(d.bottom).toBeLessThanOrEqual(d.vh);
        expect(d.left).toBeGreaterThanOrEqual(0);
        expect(d.right).toBeLessThanOrEqual(d.vw);
        expect((await measure(page)).height).toBeLessThanOrEqual(d.vh * 0.6 + 0.5);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(panel(page)).toBeVisible();
        expect(errors).toEqual([]);
      });
    }
  }
}

for (const size of [SIZES[0], SIZES[2]]) {
  for (const theme of THEMES) {
    test(`axe, ${size.name}, ${theme}: the first view, each open section and the shortcuts modal`, async ({ page, request }) => {
      await harness(request, RICH);
      await standInSso(page);
      await setTheme(page, theme);
      await page.setViewportSize({ width: size.width, height: size.height });
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await answerChooser(page);
      await openMenu(page);
      expect(await axe(page, '#account-panel'), 'first view').toEqual([]);
      for (const id of await rows(page)) {
        await page.getByTestId(id).click();
        await page.waitForTimeout(200); // Appearance's chunks (the sliders' engine, the background) arrive
        expect(await axe(page, '#account-panel'), id).toEqual([]);
        await page.getByTestId(id).click();
      }
      await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      expect(await axe(page, '[data-testid="shortcuts-dialog"]'), 'shortcuts').toEqual([]);
    });
  }
}

test('by keyboard: a section opens and shuts with Enter and Space, Esc closes the menu, focus back on Account', async ({ page }) => {
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await account.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  const appearance = page.getByTestId('menu-appearance');
  await appearance.focus();
  await page.keyboard.press('Enter');
  await expect(appearance).toHaveAttribute('aria-expanded', 'true');
  // Into the section: the sliders and the background are the next Tab stops after the row.
  await page.keyboard.press('Tab');
  await expect(page.locator('#menu-appearance')).toContainText('Blue');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#menu-appearance'))).toBe(true);
  await appearance.focus();
  await page.keyboard.press('Space');
  await expect(appearance).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(account).toBeFocused();
});

test('Keyboard shortcuts is a modal over the menu: focus in, Tab kept in, Esc closes it alone, then the menu', async ({ page }) => {
  // The install offer stands in as Chromium's would be kept, so the modal has two controls to go between.
  await page.addInitScript(() => {
    (window as unknown as { __maInstallPrompt: unknown }).__maInstallPrompt = { prompt: () => Promise.resolve() };
  });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await account.click();
  const row = panel(page).getByRole('button', { name: 'Keyboard shortcuts' });
  await expect(row).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog).toBeFocused();
  expect(await dialog.evaluate((el) => (el as HTMLDialogElement).matches(':modal'))).toBe(true);
  await expect(dialog.getByTestId('shortcuts')).toContainText('These work while your desks have focus');
  await expect(dialog.getByTestId('install-office')).toBeVisible();
  // Tab and Shift+Tab go round the modal's own controls and never leave it.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="shortcuts-dialog"]'))).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="shortcuts-dialog"]'))).toBe(true);
  }
  // A press on the menu under it does nothing: the page is inert under a modal.
  // Esc: the modal goes, the menu stays, the keyboard is back on the row.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  // The close button does the same.
  await row.click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  // A press on the backdrop too, and the menu stays open under it.
  await row.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, page.viewportSize()!.height - 5);
  await expect(dialog).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  // A second Esc closes the menu.
  await row.focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(account).toBeFocused();
});

test('one section at a time; the owner\'s About opens as he left it, the others start shut', async ({ page, request }) => {
  await harness(request, RICH);
  await standInSso(page);
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await answerChooser(page);
  await openMenu(page);
  const about = page.getByTestId('about-toggle');
  const appearance = page.getByTestId('menu-appearance');
  await about.click();
  await expect(about).toHaveAttribute('aria-expanded', 'true');
  await appearance.click();
  await expect(appearance).toHaveAttribute('aria-expanded', 'true');
  await expect(about).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await openMenu(page);
  // About was last opened by him and never shut by him: it opens again; Appearance doesn't.
  await expect(about).toHaveAttribute('aria-expanded', 'true');
  await expect(appearance).toHaveAttribute('aria-expanded', 'false');
  const box = await measure(page);
  expect(box.height).toBeLessThanOrEqual(box.vh * 0.6 + 0.5);
  // Maia's row says whether she's on before it's opened, and holds her switch.
  const maia = page.getByTestId('menu-maia');
  await expect(maia).toContainText('Off');
  await maia.click();
  await expect(page.getByRole('switch', { name: /^Maia on my desks/ })).toBeVisible();
});

/** Sign out's row and Account settings' row, as drawn: what makes a row look like one. */
const rowLooks = (page: Page) =>
  page.locator('#account-panel').evaluate((menu) => {
    const out = menu.querySelector<HTMLElement>('[data-testid="menu-sign-out"]')!;
    const settings = menu.querySelector<HTMLElement>('[data-testid="menu-account-settings"]')!;
    const look = (el: HTMLElement) => {
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { cls: el.className, height: r.height, left: Math.round(r.left), width: Math.round(r.width), font: `${c.fontSize} ${c.fontWeight} ${c.fontFamily}`, color: c.color, bg: c.backgroundColor, border: `${c.borderTopWidth} ${c.borderTopStyle}`, radius: c.borderTopLeftRadius, padding: `${c.paddingLeft} ${c.paddingRight}`, align: c.textAlign, svg: el.querySelectorAll('svg').length };
    };
    const prev = out.previousElementSibling as HTMLElement | null;
    return { out: look(out), settings: look(settings), afterDivider: !!prev?.classList.contains('menu-sep'), last: out.parentElement!.lastElementChild === out || !out.nextElementSibling?.matches('button, a, [role]') };
  });

for (const theme of THEMES) {
  for (const fallback of [false, true]) {
    test(`${theme}${fallback ? ', reduced transparency' : ''}: Sign out is one plain row at the foot, past the divider, drawn as Account settings is`, async ({ page, request }) => {
      const errors = watchConsole(page);
      if (fallback) await (await page.context().newCDPSession(page)).send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      await harness(request, RICH);
      await standInSso(page);
      await setTheme(page, theme);
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await answerChooser(page);
      await openMenu(page);
      const signOut = panel(page).getByRole('button', { name: 'Sign out', exact: true });
      // An action, never a disclosure: nothing of one about it, and nothing beside it or under it.
      for (const attr of ['aria-expanded', 'aria-controls', 'aria-haspopup', 'aria-describedby']) expect(await signOut.getAttribute(attr), attr).toBeNull();
      await expect(panel(page).getByRole('button', { name: 'More ways to sign out' })).toHaveCount(0);
      await expect(panel(page).getByText(/everywhere|Signs you out of/i)).toHaveCount(0);
      const r = await rowLooks(page);
      expect(r.afterDivider).toBe(true);
      expect(r.last).toBe(true);
      expect(r.out.svg).toBe(0);
      // The row's look is Account settings' look: class, height, width, type, ink, ground, edge, corner and padding.
      expect(r.out).toEqual({ ...r.settings, svg: 0 });
      // The hover is a row's hover, as Account settings' (the glass's wash, or under the fallback the sunken grey).
      await signOut.hover();
      await page.waitForTimeout(150);
      const hovered = await signOut.evaluate((el) => getComputedStyle(el).backgroundColor);
      await panel(page).getByTestId('menu-account-settings').hover();
      await page.waitForTimeout(150);
      expect(hovered).toBe(await panel(page).getByTestId('menu-account-settings').evaluate((el) => getComputedStyle(el).backgroundColor));
      // By keyboard: the last stop in the menu, after Account settings and Report a safety concern.
      await panel(page).getByRole('link', { name: 'Report a safety concern' }).focus();
      await page.keyboard.press('Tab');
      await expect(signOut).toBeFocused();
      // One press: no confirm, nothing opened, signed out.
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
      expect(errors).toEqual([]);
    });
  }
}

test('with a finger Sign out is 44 px, as the rows above it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await openMenu(page);
  const r = await rowLooks(page);
  expect(r.out.height).toBe(44);
  expect(r.out.height).toBe(r.settings.height);
  await context.close();
});

for (const size of SIZES) {
  for (const theme of THEMES) {
    test(`axe on the menu's foot, ${size.name}, ${theme}: at rest and with the keyboard on Sign out`, async ({ page, request }) => {
      await harness(request, RICH);
      await standInSso(page);
      await setTheme(page, theme);
      await page.setViewportSize({ width: size.width, height: size.height });
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await answerChooser(page);
      await openMenu(page);
      expect(await axe(page, '.acct-account'), 'at rest').toEqual([]);
      const signOut = page.getByTestId('menu-sign-out');
      await signOut.focus();
      await expect(signOut).toBeInViewport();
      expect(await axe(page, '#account-panel'), 'the menu, the keyboard on Sign out').toEqual([]);
    });
  }
}

test('under reduced motion a section scrolls the menu into view at once; the header stays whole', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await harness(request, RICH);
  await standInSso(page);
  await page.setViewportSize({ width: 640, height: 360 });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await answerChooser(page);
  await openMenu(page);
  // About this desk runs past the short screen's foot: the right column scrolls, in the same frame as the press.
  const about = page.getByTestId('about-toggle');
  if ((await about.getAttribute('aria-expanded')) === 'true') await about.click(); // the owner's About opens as he last left it
  const controls = (await about.getAttribute('aria-controls'))!;
  const now = await about.evaluate(
    (btn) =>
      new Promise<number>((done) => {
        (btn as HTMLButtonElement).click();
        requestAnimationFrame(() => done(btn.closest('.menu')!.scrollTop));
      }),
  );
  expect(now).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const t = await top(page, controls);
  expect(t.scrollTop).toBe(now);
  expect(t.head).toBeNull();
  expect(t.cut).toEqual([]);
  // The left column, the header with it, didn't move: only the column with the open section scrolls.
  // From the plate's top on glass (release 6.10), which has the edge; the menu inside it has the padding.
  const left = await page.locator('.acct-left').evaluate((el) => el.getBoundingClientRect().top - (el.closest('.account-glass') ?? el.closest('.menu'))!.getBoundingClientRect().top);
  expect(left).toBeCloseTo(8 + 1, 0); // its padding and its edge
});
