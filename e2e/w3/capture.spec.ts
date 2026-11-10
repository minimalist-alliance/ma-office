// W3's same-size captures for the judge. The same real public pages, the same client window, the Browser window at the same size
// on both desks: lossless frames and 100% crops of the same text, with a record of what each page actually showed. No judgement in
// the output. Writes to ~/ma-design-drafts/w3/<label>/ and the first desk's choice of pages to ~/ma-design-drafts/w3/pages.json,
// so the second desk tries the same ones first.
//
// See README.md here for how to run it. It skips unless W3_DESK is set. It never signs in to a third-party site, and never
// clicks anything on one: it only opens the address and reads the page.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { watch } from '../tests/lib';
import { sleep } from '../tests/streamlib';
import { writeLabelReadme } from './numbers';
import { callAnchor, callInfo, cdpEval, deployPages, pageUrl, removePages, whyNotUsable, type Anchor, type PageInfo } from './pages';
import { BrowserWin, CROP, SETTLE_MS, TestDesk, W3_ON, W3_SKIP, appVersion, channelHook, clientLoad, installProbe, loadW3User, pickDesk, signIn, w3Input } from './w3lib';

test.skip(!W3_ON, W3_SKIP);
test.setTimeout(60 * 60_000);

const PROFILES = [{ name: '1512x982@2', width: 1512, height: 982, scale: 2 }, { name: '1920x1080@1', width: 1920, height: 1080, scale: 1 }];

// In order. Sites may refuse a cloud address, so each has fallbacks, and the last is a page on the desk itself. Old, stable pages
// where there's a choice, because the two runs happen at different times.
const PAGES: Record<string, { what: string; candidates: string[]; fixture: string }> = {
  wikipedia: { what: 'a Wikipedia article', fixture: 'article.html', candidates: ['https://en.wikipedia.org/wiki/Typography', 'https://en.wikipedia.org/wiki/Printing_press', 'https://simple.wikipedia.org/wiki/Typography', 'https://www.gutenberg.org/files/1342/1342-h/1342-h.htm'] },
  dense: { what: 'a dense page with small text', fixture: 'article.html', candidates: ['https://news.ycombinator.com/front?day=2024-06-03', 'https://www.rfc-editor.org/rfc/rfc9110.html', 'https://man7.org/linux/man-pages/man7/socket.7.html', 'https://lite.cnn.com/'] },
  nonlatin: { what: 'a page with non-Latin text', fixture: 'nonlatin.html', candidates: ['https://ja.wikipedia.org/wiki/%E6%B4%BB%E7%89%88%E5%8D%B0%E5%88%B7', 'https://zh.wikipedia.org/wiki/%E6%B4%BB%E5%AD%97%E5%8D%B0%E5%88%B7%E8%A1%93', 'https://www.aozora.gr.jp/cards/000148/files/789_14547.html', 'https://ru.wikipedia.org/wiki/%D0%A2%D0%B8%D0%BF%D0%BE%D0%B3%D1%80%D0%B0%D1%84%D0%B8%D0%BA%D0%B0'] },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const fromDataUrl = (s: string) => Buffer.from(s.split(',')[1], 'base64');

for (const profile of PROFILES) {
  test(`W3 captures at ${profile.name}`, async ({ browser }) => {
    const inp = w3Input();
    const root = join(inp.out, inp.label);
    const dir = join(root, profile.name);
    mkdirSync(dir, { recursive: true });
    let desk = inp.deskId ? await TestDesk.resolve(inp.deskId) : null;
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.scale });
    await context.addInitScript(channelHook);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const w = watch(page);
    await signIn(context, page, loadW3User(inp), inp.url);
    const deskId = await pickDesk(page, w, inp);
    desk ??= await TestDesk.resolve(deskId);
    const d: TestDesk = desk;
    await page.evaluate(installProbe);
    const bw = new BrowserWin(page, deskId);
    const W = bw.W.bind(bw);
    const pagesFile = join(inp.out, 'pages.json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chosen: Record<string, any> = existsSync(pagesFile) ? JSON.parse(readFileSync(pagesFile, 'utf8')) : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record: any = { label: inp.label, profile, startedAt: new Date().toISOString(), desk: { instance: d.instance, deskId, type: d.type, amiId: d.ami }, client: { chrome: browser.version(), appVersion: await appVersion(page), load: clientLoad() }, pages: {} };
    const save = () => { writeFileSync(join(root, `capture-${profile.name}.json`), JSON.stringify(record, null, 2)); writeLabelReadme(root); };

    try {
      const units = await d.units();
      if (units.stream?.wanted === 'live' && !inp.allowBusy) throw new Error('another viewer is streaming on this desk. Wait, or W3_ALLOW_BUSY=1');
      record.desk.info = await d.info();
      record.leftoverTabsClosed = await deployPages(d);
      await bw.open();
      await bw.waitPicture(300_000);
      await bw.newTab();
      await sleep(1000);

      for (const [kind, spec] of Object.entries(PAGES)) {
        await test.step(kind, async () => {
          // Which page: the first that really shows, the first desk's choice leading.
          const lead: string[] = chosen[kind]?.url ? [chosen[kind].url] : [];
          const tries = [...new Set([...lead, ...spec.candidates, pageUrl(spec.fixture)])];
          const attempts: Record<string, unknown>[] = [];
          let info: PageInfo | null = null;
          let used = '';
          for (let i = 0; i < tries.length; i++) {
            await bw.go(tries[i]);
            await sleep(1500);
            // A page may go on loading for ever: past the limit, what it has is what it showed.
            await expect.poll(() => page.locator('.br-tab.active.loading').count(), { timeout: 45_000 }).toBe(0).catch(() => {});
            await sleep(2500);
            const r = await cdpEval<PageInfo>(d, callInfo);
            const why = whyNotUsable(r.value);
            attempts.push({ asked: tries[i], finalUrl: r.value?.url ?? null, title: r.value?.title ?? null, textLength: r.value?.textLength ?? null, textStart: r.value?.textStart ?? null, refused: why });
            if (!why) { info = r.value; used = tries[i]; break; }
            await page.screenshot({ path: join(dir, `${kind}-attempt${i + 1}.window.png`) });
          }
          const fixture = used === pageUrl(spec.fixture);
          const entry: Record<string, unknown> = { what: spec.what, asked: used, attempts, showed: info && { title: info.title, url: info.url, lang: info.lang, textLength: info.textLength, textStart: info.textStart, scrollHeight: info.scrollHeight }, fixture, sameAsFirstDesk: !chosen[kind]?.url || chosen[kind].url === used, firstDesk: chosen[kind]?.label ?? inp.label };
          record.pages[kind] = entry;
          save();
          if (!info) throw new Error(`${kind}: nothing showed, not even the fixture`);
          chosen[kind] ??= { url: used, label: inp.label, anchors: {} };

          // The page as it opens, whole.
          await page.mouse.move(2, 2);
          await sleep(SETTLE_MS);
          const pic = await bw.picture();
          entry.picture = pic;
          const hash0 = await W<string>('frameHash');
          const whole = await W<{ w: number; h: number; png: string }>('grab');
          const decoded = fromDataUrl(whole.png);
          writeFileSync(join(dir, `${kind}-top.decoded.png`), decoded);
          await page.screenshot({ path: join(dir, `${kind}-top.window.png`) });
          await sleep(4500);
          const hash1 = await W<string>('frameHash');
          entry.top = { streamSize: `${whole.w}x${whole.h}`, decodedSha: sha(decoded), stillAfter4500ms: hash0 === hash1 };

          // 100% crops of the same words, on what the member's screen would show and on the frame itself.
          const crops: Record<string, unknown> = {};
          for (const mode of ['small', 'body']) {
            const want: string | null = chosen[kind].url === used ? chosen[kind].anchors?.[mode] ?? null : null;
            let a = (await cdpEval<Anchor>(d, callAnchor(want, mode))).value;
            const foundSame = !want || !!a;
            if (!a && want) a = (await cdpEval<Anchor>(d, callAnchor(null, mode))).value;
            if (!a) { crops[mode] = { missing: 'no run of text at least 24 characters long' }; continue; }
            if (chosen[kind].url === used) { chosen[kind].anchors ??= {}; chosen[kind].anchors[mode] ??= a.anchor; }
            // The page has to be still before a crop. Re-reading the words' place used to scroll the page again right before the
            // screenshot, so a crop could follow a fresh scroll. So read without scrolling, and wait again while the page itself moves.
            // The stream can still show redrawn text doubled until its next keyframe: that's the stream's, and the crop keeps it.
            let at: Anchor = a;
            let settlePasses = 0;
            for (; settlePasses < 3; settlePasses++) {
              await sleep(SETTLE_MS);
              const now: Anchor | null = (await cdpEval<Anchor>(d, callAnchor(at.anchor, mode, false))).value;
              const moved = !now || now.scrollY !== at.scrollY || Math.abs(now.y - at.y) >= 1 || Math.abs(now.x - at.x) >= 1;
              if (now) at = now;
              if (!moved) break;
            }
            // Each crop starts where the words' block does, if that keeps the words inside it, so words that end a line don't leave it empty.
            const from = (deskW: number, pad: number) => Math.min(at.x - pad, Math.max(at.bx - pad, at.x + at.w + pad - deskW));
            const cssW = CROP.w / profile.scale, cssH = CROP.h / profile.scale;
            const c = bw.toClient(pic, from(cssW / pic.scale, 12), at.y);
            // The same number of device pixels on both desks, inside the picture.
            const clip = { x: Math.round(Math.max(pic.left, Math.min(pic.left + pic.width - cssW, c.x))), y: Math.round(Math.max(pic.top, Math.min(pic.top + pic.height - cssH, c.y - 16))), width: cssW, height: cssH };
            await page.screenshot({ path: join(dir, `${kind}-${mode}.crop-window.png`), clip });
            const fx = Math.round(Math.max(0, Math.min(pic.vw - CROP.w, from(CROP.w, 16)))), fy = Math.round(Math.max(0, Math.min(pic.vh - CROP.h, at.y - 16)));
            writeFileSync(join(dir, `${kind}-${mode}.crop-decoded.png`), fromDataUrl(await W<string>('grabCrop', { x: fx, y: fy, w: CROP.w, h: CROP.h })));
            crops[mode] = { anchor: at.anchor, sameWordsAsFirstDesk: foundSame, fontPx: at.fontPx, fontFamily: at.fontFamily, color: at.color, tag: at.tag, onDesk: { x: Math.round(at.x), y: Math.round(at.y), blockX: Math.round(at.bx) }, settled: settlePasses < 3, settlePasses: settlePasses + 1, windowClipCss: clip, decodedClip: { x: fx, y: fy, w: CROP.w, h: CROP.h } };
          }
          entry.crops = crops;
          writeFileSync(pagesFile, JSON.stringify(chosen, null, 2));
          save();
        });
      }
    } finally {
      record.finishedAt = new Date().toISOString();
      record.client.loadAtEnd = clientLoad();
      await bw.closeOwnTab().catch(() => {});
      await bw.close().catch(() => {});
      await removePages(d).catch(() => {});
      save();
      await context.close();
    }
  });
}
