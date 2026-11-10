// Three members in one room, each in their own browser context with Chromium's fake microphone,
// against the real server in -dev, through its stand-in for deskd's relay (the page's default link).
// These keep task 21's layout coordinates, so the channel list starts hidden; guild.spec.ts has it shown.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE, PORT, Server } from './server.ts';

interface M {
  ctx: BrowserContext;
  page: Page;
  problems: string[];
}

const server = new Server();

test.beforeAll(async () => {
  await server.start();
});
test.afterAll(async () => {
  await server.stop();
  server.cleanup();
});

async function member(browser: Browser, name: string, theme = 'light'): Promise<M> {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${name} console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name} page error: ${String(e)}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.host !== `127.0.0.1:${PORT}`) problems.push(`${name} left the host: ${r.url()}`);
  });
  await page.goto(`${BASE}/?name=${encodeURIComponent(name)}&theme=${theme}&channels=0`);
  await expect(page.locator('.ma-cm-btn-join')).toBeEnabled();
  return { ctx, page, problems };
}

async function join(m: M): Promise<void> {
  await m.page.locator('.ma-cm-btn-join').click();
  await expect(m.page.locator('.ma-cm-btn-leave')).toBeVisible();
  await m.page.locator('.ma-cm-board').focus();
}

const items = (m: M) => m.page.evaluate(() => window.commons!.engine!.itemCount);

/** Draws a short squiggle with the pen, at (x, y) in the window. */
async function squiggle(m: M, x: number, y: number): Promise<void> {
  await m.page.keyboard.press('p');
  await m.page.mouse.move(x, y);
  await m.page.mouse.down();
  for (let i = 1; i <= 20; i++) await m.page.mouse.move(x + i * 8, y + Math.sin(i / 2) * 30, { steps: 2 });
  await m.page.mouse.up();
}

/** Slots this member hears audio packets on. */
async function heardSlots(m: M): Promise<number> {
  return m.page.evaluate(async () => {
    const s = (await window.commons!.client.voiceDebug?.stats()) ?? [];
    return s.filter((x) => x.packets > 0).length;
  });
}

test('three browsers share one room: presence, voice, a live board and cursors', async ({ browser }) => {
  const a = await member(browser, 'Ana Lopez');
  const b = await member(browser, 'Ben', 'dusk');
  const c = await member(browser, 'Cy', 'dark');
  for (const m of [a, b, c]) await join(m);

  // Everyone sees everyone.
  for (const m of [a, b, c]) await expect(m.page.locator('.ma-cm-count')).toHaveText('3 in the room', { timeout: 15_000 });
  await expect(a.page.locator('.ma-cm-stack .ma-cm-avatar')).toHaveCount(3);
  await expect(a.page.locator('.ma-cm-stack .ma-cm-avatar').first()).toHaveText('AL');

  // Voice: each hears the other two (Chromium's fake microphone beeps).
  for (const m of [a, b, c]) await expect.poll(() => heardSlots(m), { timeout: 20_000 }).toBe(2);
  const st = await server.stats();
  expect(st['voicePeers']).toBe(3);

  // A draws; B and C see it.
  await squiggle(a, 400, 300);
  for (const m of [a, b, c]) await expect.poll(() => items(m)).toBe(1);

  // A's cursor shows on B with A's name.
  await a.page.mouse.move(600, 500);
  await a.page.mouse.move(620, 510);
  await expect(b.page.locator('.ma-cm-cursor span')).toHaveText('Ana Lopez');

  // C adds a note and types in it; A sees the text.
  await c.page.keyboard.press('n');
  await c.page.mouse.click(800, 400);
  await expect(c.page.locator('.ma-cm-editor')).toBeFocused();
  await c.page.keyboard.type('Ship on Friday');
  await c.page.keyboard.press('Escape');
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const doc = window.commons!.client.doc!;
        return [...doc.getMap<import('yjs').Map<unknown>>('items').values()].map((m) => m.get('tx')).filter(Boolean);
      }),
    )
    .toEqual(['Ship on Friday']);

  // Undo is per member: B's undo doesn't take A's stroke away.
  await b.page.keyboard.press('Control+z');
  await expect.poll(() => items(a)).toBe(2);

  for (const m of [a, b, c]) {
    expect(m.problems).toEqual([]);
    await m.ctx.close();
  }
  await expect.poll(async () => (await server.stats())['voicePeers']).toBe(0);
});

test('boards: save, start a new one, switch back, and they keep across a restart', async ({ browser }) => {
  const a = await member(browser, 'Ana');
  const b = await member(browser, 'Ben');
  const c = await member(browser, 'Cy');
  for (const m of [a, b, c]) await join(m);

  const before = await items(a);
  await squiggle(a, 300, 300);
  for (const m of [a, b, c]) await expect.poll(() => items(m)).toBe(before + 1);

  // Save: name the board.
  await a.page.locator('.ma-cm-chip-save').click();
  await a.page.locator('.ma-cm-nameinput').fill('Sprint plan');
  await a.page.keyboard.press('Enter');
  for (const m of [a, b, c]) await expect(m.page.locator('.ma-cm-chip-name')).toHaveText('Sprint plan');
  await expect(a.page.locator('.ma-cm-chip-state')).toHaveText('Saved');

  // B puts up a new board; everyone follows.
  await b.page.locator('.ma-cm-chip-main').click();
  await b.page.getByRole('button', { name: 'New board' }).click();
  for (const m of [a, b, c]) {
    await expect(m.page.locator('.ma-cm-chip-name')).toHaveText('Untitled board');
    await expect.poll(() => items(m)).toBe(0);
  }
  await expect(a.page.locator('.ma-cm-banner')).toHaveText('Ben opened a new board');
  await squiggle(b, 500, 400);
  await expect.poll(() => items(c)).toBe(1);

  // C goes back to Sprint plan from the list; everyone follows.
  await c.page.locator('.ma-cm-chip-main').click();
  await expect(c.page.locator('.ma-cm-boardrow-name')).toHaveText(['Untitled board', 'Sprint plan']);
  await c.page.locator('.ma-cm-boardrow', { hasText: 'Sprint plan' }).click();
  for (const m of [a, b, c]) {
    await expect(m.page.locator('.ma-cm-chip-name')).toHaveText('Sprint plan');
    await expect.poll(() => items(m)).toBe(before + 1);
  }

  // Restart the guild server. The clients come back by themselves, and a newcomer sees the boards.
  await server.stop();
  await expect(a.page.locator('.ma-cm-banner')).toHaveText(/Can’t reach the guild server/);
  await server.start();
  await expect(a.page.locator('.ma-cm-count')).toHaveText('3 in the room', { timeout: 20_000 });
  const d = await member(browser, 'Dee');
  await expect(d.page.locator('.ma-cm-chip-name')).toHaveText('Sprint plan');
  await expect.poll(() => items(d)).toBe(before + 1);
  await d.page.locator('.ma-cm-chip-main').click();
  await expect(d.page.locator('.ma-cm-boardrow-name')).toHaveText(['Untitled board', 'Sprint plan']);

  // Delete the untitled board.
  await join(d);
  await d.page.locator('.ma-cm-chip-main').click();
  await d.page.locator('.ma-cm-boardlist li', { hasText: 'Untitled board' }).hover();
  await d.page.getByRole('button', { name: 'Delete Untitled board' }).click();
  await d.page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(d.page.locator('.ma-cm-boardrow-name')).toHaveText(['Sprint plan']);

  for (const m of [a, b, c, d]) {
    expect(m.problems.filter((p) => !p.includes('WebSocket'))).toEqual([]);
    await m.ctx.close();
  }
});

test('mute, leave, and a read-only board before joining', async ({ browser }) => {
  const a = await member(browser, 'Ana');
  const b = await member(browser, 'Ben');

  // Before joining: the board shows, but there are no tools and nothing can be drawn.
  await expect(b.page.locator('.ma-cm-rail')).toHaveCount(0);
  const n = await items(b);
  await b.page.mouse.move(300, 300);
  await b.page.mouse.down();
  await b.page.mouse.move(400, 350, { steps: 5 });
  await b.page.mouse.up();
  expect(await items(b)).toBe(n);

  await join(a);
  await join(b);
  await expect(b.page.locator('.ma-cm-count')).toHaveText('2 in the room');
  await expect.poll(() => heardSlots(b), { timeout: 20_000 }).toBe(1);

  // A mutes: B sees it, and the server stops forwarding A's audio.
  await a.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(b.page.locator('.ma-cm-stack .ma-cm-avatar-muted')).toHaveCount(1);
  const packets = async () =>
    b.page.evaluate(async () => ((await window.commons!.client.voiceDebug?.stats()) ?? []).reduce((s, x) => s + x.packets, 0));
  await b.page.waitForTimeout(500);
  const p0 = await packets();
  await b.page.waitForTimeout(1500);
  expect(await packets()).toBe(p0);
  await a.page.getByRole('button', { name: 'Unmute' }).click();
  await expect.poll(packets, { timeout: 10_000 }).toBeGreaterThan(p0);

  // Mod+Shift+M mutes too.
  await a.page.locator('.ma-cm-board').focus();
  await a.page.keyboard.press('Control+Shift+M');
  await expect(a.page.getByRole('button', { name: 'Unmute' })).toBeVisible();

  // B leaves.
  await b.page.locator('.ma-cm-btn-leave').click();
  await expect(a.page.locator('.ma-cm-count')).toHaveText('1 in the room');
  await expect(b.page.locator('.ma-cm-btn-join')).toBeVisible();
  await a.page.locator('.ma-cm-people-btn').click();
  await expect(a.page.locator('.ma-cm-menu-sub')).toHaveText('Looking in · 1');

  for (const m of [a, b]) {
    expect(m.problems).toEqual([]);
    await m.ctx.close();
  }
});
