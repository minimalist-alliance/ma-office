// Records the demo walkthrough to recording/agent-ui.webm (1280x800), against the built bundle under the test
// CSP. Fake keys only. Strip metadata before sharing: README.md, "Screen recording".
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';

const PORT = Number(process.env.MA_AGENT_PORT ?? 5195);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL('../recording/', import.meta.url).pathname;
const size = { width: 1280, height: 800 };

const server = spawn(process.execPath, [new URL('./serve.mjs', import.meta.url).pathname, '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir: OUT, size } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);
const id = (t) => page.getByTestId(t);

async function type(locator, text, delay = 55) {
  await locator.click();
  await page.keyboard.type(text, { delay });
}

async function sendAndWatch(text) {
  const replies = id('msg-agent');
  const before = await replies.count();
  await type(id('composer-input'), text);
  await pause(300);
  await id('composer-send').click();
  await replies.nth(before).waitFor();
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="msg-agent"]')[n]?.getAttribute('data-state') !== 'streaming', before, { timeout: 30_000 });
}

try {
  // 1. A new desk: the manager has no key. The key goes in a hidden field, straight to the desk.
  await page.goto(`${BASE}/?fixture=fresh&theme=light`);
  await id('key-setup').waitFor();
  await pause(1800);
  await type(id('key-input'), 'sk-ant-DEMO-not-a-real-key-0000', 35);
  await pause(400);
  await type(page.getByLabel('Name it (optional)'), 'Personal');
  await pause(700);
  await id('key-submit').click();
  await id('composer-input').waitFor();
  await pause(1500);

  // 2. Chat: a reply streams, badged, with its cost underneath. A long one can be stopped.
  await sendAndWatch('Hello');
  await pause(1500);
  const replies = id('msg-agent');
  const before = await replies.count();
  await page.getByRole('button', { name: 'Show me a long reply' }).click();
  await replies.nth(before).waitFor();
  await pause(2600);
  await id('composer-stop').click();
  await pause(1500);

  // 3. Keys: only the last 4 come back. Badges hide, and the footer still says who answered.
  await id('tab-keys').click();
  await pause(2200);
  await page.getByText('Show provider badges').click();
  await pause(1600);
  await page.getByText('Show provider badges').click();
  await pause(800);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await pause(600);

  // 4. Dusk and Dark.
  await id('theme-dusk').click();
  await pause(1800);
  await id('theme-dark').click();
  await pause(1800);

  // 5. A desk at its limit: the message is refused before anything is sent, then the member raises the limit.
  await page.goto(`${BASE}/?fixture=limit&theme=dark`);
  await id('composer-input').waitFor();
  await pause(1500);
  await type(id('composer-input'), 'Plan my week');
  await pause(300);
  await id('composer-send').click();
  await id('limit-banner').waitFor();
  await pause(2600);
  await id('limit-change').click();
  await pause(1500);
  await id('limits-edit').click();
  await pause(800);
  await id('limit-agentDay').fill('');
  await type(id('limit-agentDay'), '5', 120);
  await pause(600);
  await id('limits-save').click();
  await pause(1500);
  await id('composer-send').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg-agent"]')].at(-1)?.getAttribute('data-state') === 'done', null, { timeout: 30_000 });
  await pause(1500);

  // 6. Activity: the audit log, ids and costs only.
  await id('tab-activity').click();
  await pause(2600);

  // 7. A small window, in Dusk: the rail tucks behind a button.
  await page.goto(`${BASE}/?fixture=ready&theme=dusk&size=small`);
  await id('composer-input').waitFor();
  await pause(1500);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await pause(1500);
  await id('agent-researcher').click();
  await pause(2000);
} finally {
  await context.close();
  await browser.close();
  server.kill();
}

const [video] = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
if (video) await rename(`${OUT}${video}`, `${OUT}agent-ui.webm`);
console.log(`recorded ${OUT}agent-ui.webm`);
