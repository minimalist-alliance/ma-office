// Her rest pose, pixel for pixel. In every theme and drawing tier:
// - the package's still is identical to version 7's reference engine's own still, in the same browser;
// - and it matches version 7's committed still (docs/assets/maia/svg) drawn by the browser's SVG renderer, apart
//   from edge antialiasing, since the SVG cuts the iris with a mask where the canvas uses source-atop.
import { expect, test } from '@playwright/test';
import { loadReference, openTestPage } from './helpers.js';

const CASES: [string, number][] = [['sm', 40], ['md', 64], ['lg', 200], ['lg', 400]];

interface Diff { total: number; differ: number; over16: number; over64: number; max: number; meanAbs: number; inside: number }

for (const theme of ['light', 'dusk', 'dark']) {
  for (const [tier, size] of CASES) {
    test(`rest pose, ${theme} ${tier} at ${size} px`, async ({ page }) => {
      await openTestPage(page);
      await loadReference(page);
      const r = await page.evaluate(async ({ theme, tier, size }) => {
        const w = window as unknown as {
          M: { createAvatar: (c: HTMLCanvasElement, o: object) => { pause(): void } };
          MaiaEngine: { createAvatar: (c: HTMLCanvasElement, o: object) => { drawStill(): void; tier: string } };
        };
        const read = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray): Diff => {
          let differ = 0, over16 = 0, over64 = 0, max = 0, sum = 0, inside = 0;
          for (let i = 0; i < a.length; i += 4) {
            let d = 0;
            for (let k = 0; k < 4; k += 1) d = Math.max(d, Math.abs(a[i + k]! - b[i + k]!));
            if (a[i + 3]! > 0 || b[i + 3]! > 0) inside += 1;
            if (d > 0) differ += 1;
            if (d > 16) over16 += 1;
            if (d > 64) over64 += 1;
            if (d > max) max = d;
            sum += d;
          }
          return { total: a.length / 4, differ, over16, over64, max, meanAbs: sum / (a.length / 4), inside };
        };
        // The package, paused: its still, in a bubble as an app would hold it.
        const box = document.createElement('span');
        box.style.position = 'relative';
        box.style.display = 'block';
        const c = document.createElement('canvas');
        box.append(c);
        document.body.append(box);
        const avatar = w.M.createAvatar(c, { size, theme, dpr: 1 });
        avatar.pause();
        const pkg = read(c);
        // The reference engine's still, on a canvas of its own.
        const rc = document.createElement('canvas');
        const ref = w.MaiaEngine.createAvatar(rc, { size, dpr: 1, theme });
        ref.drawStill();
        // The committed SVG still, at the same backing size.
        const img = new Image();
        img.src = `/art/svg/maia-${theme}-${tier}.svg`;
        await img.decode();
        const sc = document.createElement('canvas');
        sc.width = c.width;
        sc.height = c.height;
        sc.getContext('2d')!.drawImage(img, 0, 0, sc.width, sc.height);
        return { width: c.width, refTier: ref.tier, engine: diff(pkg, read(rc)), svg: diff(pkg, read(sc)) };
      }, { theme, tier, size });
      console.log(`${theme} ${tier} ${size}px (${r.width}px backing): engine ${JSON.stringify(r.engine)} svg ${JSON.stringify(r.svg)}`);
      expect(r.refTier).toBe(tier);
      // Identical to the reference engine: not one pixel differs.
      expect(r.engine.differ).toBe(0);
      // Against the SVG: only antialiased edges may differ, and only a little. Measured in Chromium: at most 16 of
      // 255 up to 200 px; at 400 px, 17 pixels over 16 and 3 over 64, single edge pixels, of 22,283 inside her.
      expect(r.svg.over16).toBeLessThanOrEqual(Math.ceil(r.svg.inside * 0.002));
      expect(r.svg.over64).toBeLessThanOrEqual(4);
      expect(r.svg.meanAbs).toBeLessThan(0.05);
      expect(Math.abs(r.svg.inside - r.engine.inside)).toBeLessThanOrEqual(2);
    });
  }
}
