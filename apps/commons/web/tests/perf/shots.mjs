// Screenshots of one room in Light, Dusk and Dark, for review. Writes to media/shots/.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { color, drag, join, launch, member, note, sketch, startServer, text, tool, hover } from './harness.mjs';

const out = resolve(import.meta.dirname, '../../media/shots');
mkdirSync(out, { recursive: true });
const server = await startServer();
const browser = await launch();
try {
  const a = await member(browser, 'Ana Lopez');
  const b = await member(browser, 'Ben Okafor', { theme: 'dusk' });
  const c = await member(browser, 'Cy', { theme: 'dark' });
  // Before joining.
  await a.page.screenshot({ path: `${out}/0-before-join-light.png` });
  for (const m of [a, b, c]) await join(m);
  await sketch(a);
  await note(b, 620, 220, 'Ship the room on Friday');
  await note(b, 840, 220, 'Ask the guild about boards');
  await tool(c, 'r');
  await color(c, 'Blue');
  await drag(c, 560, 430, 900, 560);
  await tool(c, 'a');
  await drag(c, 470, 300, 600, 400);
  await text(c, 590, 470, 'Launch plan');
  await hover(b, 700, 600);
  await hover(c, 380, 520);
  await a.page.locator('.ma-cm-chip-save').click();
  await a.page.locator('.ma-cm-nameinput').fill('Sprint plan');
  await a.page.keyboard.press('Enter');
  await b.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await a.page.waitForTimeout(800);
  for (const [m, t] of [[a, 'light'], [b, 'dusk'], [c, 'dark']]) {
    await tool(m, 'p');
    await m.page.screenshot({ path: `${out}/1-room-${t}.png` });
  }
  await a.page.locator('.ma-cm-people-btn').click();
  await a.page.locator('.ma-cm-chip-main').click();
  await a.page.waitForTimeout(300);
  await a.page.screenshot({ path: `${out}/2-menus-light.png` });
  for (const [m, t] of [[b, 'dusk'], [c, 'dark']]) {
    await m.page.locator('.ma-cm-people-btn').click();
    await m.page.locator('.ma-cm-chip-main').click();
    await m.page.waitForTimeout(300);
    await m.page.screenshot({ path: `${out}/2-menus-${t}.png` });
  }
  // A narrow window.
  await c.page.setViewportSize({ width: 640, height: 720 });
  await c.page.keyboard.press('Escape');
  await c.page.waitForTimeout(300);
  await c.page.screenshot({ path: `${out}/3-narrow-dark.png` });
} finally {
  await browser.close();
  await server.stop();
}
