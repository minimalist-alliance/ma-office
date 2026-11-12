// The AI tester fleet's selector map (public/fleet-map.json, ma-platform ADR 0134 addendum), fleet group G5's part: every
// apps.*, maia.*, notebook.*, files.* and commons.* key resolves in the office as a member has it, against the harness's
// fake API, fake Maia and mock desks. A key resolves when its selector has a visible match where the tools look for it
// (one, unless the tools read it as a list); a key marked "check": false says why it can't be shown here. A UI change
// that breaks a key fails here, in this repo's own suite, before the fleet's tools meet it on staging. Every key of these
// areas must be checked here or marked: a new key with neither fails the last test.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

interface El {
  sel: string;
  check?: false;
  reason?: string;
}
const MAP = JSON.parse(readFileSync(new URL('../../public/fleet-map.json', import.meta.url), 'utf8')) as { surface: string; els: Record<string, El> };
const MINE = /^(apps|maia|notebook|files|commons)\./;
const GUILD = { guildId: 'gu-fleetmap', name: 'Map check', role: 'lead', grants: ['moderate', 'invite', 'manage_spaces', 'manage_agents'] };
const PERSONAL = 'd-testk3m7q2x'; // the harness's one desk (harness/serve.mjs DESK)

const checked = new Set<string>();

function selOf(key: string): string {
  const e = MAP.els[key];
  if (!e) throw new Error(`The map has no ${key}`);
  return e.sel;
}

/** The key's visible matches in a scope: one, or with `many`, at least one. */
async function resolves(scope: Page | Locator, key: string, opts: { many?: boolean } = {}): Promise<Locator> {
  const e = MAP.els[key];
  if (!e) throw new Error(`The map has no ${key}`);
  expect(e.check, `${key} is checked here, so it isn't marked check: false`).toBeUndefined();
  const loc = scope.locator(e.sel).visible();
  await expect(loc.first(), `${key} (${e.sel}) shows`).toBeVisible();
  if (opts.many) expect(await loc.count(), `${key} shows`).toBeGreaterThan(0);
  else await expect(loc, `${key} (${e.sel}) matches one`).toHaveCount(1);
  checked.add(key);
  return loc;
}

const deskGroup = (page: Page, deskId: string): Locator => page.locator(selOf('apps.deskGroup')).filter({ has: page.locator(`[id="proxy-${deskId}"]`) });

async function press(tile: Locator): Promise<void> {
  await tile.evaluate((b) => (b as HTMLElement).click());
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, { files: { enabled: true }, maia: { enabled: true }, guilds: { list: [GUILD], desks: { [GUILD.guildId]: { deskId: 'd-gfleetmap01', state: 'running' } } } });
});

test('the map is the office surface and its own format', () => {
  expect(MAP.surface).toBe('office');
  for (const [key, e] of Object.entries(MAP.els)) {
    expect(typeof e.sel, key).toBe('string');
    if (e.check === false) expect(e.reason, `${key}: check false needs a reason`).toBeTruthy();
  }
});

test('the office, its desks, Notebook and Files', async ({ page }) => {
  await signIn(page, '/');
  await canvasPainted(page);
  await resolves(page, 'apps.office');
  await resolves(page, 'apps.desk', { many: true });
  // Tiles are inside their desk's group.
  const personal = deskGroup(page, PERSONAL);
  await expect(personal).toHaveCount(1); // apps.deskGroup: no box of its own, so attached, not visible
  await resolves(personal, 'notebook.tile');
  await resolves(personal, 'files.tile');
  await resolves(deskGroup(page, `guild-${GUILD.guildId}`), 'commons.tile');

  // The Notebook.
  await press(personal.locator(selOf('notebook.tile')));
  const nb = await resolves(page, 'notebook.view');
  await resolves(nb, 'notebook.app');
  await resolves(nb, 'notebook.editor');
  await resolves(nb, 'notebook.newPage');
  const pageBtn = await resolves(nb, 'notebook.page', { many: true });
  await resolves(pageBtn.first(), 'notebook.page.title');
  await resolves(nb, 'notebook.tab', { many: true });

  // Files: the top folder of the mock desk's drive, a row selected, the New folder dialog with a name it refuses.
  await press(personal.locator(selOf('files.tile')));
  const files = await resolves(page, 'files.view');
  await resolves(files, 'files.body');
  await resolves(files, 'files.list');
  const rows = await resolves(files, 'files.row', { many: true });
  await resolves(rows.and(page.locator('[data-type="file"]')).first(), 'files.row.size');
  await resolves(files, 'files.crumb', { many: true });
  await resolves(page, 'apps.live');
  const actions = await resolves(files, 'files.actions');
  await resolves(actions, 'files.upload');
  await resolves(actions, 'files.newFolder');
  await resolves(files, 'files.usage');
  await files.locator('[data-testid="files-row"][data-type="file"]').first().click();
  await resolves(actions, 'files.delete');
  await actions.locator(selOf('files.newFolder')).click();
  const dialog = await resolves(files, 'files.nameDialog');
  await (await resolves(dialog, 'files.nameDialog.input')).fill('a/b');
  await (await resolves(dialog, 'files.nameDialog.submit')).click();
  await resolves(dialog, 'files.nameDialog.error');
  await page.keyboard.press('Escape');
});

test('Maia: her panel, a turn with a card and a notice, one held while she writes, a stop, and Your chats', async ({ page, request }) => {
  await signIn(page, '/');
  await canvasPainted(page);
  await resolves(page, 'maia.widget');
  await (await resolves(page, 'maia.launcher')).click();
  await resolves(page, 'maia.panel');
  await resolves(page, 'maia.title');
  // Your chats while there are none: its words for that.
  await (await resolves(page, 'maia.chatsButton')).click();
  await expect(page.locator(selOf('maia.title'))).toHaveText('Your chats');
  await resolves(page, 'maia.intro');
  await (await resolves(page, 'maia.back')).click();
  await resolves(page, 'maia.newChat');
  const composer = await resolves(page, 'maia.composer');
  await composer.fill('Open my account [stub:page:account] [stub:notice]');
  await composer.press('Enter');
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'false', { timeout: 10_000 });
  await resolves(page, 'maia.send');
  await resolves(page, 'maia.item', { many: true });
  const mine = await resolves(page, 'maia.mine');
  await resolves(mine, 'maia.mine.text');
  const hers = await resolves(page, 'maia.hers');
  await resolves(hers, 'maia.reply');
  await resolves(hers, 'maia.card');
  await resolves(page, 'maia.note');
  // Held: her message while she writes it.
  await harness(request, { maiaHold: true });
  await composer.fill('Hold on');
  await composer.press('Enter');
  await resolves(page, 'maia.busy');
  await harness(request, { maiaHold: false });
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'false', { timeout: 10_000 });
  // A stop: the harness's stub refusal (a stop line only, nothing to do with her safety screen).
  await composer.fill('[stub:refusal]');
  await composer.press('Enter');
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'false', { timeout: 10_000 });
  await resolves(page.locator(selOf('maia.hers')).last(), 'maia.stop');
  // Your chats with one.
  await page.locator(selOf('maia.chatsButton')).click();
  const chat = await resolves(page, 'maia.chat');
  await resolves(chat, 'maia.chat.title');
});

test("Commons on the guild's Guild Desk: channels, the chat and its box", async ({ page }) => {
  await signIn(page, '/');
  await canvasPainted(page);
  await press(deskGroup(page, `guild-${GUILD.guildId}`).locator(selOf('commons.tile')));
  const view = await resolves(page, 'commons.view');
  const app = await resolves(view, 'commons.app');
  const channel = await resolves(app, 'commons.channel', { many: true });
  await resolves(channel.first(), 'commons.channel.name');
  await resolves(channel.first(), 'commons.channel.open');
  await resolves(app, 'commons.chat.title');
  const chat = await resolves(app, 'commons.chat');
  await resolves(chat, 'commons.chat.loaded');
  const msg = await resolves(chat, 'commons.msg', { many: true });
  const head = msg.and(page.locator('[data-head="1"]')).last();
  await resolves(head, 'commons.msg.name');
  await resolves(head, 'commons.msg.text');
  await resolves(head, 'commons.msg.time');
  await resolves(app, 'commons.composer');
});

test('every key of these areas is checked above or says why it can\'t be', () => {
  const missing = Object.entries(MAP.els)
    .filter(([k, e]) => MINE.test(k) && e.check !== false && !checked.has(k))
    .map(([k]) => k);
  expect(missing).toEqual([]);
});
