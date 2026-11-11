// A wake as the member sees it (TD-227 part 3), on the real link with the API and the gateway stood in for here: the
// desks list and `connect` answer as services/desks does through a timed wake, and the gateway answers `watch` and pushes
// `desk.progress` as the real one does (contract gateway.md 2.1, 2.2). No desk, so a wake ends at `session.open`.
//  - no "asleep" between the member's press and the picture, even with a list asked for before the press landing after
//    it, and the wake's panel doesn't move as its steps go by;
//  - a pushed `phase: ready` opens the session at once; with no push, the poll finds it within about a second;
//  - a desk that starts with the office reads "checking…", then waking, never asleep.
import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const REAL_LINK = '/?link=real';
const DESK = 'd-personal00001';
const OTHER = 'd-work00000001';
const GATEWAY = 'ws://localhost:1/v1'; // the harness's client-config, with no gateway-shim

// The harness's CSP allows no gateway without the shim; this file's gateway is the route below.
test.use({ bypassCSP: true });

/** The platform through one desk's wake: stopped until `start: true`, then waking for `upAfterMs`, then ready. */
class Platform {
  wokeAt: number | null = null;
  readyAt: number | null = null;
  readonly connects: { at: number; start: boolean; answered: string }[] = [];
  readonly frames: { at: number; type: string; deskToken?: boolean }[] = [];
  readonly gateways: WebSocketRoute[] = [];
  private readonly watchers = new Set<WebSocketRoute>();
  /** Lists asked for while this is set are answered only when it's called. */
  hold: { release: () => void; asked: number } | null = null;
  holdNext = false;

  constructor(
    private readonly upAfterMs: number,
    private readonly push: boolean,
    private readonly startsWithOffice = false,
  ) {}

  state(now = Date.now()): 'stopped' | 'starting' | 'running' {
    if (this.wokeAt === null) return 'stopped';
    return now < this.wokeAt + this.upAfterMs ? 'starting' : 'running';
  }

  private row(now = Date.now()) {
    const state = this.state(now);
    return {
      deskId: DESK, name: 'Personal', kind: 'personal', state, phase: state === 'running' ? 'ready' : state,
      allowedActions: ['connect', 'start', 'stop'], ...(this.startsWithOffice ? { startsWithOffice: true } : {}),
    };
  }

  async list(route: Route): Promise<void> {
    const asked = Date.now();
    const body = { desks: [this.row(asked), { deskId: OTHER, name: 'Work', kind: 'work', state: 'stopped', phase: 'stopped', allowedActions: ['connect', 'start', 'stop'] }], pollAfterSeconds: 60 };
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>((release) => (this.hold = { release, asked }));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: `"${asked}"` }, body: JSON.stringify(body) });
  }

  async connect(route: Route): Promise<void> {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const { start } = route.request().postDataJSON() as { start: boolean };
    const now = Date.now();
    if (id === DESK && start && this.state(now) === 'stopped') {
      this.wokeAt = now;
      setTimeout(() => this.up(), this.upAfterMs);
    }
    const state = id === DESK ? this.state(now) : 'stopped';
    const ready = state === 'running';
    this.connects.push({ at: now, start, answered: state });
    const body = {
      deskId: id, state, phase: ready ? 'ready' : state, deskToken: `token-${this.connects.length}`, expiresAt: new Date(now + 300_000).toISOString(),
      refreshAfter: new Date(now + 240_000).toISOString(), gateway: GATEWAY, deskIdentity: ready ? { fingerprintsSha256: ['AA:BB'] } : null,
      ...(state === 'starting' ? { retryAfterSeconds: 3, queue: null } : {}),
    };
    await route.fulfill({ status: state === 'starting' ? 202 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  }

  /** The desk on the gateway: watchers hear `phase: ready`, if this gateway pushes. */
  private up(): void {
    this.readyAt = Date.now();
    if (!this.push) return;
    for (const ws of this.watchers) ws.send(JSON.stringify({ type: 'desk.progress', deskId: DESK, phase: 'ready', at: new Date().toISOString(), queue: null, error: null }));
  }

  gateway(ws: WebSocketRoute): void {
    this.gateways.push(ws);
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { type: string; id?: string; deskId?: string; deskToken?: string };
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      this.frames.push({ at: Date.now(), type: m.type, deskToken: !!m.deskToken });
      if (m.type === 'watch' && m.deskId === DESK && this.push) {
        this.watchers.add(ws);
        const state = this.state();
        ws.send(JSON.stringify({ type: 'watching', id: m.id, deskId: DESK, state, phase: state === 'running' ? 'ready' : state, etag: '"1"' }));
      }
      // `session.open` is where this file stops: no desk answers it.
    });
  }

  sessionOpenAt(): number | null {
    return this.frames.find((f) => f.type === 'session.open')?.at ?? null;
  }
}

async function standIn(page: Page, platform: Platform): Promise<void> {
  await page.route((u) => u.pathname === '/v1/desks', (route) => (route.request().method() === 'GET' ? platform.list(route) : route.fallback()));
  await page.route((u) => /^\/v1\/desks\/[^/]+\/connect$/.test(u.pathname), (route) => platform.connect(route));
  await page.routeWebSocket(GATEWAY, (ws) => platform.gateway(ws));
}

interface Seen { at: number; label: string | null; panel: string | null; headingTop: number | null }

/**
 * Every frame: the desk's accessible name (its status line is in it), the Browser panel's kind and its heading's place in
 * the panel (layout only, so the window's opening transform doesn't count).
 */
async function record(page: Page): Promise<void> {
  await page.evaluate((desk) => {
    const w = window as unknown as { __wake: Seen[] };
    w.__wake = [];
    let last = '';
    const tick = (): void => {
      const label = document.getElementById(`proxy-${desk}`)?.getAttribute('aria-label') ?? null;
      const panel = document.querySelector<HTMLElement>('[data-testid="browser-panel"]');
      const heading = panel?.querySelector('h3');
      const s = { label, panel: panel?.dataset['panel'] ?? null, headingTop: heading ? heading.offsetTop : null };
      const key = JSON.stringify(s);
      if (key !== last) {
        last = key;
        w.__wake.push({ at: Date.now(), ...s });
      }
      requestAnimationFrame(tick);
    };
    tick();
  }, DESK);
}
const seen = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __wake: Seen[] }).__wake);

const browserTile = (page: Page) => page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: 'Browser', exact: true });

async function arrive(page: Page, platform: Platform): Promise<void> {
  await standIn(page, platform);
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await expect(page.locator(`[id="proxy-${DESK}"]`)).toHaveAttribute('aria-label', /asleep/);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a press on a sleeping desk shows it waking at once, never asleep again, even under a list asked for before the press', async ({ page }) => {
  const errors = watchConsole(page);
  const platform = new Platform(4_000, true);
  await arrive(page, platform);
  // A list on its way as the member presses: asked before the wake, answered after it, saying "stopped".
  platform.holdNext = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => platform.hold !== null).toBe(true);
  await record(page);
  const pressedAt = Date.now();
  await browserTile(page).evaluate((el) => (el as HTMLButtonElement).click());
  await expect.poll(() => platform.wokeAt !== null).toBe(true);
  platform.hold?.release();
  await expect.poll(() => platform.sessionOpenAt(), { timeout: 15_000 }).not.toBeNull();
  await page.waitForTimeout(300);
  const after = (await seen(page)).filter((s) => s.at >= pressedAt);
  // The window: waking from the moment it opens, never asleep. The canvas draws nothing while the camera glides to the
  // desk (rule "Never sluggish"), so its status line says asleep until the glide ends and then waking: never back again.
  expect(after.filter((s) => s.panel === 'asleep')).toEqual([]);
  const wakingAt = after.find((s) => /waking/.test(s.label ?? ''))?.at;
  expect(wakingAt).toBeDefined();
  expect(wakingAt! - pressedAt).toBeLessThan(1_500);
  expect(after.filter((s) => s.at > wakingAt! && /asleep/.test(s.label ?? ''))).toEqual([]);
  const panels = [...new Set(after.map((s) => s.panel).filter(Boolean))];
  expect(panels[0]).toBe('waking');
  expect(panels).toEqual(['waking', 'opening']);
  // The panel's heading stays put through the steps: no jump as the wake goes on.
  expect(new Set(after.filter((s) => s.panel === 'waking' || s.panel === 'opening').map((s) => s.headingTop)).size).toBe(1);
  expect(errors).toEqual([]);
});

test('with the gateway pushing, the wake watches the desk and opens the session as soon as it is ready', async ({ page }) => {
  const platform = new Platform(5_000, true);
  await arrive(page, platform);
  await browserTile(page).evaluate((el) => (el as HTMLButtonElement).click());
  await expect.poll(() => platform.sessionOpenAt(), { timeout: 15_000 }).not.toBeNull();
  const watch = platform.frames.find((f) => f.type === 'watch');
  expect(watch?.deskToken).toBe(true);
  expect(watch!.at - platform.wokeAt!).toBeLessThan(1_000); // watched as soon as the wake's answer came
  const late = platform.sessionOpenAt()! - platform.readyAt!;
  console.log(`ready to session.open: ${late} ms (push)`);
  expect(late).toBeLessThan(500);
});

test('with no push, the poll finds the desk ready within about a second, polling once a second', async ({ page }) => {
  const platform = new Platform(6_000, false);
  await arrive(page, platform);
  await browserTile(page).evaluate((el) => (el as HTMLButtonElement).click());
  await expect.poll(() => platform.sessionOpenAt(), { timeout: 15_000 }).not.toBeNull();
  const late = platform.sessionOpenAt()! - platform.readyAt!;
  console.log(`ready to session.open: ${late} ms (poll)`);
  expect(late).toBeLessThan(1_300);
  const polls = platform.connects.filter((c) => !c.start && c.at > platform.wokeAt!);
  const gaps = polls.slice(1).map((c, i) => c.at - polls[i]!.at);
  expect(Math.max(...gaps)).toBeLessThan(1_400);
  expect(Math.min(...gaps)).toBeGreaterThan(900);
  expect(polls.length).toBeLessThanOrEqual(8); // 6 s at 1 s, and no more
});

test('a desk that starts with the office reads checking, then waking, never asleep', async ({ page }) => {
  const platform = new Platform(4_000, true, true);
  await standIn(page, platform);
  await page.addInitScript((desk) => {
    const w = window as unknown as { __labels: string[] };
    w.__labels = [];
    const tick = (): void => {
      const l = document.getElementById(`proxy-${desk}`)?.getAttribute('aria-label');
      if (l && l !== w.__labels.at(-1)) w.__labels.push(l);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, DESK);
  await signIn(page, REAL_LINK);
  await expect.poll(() => platform.sessionOpenAt(), { timeout: 15_000 }).not.toBeNull();
  const labels = await page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);
  expect(labels.filter((l) => /asleep/.test(l))).toEqual([]);
  expect(labels.some((l) => /waking/.test(l))).toBe(true);
  expect(platform.connects.filter((c) => c.start)).toHaveLength(1);
});
