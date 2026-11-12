// Site sign-ins on desks (#11, S-142), the office's side, on the mock desk (`desk/mockSignIns.ts`, deskd API.md section 10
// "Signing in"): the key, the Extensions menu and its pins, More's rows under 720 px of bar, the Passwords and sign-ins
// panel (a manager added only after asking, the passwords file sent over the desk link's `bulk` only, Passkeys, where
// they're kept, and Stop where the desk serves it), and nothing of it on an older deskd, for a teen, or with the kill
// switch. Light, Zen and Dark, a 640 px window, and a 390 px phone.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const BW = 'nngceckbapebfimnlniiiahkandclblb';
const OP = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';

type Win = {
  __maDeskMock: {
    rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
    tabs: Array<{ url: string; active: boolean }>;
    signIns: {
      serves: boolean;
      extensions: { id: string; name: string; state: string; open: boolean }[];
      install(id: string): void;
      stopServed: boolean;
      saved: number;
      imports: { size: number; frames: number[]; rows: number; zeroed: boolean }[];
      alreadySaved: number;
      holdFinish: boolean;
      releaseFinish(): void;
    };
  };
};

/** A fake password no real export would hold, to look for anywhere it mustn't be. */
const FAKE_PW = 'Fake-Pw-q7Zk2-not-real';
const csv = (rows: number, pad = 0): Buffer => {
  const lines = ['name,url,username,password,note'];
  for (let i = 0; i < rows; i += 1) lines.push(`Site ${i},https://site${i}.example/,member${i}@example.com,${FAKE_PW}${i},${'x'.repeat(pad)}`);
  return Buffer.from(`${lines.join('\n')}\n`);
};

const key = (page: Page) => page.getByTestId('browser-key');
const panel = (page: Page) => page.getByRole('complementary', { name: 'Passwords and sign-ins' });
const rpc = (page: Page) => page.evaluate(() => (window as unknown as Win).__maDeskMock.rpc.map((r) => ({ m: r.m, p: r.p, idem: r.options?.idem })));
const setUp = (page: Page, fn: string, arg?: unknown): Promise<void> =>
  page.evaluate(
    ([f, a]) => {
      const s = (window as unknown as Win).__maDeskMock.signIns;
      if (f === 'installed') s.extensions = s.extensions.map((e) => (e.id === a ? { ...e, state: 'installed' } : e));
      if (f === 'old') s.serves = false;
      if (f === 'stop') s.stopServed = true;
      if (f === 'hold') s.holdFinish = true;
      if (f === 'already') s.alreadySaved = a as number;
    },
    [fn, arg] as const,
  );

async function openBrowser(page: Page, before: Array<[string, unknown?]> = []): Promise<void> {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  for (const [fn, arg] of before) await setUp(page, fn, arg);
  await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-app')).toBeVisible();
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('the key and the panel', () => {
  test('with no manager, the key is "Passwords" and opens the panel at its title; Esc gives focus back to the key', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page);
    await expect(key(page)).toHaveAccessibleName('Passwords');
    await expect(key(page)).toHaveAttribute('title', 'Passwords');
    await expect(page.getByTestId('browser-extensions')).toHaveCount(0);
    await key(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Passwords and sign-ins', level: 2 })).toBeFocused();
    await expect(key(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByTestId('pw-manager')).toHaveText(['Bitwardenby Bitwarden Inc.Add', '1Passwordby AgileBits Inc.Add', 'Proton Passby Proton AGAdd']);
    await expect(panel(page)).toContainText('A password manager fills in your passwords and passkeys on this desk, and keeps them in step with your other devices through its own account.');
    await expect(panel(page)).toContainText('Each is made by its own company, under its own terms. You sign in to it in its own window, on the desk.');
    await expect(panel(page)).toContainText('Export your passwords from Chrome, Edge, Safari or Firefox as a CSV file, then choose it here. Your desk adds them to this Browser and deletes the file.');
    await expect(panel(page)).toContainText('The file goes to your desk over its encrypted connection, and is deleted there once it’s read.');
    await expect(panel(page)).toContainText('With a password manager here, sites can make and use passkeys on this desk. A passkey on your phone, or a security key, can\'t reach a desk: when a site asks for one of those, choose another way to sign in.');
    await expect(panel(page)).toContainText('Passwords saved in this desk’s Browser stay on this desk, on its encrypted disk and in its daily snapshots, as your signed-in sessions do. Our systems don’t read them in normal operation. An honest limit, in our privacy page, says what full admin access could do.');
    await expect(panel(page)).toContainText('A password manager also keeps your passwords in its own account, under its own terms.');
    await expect(panel(page).getByRole('link', { name: 'An honest limit' })).toHaveAttribute('href', 'https://minimalistalliance.com/privacy#an-honest-limit');
    // Stop needs a count today's deskd doesn't serve.
    await expect(page.getByTestId('pw-stop')).toHaveCount(0);
    // Focus isn't trapped: the page beside it stays usable.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(key(page)).toBeFocused();
    await expect(key(page)).toHaveAttribute('aria-pressed', 'false');
    // The key again, and ✕.
    await key(page).click();
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(key(page)).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('adding a manager asks first, in place; yes opens its Web Store page on the desk, and once it’s in, it’s the key', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page);
    await key(page).click();
    await panel(page).getByRole('button', { name: 'Add Bitwarden' }).click();
    const ask = page.getByTestId('pw-ask');
    await expect(ask.getByText('Add Bitwarden to this desk?')).toBeFocused();
    await expect(ask).toContainText('Bitwarden will be able to read and change every page you open in this desk’s Browser. That’s how it fills in your sign-ins. It’s made by Bitwarden Inc., not by Minimalist Alliance.');
    // Nothing is asked of the desk until the member says yes.
    expect((await rpc(page)).some((r) => r.m === 'browser.extension.open')).toBe(false);
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Add Bitwarden' }).click();
    await page.getByTestId('pw-ask').getByRole('button', { name: 'Continue' }).click();
    // The Web Store page is on screen as the member's own tab; Add there is their own click, so the panel steps aside.
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByTestId('browser-address')).toHaveValue(`https://chromewebstore.google.com/detail/${BW}`);
    const open = (await rpc(page)).filter((r) => r.m === 'browser.extension.open');
    expect(open).toHaveLength(1);
    expect(open[0]?.p).toEqual({ id: BW });
    expect(open[0]?.idem).toMatch(/^[0-9a-f-]{36}$/);
    // The member clicks Add on the desk. Nothing tells the office, which asks the list until it's in; the first one in is pinned.
    await page.evaluate((id) => (window as unknown as Win).__maDeskMock.signIns.install(id), BW);
    await expect(key(page)).toHaveAccessibleName('Bitwarden, password manager');
    await expect(page.getByTestId('browser-extensions')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the key opens Bitwarden’s page on the desk, the bar names it, and the key again closes it', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page, [['installed', BW]]);
    await expect(key(page)).toHaveAccessibleName('Bitwarden, password manager');
    await key(page).click();
    await expect(key(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(key(page)).toHaveClass(/\bon\b/);
    // Its tab isn't one of the member's, so no tab is active: the address names the manager.
    await expect(page.getByTestId('browser-address')).toHaveValue('');
    await expect(page.getByTestId('browser-address')).toHaveAttribute('placeholder', 'Bitwarden');
    await key(page).click();
    await expect(key(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('browser-address')).toHaveValue('https://example.org/');
    const calls = (await rpc(page)).filter((r) => r.m.startsWith('browser.extension.'));
    expect(calls.map((c) => [c.m, c.p])).toEqual([
      ['browser.extension.open', { id: BW }],
      ['browser.extension.close', { id: BW }],
    ]);
    expect(errors).toEqual([]);
  });
});

test.describe('Extensions and More', () => {
  test('the menu: the manager’s row, its pin, Add a password manager, Passwords and sign-ins, and the menu’s keys', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page, [['installed', BW]]);
    const button = page.getByTestId('browser-extensions');
    await expect(button).toHaveAccessibleName('Extensions');
    await button.click();
    const menu = page.getByRole('menu', { name: 'Extensions on this desk' });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Extensions on this desk');
    await expect(menu.getByRole('menuitem', { name: 'Bitwarden by Bitwarden Inc.' })).toBeFocused();
    const pin = menu.getByRole('menuitemcheckbox', { name: 'Show Bitwarden in the bar' });
    await expect(pin).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Add a password manager' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Passwords and sign-ins' })).toBeVisible();
    await expect(menu).toContainText('Only extensions on our list can be added here. Each one can read and change the pages you open on this desk.');
    // Arrows, End and Home move; the pin is a checkbox item that stays in the menu.
    await page.keyboard.press('ArrowDown');
    await expect(pin).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pin).toHaveAttribute('aria-checked', 'false');
    await expect(key(page)).toHaveAccessibleName('Passwords');
    await page.keyboard.press('Space');
    await expect(pin).toHaveAttribute('aria-checked', 'true');
    await expect(key(page)).toHaveAccessibleName('Bitwarden, password manager');
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Passwords and sign-ins' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitem', { name: 'Bitwarden by Bitwarden Inc.' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    // From the keyboard, Esc gives the button back (from a press, what had focus before, as the quality menu does).
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: 'Bitwarden by Bitwarden Inc.' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    // Add a password manager: the panel, with the others to add, and the installed one's own line.
    await button.click();
    await page.getByRole('menuitem', { name: 'Add a password manager' }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByTestId('pw-manager')).toHaveText(['BitwardenOn this deskOpen', '1Passwordby AgileBits Inc.Add', 'Proton Passby Proton AGAdd']);
    await expect(panel(page)).toContainText('Sign in to Bitwarden in its window to fill in your passwords here. It keeps them in step with your other devices through your Bitwarden account.');
    // From the key's side, only the installed one (still 17).
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await button.click();
    await page.getByRole('menuitem', { name: 'Passwords and sign-ins' }).click();
    await expect(panel(page).getByTestId('pw-manager')).toHaveText(['BitwardenOn this deskOpen']);
    // Open, from the panel: the manager's page, and the panel steps aside.
    await panel(page).getByRole('button', { name: 'Open' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(key(page)).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('in a 640 px window, More holds the manager’s row, Picture quality and the note; the key stays in the bar', async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 640, height: 800 });
    await openBrowser(page, [['installed', BW]]);
    await expect(key(page)).toBeVisible();
    await expect(page.getByTestId('browser-extensions')).toBeHidden();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const more = page.getByRole('menu', { name: 'More' });
    await expect(more.getByRole('menuitem', { name: 'Bitwarden by Bitwarden Inc.' })).toBeFocused();
    await expect(more.getByRole('menuitemcheckbox', { name: 'Show Bitwarden in the bar' })).toHaveAttribute('aria-checked', 'true');
    await expect(more.getByTestId('more-quality')).toBeVisible();
    await expect(more).toContainText('Only extensions on our list can be added here.');
    // Picture quality turns More to its pages, and Back returns to its row.
    await more.getByTestId('more-quality').click();
    await expect(page.getByRole('menu', { name: 'Picture quality', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Back' }).click();
    await expect(page.getByTestId('more-quality')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'More' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('a phone on its side, under 700 px', () => {
  test.use({ viewport: { width: 641, height: 360 }, hasTouch: true, isMobile: true });
  test('the key folds into More (the bar is one row there); More’s Passwords and sign-ins opens the panel', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page);
    await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();
    await expect(key(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'More', exact: true }).tap();
    const more = page.getByRole('menu', { name: 'More' });
    // Picture quality first, as before, then the key's place.
    await expect(more.getByTestId('more-quality')).toBeFocused();
    const rows = more.locator('[role="menuitem"]');
    await expect(rows).toHaveText([/Picture quality/, 'Passwords and sign-ins']);
    await more.getByRole('menuitem', { name: 'Passwords and sign-ins' }).tap();
    await expect(panel(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('bringing passwords in', () => {
  test('the file is read here and goes to the desk over its link’s bulk channel only; the counts; nothing of it kept here', async ({ page }) => {
    const errors = watchConsole(page);
    const sent: string[] = [];
    page.on('request', (r) => {
      sent.push(`${r.url()} ${r.postData() ?? ''}`);
    });
    await openBrowser(page, [['hold']]);
    await key(page).click();
    const file = csv(30, 1200); // about 37 KB: three CHUNKs
    await page.getByTestId('pw-file').setInputFiles({ name: 'Chrome Passwords.csv', mimeType: 'text/csv', buffer: file });
    await expect(page.getByTestId('pw-choose')).toHaveText('Adding…');
    await expect(page.getByTestId('pw-choose')).toBeDisabled();
    await page.evaluate(() => (window as unknown as Win).__maDeskMock.signIns.releaseFinish());
    await expect(page.getByTestId('pw-result')).toHaveText('Added 30 passwords to this desk’s Browser.');
    await expect(page.getByTestId('pw-bring')).toContainText('Now delete the file you exported on this device. It holds your passwords as plain text.');
    await expect(page.getByTestId('pw-choose')).toHaveText('Choose another file…');
    // On the desk: every byte, in 16,372-byte frames in order, then zeroed; 30 rows.
    const imports = await page.evaluate(() => (window as unknown as Win).__maDeskMock.signIns.imports);
    expect(imports).toEqual([{ size: file.length, frames: [16_372, 16_372, file.length - 2 * 16_372], rows: 30, zeroed: true }]);
    // The calls carry its size and an upload id, never its bytes.
    const calls = (await rpc(page)).filter((r) => r.m.startsWith('browser.import'));
    expect(calls.map((c) => c.m)).toEqual(['browser.import.begin', 'browser.import.finish']);
    expect(calls[0]?.p).toEqual({ kind: 'passwords', size: file.length });
    expect(JSON.stringify(await rpc(page))).not.toContain(FAKE_PW);
    // Never to Minimalist Alliance's servers, nor kept in this browser, nor left on the input.
    expect(sent.filter((s) => s.includes(FAKE_PW) || s.includes('member1@example.com'))).toEqual([]);
    const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(kept).not.toContain(FAKE_PW);
    expect(await page.getByTestId('pw-file').evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('what’s already there is said, a file that isn’t an export is said, and one over 2 MiB never leaves this device', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page, [['already', 1]]);
    await key(page).click();
    await page.getByTestId('pw-file').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: csv(3) });
    await expect(page.getByTestId('pw-result')).toHaveText('Added 2 passwords to this desk’s Browser. 1 was already here.');
    await page.getByTestId('pw-file').setInputFiles({ name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b,c\n1,2,3\n') });
    await expect(page.getByTestId('pw-error')).toHaveText('That file isn’t a passwords export. Choose the CSV your browser saved.');
    await expect(page.getByTestId('pw-choose')).toHaveText('Choose a CSV file…');
    const before = (await rpc(page)).filter((r) => r.m === 'browser.import.begin').length;
    await page.getByTestId('pw-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61) });
    await expect(page.getByTestId('pw-error')).toHaveText('That file is too big to be a passwords export.');
    expect((await rpc(page)).filter((r) => r.m === 'browser.import.begin')).toHaveLength(before);
    expect(errors).toEqual([]);
  });
});

test.describe('Stop, where the desk serves it', () => {
  test('the count, the question in place, and the deletion', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page, [['stop']]);
    await key(page).click();
    const stop = page.getByTestId('pw-stop');
    await expect(stop).toContainText('12 passwords are saved in this desk’s Browser.');
    await stop.getByRole('button', { name: 'Delete the passwords saved in this desk’s Browser' }).click();
    await expect(stop.getByText('Delete 12 saved passwords from this desk’s Browser?')).toBeFocused();
    await expect(stop).toContainText('Sites you’re signed in to stay signed in. The last 7 days of snapshots still hold them until each expires. This can’t be undone.');
    await stop.getByRole('button', { name: 'Cancel' }).click();
    await stop.getByRole('button', { name: 'Delete the passwords saved in this desk’s Browser' }).click();
    await stop.getByRole('button', { name: 'Delete passwords' }).click();
    await expect(stop).toContainText('Deleted 12 passwords.');
    const clear = (await rpc(page)).filter((r) => r.m === 'browser.passwords.clear');
    expect(clear).toHaveLength(1);
    expect(clear[0]?.idem).toBeTruthy();
    expect(errors).toEqual([]);
  });
});

test.describe('where none of it shows', () => {
  test('an older deskd: no key, no Extensions, the bar as before', async ({ page }) => {
    const errors = watchConsole(page);
    await openBrowser(page, [['old']]);
    await expect(page.getByTestId('quality-button')).toBeVisible();
    await expect(key(page)).toHaveCount(0);
    await expect(page.getByTestId('browser-extensions')).toHaveCount(0);
    expect((await rpc(page)).filter((r) => r.m.startsWith('browser.extension') || r.m.startsWith('browser.import') || r.m.startsWith('browser.passwords')).map((r) => r.m)).toEqual(['browser.extensions.list']);
    expect(errors).toEqual([]);
  });

  test('a teen: nothing, and nothing asked of the desk', async ({ page, request }) => {
    await harness(request, { age: 'teen' });
    await openBrowser(page);
    await expect(page.getByTestId('browser-open-here')).toBeVisible();
    await expect(key(page)).toHaveCount(0);
    expect((await rpc(page)).some((r) => r.m.startsWith('browser.extension'))).toBe(false);
  });

  test('the kill switch: nothing, and nothing asked of the desk', async ({ page, request }) => {
    await harness(request, { configExtra: { siteSignIns: { enabled: false } } });
    await openBrowser(page);
    await expect(key(page)).toHaveCount(0);
    expect((await rpc(page)).some((r) => r.m.startsWith('browser.extension'))).toBe(false);
  });

  test('a desk that refuses (forbidden, as a teen’s or an unknown band’s): nothing', async ({ page }) => {
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.evaluate(() => {
      const m = (window as unknown as { __maDeskMock: { refuse: Record<string, string> } }).__maDeskMock;
      m.refuse['browser.extensions.list'] = 'forbidden';
    });
    await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId('browser-app')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(key(page)).toHaveCount(0);
  });
});

// The stills beside the spec's (14 to 20, 26, 27, 31, 32, 34, 39, 42), in each theme, and on a phone.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`shots, ${theme}: the key, Extensions, and the panel’s states`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBrowser(page, [['stop']]);
    await key(page).click();
    await expect(panel(page)).toBeVisible();
    await page.waitForTimeout(300);
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-panel-none.png` });
    await panel(page).getByRole('button', { name: 'Add Bitwarden' }).click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-panel-ask.png` });
    await page.getByTestId('pw-ask').getByRole('button', { name: 'Cancel' }).click();
    // Installed on the desk; the panel opening asks the list again.
    await page.evaluate((id) => (window as unknown as Win).__maDeskMock.signIns.install(id), BW);
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await key(page).click();
    await expect(key(page)).toHaveAccessibleName('Bitwarden, password manager');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await page.getByTestId('browser-extensions').click();
    await expect(page.getByRole('menu', { name: 'Extensions on this desk' })).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-extensions.png` });
    await page.keyboard.press('Escape');
    await page.getByTestId('browser-extensions').click();
    await page.getByRole('menuitem', { name: 'Passwords and sign-ins' }).click();
    await expect(panel(page)).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-panel-installed.png` });
    await page.getByTestId('pw-file').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: csv(42) });
    await expect(page.getByTestId('pw-result')).toBeVisible();
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-panel-imported.png` });
    await panel(page).locator('.pw-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-panel-lower.png` });
    await page.getByRole('button', { name: 'Delete the passwords saved in this desk’s Browser' }).click();
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-panel-delete.png` });
    await page.keyboard.press('Escape');
    await key(page).hover();
    await page.waitForTimeout(700);
    await page.waitForTimeout(300); // past the panel's 180 ms arrival
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-bar.png` });
    expect(errors).toEqual([]);
  });

  test(`a phone, ${theme}: the key on the second row, More with the manager, the panel at full width`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await setTheme(page, theme);
    const errors = watchConsole(page);
    await openBrowser(page, [['installed', BW]]);
    await expect(key(page)).toBeVisible();
    const k = (await key(page).boundingBox())!;
    expect(k.x + k.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-phone-bar.png` });
    await page.getByRole('button', { name: 'More', exact: true }).tap();
    await expect(page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Bitwarden by Bitwarden Inc.' })).toBeVisible();
    const pin = (await page.getByRole('menuitemcheckbox', { name: 'Show Bitwarden in the bar' }).boundingBox())!;
    expect(pin.height).toBeGreaterThanOrEqual(44);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-phone-more.png` });
    await page.getByRole('menuitem', { name: 'Passwords and sign-ins' }).tap();
    await expect(panel(page)).toBeVisible();
    const p = (await panel(page).boundingBox())!;
    expect(p.width).toBeGreaterThanOrEqual(389);
    await expect(panel(page).getByRole('button', { name: 'Back' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Close' })).toBeHidden();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/signins11-${theme}-phone-panel.png` });
    await panel(page).getByRole('button', { name: 'Back' }).tap();
    await expect(panel(page)).toHaveCount(0);
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test('ids stay the desk’s: nothing in the office names an extension the desk didn’t list', async ({ page }) => {
  await openBrowser(page);
  await page.evaluate((op) => {
    const s = (window as unknown as Win).__maDeskMock.signIns;
    s.extensions = s.extensions.filter((e) => e.id !== op);
  }, OP);
  await key(page).click();
  await expect(panel(page).getByTestId('pw-manager')).toHaveText(['Bitwardenby Bitwarden Inc.Add', 'Proton Passby Proton AGAdd']);
});
