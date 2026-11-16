// Courier's attachments over the desk's own bulk channel (Wave 3.1, deskd API.md §21 "Attachments"), and Requests' note for a
// member's desk not yet added (the Designer's flow 7), on the mock desk with Courier's switch on: Download (the browser's own
// download here, the bytes checked end to end), a dangerous type only after its second press, "Show" (the picture the desk
// redrew, from a blob URL of ours), an archive's list read without unpacking it, a refused message's raw download asking first
// since nothing is known of what it holds; Light, Zen and Dark with axe, and a 390 px phone. One worker per process (the harness).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const DESK = 'd-personal';

const win = (page: Page): Locator => page.getByTestId('courier-window');
const body = (page: Page): Locator => page.getByTestId('courier-body');
const thread = (page: Page): Locator => page.getByTestId('courier-thread');
const rows = (page: Page): Locator => body(page).locator('.courier-rows .courier-row');
const foot = (page: Page): Locator => page.getByTestId('courier-foot');

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked)'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const real = (errors: string[]): string[] => errors.filter((e) => !/Content Security Policy|frame is sandboxed/.test(e));

async function arrive(page: Page, request: APIRequestContext, o: { theme?: ThemeId; init?: Record<string, unknown> } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, { configExtra: { courier: { enabled: true }, links: { account: 'https://platform.localhost/account' } }, courier: null });
  if (o.init) await page.addInitScript((i) => ((window as unknown as { __maCourierMockInit: unknown }).__maCourierMockInit = i), o.init);
  // The browser's own download, not the save picker (which would wait for a person).
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await setTheme(page, o.theme ?? 'light');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  return errors;
}

async function openCourier(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Courier/ });
  await expect(tile).toHaveCount(1);
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(body(page)).toBeVisible();
}

async function wide(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await win(page).evaluate((el) => {
    const w = el.closest('.ma-window') as HTMLElement;
    w.style.width = '1100px';
    w.style.height = '760px';
  });
  await expect(body(page)).toHaveAttribute('data-cols', '3');
}

async function openRow(page: Page, name: string | RegExp): Promise<void> {
  await rows(page).filter({ hasText: name }).first().click();
  await expect(thread(page)).toBeVisible();
}

async function lane(page: Page, name: string): Promise<void> {
  await body(page).getByRole('navigation', { name: 'Lanes' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

/** The email card with this subject, opened. */
async function card(page: Page, subject: string): Promise<Locator> {
  const c = thread(page).locator('.courier-card', { hasText: subject }).first();
  if (!(await c.evaluate((el) => el.classList.contains('open')))) await c.locator('.courier-card-toggle').click();
  await expect(c).toHaveClass(/open/);
  return c;
}

const calls = (page: Page, m: string): Promise<{ p: Record<string, unknown> }[]> =>
  page.evaluate(([d, method]) => (window as unknown as { __maDeskMock: { courier: { desk(id: string): { control: { calls: { m: string; p: Record<string, unknown> }[] } } } } }).__maDeskMock.courier.desk(d!).control.calls.filter((c) => c.m === method), [DESK, m]);

test.afterEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('attachments over bulk', () => {
  test('Download writes the very bytes the desk named; a program only after its second press', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await openCourier(page);
    await wide(page);
    await openRow(page, 'Dana Ortiz');
    const c = await card(page, 'Garden plans');
    const [download] = await Promise.all([page.waitForEvent('download'), c.getByRole('button', { name: 'Download: garden-sketch.pdf' }).click()]);
    expect(download.suggestedFilename()).toBe('garden-sketch.pdf');
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 32).toString('utf8')).toContain('mock bytes of garden-sketch.pdf');
    await expect(foot(page)).toContainText('Downloaded garden-sketch.pdf.');
    expect((await calls(page, 'courier.attachment.read')).map((x) => x.p)).toEqual([{ messageId: expect.any(String), part: '2' }]);

    // A program: the first press asks, in place, and nothing is asked of the desk until the second.
    await c.getByRole('button', { name: 'Download: planting-tool.exe' }).click();
    const ask = c.locator('[data-danger="program"]').getByRole('group', { name: 'Download it anyway?' });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Download anyway' })).toBeFocused();
    expect((await calls(page, 'courier.attachment.read')).filter((x) => x.p['part'] === '3')).toEqual([]);
    const [program] = await Promise.all([page.waitForEvent('download'), ask.getByRole('button', { name: 'Download anyway' }).click()]);
    expect(program.suggestedFilename()).toBe('planting-tool.exe');
    expect((await calls(page, 'courier.attachment.read')).filter((x) => x.p['part'] === '3').map((x) => x.p['allowDanger'])).toEqual([true]);
    // Nothing in Spam or Trash is fetched: no Download there.
    expect(real(errors)).toEqual([]);
  });

  for (const theme of THEMES) {
    test(`${theme}: Show draws the desk's redrawn picture; Show files lists an archive without opening it`, async ({ page, request }) => {
      const errors = await arrive(page, request, { theme, init: { files: true } });
      await openCourier(page);
      await wide(page);
      await openRow(page, 'Dana Ortiz');
      const c = await card(page, 'Photos of the beds');
      // No preview until the press.
      expect(await calls(page, 'courier.attachment.image')).toEqual([]);
      await c.getByRole('button', { name: 'Show: beds.png' }).click();
      const img = c.getByTestId('courier-preview').locator('img');
      await expect(img).toBeVisible();
      expect(await img.getAttribute('src')).toMatch(/^blob:/);
      await expect(img).toHaveAttribute('alt', 'beds.png');
      expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
      // No Show for what isn't an image, or for a dangerous type.
      await expect(c.getByRole('button', { name: 'Show: plans.zip' })).toHaveCount(0);

      await c.getByRole('button', { name: 'Show files: plans.zip' }).click();
      const list = c.getByTestId('courier-archive').first();
      await expect(list).toContainText('3 files, read without opening it.');
      await expect(list.getByRole('list', { name: 'Files in plans.zip' })).toContainText('plans/beds.pdf');
      await expect(list).toContainText('Locked');
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierfiles-${theme}-show.png` });

      // An archive that holds a program: its list names it, and its Download still asks first.
      await c.getByRole('button', { name: 'Show files: tools.zip' }).click();
      const tools = c.locator('[data-danger="archive_programs"]').getByTestId('courier-archive');
      await expect(tools.locator('[data-danger="program"]')).toContainText('A program.');
      await c.getByRole('button', { name: 'Hide: beds.png' }).click();
      await expect(c.getByTestId('courier-preview')).toHaveCount(0);
      expect(real(errors)).toEqual([]);
    });
  }

  test('a message that couldn’t be read safely offers its raw download, asking first since nothing is known of it', async ({ page, request }) => {
    const errors = await arrive(page, request, { init: { files: true } });
    await openCourier(page);
    await wide(page);
    await lane(page, 'Other');
    await openRow(page, 'Parcel Service');
    const note = thread(page).locator('.courier-note', { hasText: 'This message couldn’t be read safely.' });
    await note.getByRole('button', { name: 'Download the message' }).click();
    const ask = note.getByRole('group', { name: 'Courier couldn’t look inside it. Download it anyway?' });
    await expect(ask).toBeVisible();
    expect(await calls(page, 'courier.message.raw')).toEqual([]);
    const [eml] = await Promise.all([page.waitForEvent('download'), ask.getByRole('button', { name: 'Download anyway' }).click()]);
    expect(eml.suggestedFilename()).toBe('Your parcel.eml');
    expect((await calls(page, 'courier.message.raw')).map((x) => x.p['allowDanger'])).toEqual([true]);
    expect(real(errors)).toEqual([]);
  });

  test('a 390 px phone: the presses are 44 px and nothing scrolls sideways', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, request, { init: { files: true } });
    await openCourier(page);
    await rows(page).filter({ hasText: 'Dana Ortiz' }).first().click();
    const c = await card(page, 'Photos of the beds');
    for (const name of ['Show: beds.png', 'Show files: plans.zip', 'Download: beds.png', 'Save to Files: beds.png']) {
      const b = c.getByRole('button', { name });
      await expect(b).toBeVisible();
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await c.getByRole('button', { name: 'Show: beds.png' }).click();
    await expect(c.getByTestId('courier-preview')).toBeVisible();
    expect(await body(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await axe(page)).toEqual([]);
    expect(real(errors)).toEqual([]);
  });
});

test.describe('Requests: a member’s desk you haven’t added (flow 7)', () => {
  for (const theme of THEMES) {
    test(`${theme}: the card's sealed mark, the note in the conversation, and Let in`, async ({ page, request }) => {
      const errors = await arrive(page, request, { theme, init: { memberRequest: true } });
      await openCourier(page);
      await wide(page);
      await lane(page, 'Requests');
      const req = body(page).locator('.courier-request', { hasText: 'Jules Park' });
      await expect(req.getByTestId('courier-request-member')).toHaveText(/A member’s desk you haven’t added/);
      await req.locator('.courier-request-open').click();
      const note = thread(page).getByTestId('courier-member-request');
      await expect(note).toContainText('A member’s desk you haven’t added');
      await expect(note).toContainText('Letting Jules in trusts their desk’s key as it is now. To be sure it’s Jules, compare safety numbers after.');
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierfiles-${theme}-member-request.png` });
      await thread(page).getByRole('group', { name: /Wants to reach you/ }).getByRole('button', { name: 'Let in' }).click();
      await expect(foot(page)).toContainText('Jules');
      expect((await calls(page, 'courier.request.decide')).map((x) => x.p['decision'])).toEqual(['let_in']);
      // Nothing else of the kind: a stranger's email in Requests has no such note.
      expect(real(errors)).toEqual([]);
    });
  }
});
