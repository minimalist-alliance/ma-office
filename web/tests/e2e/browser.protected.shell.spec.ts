// The Browser window's note when protected playback fails (TD-225), on the mock desk, whose tab gets the desk's
// `protectedMedia {at, keySystem}` through `window.__maDeskMock.protectedFailed` (deskd da3738de): the note's words and link,
// tied to its tab, dismissal that sticks for the site, nothing from a desk without the event. Screenshots in all three themes.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

type Win = { __maDeskMock: { protectedFailed(tabId: string, keySystem?: string): void; setTabs(tabs: unknown[]): void; tabs: Array<Record<string, unknown>> } };
const WORDS = 'This video is protected, so it can’t play on a desk.';
const note = (page: Page) => page.getByTestId('browser-protected');
/** The tab is on `url`, and the desk says the page was refused protected playback. */
const fail = (page: Page, tabId: string, url: string): Promise<void> =>
  page.evaluate(([t, u]) => {
    const m = (window as unknown as Win).__maDeskMock;
    m.setTabs(m.tabs.map((x) => (x['tabId'] === t ? { ...x, url: u } : x)));
    m.protectedFailed(t!);
  }, [tabId, url]);

async function open(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-app')).toBeVisible();
  await expect(page.getByTestId('live-region')).toHaveText('Browser window opened');
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the note says its words, the link opens the page on this device, and it dismisses for the site', async ({ page, context }) => {
  const errors = watchConsole(page);
  // No network here: the member's own browser is stood in for by a fulfilled route.
  await context.route('https://video.example.org/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>x</title>' }));
  await open(page);
  await expect(note(page)).toHaveCount(0);
  await fail(page, 't1', 'https://video.example.org/watch?v=1');
  await expect(note(page)).toHaveText(`${WORDS}Open on this device`);
  const [popup] = await Promise.all([context.waitForEvent('page'), note(page).getByRole('button', { name: 'Open on this device' }).click()]);
  await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  expect(popup.url()).toContain('video.example.org/watch?v=1');
  await popup.close();
  await note(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(note(page)).toHaveCount(0);
  // The same site again, another page of it: nothing.
  await fail(page, 't1', 'https://video.example.org/watch?v=2');
  await page.waitForTimeout(300);
  await expect(note(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the note belongs to its tab', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const m = (window as unknown as Win).__maDeskMock;
    m.setTabs([...m.tabs, { tabId: 't2', url: 'https://other.example.net/', title: 'Other', loading: false, active: false, canGoBack: false, canGoForward: false }]);
  });
  await fail(page, 't2', 'https://other.example.net/');
  await expect(note(page)).toHaveCount(0);
  await page.evaluate(() => {
    const m = (window as unknown as Win).__maDeskMock;
    m.setTabs(m.tabs.map((t) => ({ ...t, active: t['tabId'] === 't2' })));
  });
  await expect(note(page)).toHaveAttribute('data-tab', 't2');
  await page.evaluate(() => {
    const m = (window as unknown as Win).__maDeskMock;
    m.setTabs(m.tabs.map((t) => ({ ...t, active: t['tabId'] === 't1' })));
  });
  await expect(note(page)).toHaveCount(0);
  // A new page in the tab: the desk drops the field, and the note goes.
  await page.evaluate(() => {
    const m = (window as unknown as Win).__maDeskMock;
    m.setTabs(m.tabs.map((t) => ({ ...t, active: t['tabId'] === 't2', url: 'https://other.example.net/next', protectedMedia: undefined })));
  });
  await expect(note(page)).toHaveCount(0);
});

test('a desk without the field shows nothing and says nothing', async ({ page }) => {
  const errors = watchConsole(page);
  await open(page);
  await page.waitForTimeout(300);
  await expect(note(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: screenshot of the note`, async ({ page }) => {
    await setTheme(page, theme);
    await open(page);
    await fail(page, 't1', 'https://video.example.org/watch?v=1');
    await expect(note(page)).toBeVisible();
    await page.waitForTimeout(250);
    await page.getByRole('dialog', { name: /Browser/ }).screenshot({ path: `test-results/shots/${theme}-browser-protected.png` });
  });
}
