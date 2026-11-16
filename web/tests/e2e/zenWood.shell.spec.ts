// Zen's wood has no brown (ADR 0093, Ash grey addendum; the owner: "no green, brown or warm tints anywhere in the UI"). The three wood tiles
// the Zen theme draws (`oak-dusk`, `ash-dusk`, `walnut-dusk`) are decoded by the browser and sampled, every 3rd pixel across and down;
// none may have a warm hue, HSV 15 to 75 degrees at a meaningful saturation (a spread of 2 or more code values and S of 0.02 or more),
// and the lot, with Linoleum, stays inside the byte budget the regrade left (209,486 B).
//
// White oak (ADR 0093, White oak addendum, Nov 15) is the one exemption, and for its grain only: the owner asked for a white oak "with slight
// strands of very light and desat tan", and Zen keeps a hint of them. Its inks have no warm hue like every style's (deskStyles.test.ts), and
// its tile must keep the tan in the strands: the tile's average colour isn't warm, at most 12 % of the samples are, none past S 0.15, and at
// least three in four of those are darker than the tile's mean, so the field stays a cool grey and only the darker grain lines carry tan.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const DIR = fileURLToPath(new URL('../../src/assets/desk-styles/', import.meta.url));
const TILES = ['oak', 'ash', 'walnut', 'linoleum'] as const;

interface Sample { w: number; h: number; sampled: number; warm: number; worst: string; maxS: number; warmDarker: number; mean: [number, number, number] }

async function sample(page: Page, file: string): Promise<Sample> {
  await page.goto('about:blank');
  const b64 = readFileSync(`${DIR}${file}`).toString('base64');
  return page.evaluate(async (data) => {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const lumOf = (R: number, G: number, B: number): number => 0.2126 * R + 0.7152 * G + 0.0722 * B;
    let sampled = 0, sr = 0, sg = 0, sb = 0, sl = 0;
    const warmLums: number[] = [];
    let worst = '', maxS = 0;
    for (let y = 0; y < cv.height; y += 3) {
      for (let x = 0; x < cv.width; x += 3) {
        const i = (y * cv.width + x) * 4;
        const R = px[i]!, G = px[i + 1]!, B = px[i + 2]!;
        sampled += 1;
        sr += R; sg += G; sb += B; sl += lumOf(R, G, B);
        const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
        if (d < 2 || d / max < 0.02) continue;
        const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
        const deg = (h * 60 + 360) % 360;
        if (deg >= 15 && deg < 75) {
          warmLums.push(lumOf(R, G, B));
          maxS = Math.max(maxS, d / max);
          worst ||= `rgb(${R},${G},${B}) at ${x},${y}, hue ${deg.toFixed(1)}`;
        }
      }
    }
    const meanLum = sl / sampled;
    return {
      w: bmp.width, h: bmp.height, sampled, warm: warmLums.length, worst, maxS,
      warmDarker: warmLums.filter((l) => l < meanLum).length,
      mean: [Math.round(sr / sampled), Math.round(sg / sampled), Math.round(sb / sampled)] as [number, number, number],
    };
  }, b64);
}

function warmHue([r, g, b]: [number, number, number]): boolean {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 2 || d / max < 0.02) return false;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const deg = (h * 60 + 360) % 360;
  return deg >= 15 && deg < 75;
}

for (const id of TILES) {
  test(`the Zen ${id} tile has no warm pixel`, async ({ page }) => {
    const r = await sample(page, `${id}-dusk.webp`);
    expect(r.w).toBe(1024);
    expect(r.h).toBe(1024);
    expect(r.sampled).toBeGreaterThan(100000);
    expect(r.warm, `${id}-dusk.webp: ${r.worst}`).toBe(0);
  });
}

test('the Zen White oak tile keeps its tan to the grain: a cool field, faint tan only in the darker strands', async ({ page }) => {
  const r = await sample(page, 'white-oak-dusk.webp');
  expect(r.w).toBe(1024);
  expect(r.h).toBe(1024);
  expect(r.sampled).toBeGreaterThan(100000);
  expect(warmHue(r.mean), `mean rgb(${r.mean.join(',')})`).toBe(false);
  expect(r.warm / r.sampled, `${r.warm} warm of ${r.sampled}`).toBeLessThanOrEqual(0.12);
  expect(r.maxS, r.worst).toBeLessThanOrEqual(0.15);
  expect(r.warmDarker / Math.max(1, r.warm), `${r.warmDarker} of ${r.warm} warm samples darker than the mean`).toBeGreaterThanOrEqual(0.75);
});

test('the four Zen tiles total no more than the regrade\'s 209,486 B', () => {
  const total = TILES.reduce((n, id) => n + statSync(`${DIR}${id}-dusk.webp`).size, 0);
  expect(total).toBeLessThanOrEqual(209486);
});
