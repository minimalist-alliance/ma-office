// A guild's Commons with its channels, chat, roles and settings: three members, each in their own browser context with
// Chromium's fake microphone, through the server's stand-in for deskd's relay (the way a guild desk carries it).
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

async function member(browser: Browser, q: string, theme = 'light'): Promise<M> {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${q} console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${q} page error: ${String(e)}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.host !== `127.0.0.1:${PORT}`) problems.push(`${q} left the host: ${r.url()}`);
  });
  await page.goto(`${BASE}/?${q}&theme=${theme}&guild=${encodeURIComponent('Northwind Platform')}`);
  await expect(page.locator('.ma-cm-btn-join')).toBeEnabled();
  return { ctx, page, problems };
}

const channelRow = (m: M, name: string) => m.page.locator('.ma-cm-chan', { has: m.page.locator('.ma-cm-chan-name', { hasText: new RegExp(`^${name}$`) }) });

/** Slots this member is hearing packets on now: stats twice, a second and a half apart. */
async function liveSlots(m: M): Promise<number> {
  const snap = () => m.page.evaluate(async () => ((await window.commons!.client.voiceDebug?.stats()) ?? []).map((x) => x.packets));
  const a = await snap();
  await m.page.waitForTimeout(1500);
  const b = await snap();
  return b.filter((n, i) => n > (a[i] ?? 0)).length;
}

async function join(m: M): Promise<void> {
  await m.page.locator('.ma-cm-btn-join').click();
  await expect(m.page.locator('.ma-cm-btn-leave')).toBeVisible();
}

async function say(m: M, text: string): Promise<void> {
  await m.page.locator('.ma-cm-composer-input').fill(text);
  await m.page.keyboard.press('Enter');
}

test('channels, chat, roles and settings, through the relay', async ({ browser }) => {
  const ana = await member(browser, 'name=Ana+Lopez&role=lead&badge=lead');
  const ben = await member(browser, 'name=Ben+Okafor&role=officer&badge=officer&grants=moderate', 'dusk');
  const cy = await member(browser, 'name=Cy+Park&role=member', 'dark');

  // Only the Founder (or manage_spaces) sees New channel.
  await expect(ana.page.getByRole('button', { name: 'New channel' })).toBeVisible();
  await expect(ben.page.getByRole('button', { name: 'New channel' })).toHaveCount(0);
  await expect(cy.page.getByRole('button', { name: 'New channel' })).toHaveCount(0);

  // Ana makes a channel; everyone sees it, and she's in it.
  await ana.page.getByRole('button', { name: 'New channel' }).click();
  await ana.page.getByRole('textbox', { name: 'New channel name' }).fill('Design review');
  await ana.page.keyboard.press('Enter');
  for (const m of [ana, ben, cy]) await expect(channelRow(m, 'Design review')).toHaveCount(1);
  await expect(channelRow(ana, 'Design review')).toHaveAttribute('data-here', '1');
  await expect(ana.page.locator('.ma-cm-chat-title')).toHaveText('Design review');

  // Badges beside names: the Founder's and the Officer's seals, nothing else.
  await join(ben);
  await join(cy);
  await expect(channelRow(ana, 'Main').locator('.ma-cm-chan-voice li')).toHaveCount(2);
  await expect(channelRow(ana, 'Main').getByRole('img', { name: 'Officer' })).toHaveCount(1);
  await expect(channelRow(ana, 'Main').getByRole('img', { name: 'Founder' })).toHaveCount(0);

  // Voice is per channel: Ben and Cy hear each other in Main; Ana joins Design review and hears nobody.
  await expect.poll(() => liveSlots(ben), { timeout: 20_000 }).toBe(1);
  await join(ana);
  await expect(channelRow(cy, 'Design review').locator('.ma-cm-chan-voice li')).toHaveCount(1);
  await expect(channelRow(cy, 'Design review').getByRole('img', { name: 'Founder' })).toHaveCount(1);
  await expect.poll(() => liveSlots(ana), { timeout: 20_000 }).toBe(0);
  // Cy moves to Design review while in the room: voice follows, now Ana hears Cy and Ben hears no one.
  await channelRow(cy, 'Design review').locator('.ma-cm-chan-btn').click();
  await expect(cy.page.locator('.ma-cm-chat-title')).toHaveText('Design review');
  await expect(channelRow(ben, 'Design review').locator('.ma-cm-chan-voice li')).toHaveCount(2);
  await expect.poll(() => liveSlots(ana), { timeout: 20_000 }).toBe(1);
  await expect.poll(() => liveSlots(ben), { timeout: 20_000 }).toBe(0);
  expect((await server.stats())['voicePeers']).toBe(3);

  // Chat in Design review: Cy writes, Ana reads it, with a plain link.
  await say(cy, 'Mockups for the upload flow: https://example.com/figma/upload, comments welcome');
  const anaMsg = ana.page.locator('.ma-cm-msg', { hasText: 'Mockups for the upload flow' });
  await expect(anaMsg).toHaveCount(1);
  await expect(anaMsg.locator('a')).toHaveAttribute('href', 'https://example.com/figma/upload');
  await expect(anaMsg.locator('a')).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(cy.page.locator('.ma-cm-msg[data-pending="1"]')).toHaveCount(0);

  // Ben, in Main, sees Design review marked unread, then reads it.
  await expect(channelRow(ben, 'Design review')).toHaveAttribute('data-unread', '1');
  await channelRow(ben, 'Design review').locator('.ma-cm-chan-btn').click();
  await expect(ben.page.locator('.ma-cm-msg', { hasText: 'Mockups for the upload flow' })).toHaveCount(1);
  await expect(channelRow(ben, 'Design review')).toHaveAttribute('data-unread', '0');

  // Cy edits her own message; the others see the edit. Ana can't edit or delete it (no moderate).
  const cyMsg = cy.page.locator('.ma-cm-msg', { hasText: 'Mockups for the upload flow' });
  await cyMsg.hover();
  await cyMsg.getByRole('button', { name: 'Edit message' }).click();
  await cy.page.getByRole('textbox', { name: 'Edit message' }).fill('Mockups for the upload flow are on the board');
  await cy.page.keyboard.press('Enter');
  await expect(ana.page.locator('.ma-cm-msg', { hasText: 'are on the board' }).locator('.ma-cm-msg-edited')).toHaveCount(1);
  // Ana is the Founder: she holds moderate, so she may delete; Ben the officer holds it by grant. Cy may not delete Ana's.
  await say(ana, 'Thanks, looking now');
  const onCy = cy.page.locator('.ma-cm-msg', { hasText: 'Thanks, looking now' });
  await onCy.hover();
  await expect(onCy.getByRole('button', { name: 'Delete message' })).toHaveCount(0);

  // Ben moderates: deletes Cy's message for everyone.
  const onBen = ben.page.locator('.ma-cm-msg', { hasText: 'are on the board' });
  await onBen.hover();
  await onBen.getByRole('button', { name: 'Delete message' }).click();
  await expect(onBen).toContainText('The deletion is logged');
  await onBen.getByRole('button', { name: 'Delete', exact: true }).click();
  for (const m of [ana, ben, cy]) await expect(m.page.locator('.ma-cm-msg', { hasText: 'are on the board' })).toHaveCount(0);

  // A refreshed token gives Ben manage_spaces: New channel shows at once.
  await ben.page.evaluate(() => window.commons!.channel!.devCaller({ grants: ['moderate', 'manage_spaces'] }));
  await expect(ben.page.getByRole('button', { name: 'New channel' })).toBeVisible();

  // Ana sets Join muted; Cy leaves and joins again, muted.
  await ana.page.getByRole('button', { name: 'Commons settings' }).click();
  await ana.page.getByRole('switch').check();
  await expect(cy.page.locator('.ma-cm-side-foot')).toBeVisible();
  await cy.page.getByRole('button', { name: 'Commons settings' }).click();
  await expect(cy.page.getByRole('switch')).toBeChecked();
  await expect(cy.page.getByRole('switch')).toBeDisabled();
  await cy.page.keyboard.press('Escape');
  await cy.page.locator('.ma-cm-btn-leave').click();
  await join(cy);
  await expect(cy.page.getByRole('button', { name: 'Unmute' })).toBeVisible();

  // deskd drops Cy's relay connection (as a removal or a restart would): she comes back by herself, in the room.
  await cy.page.evaluate(() => window.commons!.channel!.devDrop());
  await expect(channelRow(ana, 'Design review').locator('.ma-cm-chan-voice li')).toHaveCount(2, { timeout: 15_000 });
  await say(cy, 'Back, sorry, network blip');
  await expect(ana.page.locator('.ma-cm-msg', { hasText: 'network blip' })).toHaveCount(1);

  // Ana deletes Design review: everyone in it lands in Main.
  await channelRow(ana, 'Design review').hover();
  await ana.page.getByRole('button', { name: 'Delete Design review' }).click();
  await ana.page.locator('.ma-cm-chan-confirm').getByRole('button', { name: 'Delete', exact: true }).click();
  for (const m of [ana, ben, cy]) {
    await expect(channelRow(m, 'Design review')).toHaveCount(0);
    await expect(m.page.locator('.ma-cm-chat-title')).toHaveText('Main');
  }
  await expect(channelRow(ben, 'Main').locator('.ma-cm-chan-voice li')).toHaveCount(3);

  for (const m of [ana, ben, cy]) {
    expect(m.problems).toEqual([]);
    await m.ctx.close();
  }
});

test('chat keeps across a restart, and holds a message until the server has it', async ({ browser }) => {
  const a = await member(browser, 'name=Dee&role=member');
  for (let i = 1; i <= 8; i++) {
    await say(a, `Note ${i}`);
    await expect(a.page.locator('.ma-cm-msg', { hasText: `Note ${i}` })).toHaveAttribute('data-pending', '0');
  }
  await server.stop();
  await expect(a.page.locator('.ma-cm-banner')).toHaveText(/Can’t reach the guild server|Connecting/);
  await say(a, 'Written while the server was down');
  await expect(a.page.locator('.ma-cm-msg', { hasText: 'Written while' })).toHaveAttribute('data-pending', '1');
  await server.start();
  await expect(a.page.locator('.ma-cm-msg', { hasText: 'Written while' })).toHaveAttribute('data-pending', '0', { timeout: 20_000 });
  const b = await member(browser, 'name=Eve&role=member');
  await expect(b.page.locator('.ma-cm-msg-text')).toContainText(['Note 1', 'Note 8', 'Written while the server was down']);
  expect(a.problems.filter((p) => !p.includes('WebSocket'))).toEqual([]);
  expect(b.problems).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
