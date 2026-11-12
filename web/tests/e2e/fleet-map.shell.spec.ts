// The AI tester fleet's map of the office (`public/fleet-map.json`, ma-platform ADR 0134 addendum; the toolkit's
// `tests/fleet-mcp/src/domain/office.ts` reads it): every `office.*` and `bible.*` key resolves on the harness office,
// in the state it names, as the fleet's tools find it. A key resolves when its selector has a visible match: exactly one,
// or at least one for a list key (the tools read those as lists). A key with `"check": false` says why it can't be
// checked here; the Bible's own keys are checked on its real view, in `apps/bible/view/tests/fleet-map.bible.spec.ts`.
// A change to an element a key names updates the map in the same commit, and this spec fails until it does. The other
// prefixes (commons, files, maia, notebook) are the next group's, in a spec of their own.
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

interface MapEl { sel: string; route?: string; note?: string; check?: false; reason?: string }
const MAP = JSON.parse(readFileSync(new URL('../../public/fleet-map.json', import.meta.url), 'utf8')) as { version: number; surface: string; routes: Record<string, unknown>; els: Record<string, MapEl> };
const MINE = /^(office|bible)\./;

const PERSONAL = 'd-personal00001';
const WORK = 'd-work00000001';
const BIBLE = 'com.minimalistalliance.bible';
const fleet = [
  { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
];
type Hook = { __maDeskMock: { sleep(deskId: string): void }; __maDesk: { camera: { isMoving(): boolean } } };

/** Which keys each state shows. `within` is the key a key is looked for inside; `list` takes one or more. */
interface Check { key: string; within?: string; list?: true }
const STATES = {
  office: [{ key: 'office.shell' }, { key: 'office.desk', list: true }, { key: 'office.desk.kind', list: true }, { key: 'office.tile', list: true }, { key: 'office.home' }, { key: 'office.desknav' }],
  noDesks: [{ key: 'office.notice' }],
  window: [{ key: 'office.window', list: true }, { key: 'office.window.close', within: 'office.window' }],
  openTile: [{ key: 'office.opentile', list: true }],
  deskMenu: [{ key: 'office.menu.desk' }, { key: 'office.menu.apps', within: 'office.menu.desk' }],
  sheet: [
    { key: 'office.apps.sheet' },
    { key: 'office.apps.close', within: 'office.apps.sheet' },
    { key: 'office.apps.row', within: 'office.apps.sheet', list: true },
    { key: 'office.apps.add', within: 'office.apps.sheet', list: true },
  ],
  installed: [{ key: 'office.apps.open', within: 'office.apps.sheet' }, { key: 'office.apps.remove', within: 'office.apps.sheet' }],
  asleep: [{ key: 'office.apps.empty', within: 'office.apps.sheet' }],
  bible: [{ key: 'bible.frame' }],
  account: [
    { key: 'office.account' },
    { key: 'office.account.dialog' },
    { key: 'office.theme', within: 'office.account.dialog' },
    { key: 'office.theme.system', within: 'office.theme' },
    { key: 'office.theme.light', within: 'office.theme' },
    { key: 'office.theme.zen', within: 'office.theme' },
    { key: 'office.theme.dark', within: 'office.theme' },
  ],
  browser: [
    { key: 'office.browser.address', within: 'office.window' },
    { key: 'office.browser.video', within: 'office.window' },
    { key: 'office.browser.tab', within: 'office.window', list: true },
    { key: 'office.browser.tab.title', within: 'office.browser.tab' },
  ],
  browserSimple: [{ key: 'office.browser.simple', within: 'office.window' }],
} satisfies Record<string, Check[]>;

const sel = (key: string): string => {
  const e = MAP.els[key];
  if (!e) throw new Error(`the map has no ${key}`);
  return e.sel;
};

/** Each check in a state, as the toolkit's el() would find it (visible matches only). */
async function resolves(page: Page, checks: Check[]): Promise<void> {
  for (const c of checks) {
    const scope: Page | Locator = c.within ? page.locator(sel(c.within)).filter({ visible: true }).first() : page;
    const all = scope.locator(sel(c.key)).filter({ visible: true });
    await expect(all.first(), `${c.key} shows`).toBeVisible();
    if (!c.list) await expect(all, `${c.key} is one element, not several`).toHaveCount(1);
  }
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
}

async function office(page: Page, request: APIRequestContext, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = { available: true, installMs: 100 };
  });
  await harness(request, { fleet, appFrames: true, ...extra });
  await signIn(page);
  await canvasPainted(page);
}

/** The Personal desk in front, as pressing it does. */
async function front(page: Page): Promise<void> {
  const desk = page.locator(`[id="proxy-${PERSONAL}"]`);
  await desk.focus();
  await desk.evaluate((e) => (e as HTMLButtonElement).click());
  await expect(page.getByRole('button', { name: 'Your office, show all desks' })).toBeVisible();
  await settled(page);
}

const pressTile = (page: Page, app: string): Promise<void> => page.locator(`[id="proxy-${PERSONAL}:${app}"]`).evaluate((e) => (e as HTMLButtonElement).click());

async function openSheet(page: Page, deskId = PERSONAL): Promise<void> {
  await settled(page);
  await page.locator(`[id="proxy-${deskId}"]`).focus();
  await page.keyboard.press('.');
  await expect(page.getByRole('menu', { name: 'Desk' })).toBeVisible();
  await page.getByTestId('desk-menu-apps').click();
  await expect(page.getByTestId('apps-sheet')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the map is the office\'s, and every office and Bible key is checked here or says why not', () => {
  expect(MAP.version).toBe(1);
  expect(MAP.surface).toBe('office');
  const checked = new Set(Object.values(STATES).flat().map((c: Check) => c.key));
  for (const [key, e] of Object.entries(MAP.els).filter(([k]) => MINE.test(k))) {
    expect(e.route, `${key}'s route`).toBe('office');
    if (e.check === false) {
      expect(e.reason, `${key} says why it isn't checked`).toBeTruthy();
      expect(checked.has(key), `${key} is check: false, so it isn't checked here`).toBe(false);
    } else expect(checked.has(key), `${key} is checked in one of this spec's states`).toBe(true);
  }
  for (const key of checked) expect(MAP.els[key], `${key} is in the map`).toBeTruthy();
});

test('the office: desks, tiles, the home mark and the desk switch with a desk in front; a window and its Close', async ({ page, request }) => {
  await office(page, request);
  await front(page);
  await resolves(page, STATES.office);
  await pressTile(page, 'notebook');
  await expect(page.getByTestId('window-notebook')).toBeVisible();
  await resolves(page, STATES.window);
});

test('the office\'s notice with no desks', async ({ page, request }) => {
  await harness(request, { desks: 'empty' });
  await signIn(page);
  await resolves(page, STATES.noDesks);
});

test('a tile at the open size, live', async ({ page, request }) => {
  const span = (n: number): number => n * 76 + (n - 1) * 16;
  const item = (app: string, x: number, w = 76, h = 76) => ({ id: `${PERSONAL}:${app}`, app, x, y: 24, w, h });
  const desk = {
    x: 0, y: 0, w: 24 + span(6) + 16 + 4 * 92 + 24, h: 24 + span(5) + 44 + 16,
    items: [item('notebook', 24, span(6), span(5)), item('chat', 24 + span(6) + 16), item('browser', 24 + span(6) + 108), item('agent', 24 + span(6) + 200)],
  };
  await office(page, request, { fleet: [fleet[0]], layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks: { [PERSONAL]: desk }, z: [PERSONAL] } } } });
  await settled(page);
  await expect(page.getByTestId('open-tile-notebook')).toBeVisible();
  await resolves(page, STATES.openTile);
});

test('the desk\'s menu and its Apps sheet; the Bible added, its row and its window', async ({ page, request }) => {
  await office(page, request);
  await front(page);
  await page.locator(`[id="proxy-${PERSONAL}"]`).focus();
  await page.keyboard.press('.');
  await resolves(page, STATES.deskMenu);
  await page.getByTestId('desk-menu-apps').click();
  await expect(page.getByTestId(`dapp-row-${BIBLE}`)).toBeVisible();
  await resolves(page, STATES.sheet);
  await page.getByTestId(`dapp-add-${BIBLE}`).click();
  await expect(page.getByTestId(`dapp-open-${BIBLE}`)).toBeVisible();
  // Open and Remove belong to the installed row; the sheet has one of each.
  await resolves(page, STATES.installed);
  await page.getByTestId(`dapp-open-${BIBLE}`).click();
  await expect(page.locator(`[data-app="app:${BIBLE}"] [data-testid="deskapp-frame"][data-state="ready"]`)).toBeVisible();
  await resolves(page, STATES.bible);
});

test('the Apps sheet of a desk that sleeps says so', async ({ page, request }) => {
  await office(page, request);
  await page.evaluate((id) => (window as unknown as Hook).__maDeskMock.sleep(id), WORK);
  await expect(page.locator(`[id="proxy-${WORK}"][aria-label$=", asleep"]`)).toHaveCount(1);
  await openSheet(page, WORK);
  await expect(page.getByTestId('dapp-empty')).toHaveAttribute('data-state', 'asleep');
  await resolves(page, STATES.asleep);
});

test('the account menu\'s Theme radios', async ({ page, request }) => {
  await office(page, request);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await resolves(page, STATES.account);
});

test('the Browser\'s bar and picture', async ({ page, request }) => {
  await office(page, request);
  await front(page);
  await pressTile(page, 'browser');
  await expect(page.getByTestId('window-browser')).toBeVisible();
  await expect.poll(() => page.getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await resolves(page, STATES.browser);
});

test('the Browser\'s Simplified switch, where the desk serves that view', async ({ page, request }) => {
  await office(page, request);
  // The desk serves the simplified view, as deskd will once its release is on the desk, with a page it simplifies in its
  // tab, before the window opens (`simple.shell.spec.ts`).
  await page.evaluate(() => {
    type Tab = { tabId: string; url: string; title: string; loading: boolean; active: boolean; canGoBack: boolean; canGoForward: boolean };
    const mock = (window as unknown as { __maDeskMock: { simple: { serves: boolean }; setTabs(tabs: Tab[]): void } }).__maDeskMock;
    mock.simple.serves = true;
    mock.setTabs([{ tabId: 't1', url: 'https://read.example/essay', title: 'read.example', loading: false, active: true, canGoBack: true, canGoForward: false }]);
  });
  await front(page);
  await pressTile(page, 'browser');
  await expect(page.getByTestId('browser-simple-on')).toBeVisible();
  await resolves(page, STATES.browserSimple);
});
