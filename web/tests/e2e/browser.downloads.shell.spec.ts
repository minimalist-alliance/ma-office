// The Browser window's download line (LS-31, ADR 0092), on the mock desk, whose `browser.downloads` the test sets through
// `window.__maDeskMock.setDownloads`: a download going and saved, said once politely, gone after a few seconds, "Show in
// Files" only for a file the desk says is in Files, and nothing at all from a desk without the topic. Screenshots in all
// three themes.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

interface Download {
  id: string;
  name: string;
  state: 'inProgress' | 'completed' | 'canceled';
  receivedBytes: number;
  totalBytes: number;
  filesPath?: string;
}

interface Control {
  refuse: Record<string, string>;
  setDownloads(downloads: Download[]): void;
}

type Win = { __maDeskMock: Control };

const dl = (over: Partial<Download>): Download => ({ id: 'g1', name: 'quarterly-report.pdf', state: 'inProgress', receivedBytes: 0, totalBytes: 0, ...over });
const setDownloads = (page: Page, list: Download[]): Promise<void> => page.evaluate((l) => (window as unknown as Win).__maDeskMock.setDownloads(l), list);
const line = (page: Page) => page.getByTestId('browser-download');

async function open(page: Page, path = '/?fixture=one'): Promise<void> {
  await signIn(page, path);
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  // The window opens a moment after the desk is focused, and says so.
  await expect(page.getByTestId('browser-app')).toBeVisible();
  await expect(page.getByTestId('live-region')).toHaveText('Browser window opened');
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a download shows going, then saved, is said politely each way, and goes after a few seconds', async ({ page }) => {
  const errors = watchConsole(page);
  await open(page);
  await expect(line(page)).toHaveCount(0);
  await setDownloads(page, [dl({ receivedBytes: 1024, totalBytes: 4096 })]);
  await expect(line(page)).toHaveAttribute('data-kind', 'going');
  await expect(line(page)).toContainText('Downloading quarterly-report.pdf');
  await expect(line(page)).toContainText('25%');
  await expect(page.getByTestId('live-region')).toHaveText('Downloading quarterly-report.pdf');
  await setDownloads(page, [dl({ receivedBytes: 3072, totalBytes: 4096 })]);
  await expect(line(page)).toContainText('75%');
  await setDownloads(page, [dl({ state: 'completed', receivedBytes: 4096, totalBytes: 4096 })]);
  await expect(line(page)).toHaveAttribute('data-kind', 'saved');
  await expect(line(page)).toHaveText('Saved quarterly-report.pdf on your desk');
  await expect(page.getByTestId('live-region')).toHaveText('Saved quarterly-report.pdf on your desk');
  // Today's images save into the desk's own Downloads, which Files doesn't show: no button that would lead nowhere.
  await expect(line(page).getByRole('button')).toHaveCount(0);
  await expect(line(page)).toHaveCount(0, { timeout: 8000 });
  expect(errors).toEqual([]);
});

test('a name from the page is plain text', async ({ page }) => {
  await open(page);
  await setDownloads(page, [dl({ name: '<img src=x onerror=alert(1)>.pdf' })]);
  await expect(line(page)).toContainText('<img src=x onerror=alert(1)>.pdf');
  await expect(line(page).locator('img')).toHaveCount(0);
});

test('a download that had already finished when the window opened says nothing', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await setDownloads(page, [dl({ state: 'completed', receivedBytes: 10, totalBytes: 10 })]);
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(line(page)).toHaveCount(0);
});

test('"Show in Files" is there only for a file in Files, and opens the Files window', async ({ page, request }) => {
  await harness(request, { files: { enabled: true } });
  await open(page);
  await setDownloads(page, [dl({})]);
  await expect(line(page)).toHaveAttribute('data-kind', 'going');
  await setDownloads(page, [dl({ state: 'completed', receivedBytes: 1, totalBytes: 1, filesPath: 'Downloads/quarterly-report.pdf' })]);
  await expect(line(page)).toContainText('Saved quarterly-report.pdf to Files');
  await line(page).getByRole('button', { name: 'Show in Files' }).click();
  await expect(page.getByTestId('window-files')).toBeVisible();
});

test('a desk without downloads shows nothing and says nothing', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, '/?fixture=one');
  // The mock desk's module comes with the first link, a moment after the shell shows; the refusal only has to be there
  // before the Browser opens.
  await page.waitForFunction(() => '__maDeskMock' in window);
  await page.evaluate(() => {
    (window as unknown as Win).__maDeskMock.refuse['browser.downloads'] = 'not_found';
  });
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(line(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: screenshot of the line going and saved`, async ({ page }) => {
    await setTheme(page, theme);
    await open(page);
    await setDownloads(page, [dl({ receivedBytes: 2048, totalBytes: 4096 })]);
    await expect(line(page)).toContainText('50%');
    await page.waitForTimeout(250);
    await page.getByRole('dialog', { name: /Browser/ }).screenshot({ path: `test-results/shots/${theme}-browser-download-going.png` });
    await setDownloads(page, [dl({ state: 'completed', receivedBytes: 4096, totalBytes: 4096 })]);
    await expect(line(page)).toHaveAttribute('data-kind', 'saved');
    await page.waitForTimeout(250);
    await line(page).screenshot({ path: `test-results/shots/${theme}-browser-download-saved.png` });
  });
}
