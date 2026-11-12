// Shared steps for the Bible view's specs: the harness, the frame, the real service's data.
import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export type Theme = 'light' | 'dusk' | 'dark';

/** Empties the service's data (and, with `q`, breaks a translation or makes it say it's starting). */
export async function reset(page: Page, q = ''): Promise<void> {
  const r = await page.request.post(`/api/reset${q}`);
  expect(r.ok()).toBe(true);
}

/** Calls the service as the view would, for setting up a test's data. */
export async function api(page: Page, m: string, p: Record<string, unknown> = {}, mutation = false): Promise<any> {
  const r = await page.request.post('/api/call', { data: { m, p, idem: mutation ? randomUUID() : undefined } });
  const j = await r.json();
  if (j.err) throw new Error(`${m}: ${JSON.stringify(j.err)}`);
  return j.res;
}

export const view = (page: Page): FrameLocator => page.frameLocator('#frame');

export function frame(page: Page): Frame {
  const f = page.frames().find((x) => x !== page.mainFrame());
  if (!f) throw new Error('no view frame');
  return f;
}

/** Opens the harness and waits for the view to be reading. */
export async function openView(page: Page, query = 'theme=light'): Promise<FrameLocator> {
  await page.goto(`/?${query}`);
  const v = view(page);
  await expect(v.locator('#app')).toHaveAttribute('data-state', 'ready');
  await expect(v.locator('#chHead')).toBeVisible();
  return v;
}

export async function calls(page: Page): Promise<{ m: string; p: any; idem?: string }[]> {
  return page.evaluate(() => (window as any).__harness.calls);
}

/** Goes to a reference by typing it into Go to, and waits for the chapter the view asked for to be on screen. */
export async function goTo(page: Page, ref: string): Promise<void> {
  const v = view(page);
  const chapters = async () => (await calls(page)).filter((c) => c.m === 'bible.chapter');
  const n = (await chapters()).length;
  await v.locator('#refBtn').click();
  const field = v.getByRole('textbox', { name: 'Go to' });
  await field.fill(ref);
  await field.press('Enter');
  await expect(v.locator('.goto')).toHaveCount(0);
  await expect.poll(async () => (await chapters()).length).toBeGreaterThan(n);
  const p = (await chapters()).pop()!.p;
  await expect(v.locator('#col')).toHaveAttribute('data-at', `${p.translation}.${p.book}.${p.chapter}`);
}

/** The verse at the top of the reading column, as the view reckons it. */
export async function topVerse(page: Page): Promise<number> {
  return frame(page).evaluate(() => {
    const limit = document.getElementById('scroll')!.getBoundingClientRect().top + 12;
    let v = 0;
    let last: string | null = null;
    for (const part of document.querySelectorAll<HTMLElement>('#col .v')) {
      if (part.dataset.v === last) continue;
      last = part.dataset.v!;
      const r = part.getClientRects()[0];
      if (!r) continue;
      if (r.top > limit) break;
      v = Number(last);
    }
    return v || 1;
  });
}

/** Scrolls the column so that verse's first line is at the top. */
export async function scrollToVerse(page: Page, verse: number): Promise<void> {
  await frame(page).evaluate((n) => {
    const s = document.getElementById('scroll')!;
    const part = document.querySelector(`#col .v[data-v="${n}"]`)!;
    s.scrollTop += part.getClientRects()[0].top - s.getBoundingClientRect().top - 10;
  }, verse);
}

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** axe-core inside the view's frame (Playwright's evaluate isn't held by the frame's policy), WCAG 2.1 A and AA. */
export async function axe(page: Page): Promise<{ id: string; help: string; nodes: string[] }[]> {
  const f = frame(page);
  await f.evaluate(AXE);
  return f.evaluate(async () => {
    const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x: any) => ({ id: x.id, help: x.help, nodes: x.nodes.map((n: any) => n.target.join(' ')) }));
  });
}
