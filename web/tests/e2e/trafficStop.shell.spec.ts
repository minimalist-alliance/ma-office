// A desk the cost guard stopped for its traffic (TD-162, contract desks.md "Traffic stops"): the reason where Start would be,
// the time it can start again, no Start before then, the stopping notice, and every other stop as it was. The harness stands in
// for Platform. Three themes at 1280 and 390.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['TRAFFIC_SHOTS'];
const DESK_LINE = 'This desk was stopped because its internet traffic went far beyond normal personal use.';
const HOST_LINE = 'This desk was stopped for a while because of very heavy internet traffic on the computer it shares with other desks.';
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(Date.now() + ms).toISOString();
const detail = (scope: string, ms: number): Record<string, unknown> => ({ reason: 'traffic', limit: '24h', scope, at: iso(-HOUR), clearsAt: iso(ms) });
const desk = (over: Record<string, unknown>): Record<string, unknown> => ({ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'stopped', ...over });

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const wakes = async (request: APIRequestContext): Promise<number> =>
  ((await (await request.get('/__harness')).json()) as { connects: { start: unknown }[] }).connects.filter((c) => c.start === true).length;

async function openBrowser(page: Page) {
  await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  return page.getByRole('dialog', { name: /Browser/ });
}

async function arrive(page: Page, request: APIRequestContext, d: Record<string, unknown>) {
  await harness(request, { fleet: [d] });
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  // The list has landed, so the window opens on what the platform said (a member sees the desk's state before they click).
  if (d['stopDetail'] && Date.parse((d['stopDetail'] as { clearsAt: string }).clearsAt) > Date.now()) await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Personal desk,/ })).toHaveAccessibleName(/heavy traffic|going to sleep|stopping/);
  return openBrowser(page);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  for (const [w, h] of [[1280, 800], [390, 844]] as [number, number][]) {
    test(`${theme} ${w}: stopped for its traffic, before clearsAt: the line and the time, no Start`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await page.setViewportSize({ width: w, height: h });
      await setTheme(page, theme);
      const dialog = await arrive(page, request, desk({ stopReason: null, stopDetail: detail('desk', 2 * HOUR) }));
      await expect(dialog.getByTestId('traffic-stop-line')).toHaveText(DESK_LINE);
      await expect(dialog.getByTestId('traffic-stop-clears')).toHaveText(/^You can start it again (after \d{1,2}:\d{2}\s?[AP]M (today|tomorrow)|on \w+ \d+)\.$/);
      await expect(dialog.getByTestId('traffic-stop-support')).toHaveText('Contact support');
      await expect(dialog.getByRole('button', { name: /Wake this desk/ })).toHaveCount(0);
      expect(await wakes(request)).toBe(0);
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/\bGB\b|15m|24h/);
      expect(await axe(page)).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${theme}-${w}.png` });
      expect(errors).toEqual([]);
    });
  }
}

test('a shared host\'s stop says so, in its own words', async ({ page, request }) => {
  const dialog = await arrive(page, request, desk({ stopDetail: detail('host', HOUR) }));
  await expect(dialog.getByTestId('traffic-stop-line')).toHaveText(HOST_LINE);
  await expect(dialog.getByRole('button', { name: /Wake this desk/ })).toHaveCount(0);
  expect(await wakes(request)).toBe(0);
});

test('after clearsAt it is an ordinary desk: the window wakes it as it opens', async ({ page, request }) => {
  await arrive(page, request, desk({ stopDetail: detail('desk', -HOUR) }));
  await expect.poll(() => wakes(request)).toBeGreaterThan(0);
  await expect(page.getByTestId('traffic-stop')).toHaveCount(0);
});

test('while stopping, the notice gives the reason and the time', async ({ page, request }) => {
  const stopAt = iso(60_000);
  const dialog = await arrive(page, request, desk({ state: 'stopping', stopAt, stopReason: 'traffic', stopDetail: detail('desk', 2 * HOUR) }));
  await expect(dialog.getByTestId('traffic-stop-line')).toHaveText(DESK_LINE);
  await expect(dialog.getByTestId('traffic-stop-clears')).toContainText('You can start it again');
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Personal desk,/ })).toHaveAccessibleName(/stopped for heavy traffic/);
});

test('a data-guard stop and an unknown stop reason are as they were', async ({ page, request }) => {
  const stopAt = iso(60_000);
  const dialog = await arrive(page, request, desk({ state: 'stopping', stopAt, stopReason: 'data_guard' }));
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText('Your desks are stopping: your data use this month went past your plan.');
  await expect(page.getByTestId('traffic-stop')).toHaveCount(0);
});

test('an idle-stopped desk wakes as it always did', async ({ page, request }) => {
  await arrive(page, request, desk({}));
  await expect.poll(() => wakes(request)).toBeGreaterThan(0);
  await expect(page.getByTestId('traffic-stop')).toHaveCount(0);
});
