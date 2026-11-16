// Maia Mode's room (CONCEPT.md Part 1 "What you see", Part 2 §2; `src/maiamode/`), on the mock desk and the harness, with Desk
// Maia stood in for by `maiamode/mockSource.ts` (`window.__maMaiaModeMock`): dark by default; turning it on through the
// disclosure; the room in A2 (Maia over the chat, the To-do column, "Show my desks"); leaving gives the office back as it was;
// the column's collapse, remembered on another device; her choices by pointer, keyboard and screen reader; the viewport with a
// desk's real app; the startup chooser; a phone; Light, Zen and Dark with axe and no warm or green tint. One worker, as every
// shell spec. Shots in $MAIA_MODE_SHOTS (skipped without it).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId, openMenuSection } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['MAIA_MODE_SHOTS'] ?? '';
// Phase 1's gate (ma-platform desks.md "Maia Mode"): client-config says the access list is on, `/v1/me` lists this member.
const ON = { configExtra: { maiaMode: { enabled: false, listed: true } }, meMaiaMode: { enabled: true } };
const PATH = '/?fixture=three';

interface Mock {
  log: { method: string; args: unknown[] }[];
}

async function axe(page: Page, include = 'body'): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document.querySelector(sel), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700); // the room's 600 ms
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const room = (page: Page): Locator => page.locator('.mm-room[data-ready]');
/** The office's own top bar: hidden with the desks while the room is up. */
const office = (page: Page): Locator => page.locator('.ma-shell > header.topbar');
/** Every call the room made to the stand-in; none before the room has made its source (the disclosure alone makes none). */
const mockLog = (page: Page): Promise<{ method: string; args: unknown[] }[]> => page.evaluate(() => (window as unknown as { __maMaiaModeMock?: Mock }).__maMaiaModeMock?.log ?? []);
const steer = (page: Page, call: string, ...args: unknown[]): Promise<void> =>
  page.evaluate(([c, a]) => (window as unknown as Record<string, Record<string, (...x: unknown[]) => void>>)['__maMaiaModeMock']![c as string]!(...(a as unknown[])), [call, args] as const);

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  // Her rows are under the menu's "Maia" since the owner's Nov 16 tidy, there only for a member her gate allows.
  if (await page.getByTestId('menu-maia').count()) await openMenuSection(page, 'menu-maia');
}

/** Through the account menu's switch and the disclosure, into the room. */
async function turnOn(page: Page): Promise<void> {
  await openMenu(page);
  await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'I’ve read this' }).check();
  await dialog.getByRole('button', { name: 'Turn on Maia' }).click();
  await expect(room(page)).toBeVisible();
  await expect(page.locator('.mm-layer.in')).toBeVisible({ timeout: 3000 });
}

/**
 * The first load after Maia Mode was allowed asks a member who never turned it on, once: the chooser's question without
 * "Ask every time". Esc answers it with the default, Desk Mode, and it's never asked again.
 */
async function answerFirstQuestion(page: Page, shotName = ''): Promise<void> {
  await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
  if (shotName) await shot(page, shotName);
  await page.keyboard.press('Escape');
  await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('#ma-root')).not.toHaveAttribute('inert', '');
}

/** The overlay has ended: whatever the startup chunk decided (it holds the office's ready until it has) is on the page. */
const officeReady = (page: Page): Promise<unknown> => page.waitForFunction(() => performance.getEntriesByName('ma:office-ready').length > 0);

async function arrive(page: Page, request: APIRequestContext, extra: Record<string, unknown> = {}, path = PATH, firstShot = ''): Promise<string[]> {
  await harness(request, { reset: true });
  await harness(request, { ...ON, ...extra });
  const errors = watchConsole(page);
  await signIn(page, path);
  await canvasPainted(page);
  if ((extra['meMaiaMode'] as { enabled?: boolean } | undefined)?.enabled !== false) await answerFirstQuestion(page, firstShot);
  return errors;
}

/** The desks the mock uses: the office's own list, Work first where there is one. */
const workDesk = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const d = (window as unknown as { __maMaiaModeMock: { desks: () => { id: string; name: string }[] } }).__maMaiaModeMock.desks();
    return (d.find((x) => /work/i.test(x.name)) ?? d[0])?.id ?? '';
  });

test.describe('Maia Mode', () => {
  test('is dark by default: no switch, no shortcut, no chooser', async ({ page, request }) => {
    await harness(request, { reset: true });
    await signIn(page, PATH);
    await canvasPainted(page);
    await openMenu(page);
    await expect(page.getByRole('switch', { name: /^Maia on my desks/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Shift+M');
    await page.waitForTimeout(400);
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /\/(chunk|startup)-[\w-]+\.js$/.test(r.name)))).toBe(false);
  });

  test('only for a member `/v1/me` lists, and client-config’s switch off is off for all', async ({ page, request }) => {
    // The list is on, but not for this member: nothing of Maia Mode is fetched (release 4's B4).
    await arrive(page, request, { meMaiaMode: { enabled: false } });
    await openMenu(page);
    await expect(page.getByRole('switch', { name: /^Maia on my desks/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Shift+M');
    await page.waitForTimeout(400);
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /\/(chunk|startup|room)-[\w-]+\.(js|css)$/.test(r.name)))).toBe(false);
    // Listed: the first load after asks once, then on, then back on the desks, so the next load would ask.
    await harness(request, { meMaiaMode: { enabled: true } });
    await page.reload();
    await canvasPainted(page);
    await answerFirstQuestion(page);
    await turnOn(page);
    await page.getByRole('button', { name: /Show my desks/ }).click();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    // The switch off for all: no chooser, no switch, whatever this browser kept, and Maia turned off on the home desk.
    await harness(request, { configExtra: { maiaMode: { enabled: false, listed: false } } });
    await page.reload();
    await canvasPainted(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0);
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    await openMenu(page);
    await expect(page.getByRole('switch', { name: /^Maia on my desks/ })).toHaveCount(0);
    await expect.poll(() => mockLog(page).then((l) => l.some((c) => c.method === 'setOn' && c.args[0] === false))).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ma.maiaMode.v1') ?? '{}').prefs?.on)).toBe(false);
  });

  test('turns off from the menu, and deletes her history after asking', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await turnOn(page);
    await page.getByRole('button', { name: /Show my desks/ }).click();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    await openMenu(page);
    await page.getByRole('button', { name: 'Delete Maia’s desk history' }).click();
    const ask = page.getByRole('group', { name: /Delete your chats with Maia/ });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await axe(page, '.mm-menu')).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(ask).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete Maia’s desk history' })).toBeFocused();
    await page.getByRole('button', { name: 'Delete Maia’s desk history' }).click();
    await page.getByRole('button', { name: 'Delete history' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Maia’s desk history deleted.' })).toBeVisible();
    await expect.poll(() => mockLog(page).then((l) => l.filter((c) => c.method === 'forget').length)).toBe(1);
    // Off: the switch, the startup rows go, and the home desk hears it.
    await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
    await expect(page.getByRole('switch', { name: /^Maia on my desks/ })).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Ask at startup' })).toHaveCount(0);
    await expect.poll(() => mockLog(page).then((l) => l.some((c) => c.method === 'setOn' && c.args[0] === false))).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ma.maiaMode.v1') ?? '{}').prefs?.offPending)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('turns on through the disclosure, and leaving gives the office back exactly as it was', async ({ page, request }) => {
    const errors = await arrive(page, request);
    const before = await page.evaluate(() => ({ cam: { ...(window as unknown as { __maDesk: { camera: { cam: object } } }).__maDesk.camera.cam } }));
    // "Not now" and Esc change nothing, and the focus goes back.
    await openMenu(page);
    await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'What Maia sees' })).toBeVisible();
    expect(await axe(page, '.mm-discl')).toEqual([]);
    await shot(page, 'disclosure-light');
    // Not until the box is ticked: the button says so (it's `aria-disabled`, so a pointer press is a keyboard one here).
    await dialog.getByRole('button', { name: 'Turn on Maia' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toHaveText('Tick “I’ve read this” first.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(office(page)).toBeVisible();

    await turnOn(page);
    await expect(office(page)).toBeHidden();
    await expect(page.locator('.ma-shell > .desks-main canvas').first()).toBeHidden();
    await expect(page.getByRole('button', { name: /Show my desks/ })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'To-do' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review: Writer wants to submit a form on example.org' })).toBeVisible();
    await expect(page.locator('.mm-field canvas')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('log', { name: 'Conversation with Maia' })).toContainText('Got it, both noted.');
    // Her credits at the column's foot (the owner, Nov 15): what's left and a renewal date, where she's drawing from, and never
    // money or a countdown. (The briefs' line above them is the member's own keys, in dollars: the wallet's.)
    const credits = page.getByRole('complementary', { name: 'To-do' }).locator('.mm-credits');
    // The member's one wallet (contract 0.4.10), shared by Maia and their agents: what's left, its parts, and what's in use.
    await expect(credits).toContainText(/Credits: 1,760 left · renews [A-Z][a-z]+ \d{1,2}/);
    await expect(credits).toContainText('1,550 of this month’s 2,500 · 210 starting');
    await expect(credits).toContainText('Today’s share is used, so this week’s is in use.');
    expect(await credits.innerText()).not.toMatch(/\$|\bin \d|\d+\s*(h|min)\b/);
    expect(await axe(page, '.mm-room')).toEqual([]);
    expect((await mockLog(page)).some((l) => l.method === 'setOn' && l.args[0] === true)).toBe(true);
    await shot(page, 'room-light');

    await page.getByRole('button', { name: /Show my desks/ }).click();
    // The focus is back in the office, on the account menu's button the room was entered from (release 4's B2).
    await expect(office(page).locator('.account-btn')).toBeFocused();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    await expect(office(page)).toBeVisible();
    await expect(office(page).locator('.account-btn')).toBeFocused();
    const after = await page.evaluate(() => ({ cam: { ...(window as unknown as { __maDesk: { camera: { cam: object } } }).__maDesk.camera.cam } }));
    expect(after).toEqual(before);
    // Alt+Shift+M goes in and back out, and the focus comes back to the desk it left.
    const desk = page.locator('.ma-shell button[id^="proxy-"]').first();
    await desk.focus();
    await page.keyboard.press('Alt+Shift+M');
    await expect(room(page)).toBeVisible();
    await page.keyboard.press('Alt+Shift+M');
    await expect(desk).toBeFocused();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    await expect(desk).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('an open window is put back as it was, and Open on my desk opens the app there', async ({ page, request }) => {
    await arrive(page, request);
    // The Work desk's Notebook, open in its window on the desks before the room.
    await page.getByRole('group', { name: 'Work desk' }).getByRole('button', { name: 'Notebook', exact: true }).focus();
    await page.keyboard.press('Enter');
    const win = page.locator('.window-layer .ma-window[data-app="notebook"]');
    await expect(win).toHaveCount(1, { timeout: 5000 });
    await page.waitForTimeout(500); // its opening FLIP from the tile
    const rect = await win.boundingBox();
    await turnOn(page);
    const desk = await workDesk(page);
    expect(desk).toBeTruthy();
    // The viewport: the real app from a desk, live; To-do folds into pills, Now first.
    await page.getByRole('button', { name: 'Show me: Scout’s laptop comparison is ready' }).click();
    const vp = page.locator('.mm-vp');
    await expect(vp).toBeVisible();
    await expect(vp.locator('.ma-window[data-app="notebook"]')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'To-do' })).toHaveCount(0);
    const pills = page.getByRole('navigation', { name: 'To-do' });
    await expect(pills.getByRole('button').first()).toContainText('Now');
    expect(await axe(page, '.mm-room')).toEqual([]);
    await shot(page, 'viewport-light');
    // The office's own window of that app is put aside while the viewport holds it (an app never runs twice)...
    await expect(win).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(vp).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'To-do' })).toBeVisible();
    // ...and back as it was once it closes, where it was on the desks.
    await expect(win).toHaveCount(1);
    await page.getByRole('button', { name: /Show my desks/ }).click();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    await expect(win).toBeVisible();
    expect(await win.boundingBox()).toEqual(rect);
    await page.keyboard.press('Alt+Shift+M');
    await expect(room(page)).toBeVisible();
    // What she shows: a closed enum on a desk the office lists, never a URL.
    await steer(page, 'show', desk, 'https://example.org');
    await page.waitForTimeout(200);
    await expect(vp).toHaveCount(0);
    await steer(page, 'show', 'd-not-mine', 'notebook');
    await page.waitForTimeout(200);
    await expect(vp).toHaveCount(0);
    await steer(page, 'show', desk, 'notebook');
    await expect(vp).toContainText('Shown by Maia');
    await expect(vp.locator('.ma-window[data-app="notebook"]')).toBeVisible();
    await vp.getByRole('button', { name: 'Open on my desk' }).click();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('.window-layer .ma-window[data-app="notebook"]')).toBeVisible({ timeout: 5000 });
  });

  test('in an empty thread, a problem and its button show without scrolling (release 4’s B8)', async ({ page, request }) => {
    await arrive(page, request);
    await turnOn(page);
    await steer(page, 'clear');
    await expect(page.locator('.mm-log > *')).toHaveCount(0);
    await steer(page, 'problem', 'Your home desk is asleep.', 'Wake it');
    const line = page.locator('.mm-problem');
    await expect(line).toContainText('Your home desk is asleep.');
    await expect(line).toBeInViewport({ ratio: 1 });
    await expect(line.getByRole('button', { name: 'Wake it' })).toBeInViewport({ ratio: 1 });
    await line.getByRole('button', { name: 'Wake it' }).click();
    await expect(line).toHaveCount(0);
    expect((await mockLog(page)).at(-1)?.method).toBe('fix');
  });

  test('her choices: a tap, Other, or a reply of your own, by keyboard and screen reader', async ({ page, request }) => {
    await arrive(page, request);
    await turnOn(page);
    const group = page.getByRole('group', { name: 'Reply choices' });
    await expect(group.getByRole('button')).toHaveText(['Show me now', 'After the newsletter', 'Tomorrow', 'Other']);
    await expect(group.getByRole('button', { name: 'Show me now, her pick' })).toBeVisible();
    await expect(group).toHaveAccessibleDescription(/Want it now, or after the newsletter/);
    // Left and Right move along them.
    await group.getByRole('button').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('button', { name: 'After the newsletter' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.mm-me').last()).toHaveText('After the newsletter');
    await expect(group).toHaveCount(0);
    expect((await mockLog(page)).at(-1)?.method).toBe('choose');

    await steer(page, 'say', 'Which should Writer start with?', ['The Q3 deck', 'The newsletter', 'The vendor list']);
    await group.getByRole('button', { name: 'Other' }).click();
    const box = page.getByRole('textbox', { name: 'Your own answer…' });
    await expect(box).toBeFocused();
    await box.fill('Both, tonight');
    await page.keyboard.press('Enter');
    expect((await mockLog(page)).find((l) => l.method === 'send' && l.args[0] === 'Both, tonight')?.args[1]).toMatchObject({ as: 'other' });

    await steer(page, 'say', 'Shall I tell Scout?', ['Yes', 'No']);
    await page.getByRole('textbox', { name: 'Message Maia' }).fill('Never mind that');
    await page.keyboard.press('Enter');
    expect((await mockLog(page)).find((l) => l.method === 'send' && l.args[0] === 'Never mind that')?.args[1]).toMatchObject({ as: 'ignored' });
  });

  test('the To-do column collapses to an edge, and the choice follows the member to another device', async ({ page, request, browser }) => {
    // The harness's own desk list, so the layout document (and the prefs in it) goes to Platform, as for a member.
    await arrive(page, request, {}, '/');
    await turnOn(page);
    await page.getByRole('button', { name: 'Collapse To-do' }).click();
    const edge = page.getByRole('button', { name: 'To-do, 2 items, 1 now' });
    await expect(edge).toBeVisible();
    await expect(edge).toHaveAttribute('aria-expanded', 'false');
    await expect(edge.locator('.mm-now-dot')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'To-do' })).toHaveCount(0);
    expect(await axe(page, '.mm-room')).toEqual([]);
    await shot(page, 'collapsed-light');
    // A Now arriving gives the dot one pulse and never reopens the column.
    await steer(page, 'now', { title: 'Inbox needs your OK on Work' });
    await expect(page.getByRole('button', { name: 'To-do, 2 items, 1 now' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Now: Inbox needs your OK on Work' })).toHaveCount(1);
    // Alt+Shift+T opens and closes it.
    await page.keyboard.press('Alt+Shift+T');
    await expect(page.getByRole('complementary', { name: 'To-do' })).toBeVisible();
    await page.keyboard.press('Alt+Shift+T');
    await expect(edge).toBeVisible();
    await page.waitForTimeout(2600); // the layout document's save: 2 s after the last change

    // Another device: no copy in its browser, so the overlay asks once the document's prefs arrive.
    const other = await (browser as Browser).newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await other.newPage();
    await signIn(p2, '/');
    const chooser = p2.getByRole('group', { name: 'Open your office in' });
    await expect(chooser).toBeVisible({ timeout: 8000 });
    await p2.getByRole('button', { name: /^Maia\s*, last used$/ }).click();
    await expect(p2.getByRole('button', { name: /^To-do, \d items/ })).toBeVisible();
    await other.close();
  });

  test('the first load after it’s allowed asks once; Desk Mode is an answer, on every device', async ({ page, request, browser }) => {
    await harness(request, { reset: true });
    await harness(request, ON);
    const errors = watchConsole(page);
    // The harness's own desk list, so the layout document (and the prefs in it) goes to Platform, as for a member.
    await signIn(page, '/');
    const chooser = page.getByRole('group', { name: 'Open your office in' });
    await expect(chooser).toBeVisible();
    await expect(page.getByRole('button', { name: /^Desks\s*, last used$/ })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Maia', exact: true })).toBeVisible();
    // Asked once, so no "Ask every time".
    await expect(page.locator('#mm-ld').getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('#ma-root')).toHaveAttribute('inert', '');
    await page.waitForTimeout(400); // its 300 ms fade in, which axe would read as low contrast
    expect(await axe(page, '#mm-ld')).toEqual([]);
    await shot(page, 'first-question-light');
    await page.keyboard.press('Enter');
    await canvasPainted(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('#ma-root')).not.toHaveAttribute('inert', '');
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    // Never again: not on this device...
    await page.reload();
    await canvasPainted(page);
    await officeReady(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0);
    await page.waitForTimeout(2600); // the layout document's save: 2 s after the last change
    // ...nor on another, where only the member's prefs on Platform can say so.
    const other = await (browser as Browser).newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await other.newPage();
    await signIn(p2, '/');
    await canvasPainted(p2);
    await officeReady(p2);
    await expect(p2.locator('#mm-ld')).toHaveCount(0);
    await other.close();
    // The switch is still in the account menu, off.
    await openMenu(page);
    await expect(page.getByRole('switch', { name: /^Maia on my desks/ })).not.toBeChecked();
    expect(errors).toEqual([]);
  });

  test('Maia Mode from the first question opens the disclosure, and turning on is all the chooser needs', async ({ page, request }) => {
    await harness(request, { reset: true });
    await harness(request, ON);
    const errors = watchConsole(page);
    await signIn(page, PATH);
    await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Desks\s*, last used$/ })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('button', { name: 'Maia', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    // Nothing turns on before the disclosure is accepted; it's over the desks, with the focus on its title.
    const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    await expect(dialog.getByRole('heading', { name: 'Before Maia works on your desks' })).toBeFocused();
    expect((await mockLog(page)).some((l) => l.method === 'setOn')).toBe(false);
    await dialog.getByRole('checkbox', { name: 'I’ve read this' }).check();
    await dialog.getByRole('button', { name: 'Turn on Maia' }).click();
    await expect(room(page)).toBeVisible();
    expect((await mockLog(page)).some((l) => l.method === 'setOn' && l.args[0] === true)).toBe(true);
    // No other step: the next load asks, with "Ask every time" ticked and Maia Mode the last used.
    await page.reload();
    await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Maia\s*, last used$/ })).toBeFocused();
    await expect(page.getByRole('checkbox', { name: 'Ask every time I open my office' })).toBeChecked();
    await page.keyboard.press('Enter');
    await expect(room(page)).toBeVisible();
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    expect(errors).toEqual([]);
  });

  test('“Not now” on that disclosure is an answer too: the desks, and never asked again', async ({ page, request }) => {
    await harness(request, { reset: true });
    await harness(request, ON);
    const errors = watchConsole(page);
    await signIn(page, PATH);
    await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
    await page.getByRole('button', { name: 'Maia', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
    await canvasPainted(page);
    await expect(office(page)).toBeVisible();
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    expect((await mockLog(page)).some((l) => l.method === 'setOn')).toBe(false);
    await page.reload();
    await canvasPainted(page);
    await officeReady(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0);
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the startup chooser asks, Enter and Esc pick the last used, and unticking stops it', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await turnOn(page);
    await page.getByRole('button', { name: /Show my desks/ }).click();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    await page.reload();
    const chooser = page.getByRole('group', { name: 'Open your office in' });
    await expect(chooser).toBeVisible();
    await expect(page.getByRole('button', { name: /^Desks\s*, last used$/ })).toBeFocused();
    await expect(page.locator('#ma-root')).toHaveAttribute('inert', '');
    await expect(page.getByRole('checkbox', { name: 'Ask every time I open my office' })).toBeChecked();
    await page.waitForTimeout(400); // its 300 ms fade in, which axe would read as low contrast
    expect(await axe(page, '#mm-ld')).toEqual([]);
    await shot(page, 'chooser-light');
    // Arrows move the highlight (and the focus with it); Enter picks.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('button', { name: 'Maia', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(room(page)).toBeVisible();
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('#ma-root')).not.toHaveAttribute('inert', '');

    // Now Maia Mode is the last used: the office prepares the room under the question and never mounts the canvas.
    await page.reload();
    await expect(page.getByRole('button', { name: /^Maia\s*, last used$/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(room(page)).toBeVisible();
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    expect(await page.evaluate(() => performance.getEntriesByName('ma:first-canvas-paint').length)).toBe(0);
    expect(await page.evaluate(() => (performance.getEntriesByName('ma:office-ready')[0] as PerformanceMark | undefined)?.detail)).toBe('maia');
    // Leaving mounts the desks then, as a first visit would.
    await page.getByRole('button', { name: /Show my desks/ }).click();
    await canvasPainted(page);
    await expect(office(page)).toBeVisible();

    await page.reload();
    await page.getByRole('checkbox', { name: 'Ask every time I open my office' }).uncheck();
    await page.getByRole('button', { name: /^Desks(\s*, last used)?$/ }).click();
    await canvasPainted(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    await page.reload();
    await canvasPainted(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0);
    await expect(page.locator('.mm-layer')).toHaveCount(0);
    // The account menu brings the question back.
    await openMenu(page);
    await expect(page.getByRole('switch', { name: 'Ask at startup' })).not.toBeChecked();
    await page.getByRole('switch', { name: 'Ask at startup' }).click();
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
    await page.keyboard.press('Enter');
    // Turning it off stops the question and opens in Desk Mode.
    await canvasPainted(page);
    await openMenu(page);
    await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
    await page.waitForTimeout(300);
    await page.reload();
    await canvasPainted(page);
    await expect(page.locator('#mm-ld')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the chooser’s highlight is the office’s glass (its own card under the fallback), and “Still loading” only while the office loads', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await turnOn(page);
    await page.getByRole('button', { name: /Show my desks/ }).click();
    await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
    const still = page.locator('.mm-ld-s');
    const card = page.locator('.mm-ch-card');

    // The office loads while the question is up (the owner, Nov 16: it said “Still loading” over a loaded office): never shown.
    await page.goto(`${PATH}&stillLoadingMs=1500`);
    await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
    await officeReady(page);
    await page.waitForTimeout(2500);
    await expect(still).not.toHaveClass(/\bon\b/);
    expect(await still.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

    // The highlighted card: C's glass, as the tiles (the owner: “The active option gets the effect”); it moves with the focus.
    const look = (): Promise<{ bg: string; after: string; afterShadow: string }> =>
      card.evaluate((el) => ({ bg: getComputedStyle(el).backgroundImage, after: getComputedStyle(el, '::after').backgroundImage, afterShadow: getComputedStyle(el, '::after').boxShadow }));
    const glass = await look();
    expect(glass.bg).toMatch(/linear-gradient.*radial-gradient/);
    expect(glass.after).toMatch(/^conic-gradient/);
    const at = await card.boundingBox();
    expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await card.boundingBox())!.x).not.toBe(at!.x);
    // Moved from the keyboard, it wears the office's focus ring too: the glass alone isn't a 3:1 edge.
    expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    // Reduced transparency: the card it was (the gradient, the breathing glow), live.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    const solid = await look();
    expect(solid.bg).toMatch(/^linear-gradient/);
    expect(solid.bg).not.toMatch(/radial-gradient/);
    expect(solid.after).toBe('none');
    expect(solid.afterShadow).not.toBe('none');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    expect((await look()).bg).toBe(glass.bg);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 5000 });

    // Still loading at the line's time (`/v1/me` held back: the chooser asks on the last visit's record, and the office isn't
    // ready until it answers): it shows, then goes once the office is ready.
    await harness(request, { meDelayMs: 5000 });
    try {
      await page.goto(`${PATH}&stillLoadingMs=1500`);
      await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
      await expect(still).toHaveClass(/\bon\b/, { timeout: 4000 });
      expect(await page.evaluate(() => performance.getEntriesByName('ma:office-ready').length)).toBe(0);
      await expect(still).not.toHaveClass(/\bon\b/, { timeout: 10_000 });
      await officeReady(page);
    } finally {
      await harness(request, { meDelayMs: 0 });
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 5000 });
    expect(errors).toEqual([]);
  });

  test('Maia’s own panel has the way in', async ({ page, request }) => {
    await arrive(page, request, { maia: { enabled: true } });
    await page.locator('.maia-launcher').click();
    await page.getByRole('button', { name: 'Switch to Maia' }).click();
    await expect(page.getByRole('dialog', { name: 'Before Maia works on your desks' })).toBeVisible();
  });

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`in ${theme}: axe, and no warm or green tint anywhere in the room`, async ({ page, request }) => {
      await setTheme(page, theme);
      await arrive(page, request, {}, PATH, `first-question-${theme}`);
      await turnOn(page);
      expect(await axe(page, '.mm-room')).toEqual([]);
      // Every colour the room draws: no saturated hue outside the cool blues (the owner's rule).
      const warm = await page.evaluate(() => {
        const bad: string[] = [];
        const hue = (c: string): string | null => {
          const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
          if (!m || (m[4] !== undefined && Number(m[4]) < 0.05)) return null;
          const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 2;
          const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
          if (s < 0.2 || l < 0.08 || l > 0.95) return null;
          let h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
          h = (h * 60 + 360) % 360;
          return h >= 185 && h <= 260 ? null : `${c} (hue ${Math.round(h)})`;
        };
        // The member's own avatar (`chrome/Avatar.tsx`) is the office's, with its six tints: the Designer's (status doc).
        for (const el of document.querySelectorAll('.mm-room, .mm-room *:not(.account-btn, .account-btn *)')) {
          const cs = getComputedStyle(el);
          for (const c of [cs.color, cs.backgroundColor, cs.borderTopColor]) {
            const w = hue(c);
            if (w) bad.push(`${(el as HTMLElement).className}: ${w}`);
          }
        }
        return bad;
      });
      expect(warm).toEqual([]);
      await shot(page, `room-${theme}`);
      await page.getByRole('button', { name: 'Show me: Scout’s laptop comparison is ready' }).click();
      await expect(page.locator('.mm-vp')).toBeVisible();
      expect(await axe(page, '.mm-room')).toEqual([]);
      await shot(page, `viewport-${theme}`);
    });
  }

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test('one column, To-do as a pill and a sheet, choices in thumb reach, the viewport a sheet', async ({ page, request }) => {
      await arrive(page, request, {}, PATH, 'phone-first-question-light');
      await turnOn(page);
      await expect(page.locator('.mm-room.phone')).toBeVisible();
      const pill = page.getByRole('button', { name: 'To-do, 2 items, 1 now' });
      await expect(pill).toBeVisible();
      // Her choices: full-width rows, at least 44 px tall, in the lower part of the screen.
      const choices = page.getByRole('group', { name: 'Reply choices' }).getByRole('button');
      for (const b of await choices.all()) {
        const r = await b.boundingBox();
        expect(r && r.height >= 44 && r.width >= 300 && r.y > 844 / 3).toBe(true);
      }
      const composer = await page.locator('.mm-composer').boundingBox();
      expect(composer && composer.y + composer.height <= 844).toBe(true);
      expect(await axe(page, '.mm-room')).toEqual([]);
      await shot(page, 'phone-light');
      await pill.click();
      const sheet = page.getByRole('dialog', { name: 'To-do' });
      await expect(sheet).toBeVisible();
      await shot(page, 'phone-sheet-light');
      await sheet.getByRole('button', { name: 'Show me: Scout’s laptop comparison is ready' }).click();
      const vp = page.locator('.mm-vp-sheet');
      await expect(vp).toBeVisible();
      const box = await vp.boundingBox();
      expect(box && Math.abs(box.height - 844 * 0.88) < 4).toBe(true);
      await shot(page, 'phone-viewport-light');
      await vp.getByRole('button', { name: /^Close/ }).click();
      await expect(vp).toHaveCount(0);
    });
  });
});
