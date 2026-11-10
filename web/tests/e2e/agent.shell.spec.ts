// The Agent window on `MockDeskLink`, which answers `agent.*` from `web/agent`'s mock, so the real `RpcAgentClient`, `DeskLink`
// subscriptions and window code all run. The first key, a reply, stop, a refused key, the restart line, and every state a member
// can hit. `agent.rtc.spec.ts` runs the window on real WebRTC, `tests/real-desk/rt-agent.mjs` on the real desk.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const KEY = 'sk-ant-TEST-not-a-real-key-canary-0000-abcd';
const REFUSED = 'sk-ant-TEST-revoked-canary-0000-wxyz';
const RESTART = 'For now, your key stays only until this desk restarts. You’d add it again after that.';

interface MockAgentDesk { client: { dump(): string; loseKey(id: string): void } }
interface MockControl {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string; deadlineMs?: number } }[];
  refuse: Record<string, string>;
  hold: Record<string, boolean>;
  releaseHeld(): void;
  lostSession: Record<string, boolean>;
  agent: { down: boolean; setDown(down: boolean): void; restart(): void; dropLink(ms: number): void; desks: Record<string, MockAgentDesk> };
}
declare global {
  interface Window {
    __maDeskMock: MockControl;
  }
}

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const panel = (page: Page): Locator => page.getByTestId('agent-panel');
const state = (page: Page): Locator => page.getByTestId('agent-state');
const keyError = (page: Page): Locator => page.getByTestId('key-error');
const restartLine = (page: Page): Locator => page.getByTestId('key-restart-line');
const calls = (page: Page, method: string): Promise<number> => page.evaluate((m) => window.__maDeskMock.rpc.filter((r) => r.m === m).length, method);
const agentCalls = (page: Page): Promise<number> => page.evaluate(() => window.__maDeskMock.rpc.filter((r) => r.m.startsWith('agent.')).length);

async function arrive(page: Page, query = ''): Promise<void> {
  await signIn(page, `/?fixture=one&speed=fast${query}`);
  await canvasPainted(page);
}

async function openAgent(page: Page, deskName = 'Personal'): Promise<void> {
  const tile = page.getByRole('group', { name: `${deskName} desk` }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
}

async function addKey(page: Page, key: string): Promise<void> {
  await page.getByTestId('key-input').fill(key);
  await page.getByTestId('key-submit').click();
}

/** To a thread with a key on it. */
async function firstKey(page: Page): Promise<void> {
  await addKey(page, KEY);
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

/** The drawer covers the thread at its default width (under the head since LS-35); it closes by its own button. */
async function closeDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByTestId('drawer')).toHaveCount(0);
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

/** axe over the window, at WCAG 2.2 AA and best practice, through devtools so the page's CSP doesn't apply. */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; failureSummary?: string }[] }[] }> } };
    const r = await w.axe.run({ include: ['.ma-window .window-body'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `test-results/shots/agent-${name}.png` });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: the first key, a reply and stop, clean and readable`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openAgent(page);

    // Before anything's typed: the key screen, and the one plain line about what a restart does.
    await expect(page.getByTestId('key-setup')).toContainText('Give Lead a key');
    await expect(restartLine(page)).toHaveText(RESTART);
    await expect(page.getByTestId('key-input')).toHaveAttribute('type', 'password');
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-key-screen`);

    // A key the provider refuses, with the right words. The field is empty, and it's the only thing that changed.
    await addKey(page, REFUSED);
    await expect(keyError(page)).toHaveText('The provider refused this key. Check it in the provider’s console, then paste it again.');
    await expect(page.getByTestId('key-input')).toHaveValue('');
    await expect(page.getByTestId('key-setup')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-key-refused`);

    await firstKey(page);
    await expect(page.getByTestId('thread')).toContainText('Ask anything');
    await shot(page, `${theme}-thread-empty`);

    await say(page, 'hello');
    await expect(page.getByTestId('msg-user')).toHaveText(/hello/);
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('msg-foot').last()).toContainText('est.');
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-reply`);

    // Stop, mid-reply.
    await say(page, 'Show me a long reply');
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'streaming');
    await page.getByTestId('composer-stop').click();
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'stopped');
    await expect(page.getByTestId('composer-send')).toBeVisible();
    await shot(page, `${theme}-stopped`);

    for (const tab of ['usage', 'keys', 'activity']) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId('drawer')).toBeVisible();
      expect(await axe(page), tab).toEqual([]);
      if (tab === 'activity') {
        // A key by its name, never its id, and no chain head: that's in the export (the brand review).
        const activity = page.getByTestId('activity-panel');
        await expect(activity.getByTestId('audit-target').filter({ hasText: 'Anthropic key' }).first()).toBeVisible();
        expect(await activity.innerText()).not.toMatch(/key:|\bk-[a-z0-9]{4,}|Chain head/);
      }
      await shot(page, `${theme}-${tab}`);
      await closeDrawer(page);
    }

    // Every mutation went with its `idem`, and nothing suggests or offers what a real desk doesn't have.
    const sent = await page.evaluate(() => window.__maDeskMock.rpc.filter((r) => ['agent.key.add', 'agent.bind', 'agent.message.send', 'agent.run.stop'].includes(r.m)));
    expect(sent.length).toBeGreaterThan(3);
    for (const r of sent) expect(r.options?.idem, r.m).toMatch(/^[0-9a-f-]{36}$/);
    await expect(agentWindow(page).getByRole('button', { name: 'Add agent' })).toHaveCount(0);
    await expect(agentWindow(page).locator('.ag-chip')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test.describe('the key', () => {
  test('reaches no log, no record and no storage, refused or kept', async ({ page, context }) => {
    const logged: string[] = [];
    page.on('console', (m) => logged.push(m.text()));
    page.on('pageerror', (e) => logged.push(String(e)));
    const requests: string[] = [];
    page.on('request', (r) => requests.push(`${r.url()} ${r.postData() ?? ''}`));
    await arrive(page);
    await openAgent(page);
    await addKey(page, REFUSED);
    await expect(keyError(page)).toBeVisible();
    await firstKey(page);
    await say(page, 'hello');
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');

    const seen = await page.evaluate(async () => {
      const stores: string[] = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie, location.href];
      const dbs = await indexedDB.databases();
      for (const { name } of dbs) {
        if (!name) continue;
        stores.push(
          await new Promise<string>((done) => {
            const open = indexedDB.open(name);
            open.onerror = () => done('');
            open.onsuccess = () => {
              const db = open.result;
              const names = [...db.objectStoreNames];
              if (!names.length) return done('');
              const tx = db.transaction(names);
              const all = names.map((n) => tx.objectStore(n).getAll());
              tx.oncomplete = () => {
                done(JSON.stringify(all.map((a) => a.result)));
                db.close();
              };
            };
          }),
        );
      }
      for (const name of await caches.keys()) stores.push(name);
      const mock = window.__maDeskMock;
      const held = Object.values(mock.agent.desks).map((d) => d.client.dump());
      return {
        record: JSON.stringify(mock.rpc),
        held: held.join(' '),
        stores: stores.join(' '),
        inputs: [...document.querySelectorAll('input, textarea')].map((e) => (e as HTMLInputElement).value).join(' '),
        html: document.documentElement.outerHTML,
      };
    });
    // The record has the call, with the key out of it.
    expect(seen.record).toContain('agent.key.add');
    expect(seen.record).toContain('[redacted]');
    for (const canary of [KEY, REFUSED]) {
      for (const [where, text] of Object.entries(seen)) expect(text.includes(canary), `${where} holds a key`).toBe(false);
      expect(logged.join(' ').includes(canary), 'the console holds a key').toBe(false);
      expect(requests.join(' ').includes(canary), 'a request holds a key').toBe(false);
    }
    expect((await context.cookies()).map((c) => c.value).join(' ')).not.toContain(KEY);
  });

  test('that fails to land says so, with nothing silently gone', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    await expect(page.getByTestId('key-setup')).toBeVisible();
    // desk-agent went away between the screen and the press.
    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(true);
    });
    await addKey(page, KEY);
    await expect(keyError(page)).toHaveText('The desk couldn’t take this key just now, and kept nothing. Paste it again.');
    await expect(page.getByTestId('key-input')).toHaveValue('');
    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(false);
      window.__maDeskMock.lostSession['agent.key.add'] = true;
    });
    await addKey(page, KEY);
    await expect(keyError(page)).toHaveText('The connection dropped before the desk answered. If the key isn’t listed, paste it again.');
    await expect(page.getByTestId('key-input')).toHaveValue('');
  });

  test('kept, with the agent not started on it: says the key is there, not that it was lost', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    await page.getByTestId('key-input').waitFor();
    await page.evaluate(() => {
      window.__maDeskMock.lostSession['agent.key.models'] = false;
    });
    await addKey(page, KEY);
    await expect(keyError(page)).toHaveText('The key is on this desk, but the agent couldn’t start on it yet. Pick it above in a moment.');
    await page.evaluate(() => {
      delete window.__maDeskMock.lostSession['agent.key.models'];
    });
    // It's there to pick.
    await expect(page.getByTestId('bind-key')).toBeVisible({ timeout: 10_000 });
  });

  test('half-typed through a dropped link and a new session: still in the field, and it lands', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page);
    await openAgent(page);
    await page.getByTestId('key-input').fill(KEY);
    const lists = await calls(page, 'agent.list');
    await page.evaluate(() => window.__maDeskMock.agent.dropLink(1_500));
    await expect(page.getByTestId('agent-blip')).toHaveText('Reconnecting…');
    await expect(page.getByTestId('key-input')).toHaveValue(KEY);
    await expect(page.getByTestId('agent-blip')).toHaveCount(0, { timeout: 15_000 });
    // A new session, so a new client that read everything again, and the field is as it was.
    await expect.poll(() => calls(page, 'agent.list')).toBeGreaterThan(lists);
    await expect(page.getByTestId('key-input')).toHaveValue(KEY);
    await page.getByTestId('key-submit').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('another provider\'s key is stopped before it leaves, with one line naming the right provider', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    // An Anthropic key under OpenAI, whose `sk-` it also fits: the longer prefix says it's Anthropic's.
    await agentWindow(page).getByRole('radio', { name: 'OpenAI' }).click();
    await addKey(page, KEY);
    await expect(keyError(page)).toHaveText('That’s a key from Anthropic. Pick Anthropic above and paste it again.');
    await expect(page.getByTestId('key-input')).toHaveValue('');
    expect(await calls(page, 'agent.key.add')).toBe(0);
  });

  test('a plainly wrong one never leaves the window', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    await addKey(page, 'nothing-like-a-key');
    await expect(keyError(page)).toContainText('start with');
    expect(await calls(page, 'agent.key.add')).toBe(0);
  });
});

test.describe('the restart line', () => {
  test('shows on the key screen and in Keys, once each, where keys say nothing', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    await expect(restartLine(page)).toHaveCount(1);
    await page.getByTestId('tab-keys').click();
    await expect(page.getByTestId('keys-panel').getByTestId('key-restart-line')).toHaveText(RESTART);
    await closeDrawer(page);
    await firstKey(page);
    await expect(restartLine(page)).toHaveCount(0); // the thread says nothing
    await page.getByTestId('tab-keys').click();
    await expect(restartLine(page)).toHaveCount(1);
    await shot(page, 'keys-restart-line');
  });

  test('isn\'t there on a desk with the store and no key yet, which its limits\' `timeZone` says', async ({ page }) => {
    await arrive(page, '&keysLast=1');
    await openAgent(page);
    await expect(page.getByTestId('key-input')).toBeVisible();
    await expect.poll(() => calls(page, 'agent.limits.get')).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(restartLine(page)).toHaveCount(0);
    await page.getByTestId('tab-keys').click();
    await expect(page.getByTestId('keys-panel')).toBeVisible();
    await expect(restartLine(page)).toHaveCount(0);
  });

  test('is gone where keys say `available`, and a key that says false gets a quiet word', async ({ page }) => {
    await arrive(page, '&agentFixture=ready&keysLast=1');
    await openAgent(page);
    await page.getByTestId('tab-keys').click();
    await expect(page.getByTestId('key-row').first()).toBeVisible();
    await expect(restartLine(page)).toHaveCount(0);
    await expect(page.getByTestId('key-again')).toHaveCount(0);
    await shot(page, 'keys-available');

    // Its sealed file went: `available: false`, and the agent shows `no_key`.
    await page.evaluate(() => {
      for (const d of Object.values(window.__maDeskMock.agent.desks)) d.client.loseKey('k-anthropic-1');
    });
    await expect(page.getByTestId('key-gone')).toContainText('This desk can’t read “Personal” (····Q7xa) any more.');
    await expect(page.getByTestId('keys-panel').getByTestId('key-again')).toHaveText('Add this key again');
    await expect(restartLine(page)).toHaveCount(0);
    await shot(page, 'key-unavailable');

    // A restart with it unreadable: Activity says so once, in its number, with what to do, and the store's own rows stay out.
    await page.evaluate(() => window.__maDeskMock.agent.restart());
    await closeDrawer(page);
    await page.getByTestId('tab-activity').click();
    const activity = page.getByTestId('activity-panel');
    await expect(activity.locator('li[data-action="key.restore"]')).toHaveCount(1);
    await expect(activity.locator('li[data-action="key.restore"]')).toContainText('After a restart, 1 key couldn’t be read');
    await expect(activity.getByTestId('audit-next')).toHaveText('Add it again in Keys.');
    await expect(activity.locator('li[data-action="key.drop"]')).toHaveCount(0);
    await shot(page, 'activity-key-unreadable');
  });

  test('after a restart that dropped the key, no_key says it needs adding again, and adding it puts everything back', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    await firstKey(page);
    await say(page, 'hello');
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');

    await page.getByTestId('composer-input').fill('half a thought');
    await page.evaluate(() => window.__maDeskMock.agent.restart());
    const setup = page.getByTestId('key-setup');
    await expect(setup).toContainText('Lead’s key needs adding again');
    await expect(page.getByTestId('key-gone')).toContainText('didn’t stay through this desk’s restart');
    await expect(page.getByTestId('key-gone')).toContainText('thread and limits are all still here');
    await expect(setup).not.toContainText('Give Lead a key');
    await expect(restartLine(page)).toHaveCount(1);
    await expect(agentWindow(page).locator('.ag-status').first()).toContainText('add key again');
    // The dead key isn't offered, and there's nothing else to pick.
    await expect(page.getByTestId('bind-key')).toHaveCount(0);
    await shot(page, 'key-lost-after-restart');

    // The same key again: same model, the dead row gone, and the thread and the draft where they were.
    await addKey(page, KEY);
    await expect(page.getByTestId('composer-input')).toHaveValue('half a thought');
    await expect(page.getByTestId('msg-user')).toHaveText(/hello/);
    await page.getByTestId('tab-keys').click();
    await expect(page.getByTestId('key-row')).toHaveCount(1);
    await expect(page.getByTestId('key-again')).toHaveCount(0);
  });
});

test.describe('spending limits on a layered desk (ADR 0043)', () => {
  test.use({ timezoneId: 'America/Denver' });
  const limitSets = (page: Page): Promise<{ p: Record<string, unknown>; idem: string | undefined }[]> =>
    page.evaluate(() => window.__maDeskMock.rpc.filter((r) => r.m === 'agent.limits.set').map((r) => ({ p: r.p, idem: r.options?.idem })));
  const lastSet = async (page: Page): Promise<Record<string, unknown>> => {
    const all = await limitSets(page);
    return all[all.length - 1]?.p ?? {};
  };
  const usagePanel = (page: Page): Locator => page.getByTestId('limits-panel');

  for (const theme of THEMES) {
    test(`${theme}: the form leads with the whole desk, with where each value comes from, clean and readable`, async ({ page }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await arrive(page, '&agentFixture=ready&keysLast=1&accountMonth=50');
      await openAgent(page);
      await expect(page.getByTestId('composer-input')).toBeVisible();
      await expect.poll(() => limitSets(page)).toHaveLength(1);
      await page.getByTestId('tab-usage').click();
      await expect(usagePanel(page).getByTestId('usage-reset').first()).toHaveText('Resets at midnight');
      await expect(usagePanel(page).getByTestId('prices-as-of')).toContainText('Prices as of Nov 6, 2026.');
      await usagePanel(page).getByTestId('limits-edit').click();
      await expect(page.getByTestId('limit-deskMonth-source')).toHaveText('From your account');
      await expect(page.getByTestId('limit-deskDay-source')).toHaveText('No limit');
      await page.getByTestId('limit-deskDay').fill('4');
      await expect(page.getByTestId('limit-deskDay-follow')).toHaveText('Remove the limit');
      expect(await axe(page)).toEqual([]);
      await page.getByTestId('limits-form').scrollIntoViewIfNeeded();
      await shot(page, `${theme}-limits-form`);
      await page.getByTestId('limit-timeZone').fill('Mars/Olympus');
      await page.getByTestId('limits-save').click();
      await expect(page.getByTestId('limit-timeZone-error')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.getByTestId('limit-timeZone').scrollIntoViewIfNeeded();
      await shot(page, `${theme}-limits-zone-error`);
      expect(errors).toEqual([]);
    });
  }

  test('over the real client and link: the zone once, then only what the member changed, and null to follow', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready&keysLast=1&accountMonth=50');
    await openAgent(page);
    await expect.poll(() => limitSets(page)).toHaveLength(1);
    expect(await lastSet(page)).toEqual({ agentId: 'manager', timeZone: 'America/Denver' });

    await page.getByTestId('tab-usage').click();
    const panel = usagePanel(page);
    await panel.getByTestId('limits-edit').click();
    await page.getByTestId('limit-deskMonth').fill('30');
    await page.getByTestId('limits-save').click();
    await expect(page.getByTestId('limits-form')).toHaveCount(0);
    let sent = await lastSet(page);
    expect(Object.keys(sent).sort()).toEqual(['agentId', 'policy']);
    expect(sent['policy']).toMatchObject({ deskMonth: { maxMicroUsd: 30_000_000, maxTokens: null } });
    expect(Object.keys(sent['policy'] as object)).not.toContain('deskDay');
    await expect(panel.locator('[data-scope="desk_month"]')).toContainText('of $30');

    await panel.getByTestId('limits-edit').click();
    await page.getByTestId('limit-deskMonth-follow').click();
    await expect(page.getByTestId('limit-deskMonth')).toHaveValue('50');
    await page.getByTestId('limits-save').click();
    await expect(page.getByTestId('limits-form')).toHaveCount(0);
    sent = await lastSet(page);
    expect((sent['policy'] as Record<string, unknown>)['deskMonth']).toBeNull();
    await expect(panel.locator('[data-scope="desk_month"]')).toContainText('of $50');

    // The agent's own day alone: none of the desk's values go, so the desk keeps following its account.
    await panel.getByTestId('limits-edit').click();
    await page.getByTestId('limit-agentDay').fill('6');
    await page.getByTestId('limits-save').click();
    await expect(page.getByTestId('limits-form')).toHaveCount(0);
    sent = await lastSet(page);
    expect(Object.keys(sent).sort()).toEqual(['agentId', 'policy']);
    expect(Object.keys(sent['policy'] as object).sort()).toEqual(['agentDay', 'agentMonth', 'agentWeek', 'keyMonth', 'run', 'runMaxSteps']);
    for (const r of await limitSets(page)) expect(r.idem).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors).toEqual([]);
  });

  test('a desk before ADR 0043: no day, no zone, nothing set on its own, and the month goes with every save as before', async ({ page }) => {
    await arrive(page, '&agentFixture=ready');
    await openAgent(page);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.getByTestId('tab-usage').click();
    await usagePanel(page).getByTestId('limits-edit').click();
    await expect(page.getByTestId('limit-deskMonth')).toHaveValue('20');
    await expect(page.getByTestId('limit-deskDay')).toHaveCount(0);
    await expect(page.getByTestId('limit-timeZone')).toHaveCount(0);
    await expect(page.locator('.ag-source, .ag-follow')).toHaveCount(0);
    await page.getByTestId('limit-agentDay').fill('6');
    await page.getByTestId('limits-save').click();
    await expect(page.getByTestId('limits-form')).toHaveCount(0);
    const all = await limitSets(page);
    expect(all).toHaveLength(1);
    expect(all[0]?.p['policy']).toMatchObject({ deskMonth: { maxMicroUsd: 20_000_000, maxTokens: null }, agentDay: { maxMicroUsd: 6_000_000, maxTokens: null } });
    expect(Object.keys(all[0]?.p ?? {})).not.toContain('timeZone');
  });
});

test.describe('every state a member can hit', () => {
  test('desk-agent not running: calm, no storm, and back on its own with the thread right', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready');
    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(true);
    });
    await openAgent(page);
    await expect(state(page)).toHaveAttribute('data-state', 'down');
    await expect(state(page)).toContainText('Your desk team isn’t running right now');
    await shot(page, 'down');
    expect(await axe(page)).toEqual([]);

    // Four reads at most to open, then a slow retry: 12 s holds two rounds at the most, at 5 s and 15 s.
    const first = await agentCalls(page);
    await page.waitForTimeout(12_000);
    const after = await agentCalls(page);
    expect(after - first).toBeLessThanOrEqual(3);
    await expect(state(page)).toBeVisible();

    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(false);
    });
    await expect(page.getByTestId('thread')).toContainText('What can you do for me today?');
    await expect(state(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a desk too old to have the relay: it says so once and asks no more', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page);
    await page.evaluate(() => {
      for (const m of ['agent.providers', 'agent.list', 'agent.key.list', 'agent.state', 'agent.conversation']) window.__maDeskMock.refuse[m] = 'not_found';
    });
    await openAgent(page);
    await expect(state(page)).toHaveAttribute('data-state', 'absent');
    await expect(state(page)).toContainText('This desk’s Agent isn’t ready yet');
    await expect(state(page)).toContainText('It arrives with an update to the desk.');
    const first = await agentCalls(page);
    await page.waitForTimeout(6_000);
    expect(await agentCalls(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('the link drops mid-reply and comes back, with the thread right, and a draft kept', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready');
    await openAgent(page);
    await say(page, 'Show me a long reply');
    const reply = page.getByTestId('msg-agent').last();
    await expect(reply).toHaveAttribute('data-state', 'streaming');
    await page.evaluate(() => window.__maDeskMock.agent.dropLink(1_500));
    await expect(page.getByTestId('agent-blip')).toHaveText('Reconnecting…');
    await expect(page.getByTestId('composer-stop')).toBeDisabled();
    // The thread stays readable and the box still takes what's typed. Enter does nothing, and loses nothing.
    await page.getByTestId('composer-input').fill('still thinking');
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('composer-input')).toHaveValue('still thinking');
    await shot(page, 'reconnecting');

    await expect(page.getByTestId('agent-blip')).toHaveCount(0);
    // The reply finished while the link was down, and the snapshot has all of it, once.
    await expect(reply).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
    await expect(reply).toContainText('That’s the end of the long answer.');
    const text = (await reply.innerText()).split('That’s the end of the long answer.').length;
    expect(text).toBe(2);
    await expect(page.getByTestId('composer-input')).toHaveValue('still thinking');
    expect(errors).toEqual([]);
  });

  test('a send the answer to which was lost keeps its idem on the second press, so it lands once', async ({ page }) => {
    await arrive(page, '&agentFixture=ready');
    await openAgent(page);
    await page.evaluate(() => {
      window.__maDeskMock.lostSession['agent.message.send'] = true;
    });
    await say(page, 'once only');
    await expect(agentWindow(page).locator('.ag-banner.error')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveValue('once only');
    await page.evaluate(() => {
      delete window.__maDeskMock.lostSession['agent.message.send'];
    });
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    const idems = await page.evaluate(() => window.__maDeskMock.rpc.filter((r) => r.m === 'agent.message.send').map((r) => r.options?.idem));
    expect(idems).toHaveLength(2);
    expect(idems[0]).toBe(idems[1]);
  });

  test('a window parked behind another desk: mounted, kept, nothing counted as seen, and right on return', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=three&speed=fast&agentFixture=ready');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    await openAgent(page);
    await page.getByTestId('composer-input').fill('my draft');
    await say(page, 'Show me a long reply');
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'streaming');
    await page.getByTestId('composer-input').fill('my draft');
    const win = agentWindow(page);
    // Another desk takes the screen, which parks this one's windows.
    await page.getByRole('button', { name: /^Work desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.locator('.ma-window.parked')).toHaveCount(1);
    const seenBefore = await calls(page, 'agent.seen');
    await page.waitForTimeout(2_500); // the reply ends while no one can see it
    expect(await calls(page, 'agent.seen')).toBe(seenBefore);

    await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(win).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveValue('my draft');
    await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('msg-agent').last()).toContainText('That’s the end of the long answer.');
    await expect.poll(() => calls(page, 'agent.seen')).toBeGreaterThan(seenBefore);
    expect(errors).toEqual([]);
  });

  test('two desks, two clients: a key and a thread on one are nowhere on the other', async ({ page }) => {
    await signIn(page, '/?fixture=three&speed=fast');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    await openAgent(page, 'Personal');
    await firstKey(page);
    await say(page, 'for this desk only');
    await expect(page.getByTestId('msg-user')).toHaveText(/for this desk only/);

    await page.getByRole('button', { name: /^Work desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(400);
    await openAgent(page, 'Work');
    const work = page.locator('.ma-window:not(.parked)');
    await expect(work.getByTestId('key-setup')).toContainText('Give Lead a key');
    await expect(work.getByTestId('msg-user')).toHaveCount(0);
    await work.getByTestId('tab-keys').click();
    await expect(work.getByTestId('key-row')).toHaveCount(0);
    const shown = await page.evaluate(() => Object.values(window.__maDeskMock.agent.desks).map((d) => d.client.dump()));
    // The key's metadata and the words are on one desk's side, however many there are.
    expect(shown.filter((d) => d.includes('"last4"'))).toHaveLength(1);
    expect(shown.filter((d) => d.includes('"role":"user"'))).toHaveLength(1);
  });

  test('setting up: the same line as every other app, and nothing asked', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { fleet: [
      { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'provisioning' },
      { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'requested' },
    ] });
    await signIn(page, '/?speed=fast');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    await openAgent(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'settingUp');
    await expect(panel(page)).toHaveText('This desk is still being set up');
    expect(await agentCalls(page)).toBe(0);
    await shot(page, 'setting-up');
    expect(errors).toEqual([]);
  });

  test('a desk put on hold with the window open: the support address over it, and nothing asked', async ({ page, request }) => {
    test.setTimeout(120_000); // until the list's next read
    const errors = watchConsole(page);
    const personal = { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' };
    await harness(request, { fleet: [personal] });
    await signIn(page, '/?speed=fast');
    await canvasPainted(page);
    await openAgent(page);
    await page.getByTestId('composer-input').or(page.getByTestId('key-input')).first().waitFor();
    await page.getByTestId('key-input').fill(KEY); // half-typed, and kept
    await harness(request, { fleet: [{ ...personal, allowedActions: [] }] });
    await expect(panel(page)).toHaveAttribute('data-panel', 'support', { timeout: 70_000 });
    await expect(panel(page)).toContainText('@');
    await expect(page.getByTestId('key-input')).toHaveValue(KEY);
    const before = await agentCalls(page);
    await page.waitForTimeout(3_000);
    expect(await agentCalls(page)).toBe(before);
    await shot(page, 'held');
    expect(errors).toEqual([]);
  });

  test('the membership refused: the line and the billing link, and nothing asked', async ({ page }) => {
    const billing = encodeURIComponent('https://platform.localhost/billing');
    await signIn(page, `/?fixture=one&speed=fast&refuse=account_inactive&billing=${billing}`);
    await canvasPainted(page);
    await openAgent(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'membership');
    await expect(panel(page)).toContainText('membership');
    expect(await agentCalls(page)).toBe(0);
    await shot(page, 'membership');
  });

  test('desk-agent going down mid-thread: the words stay, a calm line, and the same press works when it\'s back', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready');
    await openAgent(page);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(true);
    });
    await say(page, 'are you there');
    await expect(agentWindow(page).locator('.ag-banner.error')).toHaveText('The desk couldn’t do that just now. Try again shortly.');
    await expect(page.getByTestId('composer-input')).toHaveValue('are you there');
    const before = await agentCalls(page);
    await page.waitForTimeout(6_000);
    expect(await agentCalls(page)).toBe(before); // nothing asks by itself mid-thread
    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(false);
    });
    await page.getByTestId('composer-send').click();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    await expect(page.getByTestId('msg-user').last()).toHaveText(/are you there/);
    expect(errors).toEqual([]);
  });

  test('a press that finds the desk gone says so, and nothing rejects unheard', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready');
    await openAgent(page);
    await page.getByTestId('tab-activity').click();
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      window.__maDeskMock.agent.setDown(true);
    });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByTestId('activity-panel').getByRole('alert')).toHaveText('The desk couldn’t do that just now. Try again shortly.');
    await closeDrawer(page);
    await page.getByTestId('tab-keys').click();
    await page.getByRole('switch', { name: /Hide this agent/ }).evaluate((el) => (el as HTMLInputElement).click());
    await expect(page.getByTestId('keys-panel').getByRole('alert')).toHaveText('The desk couldn’t do that just now. Try again shortly.');
    expect(errors).toEqual([]);
  });

  test('a chunk that won\'t load stays in its window, and says so', async ({ page }) => {
    await page.route(/AgentBody[^/]*\.js/, (route) => route.abort());
    await arrive(page);
    await openAgent(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'crashed');
    await expect(panel(page)).toContainText('Reload this page to try again.');
    await expect(page.getByRole('button', { name: /^Personal desk/ })).toBeAttached();
  });

  test('Esc in a field with words in it keeps them, and an empty one leaves', async ({ page }) => {
    await arrive(page);
    await openAgent(page);
    const key = page.getByTestId('key-input');
    await key.fill(KEY);
    await key.press('Escape');
    await expect(key).toHaveValue(KEY);
    await expect(agentWindow(page)).toBeVisible();
    await key.fill('');
    await key.press('Escape');
    await expect(agentWindow(page)).toHaveCount(0);
  });

  test('on a phone: the key screen fills it, and stays clean', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const errors = watchConsole(page);
    await arrive(page);
    await openAgent(page);
    await expect(page.getByTestId('key-setup')).toBeVisible();
    await expect(restartLine(page)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await shot(page, 'phone-key-screen');
    // The list sits under a drawer here, so nothing says "on the left" (the brand review).
    await page.getByTestId('tab-keys').click();
    await expect(page.getByTestId('keys-panel')).toContainText('No key yet. Add one below, or pick one from the list.');
    await expect(agentWindow(page)).not.toContainText('on the left');
    await closeDrawer(page);
    await firstKey(page);
    await shot(page, 'phone-thread');
    expect(errors).toEqual([]);
  });

  test('showing it to the status line: `?agent=live` fills the panel from `agent.state`', async ({ page }) => {
    await arrive(page, '&agent=live');
    const proxy = page.getByRole('button', { name: /^Personal desk/ });
    await expect(proxy).toHaveAccessibleName(/no key$/);
    await openAgent(page);
    await firstKey(page);
    await expect(proxy).toHaveAccessibleName(/agent online$/);
  });

  test('"Show provider badges" is the layout document\'s, through a reload', async ({ page, request }) => {
    const errors = watchConsole(page);
    // Platform's own list, not a fixture's: the layout saves only for desks the list has said are this member's.
    await harness(request, { fleet: [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' }] });
    await signIn(page, '/?speed=fast&agentFixture=ready');
    await canvasPainted(page);
    await openAgent(page);
    await page.getByRole('button', { name: 'Agents', exact: true }).click(); // the rail folds away at the window's default width
    const sw = page.getByRole('switch', { name: 'Show provider badges' });
    await expect(sw).toBeChecked();
    await expect(page.getByTestId('provider-badge').first()).toBeVisible();
    await sw.evaluate((el) => (el as HTMLInputElement).click());
    await expect(sw).not.toBeChecked();
    await expect.poll(async () => (await docOf(request))?.layout?.prefs?.showProviderBadges, { timeout: 8_000 }).toBe(false);

    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(500);
    await openAgent(page);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Show provider badges' })).not.toBeChecked();
    expect(errors).toEqual([]);
  });
});

// ----- every agent is its own app on the desk (task 49 item 6).

test.describe('every agent is its own app', () => {
  const tileOf = (page: Page, name: RegExp): Locator => page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name });

  test('a staff agent has its own tile under its name, and its window is the Agent app on that agent alone', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready');
    // The desk's agent.state brings the tile: the lead keeps `Agent`, Researcher gets its own.
    await expect(tileOf(page, /^Researcher/)).toHaveCount(1);
    await expect(tileOf(page, /^Agent/)).toHaveCount(1);
    await shot(page, 'own-tile');

    await tileOf(page, /^Researcher/).evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.getByTestId('window-agent:researcher');
    await expect(page.getByRole('dialog', { name: /Researcher/ })).toBeVisible();
    await expect(win.getByTestId('agent-window')).toHaveAttribute('data-app', 'agent:researcher');
    await expect(win.getByTestId('agent-app')).toHaveAttribute('data-focus', 'researcher');
    await expect(win.locator('.ag-rail')).toHaveCount(0);
    await expect(win.locator('.ag-head-name')).toHaveText('Researcher');
    await expect(win.getByTestId('thread')).toContainText('I’m Researcher');
    await win.getByTestId('tab-settings').click();
    await expect(win.getByTestId('settings-panel')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await shot(page, 'own-window');

    // A new name is the tile's and the window's.
    await win.getByTestId('settings-name').fill('Scout');
    await win.getByTestId('settings-save').click();
    await expect(tileOf(page, /^Scout/)).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: /Scout/ })).toBeVisible();

    // Deleted from its own window: its tile and its window go.
    await win.getByTestId('agent-delete').click();
    await win.getByTestId('agent-delete-confirm').click();
    await expect(tileOf(page, /^Scout/)).toHaveCount(0);
    await expect(win).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a new agent from the lead\'s window gets its tile at once, and opens there', async ({ page }) => {
    await arrive(page, '&agentFixture=ready');
    await openAgent(page);
    await page.getByRole('button', { name: 'Agents', exact: true }).click(); // the rail folds away at the window's default width
    await agentWindow(page).getByTestId('new-agent').click();
    await agentWindow(page).getByTestId('new-agent-name').fill('Writer');
    await agentWindow(page).getByTestId('new-agent-submit').click();
    await expect(tileOf(page, /^Writer/)).toHaveCount(1);
    await tileOf(page, /^Writer/).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByRole('dialog', { name: /Writer/ }).locator('.ag-head-name')).toHaveText('Writer');
  });

  // The spec's "done means" for the Desk app: two staff agents, each with the icon and tone chosen for it, each its own
  // tile and its own window; the solo one is the one whose settings say it messages no other agent.
  test('two agents with their own icons and tones: each its own tile and window, and the solo one marked by its settings', async ({ page }) => {
    const errors = watchConsole(page);
    await arrive(page, '&agentFixture=ready');
    // Researcher (compass, teal, solo) is the fixture's; Writer (pen, plum) may message Researcher under a written rule.
    await page.evaluate(async () => {
      const desk = Object.values(window.__maDeskMock.agent.desks)[0] as unknown as {
        client: {
          createAgent(i: Record<string, unknown>, m: { idem: string }): Promise<{ id: string }>;
          setLinks(id: string, c: { solo: boolean; links: { to: string; rules: string }[] }, m: { idem: string }): Promise<unknown>;
        };
      };
      const writer = await desk.client.createAgent({ name: 'Writer', icon: 'pen', tone: 'plum' }, { idem: 'e2e-writer' });
      await desk.client.setLinks(writer.id, { solo: false, links: [{ to: 'researcher', rules: 'Ask only for sources.' }] }, { idem: 'e2e-links' });
    });
    await expect(tileOf(page, /^Researcher/)).toHaveCount(1);
    await expect(tileOf(page, /^Writer/)).toHaveCount(1);
    await expect(tileOf(page, /^Agent/)).toHaveCount(1);

    const check = async (name: RegExp, icon: string, tone: string, messages: boolean): Promise<string> => {
      await tileOf(page, name).evaluate((el) => (el as HTMLButtonElement).click());
      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      const win = dialog.locator('[data-testid="agent-window"]');
      const app = (await win.getAttribute('data-app')) ?? '';
      expect(app).toMatch(/^agent:/);
      await expect(dialog.getByTestId('agent-app')).toHaveAttribute('data-focus', app.slice('agent:'.length));
      await dialog.getByTestId('tab-settings').click();
      await expect(dialog.getByRole('radiogroup', { name: 'Icon' }).getByRole('radio', { checked: true })).toHaveAccessibleName(icon);
      await expect(dialog.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { checked: true })).toHaveAccessibleName(tone);
      const toggle = dialog.getByRole('switch', { name: 'Messages other agents' });
      if (messages) await expect(toggle).toBeChecked();
      else await expect(toggle).not.toBeChecked();
      return app;
    };
    const researcher = await check(/^Researcher/, 'Compass', 'Teal', false);
    const writer = await check(/^Writer/, 'Pen', 'Plum', true);
    expect(researcher).not.toBe(writer);
    await expect(page.getByRole('dialog', { name: /Researcher/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Writer/ })).toBeVisible();
    await shot(page, 'two-agents');
    expect(errors).toEqual([]);
  });
});

interface LayoutDoc { layout?: { prefs?: { showProviderBadges?: boolean } } | null }
async function docOf(request: APIRequestContext): Promise<LayoutDoc | undefined> {
  const state = (await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, LayoutDoc | undefined> };
  return Object.values(state.layoutDocs)[0];
}

// ----- stopped, waking and going to sleep, with the real link against the harness's `connect`.

test.describe('on the real link', () => {
  const PERSONAL = 'd-personal00001';
  const WORK = 'd-work000000001';
  const desk = (deskId: string, name: string, kind: string, s: string): Record<string, string> => ({ deskId, name, kind, state: s });
  const fleet = (s: string): Record<string, string>[] => [desk(PERSONAL, 'Personal', 'personal', s), desk(WORK, 'Work', 'work', 'stopped')];
  const wakes = async (request: APIRequestContext): Promise<number> =>
    ((await (await request.get('/__harness')).json()) as { connects: { start: unknown }[] }).connects.filter((c) => c.start === true).length;

  async function openOnRealLink(page: Page): Promise<void> {
    await signIn(page, '/?link=real');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await page.waitForTimeout(300);
    await openAgent(page);
  }

  for (const theme of THEMES) {
    test(`${theme}: asleep, then Wake, then waking`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await harness(request, { fleet: fleet('stopped'), refuseWake: { status: 409, code: 'downtime_active' } });
      await openOnRealLink(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'asleep');
      await expect(panel(page)).toContainText('Your desk team is here when it wakes.');
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-asleep`);
      const before = await wakes(request);
      await harness(request, { refuseWake: null });
      await page.getByRole('button', { name: 'Wake', exact: true }).click();
      await expect(panel(page)).toHaveAttribute('data-panel', 'waking');
      await expect.poll(() => wakes(request)).toBe(before + 1);
      await shot(page, `${theme}-waking`);
      expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
    });
  }

  test('rendering wakes nothing: a window kept through a reload sends only `start: false`', async ({ page, request }) => {
    await harness(request, { fleet: fleet('stopped'), refuseWake: { status: 409, code: 'downtime_active' } });
    await openOnRealLink(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'asleep');
    const before = await wakes(request);
    await page.waitForTimeout(3_000);
    expect(await wakes(request)).toBe(before); // however often it rendered, and with no retry of a refused wake
  });

  test('the link not open: Opening, with nothing asked of the desk', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { fleet: fleet('running') });
    await openOnRealLink(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'opening');
    await expect(panel(page)).toContainText('Opening…');
    await shot(page, 'opening');
    await harness(request, { fleet: fleet('stopping') });
    expect(errors).toEqual([]);
  });
});

test('in a narrow window an open panel sits under the head, so its buttons still switch panels (LS-35)', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  const errors = watchConsole(page);
  await arrive(page);
  await openAgent(page);
  await expect(page.getByTestId('key-setup')).toBeVisible();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('drawer')).toHaveAttribute('aria-label', 'Settings');
  const usage = page.getByTestId('tab-usage');
  // Nothing lies over the head's button: what's under its middle is the button.
  expect(await usage.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })).toBe(true);
  await usage.click({ timeout: 5_000 });
  await expect(page.getByTestId('drawer')).toHaveAttribute('aria-label', 'Usage');
  await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible();
  expect(errors).toEqual([]);
});
