// The desk driver (mm-harness contract §4) on the real staging test desk, as desk-1. It works through the Agent window's own
// UI (the composer, each card's Approve and Decline with its note, the thread, Settings, Keys and Activity) and, for its world,
// only the methods the Files and Notebook apps already call, sent on the app's own session by `page-probe.mjs`. Its world is
// the Files folder `Harness` and the Notebook tab `Harness`; the page's guards refuse anything outside them. `executions` and
// `fault` are absent: a desk can't show them (the local rig has both).
//
// It never wakes the desk (rt-lib's guard trips on any `start: true`), never takes a screenshot while a key is in a field,
// and keeps the key only in the closure it was handed.
import { HARNESS_DIR, HARNESS_TAB, INJECT, docToText, harnessPath, mdToDoc, pairCards, parseCard } from './pure.mjs';
import { toolsProbe } from './page-probe.mjs';

// The driver's pure parts, for the unit tests and for anyone reading a card off the page.
export { pairCards, parseCard } from './pure.mjs';

/** "Harness 1113-150405": 19 characters, under the agent name's 24 and the key label's 40. Leftovers from a crashed run match it. */
export const harnessName = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `Harness ${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
export const LEFTOVER = /^Harness \d{4}-\d{6}( [a-z])?$/;

/** In the page: every card in the selected agent's thread, as the page shows it. Pending ones have their rows in view. */
function readCards(els) {
  return els.map((el) => {
    const pending = el.hasAttribute('data-approval-pending');
    const was = el.querySelector('.ag-approval-was');
    const title = pending ? el.querySelector('[data-testid="approval-title"]')?.textContent : was?.querySelector('.ag-approval-sub b')?.textContent;
    const rows = [...el.querySelectorAll('[data-testid="approval-rows"] > div')].map((d) => ({
      label: (d.querySelector('dt')?.textContent ?? '').trim(),
      value: (d.querySelector('dd details .ag-pre') ?? d.querySelector('dd'))?.textContent ?? '',
    }));
    return {
      title: (title ?? '').trim(),
      level: el.getAttribute('data-level'),
      state: el.getAttribute('data-state'),
      rows,
      untrustedLine: Boolean(el.querySelector('[data-testid="approval-untrusted"]')),
      note: el.querySelector('[data-testid="approval-why"]')?.textContent ?? null,
      headline: el.querySelector('[data-testid="approval-state"]')?.textContent ?? null,
    };
  });
}

/** In the page: the newest reply, as the page shows it. */
function readReply(thread) {
  const all = thread ? [...thread.querySelectorAll('[data-testid="msg-agent"]')] : [];
  const m = all.at(-1);
  if (!m) return { count: 0 };
  return {
    count: all.length,
    state: m.getAttribute('data-state'),
    text: m.querySelector('.ag-bubble')?.textContent ?? '',
    untrustedShown: Boolean(m.querySelector('[data-testid="msg-untrusted"]')),
    summary: (m.querySelector('[data-testid="run-summary"]')?.textContent ?? '').replace(/^This task: /, ''),
    chips: [...m.querySelectorAll('[data-testid="tool-chip"]')].map((c) => ({
      words: [c.querySelector('.ag-tool-word')?.textContent, c.querySelector('.ag-tool-target')?.textContent].filter(Boolean).join(' '),
      result: c.getAttribute('data-result'),
      level: c.getAttribute('data-level'),
    })),
    pending: thread.querySelectorAll('[data-approval-pending]').length,
  };
}

/**
 * @param {{
 *   out: string,
 *   key?: (() => string | null) | null,
 *   provider?: string,
 *   model?: string | null,
 *   initScripts?: Array<[Function, unknown]>,
 *   contextOptions?: object,
 *   bundle?: { dist: string, release: object } | null,
 *   log?: (...parts: unknown[]) => void,
 *   beforeAgentWindow?: (lib: object) => Promise<void>,
 *   lib?: () => Promise<object>,
 *   wake?: boolean,
 * }} opts
 *
 * `lib` loads the desk's lib (rt-lib.mjs, desk-1's test desk, by default; `fleet.mjs` for a fleet account's desk). `wake: true`
 * wakes a sleeping desk as a member does, from the office (the fleet desk's rule); without it a stopped desk is refused.
 */
export function createDeskDriver(opts) {
  let lib = null;
  let p = null;
  let win = null;
  const say = (...parts) => (opts.log ?? lib?.log ?? console.log)(...parts);
  const made = { agents: [], keyLabels: [] };
  let selected = null;
  let auditFloor = 0;
  let lastAuditSeq = 0;
  const trash = { known: new Set(), own: new Set() };
  let knownPages = new Set();
  let keyBound = null;

  const until = async (fn, ms, every = 200) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v || Date.now() > end) return v;
      await lib.wait(every);
    }
  };
  /** A click, or where another window covers the control (the Notebook open beside the Agent), the same click sent to it. */
  const press = async (loc) => {
    try {
      await loc.click({ timeout: 3000 });
    } catch {
      await loc.dispatchEvent('click');
    }
  };
  const snap = () => p.evaluate(() => window.__rtTools.snapshot());
  const call = async (method, params, mode = 'full') => {
    const r = await p.evaluate(([m, pr, md]) => window.__rtTools.call(m, pr, { mode: md }), [method, params, mode]);
    if (!r.ok && mode === 'full' && r.code === 'refused_by_harness') throw new Error(`the page refused ${method}: ${r.details?.reason}`);
    return r;
  };
  const must = async (method, params) => {
    const r = await call(method, params);
    if (!r.ok) throw new Error(`${method} answered ${r.code}${r.details?.reason ? ` (${r.details.reason})` : ''}`);
    return r.result;
  };

  // ------------------------------------------------------------ the window

  const openAgentWindow = async () => {
    const proxy = p.locator(`[id="proxy-${lib.ALLOWED}:agent"]`);
    await proxy.focus();
    await p.keyboard.press('Enter');
    win = p.getByRole('dialog', { name: 'Agent' }).first();
    await win.waitFor({ state: 'visible', timeout: 15_000 });
    await win.getByTestId('agent-app').first().waitFor({ state: 'visible', timeout: 45_000 });
  };
  const closeDrawer = async () => {
    if (await win.getByTestId('drawer').isVisible().catch(() => false)) await press(win.getByRole('button', { name: 'Close panel' }));
  };
  const openTab = async (id) => {
    await closeDrawer();
    await press(win.getByTestId(`tab-${id}`));
    await win.getByTestId('drawer').waitFor({ state: 'visible', timeout: 8000 });
  };
  const select = async (agentId) => {
    const btn = win.getByTestId(`agent-${agentId}`);
    if (selected === agentId && (await btn.getAttribute('aria-selected').catch(() => null)) === 'true') return;
    if (!(await btn.isVisible().catch(() => false))) await press(win.getByRole('button', { name: 'Agents', exact: true })).catch(() => {});
    await press(btn);
    selected = agentId;
  };

  // ------------------------------------------------------------ Files, through the Files app's own methods

  const listAll = async (path) => {
    const out = [];
    let cursor = null;
    do {
      const r = await call('files.list', cursor ? { path, cursor } : { path });
      if (!r.ok) {
        if (r.code === 'not_found') return null;
        throw new Error(`files.list answered ${r.code}`);
      }
      out.push(...r.result.entries);
      cursor = r.result.next ?? null;
    } while (cursor);
    return out;
  };
  const walk = async (path, into) => {
    const entries = await listAll(path);
    if (!entries) return into;
    for (const e of entries) {
      const full = `${path}/${e.name}`;
      if (e.type === 'dir') {
        into[`${full}/`] = null;
        await walk(full, into);
      } else into[full] = e;
    }
    return into;
  };
  const trashItems = async () => {
    const items = [];
    let cursor = null;
    do {
      const r = await must('files.trash.list', cursor ? { cursor } : {});
      items.push(...r.items);
      cursor = r.next ?? null;
    } while (cursor);
    return items;
  };
  const writeFile = async (path, text, replace) => {
    harnessPath(path);
    const r = await p.evaluate(([pa, t, rep]) => window.__rtTools.writeFile(pa, t, { replace: rep }), [path, text, replace]);
    if (!r.ok) throw new Error(`writing ${path}: ${r.code}`);
    if (r.replaced) trash.own.add(r.replaced);
  };

  // ------------------------------------------------------------ the Notebook, through the Notebook app's own methods

  const tree = async () => {
    const t = await p.evaluate(() => window.__rtTools.harnessTree());
    if (!t.ok) throw new Error(`notebook.tree answered ${t.code}`);
    return t;
  };
  /**
   * A desk whose Notebook was never opened has no notebook at all. On a desk the run may wake (`wake: true`, the fleet desk), the
   * Notebook window is opened once as the member opens it, which makes its first notebook ("Notebook", with its own tab and page,
   * left as made), and closed again. desk-1's test desk keeps the old refusal.
   */
  const firstNotebook = async () => {
    const tile = p.locator(`[id="proxy-${lib.ALLOWED}:notebook"]`);
    await tile.focus();
    await p.keyboard.press('Enter');
    const nb = p.getByRole('dialog', { name: /Notebook/ }).first();
    await nb.waitFor({ state: 'visible', timeout: 15_000 });
    const made = await until(async () => ((await tree()).notebooks.length ? true : null), 30_000);
    await driver.shot('notebook-first-open');
    const close = nb.getByRole('button', { name: /^Close/ });
    if (await close.count()) await press(close.first());
    say(`driver: the desk's Notebook opened for the first time${made ? ', its first notebook made' : ', and still no notebook'}`);
  };
  /** A world tab by its title (`Harness`, or `Harness Work` and the like), made in the desk's first notebook if it isn't there. */
  const tabFor = async (title) => {
    if (title !== HARNESS_TAB && !title.startsWith(`${HARNESS_TAB} `)) throw new Error(`refusing: a world page in tab ${title}`);
    if (title === HARNESS_TAB) return (await harnessTab()).tabId;
    const t = await tree();
    const found = t.tabs.find((x) => x.title === title);
    if (found) return found.id;
    const { tree: base } = await harnessTab();
    const made = await must('notebook.tab.create', { notebookId: base.tabs.find((x) => x.title === HARNESS_TAB)?.notebookId ?? base.notebooks[0], title });
    if (made.page?.id) await must('notebook.page.trash', { pageId: made.page.id });
    return made.tab.id;
  };
  const harnessTab = async () => {
    let t = await tree();
    const own = t.tabs.find((x) => x.title === HARNESS_TAB);
    if (own) return { tabId: own.id, tree: t };
    if (!t.notebooks.length && opts.wake) {
      await firstNotebook();
      t = await tree();
    }
    if (!t.notebooks.length) throw new Error('this desk has no notebook to put the Harness tab in');
    const made = await must('notebook.tab.create', { notebookId: t.notebooks[0], title: HARNESS_TAB });
    // A new tab comes with an empty page: it goes, so the tab holds only what a world lays down.
    if (made.page?.id) await must('notebook.page.trash', { pageId: made.page.id });
    return { tabId: made.tab.id, tree: await tree() };
  };

  const driver = {
    name: 'desk',

    async start() {
      lib = opts.lib ? await opts.lib() : await import('../rt-lib.mjs');
      const scripts = [[toolsProbe, { allow: INJECT, dir: HARNESS_DIR, tab: HARNESS_TAB }], ...(opts.initScripts ?? [])];
      await lib.openSession({
        browserKind: 'full',
        contextOptions: opts.contextOptions ?? {},
        onContext: async (ctx) => {
          // Order matters: a shim passed in `initScripts` goes first, so the probe's send wrapper sits outside it.
          for (const [fn, arg] of [...scripts.slice(1), scripts[0]]) await ctx.addInitScript(fn, arg);
          if (!opts.bundle) return;
          const { dist, release } = opts.bundle;
          const { existsSync } = await import('node:fs');
          await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
          await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
            const file = `${dist}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
            return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
          });
        },
      });
      p = lib.S.page;
      const btn = p.locator(`#proxy-${lib.ALLOWED}`);
      await btn.waitFor({ state: 'attached', timeout: 60_000 });
      await lib.closeTour().catch(() => false);
      const desk = await lib.getDesk();
      if (desk.state !== 'running' && opts.wake && lib.wakeDesk) await lib.wakeDesk();
      else if (desk.state !== 'running') throw new Error(`the desk is ${desk.state}; opening an app would wake it, and this never does`);
      if (!opts.wake) {
        await btn.focus();
        await p.keyboard.press('Enter');
      }
      if (!(await lib.waitPanel(/online/, 60_000))) throw new Error('the desk never connected');
      await until(() => p.evaluate(() => window.__rtTools?.connected()), 30_000);
      // The stand-in comes up here, once the session is open (so a signal brings it down) and before the window reads the agents.
      if (opts.beforeAgentWindow) await opts.beforeAgentWindow(lib);
      await openAgentWindow();
      const a = await driver.audit({ older: false });
      auditFloor = a.entries.length ? a.entries.at(-1).seq : 0;
      lastAuditSeq = auditFloor;
      say(`driver: started; audit floor ${auditFloor}`);
    },

    /** Leftover agents and keys a crashed run left, by their name alone (`LEFTOVER`): listed, and removed when asked. */
    async leftovers({ remove = false } = {}) {
      await closeDrawer();
      const names = await win.locator('.ag-agent-name').allTextContents();
      const agents = names.map((n) => n.trim()).filter((n) => LEFTOVER.test(n));
      if (remove) {
        for (const name of agents) {
          const btn = win.locator('.ag-agent-btn', { hasText: name });
          const id = ((await btn.first().getAttribute('data-testid')) ?? '').replace(/^agent-/, '');
          if (id) await driver.removeAgent(id).catch((e) => say(`driver: leftover agent ${name} stays: ${e.message}`));
        }
      }
      await openTab('keys');
      const labels = (await win.getByTestId('keys-panel').locator('.ag-key-label').allTextContents()).map((l) => l.trim()).filter((l) => LEFTOVER.test(l));
      await closeDrawer();
      if (remove) for (const label of labels) await driver.removeKey(label).catch((e) => say(`driver: leftover key ${label} stays: ${e.message}`));
      return { agents, keys: labels };
    },

    async stop({ clean = true } = {}) {
      if (!p) return;
      const problems = [];
      if (clean) await driver.reset({}).catch((e) => problems.push(`world: ${e.message}`));
      for (const label of made.keyLabels) await driver.removeKey(label).catch((e) => problems.push(`key: ${e.message}`));
      for (const a of [...made.agents].reverse()) await driver.removeAgent(a.id).catch((e) => problems.push(`agent ${a.name}: ${e.message}`));
      if (problems.length) say(`driver: cleanup left ${problems.join('; ')}`);
      return problems;
    },

    async reset(world = {}) {
      // Files: everything under Harness/ to the trash (never for good), then the world.
      const top = await listAll(HARNESS_DIR);
      if (top === null) await must('files.mkdir', { path: HARNESS_DIR, parents: true });
      else if (top.length) {
        const r = await must('files.delete', { paths: top.map((e) => `${HARNESS_DIR}/${e.name}`) });
        for (const x of r.results) if (x.trashId) trash.own.add(x.trashId);
      }
      const files = world.files ?? {};
      for (const [path, text] of Object.entries(files)) {
        harnessPath(path);
        if (path.endsWith('/') || text === null) await must('files.mkdir', { path: path.replace(/\/$/, ''), parents: true });
        else await writeFile(path, text, false);
      }
      trash.known = new Set((await trashItems()).map((x) => x.id));
      // Notebook: every live page of the Harness tab to the Notebook's Trash, then the world's pages.
      const { tabId, tree: t } = await harnessTab();
      for (const pg of t.pages) if (!pg.deletedAt) await must('notebook.page.trash', { pageId: pg.id });
      const pages = [];
      const tabs = { [HARNESS_TAB]: tabId };
      for (const pg of world.notebook ?? []) {
        tabs[pg.tab] ??= await tabFor(pg.tab);
        const made = await must('notebook.page.import', { tabId: tabs[pg.tab], doc: mdToDoc(pg.title, pg.markdown) });
        pages.push({ pageId: made.page.id, tab: pg.tab, title: pg.title });
      }
      knownPages = new Set((await tree()).pages.filter((x) => x.deletedAt).map((x) => x.id));
      return { tabs, pages };
    },

    /**
     * A new agent through "New agent", as a member makes one. The first gets the key in its own key screen, named as the agent is;
     * later ones pick that key in the form. The setup screen is saved with its defaults (Notebook, Files and Browser on; Courier
     * off; To-dos on; nothing without asking). With no key, it stays on its key screen (the perf script's key-less part).
     */
    async newAgent(name) {
      await closeDrawer();
      await press(win.getByTestId('new-agent'));
      await win.getByTestId('new-agent-name').fill(name);
      const keySelect = win.locator('#ag-new-key');
      if (keyBound) {
        const labels = await keySelect.locator('option').allTextContents();
        const hit = labels.find((l) => l.startsWith(`${keyBound.label} · `));
        if (!hit) throw new Error('the harness key is not in the new agent form');
        await keySelect.selectOption({ label: hit });
      } else await keySelect.selectOption({ value: '' });
      const before = (await snap()).created.length;
      await press(win.getByTestId('new-agent-submit'));
      const created = await until(async () => (await snap()).created[before] ?? null, 15_000);
      if (!created?.agentId) throw new Error('agent.create never answered');
      const agentId = created.agentId;
      made.agents.push({ id: agentId, name });
      selected = agentId;
      await closeDrawer();
      const key = opts.key ? opts.key() : null;
      if (!keyBound && key) {
        await win.getByTestId('key-setup').waitFor({ state: 'visible', timeout: 15_000 });
        const form = win.getByTestId('key-form');
        const provider = form.getByRole('radio', { name: opts.provider ?? 'Anthropic' });
        if (await provider.count()) await press(provider);
        await form.getByLabel('Name it (optional)').fill(name);
        const field = form.getByTestId('key-input');
        await field.fill(key);
        const keysBefore = (await snap()).keys.length;
        await press(form.getByTestId('key-submit'));
        // The field is wiped by the form either way; nothing is shot until it is.
        const outcome = await until(async () => {
          if ((await snap()).keys.length > keysBefore && !(await win.getByTestId('key-setup').isVisible())) return 'bound';
          if (await form.getByTestId('key-error').isVisible().catch(() => false)) return 'refused';
          return null;
        }, 60_000);
        await field.fill('').catch(() => {});
        if (outcome !== 'bound') throw new Error(outcome === 'refused' ? `the desk refused the key: ${await form.getByTestId('key-error').innerText()}` : 'the key never bound');
        keyBound = { label: name };
        made.keyLabels.push(name);
      }
      if (keyBound) {
        // The model named, else the form's own default; never a Fable model (the owner stopped Fable on Nov 11): an older
        // desk-agent listed Anthropic's newest first (claude-fable-5-2), so a default that lands there is moved to Sonnet 5.5.
        if (/fable/i.test(opts.model ?? '')) throw new Error(`refusing: ${opts.model} is a Fable model, which the owner stopped on Nov 11`);
        await openTab('keys');
        const m = win.getByTestId('bind-model');
        const want = opts.model || (/fable/i.test(await m.inputValue().catch(() => '')) ? 'claude-sonnet-5-5' : null);
        if (want) await m.selectOption({ value: want });
        if (want && (await win.getByTestId('bind-save').isEnabled())) await press(win.getByTestId('bind-save'));
        if (/fable/i.test(await m.inputValue().catch(() => ''))) throw new Error('refusing: the new agent is on a Fable model');
        await closeDrawer();
      }
      if (keyBound) {
        // The setup screen, before any run: saved as it opens.
        await win.getByTestId('access-setup').waitFor({ state: 'visible', timeout: 20_000 });
        await press(win.getByTestId('access-save'));
        await win.getByTestId('composer-input').waitFor({ state: 'visible', timeout: 20_000 });
      }
      say(`driver: agent ${agentId} made${keyBound ? ' with the harness key' : ' with no key'}`);
      return agentId;
    },

    /**
     * The desk's own Lead (the agent `agent.list` names `manager`), for a desk whose agent and key are the member's: nothing is
     * made or removed. Its setup screen, if it shows, is saved once with its defaults, as the member would.
     */
    async lead() {
      const found = await until(async () => {
        const agents = (await snap()).agents;
        return agents.length ? (agents.find((a) => a.role === 'manager') ?? agents[0]) : null;
      }, 30_000);
      if (!found?.id) throw new Error('agent.list named no agent on this desk');
      await select(found.id);
      await closeDrawer();
      await until(async () => (await win.getByTestId('access-setup').isVisible().catch(() => false)) || (await win.getByTestId('composer-input').isVisible().catch(() => false)), 20_000);
      if (await win.getByTestId('access-setup').isVisible().catch(() => false)) {
        await driver.shot('lead-setup-screen');
        await press(win.getByTestId('access-save'));
        await win.getByTestId('composer-input').waitFor({ state: 'visible', timeout: 20_000 });
        say(`driver: ${found.id}'s setup screen saved with its defaults`);
        found.setupSaved = true;
      }
      return found;
    },

    /** How many cards the selected thread draws waiting: the page's own word, for when the wire's events go quiet (after a desk-agent restart). */
    async pendingOnPage(agentId) {
      await select(agentId);
      return win.getByTestId('thread').locator('[data-approval-pending]').count().catch(() => 0);
    },

    /** A run left waiting by an earlier, stopped script: ended with the composer's Stop, as the member would. Gives whether one was. */
    async stopWaiting(agentId) {
      await select(agentId);
      await closeDrawer();
      const stop = win.getByTestId('composer-stop');
      if (!(await stop.isVisible().catch(() => false))) return false;
      await press(stop);
      await until(async () => !(await stop.isVisible().catch(() => false)), 30_000);
      say('driver: a run left waiting was stopped with Stop');
      return true;
    },

    /** The Usage tab's numbers (agent.limits.get, as the window asks it): the policy's caps and each scope's spend, numbers only. */
    async usage(agentId) {
      await select(agentId);
      const before = (await snap()).limits.length;
      await openTab('usage');
      await win.getByTestId('limits-panel').waitFor({ state: 'visible', timeout: 10_000 });
      await until(async () => (await snap()).limits.length > before, 10_000);
      const l = (await snap()).limits.at(-1) ?? null;
      await closeDrawer();
      return l;
    },

    /**
     * Sets limit fields through the Usage tab's own form (Edit limits, the fields, Save limits), as the member does. `values` maps a
     * field (`agentDay`, `agentWeek`, `agentMonth`, `deskDay`, `deskMonth`, `keyMonth`, `run`) to the dollars typed, or '' to clear.
     */
    async setLimits(agentId, values) {
      await select(agentId);
      await openTab('usage');
      const panel = win.getByTestId('limits-panel');
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      await press(win.getByTestId('limits-edit'));
      await win.getByTestId('limits-form').waitFor({ state: 'visible', timeout: 10_000 });
      for (const [field, v] of Object.entries(values)) {
        const input = win.getByTestId(`limit-${field}`);
        if (!(await input.count())) throw new Error(`no limit field ${field}`);
        await input.fill(String(v));
      }
      const before = (await snap()).calls.filter((c) => c.m === 'agent.limits.set').length;
      await press(win.getByTestId('limits-save'));
      const done = await until(async () => {
        const calls = (await snap()).calls.filter((c) => c.m === 'agent.limits.set');
        return calls.length > before ? calls.at(-1) : null;
      }, 15_000);
      await closeDrawer();
      if (!done?.ok) throw new Error(`agent.limits.set answered ${done?.code ?? 'nothing'}`);
      return done;
    },

    /** The limit form's fields as the member sees them, typed values only (strings). */
    async limitFields(agentId) {
      await select(agentId);
      await openTab('usage');
      await win.getByTestId('limits-panel').waitFor({ state: 'visible', timeout: 10_000 });
      await press(win.getByTestId('limits-edit'));
      await win.getByTestId('limits-form').waitFor({ state: 'visible', timeout: 10_000 });
      const out = {};
      for (const input of await win.getByTestId('limits-form').locator('input[data-testid^="limit-"]').all()) {
        const id = (await input.getAttribute('data-testid')).replace(/^limit-/, '');
        out[id] = await input.inputValue();
      }
      const cancel = win.getByTestId('limits-form').getByRole('button', { name: 'Cancel' });
      if (await cancel.count()) await press(cancel);
      await closeDrawer();
      return out;
    },

    /** The Keys tab, read only: each key's provider, last 4 and whether it's available, and which agent uses which. Nothing is typed. */
    async keys() {
      const before = (await snap()).keyList.length;
      await openTab('keys');
      await win.getByTestId('keys-panel').waitFor({ state: 'visible', timeout: 10_000 });
      await until(async () => (await snap()).keyList.length > before, 10_000);
      const k = (await snap()).keyList.at(-1) ?? null;
      await closeDrawer();
      return k;
    },

    async closeWindow() {
      const close = win?.getByRole('button', { name: 'Close Agent' });
      if (close && (await close.count())) await press(close.first());
      await lib.wait(800);
      return !(await win?.isVisible().catch(() => false));
    },

    async removeAgent(agentId) {
      await select(agentId);
      await openTab('settings');
      await press(win.getByTestId('agent-delete'));
      await press(win.getByTestId('agent-delete-confirm'));
      await until(async () => !(await win.getByTestId(`agent-${agentId}`).count()), 15_000);
      made.agents = made.agents.filter((a) => a.id !== agentId);
      if (selected === agentId) selected = null;
    },

    async removeKey(label) {
      await openTab('keys');
      await press(win.getByRole('button', { name: `Delete key ${label}` }));
      await press(win.getByTestId('key-delete-confirm'));
      await win.getByTestId('key-deleted').waitFor({ state: 'visible', timeout: 15_000 });
      await closeDrawer();
      made.keyLabels = made.keyLabels.filter((l) => l !== label);
      if (keyBound?.label === label) keyBound = null;
    },

    async send(agentId, text) {
      await select(agentId);
      await closeDrawer();
      const before = (await snap()).sends.length;
      await win.getByTestId('composer-input').fill(text);
      await press(win.getByTestId('composer-send'));
      const sent = await until(async () => (await snap()).sends[before] ?? null, 20_000);
      if (!sent) throw new Error('agent.message.send never answered');
      return { runId: sent.runId, messageId: sent.messageId };
    },

    /** The selected agent's cards as the page shows them, beside the wire's ids. `pending`, or `all`. */
    async cards(agentId, state = 'pending') {
      await select(agentId);
      const raw = await win.getByTestId('thread').locator('[data-testid="approval"]').evaluateAll(readCards);
      const dom = raw.map(parseCard);
      const wire = Object.values((await snap()).approvals).filter((a) => a.agentId === agentId);
      const paired = pairCards(dom, wire);
      return state === 'pending' ? paired.filter((c) => c.state === 'pending') : paired;
    },

    /**
     * One run's cards: the wire's approvals of that run, oldest first, each beside the page's card in the same place counted from
     * the thread's end (a long thread's page may not show its oldest cards, so the newest are paired, not the first).
     */
    async runCards(agentId, runId) {
      await select(agentId);
      const wire = Object.values((await snap()).approvals)
        .filter((a) => a.agentId === agentId && a.runId === runId)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!wire.length) return [];
      const raw = await win.getByTestId('thread').locator('[data-testid="approval"]').evaluateAll(readCards);
      return pairCards(raw.map(parseCard).slice(-wire.length), wire);
    },

    /** Approve or decline, as the member does: Approve once it's offered (the card's hash checked) and armed; a note through "Decline and say why". */
    async decide(card, approve, note) {
      const pending = win.getByTestId('thread').locator('[data-approval-pending]');
      const titles = await pending.locator('[data-testid="approval-title"]').allTextContents();
      const i = titles.findIndex((t) => t.trim() === card.title);
      if (i < 0) throw new Error(`no pending card “${card.title}”`);
      const el = pending.nth(i);
      if (approve) {
        const btn = el.getByTestId('approval-approve');
        await btn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
          throw new Error(`Approve isn't offered on “${card.title}”: what it shows doesn't hash to its sha256`);
        });
        await lib.wait(700); // the card ignores a press for its first 500 ms
        await press(btn);
      } else if (note) {
        await press(el.getByTestId('approval-why-open'));
        await el.getByTestId('approval-why-input').fill(note);
        await press(el.getByTestId('approval-why-send'));
      } else await press(el.getByTestId('approval-decline'));
      if (card.id) {
        const left = await until(async () => {
          const a = (await snap()).approvals[card.id];
          return a && a.state !== 'pending' ? a.state : null;
        }, 20_000);
        if (!left) throw new Error(`the desk never took the answer on “${card.title}”`);
      }
    },

    /** `card` when one is pending, `settled` when the newest reply isn't streaming or waiting and none is, else `timeout`. */
    async waitTurn(agentId, { timeoutMs = 180_000, after = 0 } = {}) {
      await select(agentId);
      const thread = win.getByTestId('thread');
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const r = await thread.evaluate(readReply).catch(() => ({ count: 0 }));
        if (r.pending > 0) return 'card';
        if (r.count > after && r.state !== 'streaming' && r.state !== 'awaiting_approval') return 'settled';
        await lib.wait(300);
      }
      return 'timeout';
    },

    /** The contract's reply: waits until the newest reply isn't streaming and no card is pending. */
    async reply(agentId, { timeoutMs = 180_000, after = 0, runId = null } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const turn = await driver.waitTurn(agentId, { timeoutMs: Math.max(1000, end - Date.now()), after });
        if (turn === 'settled') break;
        if (Date.now() > end) break;
        await lib.wait(500);
      }
      const dom = await win.getByTestId('thread').evaluate(readReply);
      const s = await snap();
      const msgs = Object.values(s.messages).filter((m) => m.role === 'assistant' && (!runId || m.runId === runId));
      const wire = msgs.sort((a, b) => a.firstAt - b.firstAt).at(-1) ?? null;
      // The page's chips leave out declined and unanswered calls (`chipOf`): so do these, to pair by order.
      const named = (wire?.tools ?? []).filter((t) => t.decision !== 'declined' && t.decision !== 'expired');
      const chips = (dom.chips ?? []).map((c, i) => ({ ...c, name: named[i]?.name ?? null, session: named[i]?.session ?? null, approvalId: named[i]?.approvalId ?? null }));
      return { state: dom.state ?? null, text: dom.text ?? '', untrusted: wire?.untrusted ?? null, untrustedShown: Boolean(dom.untrustedShown), summary: dom.summary ?? '', chips, runId: wire?.runId ?? runId, count: dom.count ?? 0 };
    },

    /** How many replies the thread shows now: `waitTurn`'s `after`. */
    async replyCount(agentId) {
      await select(agentId);
      return (await win.getByTestId('thread').evaluate(readReply)).count ?? 0;
    },

    /** This run's approvals on the wire, oldest first: ids, tools, states and results only. */
    async wireApprovals(runId) {
      return Object.values((await snap()).approvals)
        .filter((a) => a.runId === runId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async files() {
      const found = await walk(HARNESS_DIR, {});
      const files = {};
      for (const [path, e] of Object.entries(found)) {
        if (e === null) {
          files[path] = null;
          continue;
        }
        const r = await p.evaluate((pa) => window.__rtTools.readFile(pa), path);
        files[path] = r.ok ? r.text : null;
        if (!r.ok) say(`driver: couldn't read ${path}: ${r.code}`);
      }
      const items = await trashItems();
      const fresh = items.filter((x) => !trash.known.has(x.id) && !trash.own.has(x.id));
      return { files, trash: fresh.map((x) => x.name) };
    },

    /** As the member, from the Files app: the next card's `before` changes under it. */
    async editFile(path, text) {
      await writeFile(path, text, true);
      trash.known = new Set((await trashItems()).map((x) => x.id));
    },

    async notebook() {
      const t = await tree();
      const tabOf = (id) => t.tabs.find((x) => x.id === id)?.title ?? HARNESS_TAB;
      const out = [];
      for (const pg of t.pages) {
        if (pg.deletedAt) {
          if (!knownPages.has(pg.id)) out.push({ pageId: pg.id, tab: tabOf(pg.tabId), title: pg.title, markdown: '', text: '', trashed: true });
          continue;
        }
        const r = await p.evaluate((id) => window.__rtTools.pageDoc(id), pg.id);
        const text = r.ok ? docToText(r.doc) : '';
        out.push({ pageId: pg.id, tab: tabOf(pg.tabId), title: pg.title, markdown: text, text, trashed: false });
      }
      return out;
    },

    /** The member's Undo of an agent's last edit of a page, as the Notebook's foot line does it. */
    async undoAgentEdit(title) {
      const pg = (await tree()).pages.find((x) => x.title === title && !x.deletedAt);
      if (!pg) throw new Error(`no page “${title}” in ${HARNESS_TAB}`);
      const { edits } = await must('notebook.page.agentEdits', { pageId: pg.id });
      const last = (edits ?? []).at(-1) ?? (edits ?? [])[0];
      if (!last) throw new Error(`no agent edit on “${title}”`);
      await must('notebook.page.agentUndo', { editId: last.id ?? last.editId });
    },

    /** Activity's rows since the run began, oldest first, ids and hashes only (and whether each holds the canary). */
    async audit({ older = true, since = null } = {}) {
      const floor = since ?? auditFloor;
      const asked = (s) => s.calls.filter((c) => c.m === 'agent.audit.list').length;
      const before = asked(await snap());
      await openTab('activity');
      await win.getByTestId('activity-panel').waitFor({ state: 'visible', timeout: 10_000 });
      // The panel reads the newest page each time it opens: wait for that answer, not an older one.
      await until(async () => asked(await snap()) > before, 15_000);
      // Back through "Show older" to the row the run began after, never further (the desk's whole history isn't ours).
      for (let i = 0; older && i < 40; i += 1) {
        const entries = (await snap()).audit.entries;
        const oldest = entries.length ? entries[0].seq : 0;
        const older = win.getByRole('button', { name: 'Show older' });
        if (oldest <= floor + 1 || !(await older.isVisible().catch(() => false))) break;
        await press(older);
        await lib.wait(600);
      }
      await closeDrawer();
      const s = await snap();
      const entries = s.audit.entries.filter((e) => e.seq > floor);
      if (entries.length) lastAuditSeq = entries.at(-1).seq;
      return { entries, headHash: s.audit.headHash };
    },

    /** The highest audit row seen so far: a case's rows are the ones after it. */
    auditSeq: () => lastAuditSeq,

    setCanaries: (list) => p.evaluate((l) => window.__rtTools.setCanaries(l), list),

    snapshot: snap,

    async openNotebookPage(title) {
      const t = await tree();
      const pg = t.pages.find((x) => x.title === title && !x.deletedAt);
      if (!pg) return false;
      const tile = p.locator(`[id="proxy-${lib.ALLOWED}:notebook"]`);
      await tile.focus();
      await p.keyboard.press('Enter');
      const nb = p.getByRole('dialog', { name: /Notebook/ }).first();
      await nb.waitFor({ state: 'visible', timeout: 15_000 });
      const tabBtn = nb.locator(`[role="tab"][data-tab-id="${t.tabs[0]?.id}"]`);
      if (await tabBtn.isVisible().catch(() => false)) await tabBtn.click();
      const pageBtn = nb.locator(`.nb-page-btn[data-page-id="${pg.id}"]`);
      if (!(await pageBtn.isVisible().catch(() => false))) return false;
      await pageBtn.click();
      await nb.getByTestId('note-editor').waitFor({ state: 'visible', timeout: 15_000 });
      return true;
    },

    async shot(name) {
      if (await win?.getByTestId('key-input').count().catch(() => 0)) {
        const v = await win.getByTestId('key-input').inputValue().catch(() => '');
        if (v) return null; // never a picture of a key
      }
      return lib.shot(opts.out, name);
    },

    /** The thread in Light, Zen and Dark (the account menu's Theme, this browser only), for a look at the tints. */
    async shotThemes(name) {
      const out = [];
      for (const label of ['Light', 'Zen', 'Dark']) {
        try {
          await press(p.getByRole('button', { name: 'Account', exact: true }));
          const menu = p.getByRole('dialog', { name: 'Account' });
          await menu.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: label }).click({ timeout: 5000 });
          await p.keyboard.press('Escape');
          await lib.wait(400);
          out.push(await driver.shot(`${name}-${label.toLowerCase()}`));
        } catch (e) {
          say(`driver: no ${label} shot: ${e.message.split('\n')[0]}`);
        }
      }
      return out;
    },

    page: () => p,
    window: () => win,
    lib: () => lib,
  };
  return driver;
}
