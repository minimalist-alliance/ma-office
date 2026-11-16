// Helpers for the frame budget's specs (`deskapps.budget.shell.spec.ts` in the headless shell, `deskapps.budget.chrome.shell.spec.ts`
// in Chrome itself, which needs a file of its own for its channel).
import { expect, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

export { harness };

export const PERSONAL = 'd-personal00001';
export const TALLY = 'com.minimalistalliance.sample.tally';
export const BIBLE = 'com.minimalistalliance.bible';
export const fleet = [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }];
export const READY = '[data-testid="deskapp-frame"][data-state="ready"]';
export const PAUSED = '[data-testid="deskapp-panel"][data-panel="paused"]';

export type Diag = { what: string; detail: Record<string, unknown> };

/** The office with apps on, the frame's CSP addition, and these apps already on the personal desk. */
export async function office(page: Page, request: APIRequestContext, apps: string[], extra: Record<string, unknown> = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 50, preinstalled: { [PERSONAL]: apps }, ...extra });
  await harness(request, { fleet, appFrames: true });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(400);
  return errors;
}

/** An app's tile, pressed as the keyboard and a screen reader do. */
export async function openTile(page: Page, app: string): Promise<void> {
  await page.locator(`[id="proxy-${PERSONAL}:app:${app}"]`).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.locator(READY)).toBeVisible({ timeout: 15_000 });
}

export async function viewFrame(page: Page): Promise<Frame> {
  const el = await page.locator(READY).elementHandle();
  const f = await el?.contentFrame();
  if (!f) throw new Error('no view frame');
  return f;
}

export const diags = (page: Page): Promise<Diag[]> => page.evaluate(() => (globalThis as { __maBudget?: Diag[] }).__maBudget ?? []);
export const threadOf = async (page: Page): Promise<unknown> => (await diags(page)).filter((d) => d.what === 'thread').map((d) => d.detail['thread']).pop();

/** The office's own long frames: `ms` of its own script every `every` ms, for `forMs` (a live tile, a redraw, a slow machine). */
export function busyOffice(page: Page, ms: number, every: number, forMs: number): Promise<number> {
  return page.evaluate(([ms, every, forMs]) => new Promise<number>((done) => {
    const end = performance.now() + forMs;
    let n = 0;
    const step = (): void => {
      if (performance.now() > end) return done(n);
      requestAnimationFrame(() => {
        document.body.dataset['busy'] = String(n);
        const until = performance.now() + ms;
        while (performance.now() < until) { /* the office's own frame runs long */ }
        n += 1;
        setTimeout(step, every);
      });
    };
    step();
  }), [ms, every, forMs] as const);
}

/** The view's own script holds its thread `ms` per animation frame, for `forMs`. */
export async function busyView(f: Frame, ms: number, forMs: number): Promise<void> {
  await f.evaluate(([ms, forMs]) => {
    const end = performance.now() + forMs;
    const loop = (): void => {
      if (performance.now() > end) return;
      const until = performance.now() + ms;
      while (performance.now() < until) { /* the view's frame runs long */ }
      document.body.dataset['busy'] = String(Math.random());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, [ms, forMs] as const);
}

/** The office's animation frame gaps over 50 ms, from now until `stop()`. */
export async function watchGaps(page: Page): Promise<{ stop: () => Promise<number[]> }> {
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __gapsOn: boolean };
    w.__gaps = [];
    w.__gapsOn = true;
    let prev = 0;
    const tick = (t: number): void => {
      if (prev && t - prev > 50) w.__gaps.push(Math.round(t - prev));
      prev = t;
      if (w.__gapsOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return {
    stop: () => page.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __gapsOn: boolean };
      w.__gapsOn = false;
      return w.__gaps;
    }),
  };
}
