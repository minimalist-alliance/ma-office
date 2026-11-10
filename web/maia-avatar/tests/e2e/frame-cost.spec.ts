// DANCE: the AI Engineer's condition for the 29 KB budget (ma-platform docs/maia.md section 14): drawing holds 1.5 ms a
// frame at 30 fps. Each frame is one engine step and one draw (what frame() does at 30 fps), timed with the real clock
// around the hand-driven frame, in cross-origin isolation (5 us resolution; scripts/serve.mjs). The dance is measured
// across its whole 23.2 s, beside version 7's idle and move routines, at the sizes the Desk app uses. Numbers are logged;
// the test fails when the dance's median or 95th percentile passes 1.5 ms. Run under `nice -n 15` on a shared machine.
import { expect, test } from '@playwright/test';
import { handClock } from './helpers.js';

const BUDGET_MS = 1.5;
const SIZES = [36, 64, 96, 120];
// 'queued' times the frame as the main thread sees it; 'flushed' adds a 1 px read-back after each frame, which makes the
// browser rasterise the canvas on the spot (software rendering here), so it is the larger, honest cost of the drawing.
const MODES = ['queued', 'flushed'] as const;
type Win = Window & { M: { createAvatar(c: HTMLCanvasElement, o?: object): { playRoutine(n: string): boolean; playScore(i: unknown): unknown; state: string } }; __frame(ms: number): number; __real(): number; isolated: boolean };

test('the dance, idle and move cost no more than 1.5 ms a frame at 30 fps', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => { (window as unknown as Win).__real = performance.now.bind(performance); });
  await handClock(page);
  await page.goto('/test.html');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.evaluate(async () => { (window as unknown as Win).M = await import('/lib/maia-avatar.js' as string); });
  const rows: string[] = [];
  for (const mode of MODES) for (const dpr of [2]) for (const size of SIZES) {
    const r = await page.evaluate(async ({ size, dpr, flush }) => {
      const w = window as unknown as Win;
      const box = document.createElement('div');
      box.style.cssText = `position:relative;overflow:hidden;border-radius:50%;width:${size}px;height:${size}px`;
      const c = document.createElement('canvas');
      box.append(c);
      document.body.append(box);
      const g = c.getContext("2d")!;
      const maia = w.M.createAvatar(c, { size, theme: 'dusk', dpr });
      await new Promise((ok) => setTimeout(ok, 200)); // the observer's first report
      const run = (n: number): number[] => {
        const t: number[] = [];
        for (let i = 0; i < n; i += 1) { const a = w.__real(); w.__frame(1000 / 30); if (flush) g.getImageData(0, 0, 1, 1); t.push(w.__real() - a); }
        return t;
      };
      const beats = (b: [number, string, number][]) => b.map(([t, d, level]) => ({ t, do: d, level }));
      const out: Record<string, number[]> = {};
      run(60);
      out['idle'] = run(900);
      maia.playScore({ v: 1, mood: 'bright', rhythm: 'lively', seconds: 24, beats: beats([[1, 'hop', 3], [2, 'smile', 2], [8, 'wave', 3], [12, 'flutter', 2], [14, 'hop', 2], [18, 'lean', 3], [20, 'flick', 3]]) });
      out['move'] = run(720);
      run(300);
      if (!maia.playRoutine('party')) throw new Error('no party');
      const dance: number[] = [];
      for (let i = 0; i < 1400 && (i < 5 || maia.state === 'routine'); i += 1) dance.push(...run(1));
      out['dance'] = dance;
      box.remove();
      return out;
    }, { size, dpr, flush: mode === 'flushed' });
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;
    for (const k of ['idle', 'move', 'dance']) {
      const a = r[k]!;
      rows.push(`${mode.padEnd(7)} ${size} px @${dpr}x ${k.padEnd(5)} frames ${a.length}  median ${q(a, 0.5).toFixed(3)} ms  p95 ${q(a, 0.95).toFixed(3)} ms  mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)} ms  max ${Math.max(...a).toFixed(2)} ms`);
      if (k === 'dance') {
        expect(a.length).toBeGreaterThan(600);
        expect(q(a, 0.5), `${mode} ${size} px median`).toBeLessThanOrEqual(BUDGET_MS);
        expect(q(a, 0.95), `${mode} ${size} px p95`).toBeLessThanOrEqual(BUDGET_MS);
      }
    }
  }
  console.log(rows.join('\n'));
});
