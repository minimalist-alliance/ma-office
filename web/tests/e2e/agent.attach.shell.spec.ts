// Files on an Agent message (S-118b, ADR 0049), on `MockDeskLink`, so the real `RpcAgentClient`, the chunked upload and the
// window run against `web/agent`'s mock. The owner's rule: nothing about a file is kept, here or on the desk, once it's sent.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const MARK = 'ZQXQ-FILE-CONTENT-CANARY';

interface Mock {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  refuse: Record<string, string>;
  refuseDetails: Record<string, unknown>;
  agent: { desks: Record<string, { client: { dump(): string; expireStaged(): void } }> };
}
type W = { __maDeskMock: Mock };

const rpcOf = (page: Page, method: string): Promise<Mock['rpc']> => page.evaluate((m) => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === m), method);
const input = (page: Page): Locator => page.getByTestId('attach-input');
const chips = (page: Page): Locator => page.getByTestId('staged-file');
const line = (page: Page): Locator => page.getByTestId('attach-line');
const doc = (name: string, bytes = 200, mimeType = 'text/plain') => ({ name, mimeType, buffer: Buffer.from(MARK.repeat(Math.ceil(bytes / MARK.length)).slice(0, bytes)) });

async function arrive(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one&speed=fast&agentFixture=ready');
  await canvasPainted(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Agent/ })).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('attach-button')).toBeVisible();
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run({ include: ['.ma-window .window-body'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Everything the page keeps, searched for a string that must not be there. */
async function kept(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dump = (s: Storage): string => JSON.stringify(Array.from({ length: s.length }, (_, i) => s.key(i)).map((k) => [k, k && s.getItem(k)]));
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    return JSON.stringify({ local: dump(localStorage), session: dump(sessionStorage), cookie: document.cookie, dbs, caches: await window.caches.keys() });
  });
}

const mockDump = (page: Page): Promise<string> => page.evaluate(() => Object.values((window as unknown as W).__maDeskMock.agent.desks).map((d) => d.client.dump()).join('\n'));

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: attach, send with no words, and nothing is kept; clean for axe`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);

    await input(page).setInputFiles([doc('notes.txt', 1200), doc('big-report.pdf', 700 * 1024, 'application/pdf')]);
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).first()).toContainText('notes.txt');
    await expect(chips(page).first()).toContainText('1 KB');
    await expect(chips(page).nth(1)).toContainText('700 KB');
    await expect(chips(page).nth(1)).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-attach-${theme}-staged.png` });

    // 512 KiB chunks: the second file is two puts. Each is its own action. The log keeps sizes, not content.
    const puts = await rpcOf(page, 'agent.attach.put');
    expect(puts.map((r) => r.p['index'])).toEqual([0, 0, 1]);
    expect(new Set(puts.map((r) => r.options?.idem)).size).toBe(3);
    expect(JSON.stringify(puts)).not.toContain(MARK);

    // No words, only files: Send is on.
    await expect(page.getByTestId('composer-send')).toBeEnabled();
    await page.getByTestId('composer-send').click();
    await expect(chips(page)).toHaveCount(0);
    const mine = page.getByTestId('msg-user').last();
    await expect(mine.getByTestId('sent-file')).toHaveCount(2);
    await expect(mine.getByTestId('sent-file').first()).toContainText('notes.txt');
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('msg-agent').last()).toContainText('notes.txt');
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-attach-${theme}-sent.png` });

    const sent = (await rpcOf(page, 'agent.message.send')).at(-1)!;
    expect(sent.p['text']).toBe('');
    expect(sent.p['attachments']).toHaveLength(2);

    // Nothing kept: the desk's staging is empty, and the browser holds neither the words of the file nor its bytes.
    expect(JSON.parse((await mockDump(page)).split('\n')[0]!).staged).toEqual([]);
    const stored = await kept(page);
    expect(stored).not.toContain(MARK);
    expect(stored).not.toContain('notes.txt');
    expect(await mockDump(page)).not.toContain(MARK);
    expect(errors).toEqual([]);
  });
}

test('drop and paste take files; a paste with words is just words', async ({ page }) => {
  await arrive(page);
  const form = page.getByTestId('composer');
  await form.evaluate((el, mark) => {
    const dt = new DataTransfer();
    dt.items.add(new File([mark], 'dropped.md', { type: 'text/markdown' }));
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, MARK);
  await expect(line(page)).toHaveText('Drop to attach.');
  await form.evaluate((el, mark) => {
    const dt = new DataTransfer();
    dt.items.add(new File([mark], 'dropped.md', { type: 'text/markdown' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, MARK);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText('dropped.md');
  await expect(line(page)).not.toHaveText('Drop to attach.');

  const paste = (withText: boolean) =>
    page.getByTestId('composer-input').evaluate((el, [mark, text]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([String(mark)], 'pasted.png', { type: 'image/png' }));
      if (text) dt.setData('text/plain', 'some words');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [MARK, withText] as const);
  await paste(true);
  await expect(chips(page)).toHaveCount(1);
  await paste(false);
  await expect(chips(page)).toHaveCount(2);
});

test('the caps are said before anything goes up', async ({ page }) => {
  await arrive(page);
  const before = (await rpcOf(page, 'agent.attach.put')).length;
  await input(page).setInputFiles([1, 2, 3, 4, 5, 6, 7].map((n) => doc(`f${n}.txt`, 50 + n)));
  await expect(chips(page)).toHaveCount(5);
  await expect(line(page)).toHaveText('You can attach up to 5 files, 12 MB in all.');
  expect((await rpcOf(page, 'agent.attach.put')).length - before).toBeLessThanOrEqual(5);

  await page.getByRole('button', { name: 'Remove f1.txt' }).click();
  await expect(chips(page)).toHaveCount(4);
  await input(page).setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9_000_000, 1) });
  await expect(line(page)).toHaveText('huge.bin is over 8 MB.');
  await expect(chips(page)).toHaveCount(4);
  await input(page).setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await expect(line(page)).toHaveText('empty.txt is empty.');
});

test('the keyboard does all of it: attach, remove, send', async ({ page }) => {
  await arrive(page);
  const attach = page.getByTestId('attach-button');
  await attach.focus();
  await expect(attach).toBeFocused();
  await expect(attach).toHaveAccessibleName('Attach files');
  // The picker opens from the keyboard.
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles([doc('one.txt'), doc('two.txt')]);
  await expect(chips(page)).toHaveCount(2);
  await expect(line(page)).toHaveText('');

  const removeOne = page.getByRole('button', { name: 'Remove one.txt' });
  await removeOne.focus();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(1);
  await expect(line(page)).toHaveText('Removed one.txt.');
  const removed = await rpcOf(page, 'agent.attach.remove');
  expect(removed).toHaveLength(1);
  expect(removed[0]!.options?.idem).toBeTruthy();

  await page.getByTestId('composer-input').fill('Summarize it');
  await page.getByTestId('composer-input').press('Enter');
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId('msg-user').last().getByTestId('sent-files')).toHaveAccessibleName('Attached files');
  await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');
});

test('a busy desk keeps the files for another try', async ({ page }) => {
  await arrive(page);
  await input(page).setInputFiles(doc('keep.txt'));
  await expect(chips(page).first()).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => {
    (window as unknown as W).__maDeskMock.refuse['agent.message.send'] = 'conflict';
    (window as unknown as W).__maDeskMock.refuseDetails = { reason: 'busy' };
  });
  await page.getByTestId('composer-input').fill('Read this');
  await page.getByTestId('composer-send').click();
  await expect(page.getByRole('alert')).toContainText('send again in a moment');
  await expect(chips(page)).toHaveCount(1);
  await expect(page.getByTestId('composer-input')).toHaveValue('Read this');
  await page.evaluate(() => {
    delete (window as unknown as W).__maDeskMock.refuse['agent.message.send'];
    (window as unknown as W).__maDeskMock.refuseDetails = {};
  });
  await page.getByTestId('composer-send').click();
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId('msg-user').last().getByTestId('sent-file')).toHaveCount(1);
  const sends = await rpcOf(page, 'agent.message.send');
  expect(sends.at(-1)!.p['attachments']).toEqual(sends.at(-2)!.p['attachments']);
});

test('a file the desk cannot read is named, and its staged files are cleared', async ({ page }) => {
  await arrive(page);
  await input(page).setInputFiles([doc('encrypted-plan.pdf', 300, 'application/pdf'), doc('fine.txt')]);
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(1)).toHaveAttribute('data-state', 'ready');
  await page.getByTestId('composer-send').click();
  await expect(page.getByRole('alert')).toContainText('encrypted-plan.pdf is password protected');
  await expect(chips(page)).toHaveCount(0);
  await expect(line(page)).toContainText('Attach them again');
});

test('a file the desk dropped after 10 minutes says so', async ({ page }) => {
  await arrive(page);
  await input(page).setInputFiles(doc('late.txt'));
  await expect(chips(page).first()).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => Object.values((window as unknown as W).__maDeskMock.agent.desks).forEach((d) => d.client.expireStaged()));
  await page.getByTestId('composer-input').fill('Now?');
  await page.getByTestId('composer-send').click();
  await expect(page.getByRole('alert')).toContainText('no longer on your desk');
  await expect(chips(page)).toHaveCount(0);
});

test('leaving the thread removes what is staged on the desk', async ({ page }) => {
  await arrive(page);
  await input(page).setInputFiles(doc('stay.txt'));
  await expect(chips(page).first()).toHaveAttribute('data-state', 'ready');
  const before = (await rpcOf(page, 'agent.attach.remove')).length;
  const win = page.getByRole('dialog', { name: /Agent/ });
  await win.getByRole('button', { name: 'Agents', exact: true }).click();
  await win.getByRole('tab', { name: /^Researcher/ }).click();
  await expect.poll(async () => (await rpcOf(page, 'agent.attach.remove')).length).toBe(before + 1);
});
