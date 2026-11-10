// The Agent window on real WebRTC: the shipping bundle, real desk-rtc and the gateway shim. fake-deskd has no `agent.*`, so this is
// a desk that answers `not_found`, as one without the relay does: the app mounts from its lazy chunk under the real CSP, says so once,
// and asks no more. `tests/real-desk/rt-agent.mjs` has the real relay, and `agent.shell.spec.ts` the app itself.
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';
import { buildTools, Stack } from './rtcStack';

const EVIDENCE = resolve('test-results/rtc-agent');
const stack = new Stack(EVIDENCE);

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async () => {
  test.setTimeout(600_000);
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  buildTools();
  await stack.start();
});

test.afterAll(async () => {
  await stack.stop();
});

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, { shim: stack.api });
});

test('a desk with no relay: the window opens on the real link, says so calmly, and asks no more', async ({ page }) => {
  const errors = watchConsole(page);
  const asked: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __agentCalls: string[]; __csp: string[] };
    w.__agentCalls = [];
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: Uint8Array<ArrayBuffer>) => void;
    (RTCDataChannel.prototype as unknown as { send: typeof send }).send = function sendAndRecord(d) {
      if (this.label === 'rpc') {
        const m = /"m":"(agent\.[a-z.]+)"/.exec(new TextDecoder().decode(d.subarray(12, 200)));
        if (m) w.__agentCalls.push(m[1] as string);
      }
      send.call(this, d);
    };
  });
  await signIn(page);
  await expect(page.getByRole('button', { name: /^Personal desk, 4 apps, online/ })).toHaveCount(1, { timeout: 20_000 });
  await page.getByRole('button', { name: /^Agent/ }).evaluate((el) => (el as HTMLButtonElement).click());
  const win = page.getByRole('dialog', { name: /Agent/ });
  await expect(win).toBeVisible();
  const state = win.getByTestId('agent-state');
  await expect(state).toHaveAttribute('data-state', 'absent', { timeout: 20_000 });
  await expect(state).toContainText('This desk’s Agent isn’t ready yet');
  const first = await page.evaluate(() => (window as unknown as { __agentCalls: string[] }).__agentCalls.slice());
  expect(first).toEqual(expect.arrayContaining(['agent.list', 'agent.providers', 'agent.key.list']));
  await page.waitForTimeout(7_000);
  asked.push(...(await page.evaluate(() => (window as unknown as { __agentCalls: string[] }).__agentCalls)));
  expect(asked.length).toBe(first.length); // `not_found` is final
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  await page.screenshot({ path: 'test-results/shots/agent-rtc-absent.png' });
  expect(errors).toEqual([]);
});
