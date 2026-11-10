// The crop pairs side by side, once both desks have run. Touches no desk and signs in to nothing: it reads two label folders,
// composes each crop pair at 100% in a blank page, and says where the two runs didn't match.
//   W3_PAIR=<labelA>,<labelB> npx playwright test -c w3 pair
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from '@playwright/test';

const PAIR = process.env.W3_PAIR?.split(',') ?? [];
test.skip(PAIR.length !== 2, 'W3_PAIR=<labelA>,<labelB> is not set');

test('W3 crop pairs', async ({ browser }) => {
  const root = process.env.W3_OUT ?? join(homedir(), 'ma-design-drafts', 'w3');
  const [a, b] = PAIR;
  const out = join(root, `pairs-${a}-vs-${b}`);
  mkdirSync(out, { recursive: true });
  const lines = [`# W3 crop pairs: ${a} (left) and ${b} (right)`, '', 'Each image here is one `*.crop-*.png` from each desk, side by side at 100%, nothing scaled: the same words, from the same client profile. `crop-window` is what a member\'s screen would show, `crop-decoded` the decoded frame itself. The whole frames are in the two label folders under the same paths. Each folder\'s README.md says how they were made.', ''];
  const facts = (label: string, profile: string) => { const f = join(root, label, `capture-${profile}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };

  for (const profile of readdirSync(join(root, a), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const fa = facts(a, profile), fb = facts(b, profile);
    mkdirSync(join(out, profile), { recursive: true });
    lines.push(`## ${profile}`, '');
    for (const kind of Object.keys(fa?.pages ?? {})) {
      const pa = fa.pages[kind], pb = fb?.pages?.[kind];
      if (!pb) { lines.push(`- **${kind}: ${b} has no capture of this page.**`); continue; }
      lines.push(`- ${kind}: ${pa.asked === pb.asked ? `both asked for ${pa.asked}` : `**not the same page: ${a} ${pa.asked}, ${b} ${pb.asked}**`}. Titles: "${pa.showed?.title}" and "${pb.showed?.title}".`);
      lines.push(`  Device px per desk px: ${pa.picture?.deviceFullPxPerDeskPx?.toFixed(3)} and ${pb.picture?.deviceFullPxPerDeskPx?.toFixed(3)}. Stream: ${pa.top?.streamSize} and ${pb.top?.streamSize}. Browser window's video box: ${Math.round(pa.picture?.elWidth)}x${Math.round(pa.picture?.elHeight)} and ${Math.round(pb.picture?.elWidth)}x${Math.round(pb.picture?.elHeight)}${pa.picture?.elWidth === pb.picture?.elWidth && pa.picture?.elHeight === pb.picture?.elHeight ? '' : ' **(not the same size)**'}.`);
      for (const mode of ['small', 'body']) {
        const ca = pa.crops?.[mode], cb = pb.crops?.[mode];
        if (ca?.anchor && ca.anchor !== cb?.anchor) lines.push(`  **${mode}: not the same words: "${ca.anchor}" and "${cb?.anchor}".**`);
      }
    }
    lines.push('');
    const crops = readdirSync(join(root, a, profile)).filter((f) => /\.crop-(window|decoded)\.png$/.test(f) && existsSync(join(root, b, profile, f)));
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1600, height: 500 } });
    const page = await context.newPage();
    for (const f of crops) {
      const url = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
      await page.setContent(`<!doctype html><style>html,body{margin:0;background:#fff}#p{display:inline-flex;gap:8px;font:13px sans-serif}img{display:block;image-rendering:pixelated}div div{padding:4px}</style><div id="p"><div>${a}<img src="${url(join(root, a, profile, f))}"></div><div>${b}<img src="${url(join(root, b, profile, f))}"></div></div>`, { waitUntil: 'load' });
      await page.locator('#p').screenshot({ path: join(out, profile, f) });
    }
    await context.close();
    lines.push(`${crops.length} pairs in \`${profile}/\`.`, '');
  }
  writeFileSync(join(out, 'README.md'), lines.join('\n'));
  console.log(`[w3] pairs: ${out}`);
});
