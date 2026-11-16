// Screenshots of the account button's avatar for the Designer's and the owner's read (the account-menu avatar pass, Nov 16):
// the top bar's right end and the menu's 40 px header, in Light, Zen and Dark, for the initials, a checked picture and a
// built avatar, with no seal, the Officer's and the Founder's. Desktop 1440 x 900, a phone 390 x 844 (touch), and a short
// landscape phone 844 x 390 (touch, the 36 px bar), all at device scale 2, the menu's header at each of them (`menu-*`,
// desktop's without the size in its name). Nobody's real data: the picture is drawn here.
// Skipped unless AVATAR_SHOTS names the folder, so it never runs in the suite:
//   AVATAR_SHOTS=/abs/dir MA_PW_PORT=4373 npx playwright test --project=shell avatar.shots
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const OUT = process.env['AVATAR_SHOTS'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const A = 'd-personal00001';
const layout = { desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] } }, z: [A] };
const RECIPE = { kind: 'built', kit: 1, skin: 4, face: 'smile', hair: 'curly-short', hairColor: 1, top: 'crew', topColor: 2, bg: 0 };
const PICTURE = `https://api.avatar.test/v1/public/avatars/im_${'a'.repeat(26)}`;
const KINDS = {
  initials: null,
  picture: { kind: 'upload', url: PICTURE, setAt: '2026-11-09T10:00:00Z' },
  built: { kind: 'built', config: RECIPE, setAt: '2026-11-09T10:00:00Z' },
} as const;
const SEALS = { none: { status: 'active', tier: 'alliance' }, officer: { status: 'active', tier: 'officer', badge: 'officer' }, lead: { status: 'active', tier: 'lead', badge: 'lead' } } as const;
const VIEWS: Record<string, BrowserContextOptions> = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  short: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
};

test.skip(!OUT, 'AVATAR_SHOTS names the folder for the screenshots');
test.describe.configure({ timeout: 600_000 });

/** A portrait stand-in, drawn by the browser: soft shapes on a gradient, no face, nobody's photo. */
async function pictureBytes(browser: Browser): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await p.setContent(
    '<body style="margin:0"><div style="position:relative;width:256px;height:256px;overflow:hidden;background:linear-gradient(160deg,#9db4cf,#4d6584)">' +
      '<div style="position:absolute;left:78px;top:46px;width:100px;height:118px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#e3c3a6,#b98d6c)"></div>' +
      '<div style="position:absolute;left:70px;top:30px;width:116px;height:64px;border-radius:58px 58px 20px 20px;background:#3a2f2a"></div>' +
      '<div style="position:absolute;left:28px;top:176px;width:200px;height:140px;border-radius:50%;background:#2c3e57"></div></div></body>',
  );
  const png = await p.screenshot();
  await p.close();
  return png;
}

async function settled(page: Page, kind: keyof typeof KINDS): Promise<void> {
  const face = page.getByRole('button', { name: 'Account', exact: true }).locator('.avatar-face');
  if (kind === 'initials') await expect(face).toHaveAttribute('data-initials', 'TM');
  else await expect.poll(() => face.locator('img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0).catch(() => false)).toBe(true);
  await page.waitForTimeout(150);
}

for (const [view, options] of Object.entries(VIEWS)) {
  for (const theme of THEMES) {
    test(`avatar shots, ${view}, ${theme}`, async ({ browser, request }, info) => {
      mkdirSync(OUT, { recursive: true });
      const png = await pictureBytes(browser);
      const context = await browser.newContext({ ...options, deviceScaleFactor: 2, bypassCSP: true, baseURL: info.project.use.baseURL! });
      const page = await context.newPage();
      await page.route('https://api.avatar.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
      await setTheme(page, theme);
      await page.addInitScript((d) => {
        if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v2', d);
      }, JSON.stringify(layout));
      await harness(request, { reset: true });
      await harness(request, { fleet: [{ deskId: A, name: 'Personal', kind: 'personal', state: 'running', allowedActions: ['connect', 'stop', 'rename'] }] });
      await signIn(page);
      await canvasPainted(page);
      const account = page.getByRole('button', { name: 'Account', exact: true });
      for (const [kind, avatar] of Object.entries(KINDS) as [keyof typeof KINDS, (typeof KINDS)[keyof typeof KINDS]][]) {
        for (const [seal, membership] of Object.entries(SEALS)) {
          await harness(request, { avatar, membership });
          await page.reload();
          await canvasPainted(page);
          await settled(page, kind);
          const bar = (await page.locator('.topbar').boundingBox())!;
          const btn = (await account.boundingBox())!;
          const width = Math.min(bar.width, view === 'desktop' ? 360 : 300);
          await page.screenshot({ path: `${OUT}/bar-${view}-${theme}-${kind}-${seal}.png`, clip: { x: bar.x + bar.width - width, y: bar.y, width, height: bar.height } });
          // The button alone, 8 px round it, for a close look.
          await page.screenshot({ path: `${OUT}/button-${view}-${theme}-${kind}-${seal}.png`, clip: { x: btn.x - 8, y: btn.y - 8, width: btn.width + 16, height: btn.height + 16 } });
          // The menu's 40 px header at every size (desktop only until the release 6.8 brand review).
          await account.click();
          const head = page.locator('.menu-me');
          await expect(head).toBeVisible();
          if (kind !== 'initials') await expect.poll(() => head.locator('img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0).catch(() => false)).toBe(true);
          await page.waitForTimeout(150);
          const h = (await head.boundingBox())!;
          await page.screenshot({ path: `${OUT}/menu-${view === 'desktop' ? '' : `${view}-`}${theme}-${kind}-${seal}.png`, clip: { x: h.x - 12, y: bar.y, width: Math.max(h.width + 24, bar.x + bar.width - h.x + 12), height: h.y + h.height + 8 - bar.y } });
          await page.keyboard.press('Escape');
        }
      }
      // Hover and open, the Founder's built avatar.
      await harness(request, { avatar: KINDS.built, membership: SEALS.lead });
      await page.reload();
      await canvasPainted(page);
      await settled(page, 'built');
      const btn = (await account.boundingBox())!;
      const clip = { x: btn.x - 8, y: btn.y - 8, width: btn.width + 16, height: btn.height + 16 };
      if (view === 'desktop') {
        await account.hover();
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/state-${view}-${theme}-hover.png`, clip });
        await account.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await page.mouse.move(0, 400);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/state-${view}-${theme}-focus.png`, clip });
      }
      await account.click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/state-${view}-${theme}-open.png`, clip });
      await context.close();
    });
  }
}
