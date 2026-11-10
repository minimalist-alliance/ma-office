// The rest of the app: themes, badges, streaming and stop, several agents, the audit export, a small window,
// and frame pacing while a reply streams. Screenshots go to test-results/shots/ for a look by eye.
import { readFile } from 'node:fs/promises';
import { auditRow, expect, open, sendAndWait, test } from './watch';

const THEMES = ['light', 'dusk', 'dark'] as const;

test('all three themes come from the Desk tokens', async ({ page }) => {
  await open(page, 'ready');
  const seen = new Set<string>();
  for (const theme of THEMES) {
    await page.getByTestId(`theme-${theme}`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const colors = await page.evaluate(() => {
      const app = document.querySelector('.ag-app') as HTMLElement;
      const root = getComputedStyle(document.documentElement);
      return { app: getComputedStyle(app).backgroundColor, token: root.getPropertyValue('--ma-surface-window').trim(), text: getComputedStyle(app).color };
    });
    expect(colors.token).not.toBe('');
    seen.add(colors.app);
    await page.screenshot({ path: `test-results/shots/ready-${theme}.png` });
  }
  expect(seen.size).toBe(3);
});

test('the key screen, the drawer and a small window in every theme', async ({ page }) => {
  for (const theme of THEMES) {
    await open(page, 'fresh', { theme });
    await page.screenshot({ path: `test-results/shots/fresh-${theme}.png` });
    await open(page, 'ready', { theme });
    await page.getByTestId('tab-usage').click();
    await page.screenshot({ path: `test-results/shots/usage-${theme}.png` });
    await open(page, 'limit', { theme, size: 'small' });
    await expect(page.locator('.ag-rail')).toBeHidden();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await expect(page.locator('.ag-rail')).toBeVisible();
    await page.screenshot({ path: `test-results/shots/small-${theme}.png` });
  }
});

test('provider badges show by default, hide, and come back on a provider change', async ({ page }) => {
  await open(page, 'ready');
  const head = page.locator('.ag-head');
  const rail = page.locator('.ag-rail');
  await expect(head.getByTestId('provider-badge')).toContainText('Anthropic');
  await expect(rail.getByTestId('provider-badge')).toHaveCount(2);
  await expect(page.getByTestId('msg-agent').first().getByTestId('provider-badge')).toBeVisible();

  await page.getByText('Show provider badges').click();
  await expect(head.getByTestId('provider-badge')).toHaveCount(0);
  await expect(rail.getByTestId('provider-badge')).toHaveCount(0);
  await expect(page.getByTestId('msg-agent').first().getByTestId('provider-badge')).toHaveCount(0);
  // Hidden isn't unknowable: the footer still says who answered.
  await expect(page.getByTestId('msg-foot').first()).toHaveAttribute('title', 'Answered by Anthropic · claude-sonnet-4-5');

  // Move the manager to OpenAI: its badge comes back until dismissed.
  await page.getByTestId('tab-keys').click();
  await page.getByTestId('bind-key').selectOption('k-openai-1');
  await page.getByTestId('bind-save').click();
  await expect(head.getByTestId('provider-badge')).toContainText('OpenAI');
  await page.getByTestId('badge-dismiss').click();
  await expect(head.getByTestId('provider-badge')).toHaveCount(0);

  // Per agent too.
  await page.getByText('Show provider badges').click();
  await expect(head.getByTestId('provider-badge')).toContainText('OpenAI');
  await page.getByText('Hide this agent’s provider badge').click();
  await expect(head.getByTestId('provider-badge')).toHaveCount(0);
  await expect(rail.getByTestId('provider-badge')).toHaveCount(1); // Researcher's
});

test('a reply streams, can be stopped, and keeps what it said', async ({ page }) => {
  await open(page, 'ready', { speed: 'normal' });
  const replies = page.getByTestId('msg-agent');
  const before = await replies.count();
  await page.getByRole('button', { name: 'Show me a long reply' }).click();
  const reply = replies.nth(before);
  await expect(reply).toHaveAttribute('data-state', 'streaming');
  await expect(page.getByRole('tab', { name: /Lead/ })).toContainText('working');
  await expect(reply.locator('.ag-bubble')).toContainText('longer answer');
  await page.getByTestId('composer-stop').click();
  await expect(reply).toHaveAttribute('data-state', 'stopped');
  await expect(reply).toContainText('Stopped');
  await expect(reply.getByTestId('msg-foot')).toContainText('tokens');
  await expect(page.getByTestId('composer-send')).toBeVisible();
});

test('several agents, each with its own thread, and a new one starts without a key', async ({ page }) => {
  await open(page, 'ready');
  const researcher = page.getByTestId('agent-researcher');
  await expect(researcher.locator('.ag-count')).toHaveText('1');
  await researcher.click();
  await expect(page.locator('.ag-head-name')).toHaveText('Researcher');
  await expect(page.getByTestId('thread')).toContainText('I’m Researcher');
  await expect(researcher.locator('.ag-count')).toHaveCount(0);

  // Unsent text stays with its agent.
  await page.getByTestId('composer-input').fill('draft for researcher');
  await page.getByTestId('agent-manager').click();
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await researcher.click();
  await expect(page.getByTestId('composer-input')).toHaveValue('draft for researcher');

  await page.getByTestId('new-agent').click();
  await page.getByLabel('Name', { exact: true }).fill('Scribe');
  await page.locator('#ag-new-key').selectOption('');
  await page.getByRole('button', { name: 'Add agent' }).click();
  await expect(page.locator('.ag-head-name')).toHaveText('Scribe');
  await expect(page.getByTestId('key-setup')).toBeVisible();
  // Its settings open beside it.
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Use a key on this desk' })).toBeVisible();
  await page.locator('.ag-main').getByTestId('bind-save').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('activity exports as JSON with ids and costs, never content', async ({ page }) => {
  await open(page, 'ready');
  await sendAndWait(page, 'my private grocery list');
  await page.getByTestId('tab-activity').click();
  const panel = page.getByTestId('activity-panel');
  await expect(auditRow(page, 'Model call')).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Export' }).click()]);
  const text = await readFile((await download.path()) as string, 'utf8');
  const json = JSON.parse(text) as { headHash: string; entries: { action: string; hash: string }[] };
  expect(json.entries.map((e) => e.action)).toContain('llm.call');
  expect(json.entries[json.entries.length - 1]?.hash).toBe(json.headHash);
  expect(text).not.toContain('grocery');
});

test('Esc closes the drawer, and the keyboard reaches everything', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('tab-usage').click();
  await page.getByTestId('limits-edit').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('drawer')).toHaveCount(0);
  await page.getByTestId('agent-researcher').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ag-head-name')).toHaveText('Researcher');
});

test('a streaming reply holds 60 fps: no long tasks, frames on time', async ({ page }) => {
  await open(page, 'ready', { speed: 'normal' });
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: number[]; running: boolean } };
    w.__perf = { frames: [], long: [], running: true };
    new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__perf.long.push(e.duration))).observe({ type: 'longtask', buffered: false });
    let last = performance.now();
    const tick = (t: number): void => {
      w.__perf.frames.push(t - last);
      last = t;
      if (w.__perf.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByTestId('composer-input').fill('Show me a long reply');
  const reply = await sendAndWait(page, null, { timeout: 30_000 });
  await expect(reply).toContainText('end of the long answer');
  const perf = await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: number[]; running: boolean } };
    w.__perf.running = false;
    const f = w.__perf.frames.slice(2).sort((a, b) => a - b);
    return { n: f.length, p50: f[Math.floor(f.length * 0.5)] ?? 0, p95: f[Math.floor(f.length * 0.95)] ?? 0, late: f.filter((x) => x > 25).length / Math.max(1, f.length), long: w.__perf.long };
  });
  console.log(`streaming frames: n=${perf.n} p50=${perf.p50.toFixed(1)}ms p95=${perf.p95.toFixed(1)}ms late=${(perf.late * 100).toFixed(1)}% longtasks=${perf.long.length}`);
  expect(perf.n).toBeGreaterThan(60);
  expect(perf.long, 'tasks over 50 ms while streaming').toEqual([]);
  expect(perf.p95).toBeLessThan(20);
  expect(perf.late).toBeLessThan(0.05);
});
