// The clipboard, both ways, through the real Browser window of the shipped app on staging's test host, on the real test
// desk (TD-209, handoffs 14 B, 15 B and 15 C; deskd API.md section 10). As desk-1, with the member's clipboard granted to
// the app's origin. Paste: the exact text with a newline and a tab, once, through the page's own paste event; 1,000,000
// bytes whole and 1,000,001 refused with the bar's line. Copy: a selection on the desk reaches the member's clipboard
// exactly, a copy then paste gets the new text, and a page's own write with no gesture doesn't. None of the text may be
// in the desk's journal or the console. The weekend's integration check (int-15c), made part of the gate by task 33.
//
//   npx playwright test tests/clipboard.spec.ts --output test-results-clipboard
//
// It shares stream.spec.ts's page server, and opens the Browser window as browser-window.spec.ts does, so never run it
// alongside either. The numbers go to screenshots/clipboard-report.json.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { APP, DESK_ID, deskTruth, focusTestDesk, loadUser, onDesk, signInApp, watch, type Watch } from './lib';
import { PAGES_DIR, deployPages, pageUrl, removePages, sleep, titleState } from './streamlib';

const REPORT = 'screenshots/clipboard-report.json';
const FAILURE_SHOT = 'screenshots/clipboard-failure.png';

// Two text boxes and a field at fixed desk pixels. The title says what the page holds: lengths and hashes, never text.
const CLIP_HTML = `<!doctype html><meta charset="utf-8"><title>clip</title>
<style>html,body{margin:0;background:#eef;font:20px sans-serif}textarea,input{position:fixed;font:16px monospace}
#dst{left:100px;top:100px;width:760px;height:400px}#src{left:1000px;top:100px;width:760px;height:400px}#fld{left:100px;top:600px;width:760px;height:60px}</style>
<body><textarea id="dst"></textarea><textarea id="src"></textarea><input id="fld" autocomplete="off">
<script>
const q = new URLSearchParams(location.search);
const dst = document.getElementById('dst'), src = document.getElementById('src'), fld = document.getElementById('fld');
src.value = q.get('copy') || '';
const sel = () => setTimeout(() => src.select(), 0);
src.addEventListener('focus', sel); src.addEventListener('mouseup', (e) => { e.preventDefault(); sel(); });
const s = { n: q.get('n') || '', r: q.get('r') || '', dp: 0, dl: 0, dh: '', fp: 0, fl: 0, fh: '', cp: 0, ng: 0, foc: 0 };
const hash = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
const pub = async () => { s.dl = dst.value.length; s.dh = await hash(dst.value); s.fl = fld.value.length; s.fh = await hash(fld.value); s.foc = document.hasFocus() ? 1 : 0; s.ae = (document.activeElement && document.activeElement.id) || ''; document.title = 'K' + JSON.stringify(s).replaceAll('"', '~'); };
dst.addEventListener('paste', () => { s.dp++; });
fld.addEventListener('paste', () => { s.fp++; });
document.addEventListener('copy', () => { s.cp++; pub(); });
addEventListener('input', pub, true);
setInterval(pub, 400); pub();
if (q.get('ng')) setTimeout(async () => { try { await navigator.clipboard.writeText(q.get('ng')); s.ng = 1; } catch (e) { s.ng = -1; } pub(); }, +(q.get('after') || 6000));
</script></body>`;

type ClipState = { ae?: string; n: string; r: string; dp: number; dl: number; dh: string; fp: number; fl: number; fh: string; cp: number; ng: number; foc: number };
const h16 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16);

const report: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  report[k] = v;
  console.log(`[clipboard] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
};

let context: BrowserContext;
let page: Page;
let w: Watch;
let pagesUp = false;
let tabToClose: Locator | null = null;

test.setTimeout(8 * 60_000);

test.beforeAll(async ({ browser }) => {
  mkdirSync('screenshots', { recursive: true });
  const truth = await deskTruth();
  expect(truth.deskId).toBe(DESK_ID);
  note('desk', { deskId: truth.deskId, deskdVersion: truth.deskdVersion, rtcVersion: truth.rtcVersion });
  await deployPages();
  pagesUp = true;
  const out = await onDesk(`echo ${Buffer.from(CLIP_HTML).toString('base64')} | base64 -d > ${PAGES_DIR}/clip.html && chmod 644 ${PAGES_DIR}/clip.html && curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' ${pageUrl('clip.html')}`);
  if (!out.includes('HTTP=200')) throw new Error('clip.html not served');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  page = await context.newPage();
  w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  note('at the failure', { text: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300) });
  await page.screenshot({ path: FAILURE_SHOT }).catch(() => {});
});

test.afterAll(async () => {
  note('console errors', w?.errors ?? []);
  await tabToClose?.click({ timeout: 5000 }).catch(() => {});
  await page?.getByRole('dialog', { name: /Browser/ }).getByRole('button', { name: 'Close Browser', exact: true }).click({ timeout: 5000 }).catch(() => {});
  await context?.close();
  if (pagesUp) await removePages().catch((e: Error) => note('removePages failed', e.message.slice(0, 200)));
});

test('paste and copy through the real Browser window', async () => {
  const win = page.getByRole('dialog', { name: /Browser/ });
  const video = win.getByLabel("The page in this desk's browser", { exact: true });
  const keys = win.getByLabel("Keyboard for the page in this desk's browser", { exact: true });
  const address = win.getByRole('textbox', { name: 'Address' });
  const tabs = win.getByTestId('browser-tab');
  const activeTab = win.getByRole('tab', { selected: true });
  const nonce = randomBytes(4).toString('hex');
  const member = {
    set: (t: string) => page.evaluate((x) => navigator.clipboard.writeText(x), t),
    get: () => page.evaluate(() => navigator.clipboard.readText()),
  };

  async function state(ok: (s: ClipState) => boolean = () => true, ms = 10_000): Promise<ClipState | null> {
    const t0 = Date.now();
    let last: ClipState | null = null;
    while (Date.now() - t0 < ms) {
      const s = titleState<ClipState>((await activeTab.getAttribute('title', { timeout: 2000 }).catch(() => null)) ?? undefined, 'K');
      if (s && s.n === nonce) { last = s; if (ok(s)) return s; }
      await sleep(150);
    }
    return last;
  }
  let toViewport: (x: number, y: number) => { x: number; y: number } = () => { throw new Error('no picture yet'); };
  const clickAt = async (x: number, y: number) => {
    // The picture's place now: a line in the bar can move it.
    const b = await video.evaluate((v: HTMLVideoElement) => { const r = v.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, vw: v.videoWidth, vh: v.videoHeight }; });
    const scale = Math.min(b.width / b.vw, b.height / b.vh);
    toViewport = (px, py) => ({ x: b.left + (b.width - b.vw * scale) / 2 + px * scale, y: b.top + (b.height - b.vh * scale) / 2 + py * scale });
    const c = toViewport(x, y);
    await page.mouse.move(c.x, c.y);
    await page.mouse.click(c.x, c.y);
  };

  const go = async (path: string) => {
    await address.click();
    await address.fill(pageUrl(path));
    await address.press('Enter');
  };
  // Each page after the first has its own r, which its title carries: until it shows, the title is the last page's, and a
  // click would land on a page still loading.
  const load = async (r: string, query = '') => {
    await go(`clip.html?n=${nonce}&r=${r}${query}`);
    expect((await state((s) => s.r === r, 30_000))?.r, `page ${r} loaded`).toBe(r);
  };
  // The copied box, focused on the desk's page: a click selects all of it. Asked again if the page didn't take the click.
  const focusSource = async (): Promise<ClipState | null> => {
    let got: ClipState | null = null;
    for (let i = 0; i < 3 && got?.ae !== 'src'; i++) {
      await clickAt(1380, 300);
      got = await state((s) => s.ae === 'src', 3000);
    }
    expect(got?.ae, 'the copied box has the focus on the desk').toBe('src');
    return got;
  };

  await test.step('open the Browser window on the test desk, with a page of text boxes', async () => {
    const deskName = await focusTestDesk(page, w);
    const deskProxy = page.locator(`#proxy-${DESK_ID}`);
    await deskProxy.focus();
    await page.keyboard.press('Enter');
    const tile = deskProxy.locator('..').getByRole('button', { name: /^Browser/ });
    let box = await tile.boundingBox();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const now = await tile.boundingBox();
      if (now && JSON.stringify(now) === JSON.stringify(box)) break;
      box = now;
    }
    if (!box) throw new Error('no Browser tile on the test desk');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(150);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(win).toBeVisible({ timeout: 15_000 });
    await expect(win.getByRole('heading', { name: /^Browser/ })).toContainText(deskName);
    await expect(win.getByTestId('browser-panel')).toHaveCount(0, { timeout: 90_000 });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBe(1920);
    await expect.poll(() => tabs.count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const before = await tabs.count();
    await win.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 20_000 });
    tabToClose = tabs.filter({ has: page.getByRole('tab', { selected: true }) }).getByRole('button', { name: /^Close K\{/ });
    await address.click();
    await address.fill(pageUrl(`clip.html?n=${nonce}&copy=${encodeURIComponent(`desk copy check: ü 中文 🎉 ${nonce}`)}`));
    await address.press('Enter');
    expect((await state(() => true, 30_000))?.n, 'the page loaded').toBe(nonce);
    const b = await video.evaluate((v: HTMLVideoElement) => { const r = v.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, vw: v.videoWidth, vh: v.videoHeight }; });
    const scale = Math.min(b.width / b.vw, b.height / b.vh);
    toViewport = (x, y) => ({ x: b.left + (b.width - b.vw * scale) / 2 + x * scale, y: b.top + (b.height - b.vh * scale) / 2 + y * scale });
  });

  const plain = `ma clipboard check: é 漢字 👍\n\tsecond line ${nonce}`;
  await test.step('paste: the exact text, newline and tab, once, through the page\'s own paste event', async () => {
    await member.set(plain);
    await clickAt(480, 300);
    await expect(keys, 'the stream has the keyboard').toBeFocused();
    await sleep(300);
    const t0 = Date.now();
    await page.keyboard.press('Control+v');
    const got = await state((s) => s.dl > 0, 20_000);
    note('paste plain', { ms: Date.now() - t0, pasteEvents: got?.dp, length: got?.dl, expectedLength: plain.length, hashOk: got?.dh === h16(plain) });
    expect(got?.dh, 'the textarea holds exactly the text').toBe(h16(plain));
    expect(got?.dp, "the page's own paste handler ran, once").toBe(1);
  });

  await test.step('paste: 1,000,000 bytes land whole, and 1,000,001 is refused with the line', async () => {
    // A fresh copy of the page, so the box starts empty.
    await load('2');
    expect((await state((s) => s.dl === 0 && s.dp === 0, 20_000))?.dl, 'a fresh page').toBe(0);
    await clickAt(480, 300);
    await sleep(300);
    const big = 'a'.repeat(1_000_000);
    await member.set(big);
    const t0 = Date.now();
    await page.keyboard.press('Control+v');
    const got = await state((s) => s.dl === 1_000_000, 40_000);
    note('paste 1,000,000', { ms: Date.now() - t0, length: got?.dl, hashOk: got?.dh === h16(big), pasteEvents: got?.dp });
    expect(got?.dh, 'a million bytes, whole').toBe(h16(big));

    await member.set(big + 'a');
    await page.keyboard.press('Control+v');
    await expect(win.getByText("That's too much text to paste at once."), 'the bar says so').toBeVisible({ timeout: 10_000 });
    await sleep(2000);
    const after = await state();
    note('paste 1,000,001', { length: after?.dl, pasteEvents: after?.dp });
    expect(after?.dl, 'nothing typed').toBe(1_000_000);
  });

  const copied = `desk copy check: ü 中文 🎉 ${nonce}`;
  await test.step('copy: selected text on the desk, Ctrl+C, reaches the member\'s clipboard exactly', async () => {
    await load('3', `&copy=${encodeURIComponent(copied)}`);
    await member.set(`before ${nonce}`);
    await focusSource();
    await sleep(600);
    const t0 = Date.now();
    await page.keyboard.press('Control+c');
    let got = '';
    await expect.poll(async () => (got = await member.get()), { timeout: 10_000 }).toBe(copied);
    note('copy', { ms: Date.now() - t0, exact: got === copied, deskCopyEvents: (await state())?.cp });
  });

  await test.step('copy, then paste at once: the field gets what was just copied', async () => {
    // Keys only between the two: Tab moves the desk's focus from the copied box to the field, as a keyboard user does.
    await load('5', `&copy=${encodeURIComponent(copied)}`);
    await member.set(`stale ${nonce}`);
    const before = await focusSource();
    await page.keyboard.press('Control+a');
    await sleep(2500); // past the click's own 2 s window
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Control+v');
    const got = await state((s) => s.fl > 0, 20_000);
    note('copy then paste (Tab)', { focusBefore: before?.ae, focusAfter: got?.ae, length: got?.fl, hashOk: got?.fh === h16(copied), staleHash: got?.fh === h16(`stale ${nonce}`) });
    expect(got?.fh, 'the field holds what was just copied').toBe(h16(copied));
  });

  await test.step('observed only: copy, a click into another field, and paste, all at machine speed', async () => {
    await load('6', `&copy=${encodeURIComponent(copied)}`);
    await member.set(`stale ${nonce}`);
    await focusSource();
    await sleep(2500);
    await page.keyboard.press('Control+c');
    await clickAt(480, 630);
    await page.keyboard.press('Control+v');
    const got = await state((s) => s.fl > 0, 20_000);
    note('observed: copy, click, paste at once', { gotCopy: got?.fh === h16(copied), gotStale: got?.fh === h16(`stale ${nonce}`), memberNow: (await member.get()) === copied ? 'copy' : 'other' });
  });

  await test.step("copy with no gesture: a page's own write doesn't reach the member's clipboard", async () => {
    await member.set(`untouched ${nonce}`);
    await load('4', `&ng=${encodeURIComponent(`no gesture ${nonce}`)}&after=6000`);
    // Focus on the page with a click well before its timer, so that click's 2 s window is long gone when the page writes.
    await clickAt(480, 300);
    const wrote = await state((s) => s.ng !== 0, 15_000);
    await sleep(3000);
    const now = await member.get();
    // Measured, not a gate: on the kiosk the page's own write has never settled (0 here and in the weekend's runs), so
    // this shows that nothing reached the member, and not yet that a write on the desk was kept from them.
    note('copy, no gesture', { pageWrote: wrote?.ng, memberUnchanged: now === `untouched ${nonce}` });
    expect(now, "the member's clipboard is as it was").toBe(`untouched ${nonce}`);
  });

  await test.step('nothing kept: no text in the desk journal, nor in the console', async () => {
    // Only the texts as they were on the clipboard: the page server logs its URLs, which carry the nonce and encoded copies.
    const count = await onDesk(`journalctl --since -20min --no-pager | grep -c -e 'ma clipboard check' -e 'desk copy check' -e 'no gesture ' || true`);
    note('journal lines with the text', count.trim());
    expect(count.trim()).toBe('0');
    expect(w.errors.filter((e) => e.includes(nonce) || e.includes('clipboard check')), 'console').toEqual([]);
  });
});
