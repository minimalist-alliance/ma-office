// A member whose network lets no voice through: the guild desk's answer names an address nothing can reach (as if UDP
// 8791 and up and 443 were all blocked), so after 8 s the room says so, calmly, with Retry, and the board and chat
// keep working.
import { expect, test } from '@playwright/test';
import { BASE, PORT, Server } from './server.ts';

const server = new Server();

test.beforeAll(async () => {
  await server.start(['-advertise', '192.0.2.1']);
});
test.afterAll(async () => {
  await server.stop();
  server.cleanup();
});

test('voice blocked: a calm line with Retry, and the board and chat still work', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${String(e)}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.host !== `127.0.0.1:${PORT}`) problems.push(`left the host: ${r.url()}`);
  });
  await page.goto(`${BASE}/?name=Fay&theme=light`);
  await page.locator('.ma-cm-btn-join').click();
  await expect(page.locator('.ma-cm-btn-leave')).toBeVisible();
  const line = page.locator('.ma-cm-voiceline');
  await expect(line).toHaveCount(0);
  await expect(line).toHaveText(/^Your network blocks voice here\. The board and chat still work\.\s*Retry$/, { timeout: 12_000 });

  // The board still takes a stroke, and chat still goes.
  const box = (await page.locator('.ma-cm-board').boundingBox())!;
  await page.locator('.ma-cm-board').focus();
  await page.keyboard.press('p');
  await page.mouse.move(box.x + 200, box.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 200 + i * 10, box.y + 300 + i * 4);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.commons!.engine!.itemCount)).toBe(1);
  await page.locator('.ma-cm-composer-input').fill('No voice from this network, I’ll follow in chat');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ma-cm-msg', { hasText: 'follow in chat' })).toHaveAttribute('data-pending', '0');

  // Retry tries again: the line goes, and comes back when it can't get through again.
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toHaveCount(0);
  await expect(line).toBeVisible({ timeout: 12_000 });

  expect(problems).toEqual([]);
  await ctx.close();
});
