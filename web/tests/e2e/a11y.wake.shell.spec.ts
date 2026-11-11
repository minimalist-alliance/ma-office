// The accessibility pass of Nov 10: a desk's own comings and goings are said through the shell's live region, not only
// in its button's name, which isn't read out when it changes (`a11y/wakeSaid.ts`). Nothing is said as the office loads.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const desk = (deskId: string, name: string, kind: string, state: string) => ({ deskId, name, kind, state });
const said = (page: Page) => page.getByTestId('live-region');

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('pressing a desk that is asleep says it is waking, and then that it is awake', async ({ page, request }) => {
  await harness(request, { fleet: [desk('d-personal00001', 'Personal', 'personal', 'stopped'), desk('d-work000000001', 'Work', 'work', 'stopped')] });
  // Every line the live region says, in order.
  await page.addInitScript(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="live-region"]')?.textContent ?? '';
      if (t && w.__said[w.__said.length - 1] !== t) w.__said.push(t);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const lines = () => page.evaluate(() => (window as unknown as { __said: string[] }).__said.slice());
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  await page.waitForTimeout(1500);
  // The load itself, asleep desks and all, says nothing about them.
  expect((await lines()).filter((l) => / is (asleep|awake|waking)/.test(l))).toEqual([]);

  const personal = page.getByRole('button', { name: /^Personal desk, / });
  await personal.focus();
  await page.keyboard.press('Enter');
  await expect(said(page)).toHaveText('Personal desk is waking');
  await expect(personal).toHaveAccessibleName(/waking/);

  // Platform says it runs: the next list (2 s while anything is waking) brings it.
  await harness(request, { fleet: [desk('d-personal00001', 'Personal', 'personal', 'running'), desk('d-work000000001', 'Work', 'work', 'stopped')] });
  await expect(said(page)).toHaveText('Personal desk is awake', { timeout: 15_000 });

  // Work never moved, so it was never mentioned.
  expect((await lines()).some((l) => l.startsWith('Work desk is'))).toBe(false);
});
