// Records three members in one room, each in their own browser context and theme, for the docs.
// Each page's video lands in recording/; scripts/compose.sh then puts them side by side.
//   npm run record   (on the build server: see README, "Recording")
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { circle, click, color, drag, hover, join, launch, member, startServer, stroke, tool } from './harness.mjs';

const dir = resolve(import.meta.dirname, '../../recording');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const server = await startServer();
const browser = await launch();
const size = { width: 640, height: 720 };
const pause = (m, ms) => m.page.waitForTimeout(ms);
try {
  const [a, b, c] = await Promise.all([
    member(browser, 'Ana Lopez', { ...size, video: `${dir}/a` }),
    member(browser, 'Ben Okafor', { ...size, theme: 'dusk', video: `${dir}/b` }),
    member(browser, 'Cy Tanaka', { ...size, theme: 'dark', video: `${dir}/c` }),
  ]);
  await pause(a, 1200);
  for (const m of [a, b, c]) {
    await join(m);
    await pause(m, 700);
  }
  await pause(a, 800);

  // Ana sketches; the others watch it arrive.
  await tool(a, 'p');
  await color(a, 'Amber');
  await stroke(a, circle(150, 130, 30, 30), 3);
  await color(a, 'Ink');
  await stroke(a, [[90, 300], [160, 262], [240, 282], [330, 245], [420, 270]], 10);
  await stroke(a, [[250, 250], [250, 196], [286, 166], [322, 196], [322, 250]], 8);
  await hover(a, 380, 180);

  // Ben leaves a note while Ana's cursor wanders.
  await tool(b, 'n');
  await click(b, 470, 150);
  await b.page.locator('.ma-cm-editor').waitFor();
  await b.page.keyboard.type('Ship the room on Friday', { delay: 55 });
  await b.page.keyboard.press('Escape');
  await hover(a, 300, 420, 20);

  // Cy adds an arrow, a box and a label.
  await tool(c, 'a');
  await color(c, 'Blue');
  await drag(c, 360, 300, 430, 380, 16);
  await tool(c, 'r');
  await drag(c, 300, 390, 560, 480, 16);
  await tool(c, 't');
  await click(c, 320, 425);
  await c.page.locator('.ma-cm-editor').waitFor();
  await c.page.keyboard.type('Launch plan', { delay: 60 });
  await c.page.keyboard.press('Escape');
  await hover(c, 200, 520, 16);
  await pause(a, 600);

  // Ana saves the board under a name.
  await a.page.locator('.ma-cm-chip-save').click();
  await pause(a, 300);
  await a.page.keyboard.type('Sprint plan', { delay: 60 });
  await a.page.keyboard.press('Enter');
  await pause(a, 1200);

  // Ben puts up a new board for everyone, and draws on it.
  await b.page.locator('.ma-cm-chip-main').click();
  await pause(b, 700);
  await b.page.getByRole('button', { name: 'New board' }).click();
  await pause(b, 900);
  await tool(b, 'o');
  await color(b, 'Green');
  await drag(b, 200, 200, 420, 360, 18);
  await pause(b, 600);

  // Cy goes back to Sprint plan from the list.
  await c.page.locator('.ma-cm-chip-main').click();
  await pause(c, 900);
  await c.page.locator('.ma-cm-boardrow', { hasText: 'Sprint plan' }).click();
  await pause(c, 1200);

  // Ana mutes; everyone sees it. Then the people list.
  await a.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await pause(a, 900);
  await c.page.locator('.ma-cm-people-btn').click();
  await pause(c, 2200);
} finally {
  await browser.close(); // flushes the videos
  await server.stop();
}
console.log(`videos in ${dir}`);
