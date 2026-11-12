// Dev and test only, like `mockDeskLink.ts`, which is all that imports this: never in a production bundle (scripts/build-release.mjs
// checks). A desk's apps (deskd API.md section 19) for `MockDeskLink`: the catalog with the sample app, Tally
// (`spikes/app-contract-sample/`, its real view files and manifest, the manifest's file hashes filled in and signed with a test
// review key made here, which only a non-production build trusts), and the Bible's catalog row from Sales' copy, as a first-party
// app bundled in deskd's image (`signatures: null`, a stand-in view: the real one is a later brief). Tally runs here in
// JavaScript, as the sample's Go service would: `tally.get`, `tally.add`, `tally.reset`, the `tally` topic and its widget. Its
// count is kept per desk across a Remove, as deskd keeps an app's data. Steer it as `window.__maDeskMock.apps`, or before load
// with `window.__maAppsMockInit`. By default apps aren't available, as on every real desk today.
import tallyHtml from '../../../spikes/app-contract-sample/app/view/index.html?raw';
import tallyJs from '../../../spikes/app-contract-sample/app/view/view.js?raw';
import tallyCss from '../../../spikes/app-contract-sample/app/view/view.css?raw';
import tallyManifestSource from '../../../spikes/app-contract-sample/app/ma-app.json?raw';
import { guildIdOfPanel } from '../guild/panel';
import { useGuildStore } from '../guild/guildStore';
import type { RawTopicEvent } from './deskLink';

export const TALLY = 'com.minimalistalliance.sample.tally';
export const BIBLE = 'com.minimalistalliance.bible';

export interface MockAppsControl {
  /** What `apps.list` says. */
  available: boolean;
  reason: string | null;
  /** No catalog to give: `catalog: null`. */
  noCatalog: boolean;
  /** How long an install takes, so its calm state shows. */
  installMs: number;
  /** A view file served changed from what the manifest says: `{appId: path}`. */
  tamper: Record<string, string>;
  /** Every `apps.*` call, in order. */
  calls: { m: string; p: Record<string, unknown> }[];
  /** Put an installed app in `failed` with this problem, as deskd does after three crashes. */
  fail(deskId: string, appId: string, problem: string): void;
  /** Install an app on a desk as if it had been added before this page loaded. */
  preinstall(deskId: string, appId: string): void;
  /** Send every desk's `apps` again, as after a change to `available`. */
  push(): void;
}

const init = (window as unknown as { __maAppsMockInit?: Partial<Pick<MockAppsControl, 'available' | 'reason' | 'noCatalog' | 'installMs' | 'tamper'>> & { preinstalled?: Record<string, string[]> } }).__maAppsMockInit ?? {};

const refused = (code: string, reason?: string): Error => Object.assign(new Error(`mock apps: ${code}`), { code, details: reason ? { reason } : {} });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))));
const sha = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

// ----- the Bible's stand-in view, bundled: just enough to show it's framed and bridged.
const BIBLE_HTML = '<main class="b"><h1>Bible</h1><p id="t">Opening…</p><p class="k">John 3</p></main>';
const BIBLE_JS = `"use strict";
const apply = (tokens) => { for (const [k, v] of Object.entries(tokens || {})) document.documentElement.style.setProperty("--bible-" + k.replace(/\\./g, "-"), v); };
addEventListener("message", (e) => {
  if (e.source !== parent || !e.data || e.data.t !== "ma.bridge" || !e.ports[0]) return;
  apply(e.data.tokens);
  e.ports[0].onmessage = (m) => { if (m.data && m.data.t === "theme") apply(m.data.tokens); };
  document.getElementById("t").textContent = "The reading view comes with the app.";
});`;
// In the office's font and the app's ink as the tokens give them, under names of its own (`--bible-*`, so the office's check
// of its own `--ma-*` names, `theme/cssVars.test.ts`, doesn't read them as the office's): the reference chip is in its accent.
const BIBLE_CSS = 'html,body{margin:0;height:100%}body{display:grid;place-items:center;text-align:center;background:var(--bible-surface-window);color:var(--bible-text-primary);font:15px/1.4 var(--bible-font,system-ui,sans-serif)}h1{margin:0 0 8px;font-size:22px;font-weight:600}p{margin:0;color:var(--bible-text-secondary)}p.k{display:inline-block;margin-top:16px;padding:4px 12px;border-radius:8px;background:var(--bible-accent-subtle);color:var(--bible-accent-default);font-weight:600}';

interface View {
  manifest: string;
  signatures: string | null;
  bundled: boolean;
  files: Record<string, string>;
}

interface AppDef {
  id: string;
  name: string;
  publisher: string;
  description: string;
  line?: string;
  about?: string;
  credits?: string[];
  bundled: boolean;
  version: string;
  bytes: number;
  methods: { name: string; mutation: boolean }[];
  topics: string[];
  window: { width: number; height: number; minWidth: number; minHeight: number };
  view: () => Promise<View>;
}

let key: Promise<{ spki: string; sign: (data: Uint8Array) => Promise<string>; keyId: string }> | null = null;
/** The test review key: made here, trusted only by a non-production build (`deskapps/host/keys.ts`). */
function testKey(): Promise<{ spki: string; sign: (data: Uint8Array) => Promise<string>; keyId: string }> {
  key ??= (async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const keyId = hex(await crypto.subtle.digest('SHA-256', spki)).slice(0, 16);
    const w = globalThis as { __maTestAppKeys?: { tier: string; spki: string }[] };
    w.__maTestAppKeys = [{ tier: 'first-party', spki: b64(spki) }];
    return { spki: b64(spki), keyId, sign: async (data) => b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, data as BufferSource)) };
  })();
  return key;
}

let tallyView: Promise<View> | null = null;
function tallyViewOf(): Promise<View> {
  tallyView ??= (async () => {
    const m = JSON.parse(tallyManifestSource) as Record<string, unknown>;
    const files: Record<string, { sha256: string; size: number; mode: string }> = {
      'bin/tally': { sha256: await sha('a stand-in for the sample binary'), size: 2_310_144, mode: '0755' },
    };
    const view = { 'view/index.html': tallyHtml, 'view/view.js': tallyJs, 'view/view.css': tallyCss };
    for (const [p, text] of Object.entries(view)) files[p] = { sha256: await sha(text), size: enc.encode(text).length, mode: '0644' };
    const manifest = JSON.stringify({ ...m, arch: 'arm64', files }, null, 2);
    const k = await testKey();
    const sig = await k.sign(enc.encode(manifest));
    return { manifest, signatures: JSON.stringify({ signatures: [{ role: 'review', keyId: k.keyId, sig }] }), bundled: false, files: view };
  })();
  return tallyView;
}

let bibleView: Promise<View> | null = null;
function bibleViewOf(): Promise<View> {
  bibleView ??= (async () => {
    const view = { 'view/index.html': BIBLE_HTML, 'view/view.js': BIBLE_JS, 'view/view.css': BIBLE_CSS };
    const files: Record<string, { sha256: string; size: number; mode: string }> = {};
    for (const [p, text] of Object.entries(view)) files[p] = { sha256: await sha(text), size: enc.encode(text).length, mode: '0644' };
    const manifest = JSON.stringify({
      manifest: 1, id: BIBLE, name: 'Bible', version: '1.0.0', publisher: 'Minimalist Alliance', description: 'Read, search and keep notes in four translations.',
      appApi: '>=1.0 <2', arch: 'arm64', run: { exec: ['bin/bible-app'], start: 'on-demand', startTimeoutSec: 5, stopTimeoutSec: 5 },
      resources: { memoryMaxMiB: 96, cpuMax: 0.5, tasksMax: 32, diskMaxMiB: 64 }, permissions: [],
      views: { window: { html: 'view/index.html', script: 'view/view.js', style: 'view/view.css', width: 720, height: 560, minWidth: 320, minHeight: 360 }, widget: true },
      methods: [{ name: 'bible.state.get', mutation: false }], topics: ['bible.marks'], files,
    }, null, 2);
    return { manifest, signatures: null, bundled: true, files: view };
  })();
  return bibleView;
}

const APPS: AppDef[] = [
  {
    id: BIBLE,
    name: 'Bible',
    publisher: 'Minimalist Alliance',
    description: 'Read, search and keep notes in four translations.',
    // Sales' listing (ma-coord business/bible-app-copy.md section 1), as the catalog would carry it.
    line: 'Read, search and keep notes in four translations.',
    about:
      'Read the Bible on your desk in the Berean Standard Bible, the World English Bible, the King James Version or the American Standard Version, and switch any time.\n\n' +
      'Search by word or phrase. Highlight, bookmark and write notes as you read; they belong to the verse, so they show in every translation.\n\n' +
      'The translations come inside the app, so it never needs the internet. Your highlights, bookmarks and notes are saved on your desk.',
    credits: [
      'Berean Standard Bible (BSB). Dedicated to the public domain by its publishers in 2023.',
      'World English Bible (WEB). Public domain.',
      'King James Version (KJV), the 1769 text. Public domain in the United States.',
      'American Standard Version (ASV), 1901. Public domain.',
    ],
    bundled: true,
    version: '1.0.0',
    bytes: 7_549_747,
    methods: [{ name: 'bible.state.get', mutation: false }],
    topics: ['bible.marks'],
    window: { width: 720, height: 560, minWidth: 320, minHeight: 360 },
    view: bibleViewOf,
  },
  {
    id: TALLY,
    name: 'Tally',
    publisher: 'Minimalist Alliance',
    description: 'Counts things. The sample app for the desk app contract.',
    bundled: false,
    version: '0.1.0',
    bytes: 1_048_576,
    methods: [
      { name: 'tally.get', mutation: false },
      { name: 'tally.add', mutation: true },
      { name: 'tally.reset', mutation: true },
    ],
    topics: ['tally'],
    window: { width: 360, height: 280, minWidth: 280, minHeight: 200 },
    view: tallyViewOf,
  },
];

interface Installed {
  state: string;
  problem: string | null;
  installedAt: string;
}

/** Per desk: what's installed, and each app's data, which a Remove keeps. */
const installed = new Map<string, Map<string, Installed>>();
const tallies = new Map<string, { count: number; updatedAt: string }>();
const idems = new Map<string, unknown>();
const listeners = new Map<string, Set<(msg: Record<string, unknown>) => void>>();
const topicListeners = new Map<string, Set<(e: RawTopicEvent) => void>>();
let seq = 0;

const appsOf = (deskId: string): Map<string, Installed> => {
  let m = installed.get(deskId);
  if (!m) installed.set(deskId, (m = new Map()));
  return m;
};
const tallyOf = (deskId: string): { count: number; updatedAt: string } => tallies.get(deskId) ?? { count: 0, updatedAt: '0001-01-01T00:00:00Z' };

function record(deskId: string, def: AppDef, inst: Installed): Record<string, unknown> {
  const t = tallyOf(deskId);
  const summary = def.id === TALLY ? { rows: [{ text: String(t.count), detail: 'Tally', time: t.updatedAt }] } : { rows: [{ text: 'John 1', detail: 'Berean Standard Bible' }] };
  return {
    id: def.id, name: def.name, version: def.version, previous: null, publisher: def.publisher, description: def.description, appApi: '1.0', start: 'on-demand',
    resources: { memoryMaxMiB: 32, cpuMax: 0.25, tasksMax: 16, diskMaxMiB: 16 }, permissions: [], net: [], views: { window: def.window, widget: true },
    methods: def.methods, topics: def.topics, tier: 'first-party', grants: [], state: inst.state, problem: inst.problem, summary, installedAt: inst.installedAt, updatedAt: inst.installedAt,
  };
}

function list(deskId: string): Record<string, unknown> {
  const apps = [...appsOf(deskId).entries()].flatMap(([id, inst]) => {
    const def = APPS.find((a) => a.id === id);
    return def ? [record(deskId, def, inst)] : [];
  });
  return { available: control.available, reason: control.available ? null : control.reason, appApi: '1.0', apps };
}

function push(deskId: string): void {
  seq += 1;
  const msg = { ...list(deskId), seq, type: 'patch' };
  for (const fn of listeners.get(deskId) ?? []) fn(msg);
}

function emitTally(deskId: string): void {
  seq += 1;
  for (const fn of topicListeners.get(`${deskId}|${TALLY}|tally`) ?? []) fn({ type: 'patch', seq, data: tallyOf(deskId) });
}

/** On a Guild Desk, installing and removing are the Founder's. */
const founder = (deskId: string): boolean => {
  const guildId = guildIdOfPanel(deskId);
  return !guildId || (useGuildStore.getState().hello[guildId]?.role ?? useGuildStore.getState().guilds.find((g) => g.guildId === guildId)?.role) === 'lead';
};

export const appsControl: MockAppsControl = {
  available: init.available ?? false,
  reason: init.reason ?? 'no_sandbox',
  noCatalog: init.noCatalog ?? false,
  installMs: init.installMs ?? 500,
  tamper: init.tamper ?? {},
  calls: [],
  fail: (deskId, appId, problem) => {
    const inst = appsOf(deskId).get(appId);
    if (!inst) return;
    inst.state = 'failed';
    inst.problem = problem;
    push(deskId);
  },
  preinstall: (deskId, appId) => {
    appsOf(deskId).set(appId, { state: 'stopped', problem: null, installedAt: new Date().toISOString() });
    push(deskId);
  },
  push: () => {
    for (const deskId of listeners.keys()) push(deskId);
  },
};
for (const [deskId, ids] of Object.entries(init.preinstalled ?? {})) for (const id of ids) appsOf(deskId).set(id, { state: 'stopped', problem: null, installedAt: '2026-11-10T16:00:00Z' });
const control = appsControl;

/** deskd's `apps.*` for one mock desk. */
export async function answerApps(deskId: string, method: string, params: Record<string, unknown>, idem?: string): Promise<unknown> {
  control.calls.push({ m: method, p: params });
  const id = typeof params['id'] === 'string' ? params['id'] : '';
  const def = APPS.find((a) => a.id === id);
  const mine = appsOf(deskId);
  if (method === 'apps.list') return list(deskId);
  if (method === 'apps.catalog.get') {
    if (!control.available || control.noCatalog) return { available: control.available, reason: control.available ? null : control.reason, catalog: null };
    return {
      available: true,
      reason: null,
      catalog: {
        seq: 7,
        issuedAt: '2026-11-11T12:00:00Z',
        apps: APPS.map((a) => ({
          id: a.id, name: a.name, publisher: a.publisher, description: a.description, installed: mine.has(a.id), bundled: a.bundled,
          ...(a.line ? { line: a.line } : {}), ...(a.about ? { about: a.about } : {}), ...(a.credits ? { credits: a.credits } : {}),
          versions: [{ version: a.version, packageSha256: a.id === TALLY ? 'c'.repeat(64) : 'b'.repeat(64), bytes: a.bytes, appApi: '>=1.0 <2', permissions: [], net: [], resources: { diskMaxMiB: 16 }, notes: '', installable: true, reason: null }],
        })),
      },
    };
  }
  if (!control.available) throw refused('unavailable', control.reason ?? 'no_sandbox');
  if (method === 'apps.install' || method === 'apps.remove') {
    if (!idem) throw refused('bad_request', 'idem');
    if (!founder(deskId)) throw refused('forbidden', 'grant');
    const kept = idems.get(`${deskId}|${idem}`);
    if (kept) return kept;
    if (!def) throw refused('not_found', method === 'apps.install' ? 'version' : 'app');
    let res: unknown;
    if (method === 'apps.install') {
      if (params['version'] !== def.version) throw refused('not_found', 'version');
      if (!Array.isArray(params['grants']) || params['grants'].length) throw refused('bad_request', 'grants');
      await new Promise((done) => window.setTimeout(done, control.installMs));
      if (!mine.has(id)) mine.set(id, { state: 'running', problem: null, installedAt: new Date().toISOString() });
      res = { id, version: def.version, state: 'running' };
    } else {
      if (!mine.has(id)) throw refused('not_found', 'app');
      mine.delete(id); // its data (the count) stays
      res = {};
    }
    idems.set(`${deskId}|${idem}`, res);
    push(deskId);
    return res;
  }
  const inst = def ? mine.get(id) : undefined;
  if (!def || !inst) throw refused('not_found', 'app');
  if (method === 'apps.start') {
    inst.state = 'running';
    inst.problem = null;
    push(deskId);
    return { id, state: 'running', problem: null };
  }
  if (method === 'apps.stop') {
    inst.state = 'stopped';
    push(deskId);
    return { id, state: 'stopped', problem: null };
  }
  if (method === 'apps.view.get') {
    const view = await def.view();
    const files = { ...view.files };
    const t = control.tamper[id];
    if (t && t in files) files[t] = `${files[t]}\n/* changed after it was signed */`;
    return { id, version: def.version, manifest: view.manifest, signatures: view.signatures, ...(view.bundled ? { bundled: true } : {}), files };
  }
  if (method === 'apps.call' || method === 'apps.mutate') {
    if (inst.state === 'failed') throw refused('unavailable', inst.problem ?? 'crashed');
    const m = String(params['m'] ?? '');
    const declared = def.methods.find((x) => x.name === m);
    if (!declared) throw refused('not_found', 'method');
    if (declared.mutation !== (method === 'apps.mutate')) throw refused('bad_request', 'mutation');
    if (inst.state !== 'running') {
      inst.state = 'running';
      push(deskId);
    }
    if (def.id !== TALLY) return {};
    if (m === 'tally.get') return tallyOf(deskId);
    if (!idem) throw refused('bad_request', 'idem');
    const kept = idems.get(`${deskId}|${idem}`);
    if (kept) return kept;
    const p = (params['p'] ?? {}) as { by?: unknown };
    const t = tallyOf(deskId);
    if (m === 'tally.add') {
      const by = typeof p.by === 'number' ? p.by : 0;
      if (by < -100 || by > 100 || by === 0) throw refused('bad_request', 'by');
      tallies.set(deskId, { count: t.count + by, updatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    } else tallies.set(deskId, { count: 0, updatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    const res = { count: tallyOf(deskId).count };
    idems.set(`${deskId}|${idem}`, res);
    emitTally(deskId);
    push(deskId); // the widget's summary
    return res;
  }
  throw refused('not_found');
}

/** The `apps` topic for one desk: a snapshot, then the whole list again on any change. */
export function subscribeApps(deskId: string, fn: (msg: Record<string, unknown>) => void): () => void {
  let set = listeners.get(deskId);
  if (!set) listeners.set(deskId, (set = new Set()));
  set.add(fn);
  const timer = window.setTimeout(() => {
    seq += 1;
    fn({ ...list(deskId), seq, type: 'snapshot' });
  }, 20);
  return () => {
    window.clearTimeout(timer);
    set.delete(fn);
  };
}

/** An app's own topic, `app:<id>:<topic>`: a snapshot first, then patches. */
export function subscribeAppTopic(deskId: string, topic: string, fn: (e: RawTopicEvent) => void, refusedFn?: (code: string) => void): () => void {
  const m = /^app:([a-z0-9.-]+):([A-Za-z0-9.]+)$/.exec(topic);
  const def = m ? APPS.find((a) => a.id === m[1]) : undefined;
  if (!m || !def || !def.topics.includes(m[2]!) || !appsOf(deskId).has(def.id)) {
    window.setTimeout(() => refusedFn?.('not_found'), 0);
    return () => {};
  }
  const key = `${deskId}|${def.id}|${m[2]}`;
  let set = topicListeners.get(key);
  if (!set) topicListeners.set(key, (set = new Set()));
  set.add(fn);
  const timer = window.setTimeout(() => {
    seq += 1;
    fn({ type: 'snapshot', seq, data: def.id === TALLY ? tallyOf(deskId) : { marks: [] } });
  }, 20);
  return () => {
    window.clearTimeout(timer);
    set.delete(fn);
  };
}
