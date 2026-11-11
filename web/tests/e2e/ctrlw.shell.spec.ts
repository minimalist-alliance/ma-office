// Ctrl+W without fear (#16): the close guard asks, in the browser's own words, only while something would be lost, and full
// screen keeps the habit keys for the desk where Keyboard Lock is (`shell/closeGuard.ts`, `shell/keyLock.ts`). The lock is a
// stub here, since a test browser's full screen is no real one: what's checked is what the office asks of it, and the keys.
import { expect, test, type Dialog, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const KEY = 'sk-ant-TEST-not-a-real-key-canary-0000-abcd';
const LOCKED = ['KeyW', 'KeyT', 'KeyN', 'Tab', 'PageUp', 'PageDown', 'KeyL', 'KeyR', 'F5'];
const LINE = 'In full screen, Ctrl+W, T, N and Tab go to your desk.';

interface Kb {
  locks: string[][];
  unlocks: number;
}
interface Sent {
  channel: 'input' | 'keys';
  bytes: number[];
}

/** Every prompt the page shows as it goes, answered by leaving. */
function watchPrompts(page: Page): string[] {
  const prompts: string[] = [];
  page.on('dialog', (d: Dialog) => {
    prompts.push(d.type());
    void d.accept();
  });
  return prompts;
}

/** Whether leaving now would ask, from the guard's own answer, without leaving. */
const wouldAsk = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

/** The browser's install offer, as Platform's loader keeps it (`window.__maInstallPrompt`), counting its prompts. */
const holdInstallOffer = (page: Page): Promise<unknown> =>
  page.addInitScript(() => {
    const w = window as unknown as { __maInstallPrompt: unknown; __prompted: number };
    w.__prompted = 0;
    w.__maInstallPrompt = {
      prompt: (): Promise<{ outcome: string }> => {
        w.__prompted += 1;
        return Promise.resolve({ outcome: 'accepted' });
      },
    };
  });

/** The office as an installed app's window (`display-mode: standalone`). */
const asInstalled = (page: Page): Promise<unknown> =>
  page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList =>
      query.includes('display-mode: standalone') ? ({ ...real(query), media: query, matches: true } as MediaQueryList) : real(query);
  });

async function openShortcuts(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByTestId('shortcuts')).toBeVisible();
}

/** A page with no Keyboard Lock, as Safari and Firefox are. */
const noKeyboard = (page: Page): Promise<unknown> =>
  page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'keyboard', { configurable: true, get: () => undefined });
  });

/** A Keyboard Lock that records what it's asked. */
const stubKeyboard = (page: Page): Promise<unknown> =>
  page.addInitScript(() => {
    const kb = {
      locks: [] as string[][],
      unlocks: 0,
      lock(codes: string[] = []): Promise<void> {
        kb.locks.push([...codes]);
        return Promise.resolve();
      },
      unlock(): void {
        kb.unlocks += 1;
      },
    };
    (window as unknown as { __kb: typeof kb }).__kb = kb;
    Object.defineProperty(Navigator.prototype, 'keyboard', { configurable: true, get: () => kb });
  });
const kb = (page: Page): Promise<Kb> => page.evaluate(() => (window as unknown as { __kb: Kb }).__kb);

async function arrive(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one&speed=fast');
  await canvasPainted(page);
}

/** The Agent's composer, with a key on its agent. */
async function agentComposer(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Agent/ })).toBeVisible();
  const keyInput = page.getByTestId('key-input');
  await keyInput.or(page.getByTestId('composer-input')).first().waitFor();
  if (await keyInput.isVisible()) {
    await keyInput.fill(KEY);
    await page.getByTestId('key-submit').click();
  }
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('composer-input').click();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('the close guard', () => {
  test('a desk connected and windows open ask nothing; an Agent draft with text asks; emptied or sent, it lets go', async ({ page }) => {
    const errors = watchConsole(page);
    const prompts = watchPrompts(page);
    await arrive(page);
    await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await agentComposer(page);

    // Typed, then taken back out: nothing to lose.
    await page.keyboard.type('Never mind');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    // Sent: it's the desk's now.
    await page.keyboard.type('Hello');
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    await page.reload();
    await canvasPainted(page);
    expect(prompts).toEqual([]);

    // A draft with text: the browser's own prompt, and leaving goes ahead once they say so.
    await agentComposer(page);
    await page.keyboard.type('A thought for later');
    await page.reload();
    await canvasPainted(page);
    expect(prompts).toEqual(['beforeunload']);
    expect(errors).toEqual([]);
  });

  test('an Agent settings form asks only while it has changes; put back, or saved, it lets go', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page);
    await agentComposer(page);
    await page.getByTestId('tab-settings').click();
    const name = page.getByTestId('settings-name');
    await expect(name).toBeVisible();
    const was = await name.inputValue();
    expect(await wouldAsk(page)).toBe(false); // open, with nothing changed

    await name.click();
    await page.keyboard.type('x');
    await expect.poll(() => wouldAsk(page)).toBe(true);
    await name.fill(was); // put back as it was
    await expect.poll(() => wouldAsk(page)).toBe(false);
    await name.fill('Scout');
    await expect.poll(() => wouldAsk(page)).toBe(true);
    await page.getByTestId('settings-save').click();
    await expect(page.locator('.ag-head-name')).toHaveText('Scout');
    await expect.poll(() => wouldAsk(page)).toBe(false);

    const prompts = watchPrompts(page);
    await page.reload();
    await canvasPainted(page);
    expect(prompts).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a Maia draft asks, while her panel shows and once it is hidden; staying keeps it, and emptied it lets go', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { maia: { enabled: true } });
    await arrive(page);
    await page.locator('.maia-launcher').click();
    const composer = page.getByRole('textbox', { name: 'Message to Maia' });
    await expect(composer).toBeFocused();
    await page.keyboard.type('Ask her about');

    const prompts: string[] = [];
    page.on('dialog', (d) => {
      prompts.push(d.type());
      void d.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => prompts).toEqual(['beforeunload']);
    expect(page.isClosed()).toBe(false);
    await expect(composer).toHaveValue('Ask her about'); // staying lost nothing

    await page.getByRole('button', { name: 'Hide Maia' }).click();
    await expect(composer).toHaveCount(0);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => prompts).toEqual(['beforeunload', 'beforeunload']);
    expect(page.isClosed()).toBe(false);

    await page.locator('.maia-launcher').click();
    await expect(composer).toHaveValue('Ask her about');
    await composer.fill('');
    await composer.dispatchEvent('input');
    expect(errors).toEqual([]);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(prompts).toEqual(['beforeunload', 'beforeunload']);
  });
});

test.describe('full screen with Keyboard Lock', () => {
  const sent = async (page: Page): Promise<number[]> =>
    (await page.evaluate(() => (window as unknown as { __maDeskMock: { input: Sent[] } }).__maDeskMock.input))
      .map(({ bytes }) => new DataView(new Uint8Array(bytes).buffer))
      .filter((v) => v.getUint8(0) === 4 && v.getUint8(1) === 1) // KEY, down
      .map((v) => v.getUint32(12));
  const clear = (page: Page): Promise<void> =>
    page.evaluate(() => {
      (window as unknown as { __maDeskMock: { input: Sent[] } }).__maDeskMock.input.length = 0;
    });
  const pressCtrlW = async (page: Page): Promise<boolean> => {
    await page.getByTestId('browser-keys').evaluate((el) => {
      const w = window as unknown as { __prevented: boolean[] };
      w.__prevented = [];
      el.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'w') setTimeout(() => w.__prevented.push(e.defaultPrevented));
      });
    });
    await page.keyboard.press('Control+w');
    await page.waitForTimeout(50);
    return page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented.at(-1) ?? false);
  };

  test('full screen locks the habit keys, never Escape; Ctrl+W then reaches the desk, and leaving unlocks', async ({ page }) => {
    const errors = watchConsole(page);
    await stubKeyboard(page);
    await arrive(page);
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
    await expect.poll(async () => (await kb(page)).locks).toEqual([LOCKED]);
    expect((await kb(page)).locks[0]).not.toContain('Escape');

    // The Browser opens over the bars, so it comes second.
    await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const video = page.getByTestId('browser-video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
    await page.waitForTimeout(300); // the window's FLIP
    const b = (await video.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('browser-keys')).toBeFocused();
    await clear(page);
    expect(await pressCtrlW(page)).toBe(true);
    expect(await sent(page)).toEqual([0xffe3, 0x77]); // Control, then w: on to the desk's own browser
    expect(page.isClosed()).toBe(false);

    await page.evaluate(() => document.exitFullscreen());
    await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
    await expect.poll(async () => (await kb(page)).unlocks).toBe(1);
    await page.mouse.click(b.x + 20, b.y + 20);
    await clear(page);
    expect(await pressCtrlW(page)).toBe(false); // the member's own browser's again, as before
    expect((await sent(page)).filter((k) => k !== 0xffe3)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the shortcuts list says so where the lock is, and offers no install the browser hasn\'t', async ({ page }) => {
    await stubKeyboard(page);
    await arrive(page);
    await openShortcuts(page);
    await expect(page.getByTestId('shortcuts-full-screen')).toHaveText(LINE);
    await expect(page.getByTestId('shortcuts').locator('.about-row')).toHaveCount(19); // with #9's paste line
    await expect(page.getByTestId('install-office')).toHaveCount(0);
  });

  test('without Keyboard Lock, as in Safari and Firefox: full screen as ever, no error, and nothing said', async ({ page }) => {
    const errors = watchConsole(page);
    await noKeyboard(page);
    await arrive(page);
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByTestId('shortcuts')).toBeVisible();
    await expect(page.getByTestId('shortcuts-full-screen')).toHaveCount(0);
    await expect(page.getByTestId('shortcuts')).not.toContainText('full screen');
    expect(errors).toEqual([]);
  });
});

test.describe('the installed office', () => {
  test('"Install the office as an app" while the browser offers it: one prompt, then gone', async ({ page }) => {
    const errors = watchConsole(page);
    await holdInstallOffer(page);
    await arrive(page);
    await openShortcuts(page);
    const install = page.getByTestId('install-office');
    await expect(install).toHaveText('Install the office as an app');
    await expect(page.getByTestId('shortcuts')).toContainText('In its own window, Ctrl+W and Ctrl+T go to your desk.');
    // Its stills, in every theme, for the Product Designer: the panel's end, with the full-screen line above the offer.
    const dialog = page.getByRole('dialog', { name: 'Account' });
    await install.scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dusk', 'dark']) {
      await page.evaluate((t) => {
        document.documentElement.dataset['theme'] = t;
      }, theme);
      await page.waitForTimeout(250);
      await dialog.screenshot({ path: `test-results/shots/ctrlw-shortcuts-${theme}.png` });
    }
    await install.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted: number }).__prompted)).toBe(1);
    await expect(install).toHaveCount(0);
    await expect(page.getByTestId('shortcuts')).not.toContainText('In its own window');
    expect(errors).toEqual([]);
  });

  test('already installed: no offer, and Ctrl+T in the picture goes to the desk without full screen', async ({ page }) => {
    const errors = watchConsole(page);
    await holdInstallOffer(page);
    await asInstalled(page);
    await arrive(page);
    await openShortcuts(page);
    await expect(page.getByTestId('install-office')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const video = page.getByTestId('browser-video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
    await page.waitForTimeout(300); // the window's FLIP
    const b = (await video.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('browser-keys')).toBeFocused();
    await page.evaluate(() => {
      (window as unknown as { __maDeskMock: { input: Sent[] } }).__maDeskMock.input.length = 0;
    });
    await page.keyboard.press('Control+t');
    const downs = (await page.evaluate(() => (window as unknown as { __maDeskMock: { input: Sent[] } }).__maDeskMock.input))
      .map(({ bytes }) => new DataView(new Uint8Array(bytes).buffer))
      .filter((v) => v.getUint8(0) === 4 && v.getUint8(1) === 1)
      .map((v) => v.getUint32(12));
    expect(downs).toEqual([0xffe3, 0x74]); // Control, then t
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(errors).toEqual([]);
  });
});
