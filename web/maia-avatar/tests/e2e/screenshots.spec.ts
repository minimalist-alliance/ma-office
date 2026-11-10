// screenshots/maia-{light,dusk,dark}.png: the demo's top half in each theme, paused so every Maia shows her rest
// pose, with version 7's stills beside the package's. `npm run screenshots` (after a build) rewrites them.
// Every chunk but the image's own is dropped, so no metadata goes into git.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1120, height: 900 }, deviceScaleFactor: 2 });

/** PNG with only the chunks that make the image: IHDR, PLTE, tRNS, IDAT, IEND. */
function bare(png: Buffer): Buffer {
  const keep = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  const out = [png.subarray(0, 8)];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), end = at + 12 + len;
    if (keep.has(type)) out.push(png.subarray(at, end));
    at = end;
  }
  return Buffer.concat(out);
}

for (const theme of ['light', 'dusk', 'dark']) {
  test(`screenshot, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.locator(`input[name=theme][value=${theme}]`).check({ force: true });
    await page.locator('#pause').click();
    await page.evaluate(() => { const r = document.getElementById('readout'); if (r) r.style.visibility = 'hidden'; });
    await page.waitForTimeout(300);
    const top = await page.locator('#bubble').boundingBox();
    const bottom = await page.locator('#compare').boundingBox();
    expect(top && bottom).toBeTruthy();
    const shot = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 1120, height: Math.ceil(bottom!.y + bottom!.height + 24) } });
    mkdirSync(new URL('../../screenshots/', import.meta.url), { recursive: true });
    writeFileSync(new URL(`../../screenshots/maia-${theme}.png`, import.meta.url), bare(shot));
  });
}
