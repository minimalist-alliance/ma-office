// Each desk's button in the canvas's accessible mirror (`src/a11y/ProxyLayer.tsx`) says which desk it is and its kind,
// from the desk list the office already holds (`state/deskStore.ts`, DeskInfo): `data-desk` (its id) and `data-kind`
// (personal, work or guild; custom for a custom desk). The AI tester fleet reads them through the map's
// `office.desk.kind` (`public/fleet-map.json`), so its `office_open` says each desk's kind. Nothing on screen changes:
// the same buttons, names and boxes, and no other element of the mirror carries either attribute.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const MAP = JSON.parse(readFileSync(new URL('../../public/fleet-map.json', import.meta.url), 'utf8')) as { els: Record<string, { sel: string }> };
const PERSONAL = 'd-personal00001';
const WORK = 'd-work00000001';
const GUILD = { guildId: 'gu-kindcheck01', name: 'Kind check', role: 'member', grants: [] };
const GUILD_DESK = `guild-${GUILD.guildId}`;

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, {
    fleet: [
      { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
    ],
    guilds: { list: [GUILD], desks: { [GUILD.guildId]: { deskId: 'd-gkindcheck1', state: 'running' } } },
  });
});

test('each desk button carries its own id and kind: personal, work and guild', async ({ page }) => {
  await signIn(page);
  await canvasPainted(page);
  // The Guild Desk comes with the guild list, after the member's own desks.
  await expect(page.locator(`[id="proxy-${GUILD_DESK}"]`)).toBeVisible();
  const byId = (id: string) => page.locator(`[id="proxy-${id}"]`);
  await expect(byId(PERSONAL)).toHaveAttribute('data-desk', PERSONAL);
  await expect(byId(PERSONAL)).toHaveAttribute('data-kind', 'personal');
  await expect(byId(WORK)).toHaveAttribute('data-desk', WORK);
  await expect(byId(WORK)).toHaveAttribute('data-kind', 'work');
  await expect(byId(GUILD_DESK)).toHaveAttribute('data-desk', GUILD_DESK);
  await expect(byId(GUILD_DESK)).toHaveAttribute('data-kind', 'guild');
  // The map's key finds the same buttons as office.desk, each one with its kind, and nothing else carries them.
  const kinds = page.locator(MAP.els['office.desk.kind']!.sel).filter({ visible: true });
  const desks = page.locator(MAP.els['office.desk']!.sel).filter({ visible: true });
  await expect(desks).toHaveCount(3);
  await expect(kinds).toHaveCount(3);
  const ids = (els: Element[]) => els.map((e) => e.id).sort();
  expect(await kinds.evaluateAll(ids)).toEqual(await desks.evaluateAll(ids));
  await expect(page.locator('.proxy-layer [data-kind], .proxy-layer [data-desk]')).toHaveCount(3);
});
