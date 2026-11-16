// Maia's web search in the office (ma-platform ADR 0137), against the harness's fake Maia only: one card for a reply's
// whole batch, Search, Not now and Always allow as one turn each with no message, an expired card, the auto line and its
// way back, the sources under her reply, axe in every theme, and shots for the brand read (no green, brown or warm tint).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface Turn {
  conversationId: string | null;
  message?: string;
  webSearch?: { batchId: string; decision: string };
}
interface Harness {
  maiaTurns: Turn[];
  maiaWebModes: string[];
}

const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message to Maia' });
const card = (page: Page): Locator => page.getByRole('group', { name: 'Search the web?' });

async function arrive(page: Page, request: APIRequestContext, mode: 'ask' | 'auto', theme?: ThemeId): Promise<void> {
  await harness(request, { reset: true });
  await harness(request, { maia: { enabled: true, animation: false, webSearch: mode } });
  if (theme) await setTheme(page, theme);
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await page.locator('.maia-launcher').click();
  await expect(composer(page)).toBeFocused();
}

async function ask(page: Page, text: string): Promise<void> {
  const sent = (await page.locator('.maia-me').count()) + 1;
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(page.locator('.maia-me')).toHaveCount(sent);
  await expect(page.locator('.maia-msg[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document.querySelector('#maia-panel'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test('ask: one card lists the whole batch; Search is one turn with no message, and her reply comes with its sources', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request, 'ask');
  await ask(page, '[stub:web] When is the next Firefox ESR?');
  await expect(card(page)).toHaveCount(1);
  const items = card(page).getByRole('list', { name: 'Searches' }).getByRole('listitem');
  await expect(items).toHaveText(['firefox esr release schedule', 'chrome extended stable channel', 'safari 27 release date']);
  await expect(card(page).getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Not now' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Always allow' })).toHaveAccessibleDescription(/without asking/);
  const before = (await read(request)).maiaTurns.length;

  await card(page).getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.maia-her').last()).toContainText('Firefox 152 ESR is due December 8 [1]');
  await expect(card(page)).toContainText('Searching…');
  await expect(card(page).getByRole('button')).toHaveCount(0);
  const turns = (await read(request)).maiaTurns.slice(before);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.message).toBeUndefined();
  expect(turns[0]!.webSearch?.decision).toBe('approve');

  const sources = page.getByRole('navigation', { name: 'Sources' }).last();
  const first = sources.getByRole('link', { name: 'Firefox ESR' });
  await expect(first).toHaveAttribute('href', 'https://www.mozilla.org/firefox/esr/');
  await expect(first).toHaveAttribute('target', '_blank');
  await expect(first).toHaveAttribute('rel', /noopener noreferrer/);
  await expect(first).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(sources).toContainText('mozilla.org');
  expect(errors).toEqual([]);
});

test('ask: Not now runs nothing and says so; a second press on an answered card sends nothing', async ({ page, request }) => {
  await arrive(page, request, 'ask');
  await ask(page, '[stub:web] Browsers?');
  await card(page).getByRole('button', { name: 'Not now' }).click();
  await expect(card(page)).toContainText('Not searched.');
  await expect(page.locator('.maia-her').last()).toContainText("I didn't search the web");
  const turns = (await read(request)).maiaTurns;
  expect(turns.at(-1)?.webSearch?.decision).toBe('decline');
  expect(turns.filter((t) => t.webSearch)).toHaveLength(1);
});

test('ask: Always allow searches this batch and switches to auto; the next one runs with a line, and Ask me first goes back', async ({ page, request }) => {
  await arrive(page, request, 'ask');
  await ask(page, '[stub:web] Browsers?');
  await card(page).getByRole('button', { name: 'Always allow' }).click();
  await expect(page.locator('.maia-her').last()).toContainText('Firefox 152 ESR');
  expect((await read(request)).maiaWebModes).toEqual(['auto']);
  await ask(page, '[stub:web] And again?');
  await expect(card(page)).toHaveCount(1, { timeout: 5_000 });
  const line = page.locator('.maia-web-searched').last();
  await expect(line).toContainText('Searched the web for “firefox esr release schedule”.');
  await line.getByRole('button', { name: 'Ask me first' }).click();
  await expect(line).toContainText('Maia will ask before she searches.');
  expect((await read(request)).maiaWebModes).toEqual(['auto', 'ask']);
});

test('an expired card offers nothing and sends nothing', async ({ page, request }) => {
  await arrive(page, request, 'ask');
  await ask(page, '[stub:web] [stub:web-expired] Browsers?');
  await expect(card(page)).toContainText('This request has expired.');
  await expect(card(page).getByRole('button')).toHaveCount(0);
  expect((await read(request)).maiaTurns.filter((t) => t.webSearch)).toHaveLength(0);
});

test('auto: no card, the line says what she searched, and the sources show under her answer', async ({ page, request }) => {
  await arrive(page, request, 'auto');
  await ask(page, '[stub:web] When is the next Firefox ESR?');
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('.maia-web-searched')).toContainText('firefox esr release schedule');
  await expect(page.getByRole('navigation', { name: 'Sources' })).toBeVisible();
});

for (const theme of THEMES) {
  test(`the card and the sources pass axe, in ${theme}`, async ({ page, request }) => {
    await arrive(page, request, 'ask', theme);
    await ask(page, '[stub:web] Browsers?');
    await expect(card(page)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/maia-web-card-${theme}.png` });
    await card(page).getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Sources' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/maia-web-sources-${theme}.png` });
  });
}
