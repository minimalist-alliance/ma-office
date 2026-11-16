// Serves a built bundle the way production does: a copy of the Platform loader's behaviour at the
// SPA fallback, /v/<version>/ immutable, the default CSP from contract hostnames.md, and a fake
// Platform API and Cognito, so the real auth code runs over real HTTP.
//
//   node harness/serve.mjs --dist dist/release --port 4173
//
// Tests steer it through POST /__harness (see `state` below). With `shim` set, the desk is the real
// thing: `connect` and the gateway are gateway-shim's, and the rest of the API stays fake here.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { streamQuality } from './streamQuality.mjs';
import { appearance } from './appearance.mjs';
import { bandwidthReply } from './bandwidth.mjs';
import { ageState } from './age.mjs';
import { guilds } from './guilds.mjs';
import { notifications } from './notifications.mjs';
import { courierRegistry } from './courierRegistry.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const DIST = resolve(args.dist ?? 'dist/release');
const PORT = Number(args.port ?? 4173);
const release = JSON.parse(readFileSync(join(DIST, 'ma-release.json'), 'utf8'));
const ORIGIN = `http://localhost:${PORT}`;

// The default CSP, with this origin standing in for api. and auth, and the shim for gw.
// `accountFrame`: Platform's frame-src for the account page (ma-platform contract hostnames.md, 0.3.49). Off, as in prod until it ships.
// `openRouter`: the one origin the free models' Connect trades its code at (agent-free-key spec §2.5, hostnames.md). On, as the
// office's CSP has it; off to see the office's own CSP refuse it. A spec answers that origin itself (`page.route`): nothing here,
// and no test, ever reaches the real OpenRouter.
// `sso`: the shared sign-in's origin (ma-platform contract auth.md §2.8), as Platform's office CSP must allow it where it's on.
const ssoCsp = () => (typeof state.sso?.origin === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(state.sso.origin) ? ` ${state.sso.origin}` : '');
const csp = () => `default-src 'self';${state.appFrames ? " script-src 'self' blob:;" : ''} connect-src 'self'${state.openRouter ? ' https://openrouter.ai' : ''}${state.shim ? ` ${gatewayUrl()}` : ''}${ssoCsp()}; img-src 'self' data: blob:${/^https:\/\/[a-z0-9.-]+$/.test(process.env.MA_AVATAR_ORIGIN ?? '') ? ` ${process.env.MA_AVATAR_ORIGIN}` : ''}; media-src 'self' blob:; worker-src 'self' blob:;${state.accountFrame ? ' frame-src https://platform.localhost;' : ''} frame-ancestors 'none'`;

const MIME = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.avif': 'image/avif',
};

// The loading overlay (ADR 0058; the Product Designer's design): `loader/index.html` and `loader/loading.css` are copies of
// ma-platform's `sites/desk-loader/index.html` and `loading.css`, byte for byte. Copy them again whenever the loader's change.
// The page here takes the overlay's link and markup from that copy, so the specs see what members get.
const LOADER_COPY = readFileSync(new URL('./loader/index.html', import.meta.url), 'utf8');
const LOADING_CSS = readFileSync(new URL('./loader/loading.css', import.meta.url), 'utf8');
const LOADING_LINK = '<link rel="stylesheet" href="/_loader/loading.css">';
const OVERLAY_BODY = LOADER_COPY.slice(LOADER_COPY.indexOf('<div id="ma-root"'), LOADER_COPY.indexOf('</body>'));
if (!LOADER_COPY.includes(LOADING_LINK) || !OVERLAY_BODY.includes('<div id="ma-ld" role="status" hidden>')) throw new Error('harness/loader/index.html: no overlay');

const LOADER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="ma-api-base" content="${ORIGIN}">
<title>Minimalist Alliance</title>
<script src="/_loader/theme.js"></script>
${LOADING_LINK}
<script type="module" src="/_loader/loader.js"></script>
</head>
<body>
<noscript>Minimalist Alliance needs JavaScript.</noscript>
${OVERLAY_BODY}</body>
</html>
`;

// As the Platform loader's blocking theme.js: an inline color before the stylesheet exists.
const THEME_JS = `(function () {
  var t = null;
  try { t = localStorage.getItem('ma.theme.resolved'); } catch (e) {}
  if (t !== 'light' && t !== 'dusk' && t !== 'dark') return;
  var d = document.documentElement;
  d.setAttribute('data-theme', t);
  d.style.colorScheme = t === 'light' ? 'light' : 'dark';
  d.style.backgroundColor = t === 'light' ? 'Canvas' : 'CanvasText';
})();
`;

const loaderJs = () => `// A copy of sites/desk-loader/loader.js's behaviour, against this harness.
// The loading overlay's part (ADR 0058), as loader.js has it; \`loadingMaxMs\` stands in for its 15 s.
function loadingDone(how) {
  document.getElementById('ma-root')?.removeAttribute('aria-busy');
  const el = document.getElementById('ma-ld');
  if (!el || el.hasAttribute('aria-hidden')) return;
  el.setAttribute('aria-hidden', 'true');
  const remove = () => el.remove();
  const cs = getComputedStyle(el);
  if (how === 'now' || document.hidden || cs.display === 'none' || cs.opacity === '0') return remove();
  const inner = el.querySelector('.ma-ld-in');
  const shown = how !== 'fast' && !!inner && getComputedStyle(inner).opacity !== '0';
  el.addEventListener('animationend', (event) => {
    if (event.target === el) remove();
  });
  setTimeout(remove, 700);
  el.classList.add(shown ? 'ma-ld-out' : 'ma-ld-fast');
}
setTimeout(() => loadingDone(), ${Number(state.loadingMaxMs) || 15000});
async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}
async function boot() {
  const cfg = await getJson('/v1/client-config?app=desk-web');
  if (cfg.loadingOverlay && cfg.loadingOverlay.enabled === false) loadingDone('now');
  const rel = await getJson(cfg.assetBase + 'ma-release.json');
  for (const href of rel.css ?? []) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cfg.assetBase + href;
    document.head.append(link);
  }
  const script = document.createElement('script');
  script.type = 'module';
  script.src = cfg.assetBase + rel.entry;
  if (!rel.loadingOverlay) script.addEventListener('load', () => loadingDone('now'));
  script.addEventListener('error', () => failed(new Error(script.src + ' did not load')));
  document.head.append(script);
}
function failed(err) {
  console.error('desk loader:', err);
  loadingDone('fast');
  document.getElementById('ma-root').textContent = 'Desk is unavailable right now. Try again in a minute.';
}
boot().catch(failed);
`;

// A stand-in for Platform's sign-in pages (ma-platform web/signin), doing the handoff as they do: the
// refresh token in `ma-desk-web-refresh`, in this tab's sessionStorage for "Until you close the browser" and in
// localStorage otherwise, then the return path. web/signin's own tests run the real pages against this app's real bundle.
const SIGNIN_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in pages</title><script src="/_signin/stub.js"></script></head><body><h1>Sign-in pages</h1></body></html>';
const signinJs = (staySignedIn) => `const q = new URLSearchParams(location.search);
if (!q.has('error')) {
  ${staySignedIn === 'browser' ? 'sessionStorage' : 'localStorage'}.setItem('ma-desk-web-refresh', 'refresh-from-signin-pages');
  location.replace(q.get('return') || '/');
}
`;

const FRESH = () => ({
  /** auth.signInPath in client-config. Null is the field being absent: managed login. HARNESS_SIGN_IN_PATH runs a whole suite with it on. */
  signInPath: process.env.HARNESS_SIGN_IN_PATH ?? null,
  /** The route isn't there yet: /_signin/ gets the SPA fallback, like any other path. */
  signInRouteMissing: false,
  /** The stand-in for the pages stays put, as a member still reading the form does, instead of signing in by itself. */
  signInHolds: false,
  /** client-config's `version`, as if a new release had shipped since the page loaded. Null: this bundle's own. Only the
   * version changes: `assetBase` stays this bundle's, since it's the only one served, so a reload still works. */
  releaseVersion: null,
  /** links.account in client-config, whatever it holds. Null is the field being absent. */
  accountLink: 'https://platform.localhost/account',
  /** The office CSP lets the account page be framed (Account settings, ADR 0052). Off, as in prod until Platform ships it. */
  accountFrame: false,
  /** The office CSP lets the free models' Connect reach https://openrouter.ai (agent-free-key spec §2.5). Off: the CSP refuses it. */
  openRouter: true,
  /** GET /v1/me's `roles`, such as ['owner']. Null: none, as for every member. */
  roles: null,
  /** GET /v1/me's `maiaMode` (ma-platform desks.md "Maia Mode"), such as `{ enabled: true }` for a listed member. Null: absent. */
  meMaiaMode: null,
  /**
   * The `billing` block of client-config?app=platform-web, which the office's card A reads for Pay and the Alliance
   * price, such as { enabled: true, officerMonthlyUsd: 100 }. Null: no block, as in prod. 'fail': a 503.
   */
  platformBilling: null,
  /** client-config?app=platform-web's `free` block (ma-platform tiers.md 11), such as { open: true, browserMinutesPerDay: 45 }. Null: absent. */
  platformFree: null,
  /**
   * GET /v1/billing/status's answer (ma-platform billing.md), as given: the "You're on {Free} now" card reads its `steppedDown`
   * (free/freeNow.tsx). Null: a 404, as for a route the harness doesn't serve. 'fail': a 503.
   */
  billingStatus: null,
  /** Hold that answer this long. */
  platformConfigDelayMs: 0,
  /** Managed login stays put, as a member still reading its form does, instead of signing in by itself. */
  authorizeHolds: false,
  /** Managed login sends the member straight back with no code: to the redirect URI ('callback'), or to the app ('home'). */
  authorizeBounces: null,
  /** Refuse the code exchange at the token endpoint. */
  codeExchangeFails: false,
  /** GET /v1/desks answers 401 to any token, as if the API had stopped accepting a good one. */
  desksUnauthorized: false,
  /**
   * client-config's `auth.sso`, as given (ma-platform contract auth.md §2.8), such as { origin: 'https://id.localhost' }, which
   * the CSP then allows. Null is the field being absent: off, as today. A spec answers that origin itself (`context.route`).
   */
  sso: null,
  /** Every signed-in call answers `401 session_revoked`, as after Sign out in another app in this browser (§2.8, §6). */
  sessionRevoked: false,
  /** What GET /v1/desks answers: 'ok', 'empty', 'unpaid', 'forbidden', 'error'. */
  desks: 'ok',
  /** Hold each GET /v1/desks answer this long (the loading overlay waits for it, ADR 0058). */
  desksDelayMs: 0,
  /** Hold each GET /v1/me answer this long (the loading overlay waits for it too, ADR 0058). */
  meDelayMs: 0,
  /** The loader's safety time for the loading overlay; its own is 15 s. Read when the page loads. */
  loadingMaxMs: 15000,
  /** ma-release.json as served: null as built; 'noOverlay' as a bundle from before the loading overlay; 'fail' a 503. */
  releaseManifest: null,
  /** Seconds an access token lives. */
  expiresIn: 3600,
  /** Answer the token endpoint's refresh with 400 invalid_grant. */
  refreshFails: false,
  /** Answer it with this instead, for good: { status, body } (a string goes out as it is), or 'drop' to cut the connection. */
  refreshFailure: null,
  /** Refresh tokens to refuse with invalid_grant, as if rotated away past the grace. */
  refreshRefuses: [],
  /** Hold each refresh's answer this long. */
  refreshDelayMs: 0,
  /** The refresh token each refresh carried. */
  refreshSent: [],
  /** Answer /oauth2/revoke's headers at once and its body this much later, as a slow link does. */
  revokeBodyMs: 0,
  /** Never answer /oauth2/revoke. */
  revokeHolds: false,
  /** Refresh tokens revoked so far; a refresh with one is refused, as Cognito does. */
  revoked: [],
  /** Every POST /v1/me/sign-out's body, such as { everywhere: true }. */
  signOuts: [],
  /** Answer POST /v1/me/sign-out with this status instead of 204, such as 503. */
  signOutFails: null,
  /** Hold its answer this long. */
  signOutDelayMs: 0,
  log: [],
  /** Base URL of a running gateway-shim. Null: `connect` says the desk isn't ready yet, for good. */
  shim: null,
  /** Answer `connect` as if the desk were elsewhere in its lifecycle, such as { state: 'starting', phase: 'booting' }. */
  connectOverride: null,
  /** Rewrite `refreshAfter` in `connect` responses to this many seconds from now. */
  refreshAfterSec: null,
  /**
   * What GET /v1/me says about the membership: { status, tier: 'alliance' | 'officer' | 'lead', badge } (contract
   * tiers.md). With no `badge`, as here, there's no badge; `tier: 'member'` is the old id from before the migration.
   * `age` in a POST sets this and `ageRules` from a name (`age.mjs`).
   */
  membership: { status: 'active', tier: 'officer' },
  /** GET /v1/me's `avatar`: { kind: 'built', config, setAt } or { kind: 'upload', url, setAt }. Null: none. */
  avatar: null,
  /** GET /v1/me's `preferences.staySignedIn` ("Stay signed in", ma-platform contract auth.md section 3.3). Null: no `preferences`, as a Platform from before it. */
  staySignedIn: null,
  /**
   * GET /v1/me's `preferences.officeTour`, the office tour's setting as proposed to Platform (ADR 0056, `docs/sub-status/walkthrough.md`).
   * 'absent', as today: not sent, and PUT /v1/me/preferences answers this app's token 403 forbidden, as the contract says.
   * Anything else (null included) is Platform having opened it: sent as it is, and PUT {officeTour: {off}} stores it.
   */
  officeTour: 'absent',
  /** Every PUT /v1/me/preferences: { body, status }. */
  preferencePuts: [],
  /**
   * GET /v1/me's `notices` (ma-platform contract auth.md section 2.7), such as [{ kind: 'close_hold_cancelled', at, requestedAt }].
   * Null: no `notices`, as a Platform from before it. POST /v1/me/notices/{kind}/dismiss takes that kind off.
   */
  notices: null,
  /** Refuse that dismiss: { status, times }. `times` refuses only that many; no `times`, every one. */
  noticeDismissFail: null,
  /** Every dismiss asked for: { kind, auth, body, status }. */
  noticeDismisses: [],
  /** client-config's `tierNames` (contract tiers.md section 3). Null is the field being absent, as in prod until it ships. */
  tierNames: { alliance: 'Alliance Member', officer: 'Officer', lead: 'Founder' },
  /** Refuse `PATCH /v1/desks/{deskId}` with this: { status, code, details, times }. `times` refuses only that many. */
  renameFail: null,
  /** Every rename asked for: { deskId, body, status }. */
  renames: [],
  /** New names, by desk id, laid over the list as Platform would. */
  deskNames: {},
  /** client-config's `ageRules` block, on `desk-web` and `platform-web`. Null is the block being absent: off, as in prod. */
  ageRules: null,
  /** client-config's `tierAllowances` (tiers.md 11.3; Officer's `weeklyAllowanceGb` is proposed). Null: the block is absent. */
  tierAllowances: null,
  /**
   * Desks that answer the list and `connect` as contract desks.md says, such as [{ deskId, name, kind, state: 'stopped' }].
   * `allowedActions: []` is a held desk, which `connect` refuses with desk_unavailable; so does `refuse: 'desk_unavailable'`
   * on a desk the list doesn't show as held, as when a hold lands between a poll and a connect.
   */
  fleet: null,
  /** Refuse every `connect` of the fleet as the membership does: { code: 'account_suspended', details: { billingUrl } }. `message` sets the words (the data guard's `403 data_guard` sends its own). */
  refuseConnect: null,
  // A safety suspension: `purpose: "export"` is refused too (desks.md 0.3.64).
  refuseExport: null,
  /**
   * A closed account (ma-platform contract moderation.md section 8): its office token gets GET /v1/me, GET /v1/me/export,
   * the sign-out, the desk list and a desk, and `connect` with `purpose: "export"`; every other route is 403 account_closed.
   * `'all'` refuses the desk list too, for an `account_closed` from any API. `membership` carries `closed`, `exportUntil` and
   * `held` on its own, as the spec gives them (contract section 8, 0.3.117 draft amended Nov 12).
   */
  closedAccount: false,
  /** Refuse `start: true`, such as { status: 409, code: 'downtime_active' }, with `details` if given (a stopping desk's `{ state, retryAfterSeconds }`). */
  refuseWake: null,
  /** Every `connect` so far: { deskId, start }. */
  connects: [],
  /** Whose tokens the fake Cognito gives out from now on. As on Platform, a token's `sub` is who a call is for, whatever this says by then. */
  userId: 'u-test',
  /** GET and PUT /v1/me/desk-layout, per member: { version, updatedAt, layout }. */
  layoutDocs: {},
  /** Refuse layout calls, such as { status: 503, code: 'unavailable', method: 'PUT', times: 2, retryAfter: 1 }. `bare` answers with only `message`, as API Gateway itself does (errors.md). */
  layoutFail: null,
  /** Every layout PUT so far: { user, ifMatch, bytes, status, at }. */
  layoutPuts: [],
  /** Every layout GET so far, with what it asked and what it got: { ifNoneMatch, status, at }. */
  layoutGets: [],
  /** Hold every layout answer this long. */
  layoutDelayMs: 0,
  /** Inside the ETag's quotes, before the version: Platform's are plain numbers, and the client mustn't care. */
  layoutTagPrefix: '',
  /** A member's saves this calendar minute, as `signup-limits` counts them. */
  layoutSlots: {},
  /**
   * A fake Support Maia (ma-platform contract maia.md), on this same origin so the CSP's `connect-src 'self'` covers
   * it. Null, as in prod: client-config has no `maia` block and every Maia route is a 404. On, such as
   * { enabled: true }: `url` (default this origin), `enabled`, `stateStatus`, `animation`, `memory`, `maxItems`,
   * `limited` (`personal`), `resetsAt`, `usedFraction`, `sleepAfterSec`, `slow` (ms between text frames), `rememberText`. Turns act on markers, as staging's stub does:
   * `[stub:refusal]`, `[stub:status]`, `[stub:notice]`, `[stub:markdown]`, `[stub:desk:<deskId>]`, `[stub:page:<page>]`,
   * `[stub:lead]`, `[stub:remember:<kind>]`, `[stub:forget:<memoryId>]`, `[stub:expired]`, `[stub:routine:<name>]` (her score
   * carries that `routine`, as the server adds `party` for the owner).
   */
  maia: null,
  /**
   * Maia's welcome interviewer (ma-platform contract maia.md "Welcome"), on the fake Maia's origin; needs `maia` on. Null: its
   * routes answer 404, so the office runs the scripted path on this browser alone. On, such as { model: true }: `model`
   * (whether a turn reaches the model), `mode: 'scripted'` (every turn scripted, as past a cap), `delayMs` (each turn's wait,
   * past 2.5 s for the office's fallback), `talk` (the kept talk `GET` returns, for L3). Model turns act on the answer: an
   * `ack` of `lovely`, an echo, free text with "mail" placed on `email`, `[stub:followup]` asks one follow-up, and q3's own
   * words name a custom helper.
   */
  welcome: null,
  /**
   * client-config's `welcome` (the welcome's kill switch): off here, as the tour's is, so every other spec's member never
   * meets it nor the mark menu's "Set up my office with Maia". `welcome.shell.spec.ts` sets null (absent, which is on).
   */
  welcomeSwitch: { enabled: false },
  /** Every welcome call's body, exactly as it came: { method, body }. */
  welcomeCalls: [],
  /** Refuse the next turns: { status, code, times }. */
  maiaTurnFail: null,
  /**
   * True holds each turn that gets as far as her words just before them (after `[stub:status]`'s line and free Maia's slow
   * start; a stop never waits), until a POST sets it false or resets: a spec checks what shows while she answers for as long
   * as it likes, instead of racing a stub that can finish in a few ms (TD-239).
   */
  maiaHold: false,
  /** Every turn's body, exactly as it came. */
  maiaTurns: [],
  /** Every decision: { proposalId, decision, result, errorCode }. */
  maiaDecisions: [],
  maiaProposals: {},
  maiaMemories: [],
  maiaConversations: {},
  maiaCount: 0,
  // Web search (ADR 0137): each batch the fake asked for, by id, and every mode the office saved.
  maiaWebBatches: {},
  maiaWebModes: [],
  /** client-config's `export` block, such as { enabled: true, moves: true }. Null is the block being absent: off. */
  export: null,
  /** client-config's `simpleView` block (task 47), a kill switch: { enabled: false } is off. Null is the block being absent: on, as on prod. */
  simpleView: null,
  /** client-config's `deskApps` block (ADR 0054), a kill switch: { enabled: false } is off. Null is the block being absent: on, as it ships. */
  deskApps: null,
  /**
   * The office CSP has `script-src 'self' blob:`, which an app view's frame needs (ADR 0054: a `srcdoc` frame inherits the office's
   * policy, and the view's script runs from a `blob:` URL by its hash). Off, as in prod until Platform adds it.
   */
  appFrames: false,
  /** GET /v1/me/export carries the newer records too (Maia chats, activity log, tickets, phone factor). */
  meExportExtras: false,
  /**
   * client-config's `files` block, the Files app's kill switch (absent or `enabled: true` is on, as in prod). The harness has it OFF,
   * so the specs about desks' geometry, saved layouts and tile counts hold what they always did without a tile they didn't count on.
   * The Files specs turn it on: `{ files: { enabled: true } }`.
   */
  files: { enabled: false },
  /**
   * client-config's `todo` block, To-do's kill switch (absent or `enabled: true` is on, as in prod: the app ships on). OFF here,
   * as `files` is, so the specs about geometry, saved layouts and tile counts hold; the To-do specs turn it on: `{ todo: null }`.
   */
  todo: { enabled: false },
  /**
   * client-config's `documents` block, Documents' kill switch (absent or `enabled: true` is on, as in prod: the app ships on). OFF
   * here, as `todo` is, so the specs about geometry, saved layouts and tile counts hold; the Documents spec turns it on: `{ documents: null }`.
   */
  documents: { enabled: false },
  /**
   * client-config's `setupCircle` block (S-121), the setup circle's kill switch (absent is on, as in prod). The harness has
   * it OFF, as `files` is, so the specs about the bottom bar, the account menu and the canvas hold what they always did; the
   * setup specs turn it on with `{ setupCircle: null }`.
   */
  setupCircle: { enabled: false },
  /**
   * client-config's `walkthrough` block (ADR 0056), the office tour's kill switch (absent is on, as in prod). The harness has
   * it OFF, as `setupCircle` is: every spec is a fresh member, whose first visit would start the tour over what it tests.
   * The tour's specs turn it on with `{ walkthrough: null }`.
   */
  walkthrough: { enabled: false },
  /** More client-config for desk-web, as Platform may send it: `whatsNew`, `tierAllowances`, and `links` added to the usual. Null: none. */
  configExtra: null,
  /** GET /v1/me/export answers 503 this many times. */
  meExportFails: 0,
  /** What POST /v1/moves made: { moveId, sourceDeskId, targetDeskId, state, createdAt }. GET /v1/moves lists them. */
  moves: [],
  /** How long a move code lasts. */
  moveCodeSeconds: 900,
  /** `remove-source` answers 503 while true. */
  removeSourceFails: false,
  /** The first remove-cloud-desk ask answers 202 (the desk is stopping), the next 200. */
  removeNeedsStop: false,
  /**
   * The member's notifications (`notifications.mjs`, ma-platform contract notifications.md): { items, paused, unreadExtra }.
   * Null: an empty list, so the bell shows with no count.
   */
  notifications: null,
  /** Every POST to `/v1/me/notifications/read` and `/seen`: { path, body }. */
  notificationPosts: [],
  /** Courier's address registry (`courierRegistry.mjs`, ma-platform contract relay.md 0.4.0 §4). Null: every route is 404. */
  courier: null,
  /** Every PUT of a desk's address: { deskId, body }. */
  courierPuts: [],
});
let state = FRESH();
/** Turns waiting on `maiaHold`, each let go when a POST turns it off or resets the state. */
const maiaHeld = new Set();
let refreshGen = 0;
const gatewayUrl = () => (state.shim ? `${state.shim.replace(/^http/, 'ws')}/v1` : 'ws://localhost:1/v1');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const LAYOUT_MAX_BYTES = 64 * 1024;
const LAYOUT_BODY_MAX_BYTES = 256 * 1024;
const LAYOUT_PUTS_PER_MIN = 60;
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const codes = new Map();

const SHIM_DESK = 'd-dev0000000000'; // gateway-shim --desk-id, by default
const DESK = {
  deskId: 'd-testk3m7q2x', kind: 'personal', name: 'Personal', state: 'running', phase: 'ready', agentStatus: 'online',
  badges: { total: 0, apps: {} }, queue: null, lastError: null, allowedActions: ['connect', 'stop'],
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'r-harness', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** The list as services/desks answers it: an ETag from the body, and 304 when If-None-Match has it. */
function listReply(req, res, body) {
  const tag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
  if (req.headers['if-none-match'] === tag) {
    state.log.push('list 304');
    res.writeHead(304, { ETag: tag, 'X-Request-Id': 'r-harness' });
    return res.end();
  }
  return json(res, 200, body, { ETag: tag });
}

const envelope = (code, message, retryable = false, details = undefined) => ({ error: { code, message, requestId: 'r-harness', retryable, ...(details ? { details } : {}) } });

function readBody(req) {
  return new Promise((done) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => done(data));
  });
}

function claimsOf(req) {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const [, payload] = h.slice(7).split('.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

function authorized(req) {
  const claims = claimsOf(req);
  return !!claims && claims.exp * 1000 > Date.now();
}

function tokens(nonce) {
  const exp = Math.floor(Date.now() / 1000) + state.expiresIn;
  refreshGen += 1;
  return {
    access_token: jwt({ token_use: 'access', sub: state.userId, exp }),
    id_token: jwt({ token_use: 'id', sub: state.userId, nonce, exp }),
    refresh_token: `refresh-${refreshGen}`,
    token_type: 'Bearer',
    expires_in: state.expiresIn,
  };
}

const inSeconds = (sec) => new Date(Date.now() + sec * 1000).toISOString();

const fleetPhase = (d) => ({ running: 'connecting', starting: 'starting', requested: 'starting', provisioning: 'starting' })[d.state] ?? 'stopped';
/** services/desks model.ts: the list asks for 2 s polls while any desk is in one of these. */
const TRANSITIONAL = new Set(['requested', 'queued', 'provisioning', 'starting', 'stopping', 'resizing', 'upgrading', 'retaining', 'destroying']);
const WAKING = new Set(['requested', 'queued', 'provisioning', 'starting']);

/** `connect` in services/desks: a stopped desk answers 200 with its state unless `start` is true. */
function fleetConnect(res, deskId, start, purpose) {
  const desk = state.fleet.find((d) => d.deskId === deskId);
  if (!desk) return json(res, 404, envelope('not_found', 'Not found.'));
  // As services/desks: a hold first, the same for everyone and saying nothing of why, then the membership.
  if ((Array.isArray(desk.allowedActions) && !desk.allowedActions.length) || desk.refuse === 'desk_unavailable') {
    return json(res, 403, envelope('desk_unavailable', "This desk can't be opened right now. Contact support."));
  }
  // `purpose: "export"` opens a closed account's desk for the export only (ma-platform draft ADR, section 3).
  if (purpose === 'export' && state.refuseExport) return json(res, 403, envelope(state.refuseExport.code, state.refuseExport.message ?? 'Refused.', false, state.refuseExport.details ?? {}));
  if (state.refuseConnect && !(purpose === 'export' && state.export?.enabled)) return json(res, 403, envelope(state.refuseConnect.code, state.refuseConnect.message ?? 'Refused.', false, state.refuseConnect.details));
  if (start && state.refuseWake) {
    const { status, code, details, message } = state.refuseWake;
    // `times`: refuse only that many wakes, for a passing failure.
    if (state.refuseWake.times && --state.refuseWake.times === 0) state.refuseWake = null;
    return json(res, status, envelope(code, message ?? 'Refused.', false, details));
  }
  if (start && desk.state === 'stopped') desk.state = 'starting';
  const waking = WAKING.has(desk.state);
  return json(res, waking ? 202 : 200, {
    deskId, state: desk.state, phase: fleetPhase(desk), deskToken: 'harness-no-desk', expiresAt: inSeconds(300), refreshAfter: inSeconds(240),
    gateway: gatewayUrl(), deskIdentity: null, identityAsOf: null, ...(waking ? { retryAfterSeconds: 3, queue: null } : {}),
  });
}

const named = (deskId) => (state.deskNames[deskId] ? { name: state.deskNames[deskId] } : {});

/**
 * `PATCH /v1/desks/{deskId}` as contract tiers.md section 8 says: the desk's owner with `officer` or `lead` (the old
 * `member` reads as `officer`), a desk whose `allowedActions` has `rename`, and a name of 1 to 40 characters, trimmed.
 */
async function handleRename(req, res, deskId) {
  const body = await readBody(req);
  const done = (status, reply) => {
    state.renames.push({ deskId, body, status });
    return json(res, status, reply);
  };
  const fail = state.renameFail;
  if (fail) {
    if (fail.times && --fail.times === 0) state.renameFail = null;
    return done(fail.status, envelope(fail.code, 'Refused.', fail.status >= 500, fail.details));
  }
  const desks = state.fleet ?? [state.shim ? { ...DESK, deskId: SHIM_DESK } : DESK];
  const desk = desks.find((d) => d.deskId === deskId);
  if (!desk) return done(404, envelope('not_found', 'Not found.'));
  const tier = state.membership?.tier ?? 'officer';
  if (tier !== 'officer' && tier !== 'lead' && tier !== 'member') return done(403, envelope('tier_required', 'Not with this membership.', false, { tiers: ['officer', 'lead'] }));
  const allowed = desk.allowedActions ?? DESK.allowedActions;
  if (!allowed.includes('rename')) return done(409, envelope('invalid_state', 'Not now.'));
  let name;
  try {
    name = JSON.parse(body).name;
  } catch {
    return done(400, envelope('invalid_request', 'Bad JSON.'));
  }
  // Control characters, built from code points so this file holds none.
  const control = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
  name = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : name; // as Platform keeps it
  if (typeof name !== "string" || [...name].length < 1 || [...name].length > 40 || control.test(name)) {
    return done(400, envelope('invalid_request', 'A desk name is 1 to 40 characters.'));
  }
  state.deskNames[deskId] = name.trim();
  return done(200, { ...DESK, ...desk, name: name.trim(), refuse: undefined });
}

/**
 * `/v1/me/desk-layout` as `services/identity` in ma-platform answers it (contract desks.md, `layout.ts`), for one
 * document per member, who comes only from the token. A read has no limit of its own, and no 304. A save's checks go in
 * the route's order: If-Match, then the body, then the limit, then the version. So a 400, 413 or 428 isn't counted, a 412 is.
 */
async function handleLayout(req, res) {
  if (state.layoutDelayMs) await new Promise((done) => setTimeout(done, state.layoutDelayMs));
  const user = claimsOf(req).sub;
  const doc = state.layoutDocs[user] ?? { version: 0, updatedAt: null, layout: null };
  const tag = `"${state.layoutTagPrefix}${doc.version}"`;
  const fail = state.layoutFail;
  const body = req.method === 'PUT' ? await readBody(req) : '';
  const answer = (status, reply, headers = {}) => {
    const entry = { status, at: Date.now() };
    if (req.method === 'PUT') state.layoutPuts.push({ ...entry, user, ifMatch: req.headers['if-match'] ?? null, bytes: Buffer.byteLength(body) });
    else state.layoutGets.push({ ...entry, user, ifNoneMatch: req.headers['if-none-match'] ?? null });
    return json(res, status, reply, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  };
  if (fail && (!fail.method || fail.method === req.method)) {
    if (fail.times && --fail.times === 0) state.layoutFail = null;
    if (fail.bare) return answer(fail.status, { message: fail.bare });
    return answer(fail.status, envelope(fail.code ?? 'unavailable', 'Refused.', fail.status >= 500), fail.retryAfter ? { 'Retry-After': String(fail.retryAfter) } : {});
  }
  if (req.method === 'GET') {
    // Platform has no 304 here: it ignores If-None-Match and sends the document (contract desks.md).
    return answer(200, doc, { ETag: tag });
  }
  if (req.method !== 'PUT') return answer(404, { message: 'Not Found' }); // API Gateway has no other route here

  const ifMatch = req.headers['if-match']?.trim();
  if (!ifMatch) return answer(428, envelope('precondition_required', 'Send If-Match with the version you last loaded.'));
  // Platform's are plain numbers, so anything else is a 400, `*` included. This also lets through what `layoutTagPrefix` sent.
  const quoted = new RegExp(`^"${state.layoutTagPrefix}(0|[1-9]\\d{0,14})"$`);
  if (!quoted.test(ifMatch)) return answer(400, envelope('invalid_request', 'If-Match must be a quoted version.'));

  const tooLarge = () => answer(413, { error: { code: 'invalid_request', message: 'The layout is over 64 KiB.', requestId: 'r-harness', retryable: false, details: { maxBytes: LAYOUT_MAX_BYTES } } });
  if (Buffer.byteLength(body) > LAYOUT_BODY_MAX_BYTES) return tooLarge();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return answer(400, envelope('invalid_request', 'The body must be a JSON object.'));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return answer(400, envelope('invalid_request', 'The body must be a JSON object.'));
  const { layout } = parsed;
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) return answer(400, envelope('invalid_request', 'layout must be a JSON object.'));
  if (!Number.isInteger(layout.schemaVersion) || layout.schemaVersion < 1) return answer(400, envelope('invalid_request', 'layout.schemaVersion must be an integer of at least 1.'));
  if (Buffer.byteLength(JSON.stringify(layout)) > LAYOUT_MAX_BYTES) return tooLarge();

  // Per member and per calendar minute, so Retry-After is what's left of the minute.
  const now = new Date();
  const slot = `${user}#${now.toISOString().slice(0, 16)}`;
  if ((state.layoutSlots[slot] ?? 0) >= LAYOUT_PUTS_PER_MIN) {
    const retry = 60 - now.getUTCSeconds();
    return answer(429, { error: { code: 'rate_limited', message: 'Too many layout saves. Try again shortly.', requestId: 'r-harness', retryable: true, details: { retryAfterSeconds: retry } } }, { 'Retry-After': String(retry) });
  }
  state.layoutSlots[slot] = (state.layoutSlots[slot] ?? 0) + 1;

  if (ifMatch !== tag) {
    return answer(412, { error: { code: 'version_mismatch', message: 'The layout changed since you loaded it.', requestId: 'r-harness', retryable: false, details: { currentVersion: doc.version } } });
  }
  const next = { version: doc.version + 1, updatedAt: now.toISOString(), layout };
  state.layoutDocs[user] = next;
  return answer(200, next, { ETag: `"${state.layoutTagPrefix}${next.version}"` });
}

/** `GET /v1/me/export` (ma-platform draft ADR, section 2): what Platform holds about the member, as one object. */
function handleMeExport(req, res) {
  if (!state.export?.enabled) return json(res, 404, envelope('not_found', 'Not found.'));
  if (state.meExportFails > 0) {
    state.meExportFails -= 1;
    return json(res, 503, envelope('unavailable', 'Try again.', true));
  }
  const desks = (state.fleet ?? [DESK]).map((d) => ({ deskId: d.deskId, name: d.name, kind: d.kind ?? 'personal', hosting: d.hosting ?? 'cloud', state: d.state }));
  return json(res, 200, {
    formatVersion: 1,
    account: {
      userId: claimsOf(req).sub, name: 'Test Member', email: 'member-1@example.org', signInMethod: 'password', createdAt: '2026-11-01T09:00:00Z',
      ...(state.meExportExtras ? { activity: [{ at: '2026-11-02T10:00:00Z', action: 'sign_out', by: 'you', details: {} }], signInFactors: { available: true, authenticatorApp: false, emailCode: true, textCode: false, phone: null, preferred: 'email', googleSignIn: false } } : {}),
    },
    membership: { ...state.membership, startedAt: '2026-11-01T09:00:00Z' },
    billingHistory: { charges: [], refunds: [], invoices: [] },
    maiaMemories: { available: false, note: "Maia's memory isn't on yet." },
    ...(state.meExportExtras
      ? {
          maiaChats: { available: true, truncated: false, items: [{ conversationId: 'c-1', title: 'Moving a desk', createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:01:00Z', messages: [{ role: 'user', text: 'How do I move a desk?', at: '2026-11-02T10:00:00Z' }] }] },
          supportTickets: { available: true, items: [] },
        }
      : {}),
    desks,
    generatedAt: new Date().toISOString(),
  });
}

/** `/v1/moves` (ma-platform draft ADR, section 4): a one-time code for a move, and the moves so far. */
async function handleMoves(req, res) {
  if (!state.export?.moves) return json(res, 404, envelope('not_found', 'Not found.'));
  if (req.method === 'GET') return json(res, 200, { moves: state.moves });
  if (req.method !== 'POST') return json(res, 404, { message: 'Not Found' });
  const { sourceDeskId, targetDeskId } = JSON.parse((await readBody(req)) || '{}');
  const desks = state.fleet ?? [DESK];
  const source = desks.find((d) => d.deskId === sourceDeskId);
  const target = desks.find((d) => d.deskId === targetDeskId);
  if (!source || !target || source === target || source.hosting === 'self') return json(res, 400, envelope('invalid_request', 'Pick a cloud desk and another desk of yours.'));
  const move = { moveId: `mv-${state.moves.length + 1}`, sourceDeskId, targetDeskId, state: 'created', createdAt: new Date().toISOString() };
  state.moves.push(move);
  return json(res, 201, { moveId: move.moveId, code: 'K7Q2M9XAP4TB', expiresAt: inSeconds(state.moveCodeSeconds) });
}

/** `POST /v1/moves/{id}/cancel` (contract desks.md 0.3.43) and `POST /v1/moves/{id}/remove-cloud-desk` `{confirm}` (contract 0.3.43; a desk still up answers 202 first): the member ends a move, or removes the cloud desk once it's done. */
async function handleMoveAction(req, res, moveId, action) {
  if (!state.export?.moves) return json(res, 404, envelope('not_found', 'Not found.'));
  if (req.method !== 'POST') return json(res, 404, { message: 'Not Found' });
  state.log.push(`POST /v1/moves/${moveId}/${action}`);
  const move = state.moves.find((m) => m.moveId === moveId);
  if (!move) return json(res, 404, envelope('not_found', 'No such move.'));
  if (action === 'cancel') {
    if (move.state === 'done') return json(res, 409, envelope('move_ended', 'That move is finished.'));
    move.state = 'cancelled';
    return json(res, 200, { moveId, state: 'cancelled' });
  }
  if (state.removeSourceFails) return json(res, 503, envelope('unavailable', 'Try again.', true));
  if (move.state !== 'done') return json(res, 409, envelope('invalid_state', 'The move is not finished.'));
  const sent = JSON.parse((await readBody(req)) || '{}');
  if (sent.confirm !== move.sourceDeskId) return json(res, 422, envelope('confirm_mismatch', 'Type the desk ID to remove it.'));
  if (state.removeNeedsStop) {
    state.removeNeedsStop = false; // the first ask stops the desk, the next removes it
    return json(res, 202, { deskId: move.sourceDeskId, state: 'stopping', retryAfterSeconds: 1 });
  }
  state.fleet = (state.fleet ?? [DESK]).filter((d) => d.deskId !== move.sourceDeskId);
  return json(res, 200, { deskId: move.sourceDeskId, state: 'destroyed', dataKeptUntil: inSeconds(30 * 24 * 3600) });
}

async function handleConnect(req, res, path) {
  const body = await readBody(req);
  const { start, purpose } = JSON.parse(body || '{}');
  const deskId = decodeURIComponent(path.split('/')[3]);
  state.log.push(`connect start=${start}${purpose ? ` purpose=${purpose}` : ''}`);
  state.connects.push({ deskId, start, ...(purpose ? { purpose } : {}) });
  if (state.closedAccount && purpose !== 'export') return json(res, 403, envelope('account_closed', 'This account is closed.'));
  if (state.fleet) return fleetConnect(res, deskId, start === true, purpose);
  if (!state.shim) {
    return json(res, 202, {
      deskId: DESK.deskId, state: 'running', phase: 'connecting', deskToken: 'harness-no-desk', expiresAt: inSeconds(300), refreshAfter: inSeconds(240),
      gateway: gatewayUrl(), deskIdentity: null, identityAsOf: null, retryAfterSeconds: 3, queue: null,
    });
  }
  const shim = await fetch(`${state.shim}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const reply = await shim.json();
  if (shim.ok && state.refreshAfterSec) reply.refreshAfter = inSeconds(state.refreshAfterSec);
  if (shim.ok && state.connectOverride) return json(res, 202, { ...reply, retryAfterSeconds: 1, ...state.connectOverride });
  return json(res, shim.status, reply);
}

const MAIA_SCORE = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [{ t: 0, do: 'wave', level: 2 }, { t: 7, do: 'smile', level: 1 }, { t: 16, do: 'blink' }] };
/** What `[stub:refusal]` stops with, markup and all, which must show exactly as it is. */
const MAIA_STOP_TEXT = "I can't help with that one. <b>Not bold</b> **not Markdown** [not a link](https://minimalistalliance.com/)";
/** Everything the renderer must render, and everything it must block, as `[stub:markdown]` on staging tries. */
const maiaMarkdown = () => [
  '## Getting started',
  'Some **bold**, some *italic*, ***both***, and `inline code`.',
  '',
  '1. Open your desk',
  '   - then the Browser',
  '2. Sign in',
  '',
  '```',
  'ssh desk <b>not bold</b>',
  '```',
  '',
  '<b>raw bold</b> <img src="' + ORIGIN + '/__pixel/raw.gif"> <script>window.__maiaPwned = true</script>',
  '![tracking pixel](' + ORIGIN + '/__pixel/md.gif?leak=1)',
  'Our page: [Privacy](https://minimalistalliance.com/privacy). Theirs: [Click me](https://evil.example/phish).',
  'Bare: https://minimalistalliance.com/terms and https://evil.example/bare',
].join('\n');

/** Support Maia's member routes, as `services/maia` answers them, for one member. */
async function handleMaia(req, res, url) {
  const m = state.maia;
  const path = url.pathname;
  if (!m) return json(res, 404, { message: 'Not Found' });
  if (path === '/v1/maia/state' && req.method === 'GET') {
    if (m.stateStatus && m.stateStatus !== 200) return json(res, m.stateStatus, envelope('unavailable', 'Try again.', true));
    return json(res, 200, {
      enabled: m.enabled !== false && m.trial !== 'ended' && m.trial !== 'off', modelLabel: m.modelLabel ?? 'Claude Opus 5.5', limited: m.limited ?? (m.trial === 'ended' || m.trial === 'off' ? 'trial' : null), resetsAt: m.resetsAt ?? null, usedFraction: m.usedFraction ?? 0.02, retentionDays: 30,
      animation: { enabled: m.animation !== false, sleepAfterSec: m.sleepAfterSec ?? 300 },
      memory: { enabled: m.memory !== false, maxItems: m.maxItems ?? 50 },
      // Free Maia (ma-platform ADR 0104): `m.freeUntil` makes this member past their allowance and on her free model.
      free: { enabled: true, active: !!m.freeUntil, until: m.freeUntil ?? null },
      // A free member's trial (contract maia.md, "The free tier's trial"): `m.trial` is a status string, or a whole trial object, only in a free member's state.
      ...(m.trial ? { trial: typeof m.trial === 'object' ? m.trial : { status: m.trial, days: 7, endsAt: m.trial === 'active' ? new Date(Date.now() + 5 * 86_400_000).toISOString() : null, usedFraction: m.trial === 'ended' ? 1 : 0 } } : {}),
      // File attachments: only when `m.attachments` is set, as in prod until the server turns them on.
      ...(m.attachments ? { attachments: { enabled: true, maxFiles: 3, maxFileBytes: 2_000_000, maxTotalBytes: 4_000_000, accept: ['png', 'jpg', 'pdf', 'txt', 'csv', 'md'], freeImages: false, ...(m.attachments === true ? {} : m.attachments) } } : {}),
      // Web search (ma-platform ADR 0137): only when `m.webSearch` is set ('ask' or 'auto'). The real Maia has it on by default
      // for an adult Officer, Founder or owner; here a spec turns it on, so the other Maia specs see her as before.
      ...(m.webSearch ? { webSearch: { enabled: true, mode: m.webSearch } } : {}),
    });
  }
  if (path === '/v1/maia/preferences' && m.webSearch) {
    if (req.method === 'GET') return json(res, 200, { webSearch: { mode: m.webSearch, chosen: true } });
    if (req.method === 'PUT') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (b?.webSearch?.mode !== 'ask' && b?.webSearch?.mode !== 'auto') return json(res, 400, envelope('invalid_request', 'Bad mode.'));
      m.webSearch = b.webSearch.mode;
      state.maiaWebModes.push(m.webSearch);
      return json(res, 204);
    }
  }
  if (path === '/v1/maia/turn' && req.method === 'POST') return maiaTurn(req, res);
  if (path === '/v1/maia/welcome' || path === '/v1/maia/welcome/turn') return welcomeRoute(req, res, path);
  if (path === '/v1/maia/memories') {
    if (req.method === 'GET') return json(res, 200, { version: 1, memories: [...state.maiaMemories].reverse() });
    if (req.method === 'DELETE') {
      state.maiaMemories = [];
      return json(res, 204);
    }
  }
  const memory = /^\/v1\/maia\/memories\/([^/]+)$/.exec(path);
  if (memory && req.method === 'DELETE') {
    state.maiaMemories = state.maiaMemories.filter((x) => x.memoryId !== decodeURIComponent(memory[1]));
    return json(res, 204);
  }
  if (path === '/v1/maia/conversations' && req.method === 'GET') {
    // Newest first, as the server sends them.
    const list = Object.entries(state.maiaConversations).map(([conversationId, c]) => ({ conversationId, title: c.title, model: 'claude-opus-5-5', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt }));
    return json(res, 200, { conversations: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  }
  const conversation = /^\/v1\/maia\/conversations\/([^/]+)$/.exec(path);
  if (conversation) {
    const id = decodeURIComponent(conversation[1]);
    const c = state.maiaConversations[id];
    if (!c) return json(res, 404, envelope('not_found', 'Not found.'));
    if (req.method === 'DELETE') {
      delete state.maiaConversations[id];
      return json(res, 204);
    }
    return json(res, 200, { conversationId: id, model: 'claude-opus-5-5', createdAt: c.createdAt, updatedAt: c.createdAt, messages: c.messages });
  }
  const decision = /^\/v1\/maia\/proposals\/([^/]+)\/decision$/.exec(path);
  if (decision && req.method === 'POST') {
    const proposalId = decodeURIComponent(decision[1]);
    const body = JSON.parse((await readBody(req)) || '{}');
    state.maiaDecisions.push({ proposalId, ...body });
    const p = state.maiaProposals[proposalId];
    if (!p) return json(res, 404, envelope('not_found', 'Not found.'));
    if (p.decided) return json(res, 409, envelope('already_decided', 'Already decided.'));
    if (body.decision === 'confirmed' && p.action === 'remember') {
      if (m.memory === false) return json(res, 409, envelope('memory_off', 'Memory is off.'));
      if (state.maiaMemories.length >= (m.maxItems ?? 50)) return json(res, 409, envelope('memory_full', 'Memory is full.'));
      if (/password|token|secret/i.test(p.params.text)) return json(res, 422, envelope('memory_private', 'That looks private.'));
      state.maiaCount += 1;
      state.maiaMemories.push({ memoryId: `mem_${state.maiaCount}`, kind: p.params.kind, text: p.params.text, createdAt: new Date().toISOString(), conversationId: p.conversationId });
    }
    if (body.decision === 'confirmed' && p.action === 'forget') state.maiaMemories = state.maiaMemories.filter((x) => x.memoryId !== p.params.memoryId);
    p.decided = true;
    return json(res, 204);
  }
  return json(res, 404, envelope('not_found', 'Not found.'));
}

/** The welcome's interviewer, as `services/maia/src/welcome.ts` answers (a stub: no model). */
async function welcomeRoute(req, res, path) {
  const w = state.welcome;
  if (!w) return json(res, 404, envelope('not_found', 'Not found.'));
  const raw = req.method === 'POST' ? await readBody(req) : '';
  const body = raw ? JSON.parse(raw) : null;
  state.welcomeCalls.push({ method: req.method, path, body });
  if (path === '/v1/maia/welcome' && req.method === 'GET') return json(res, 200, { due: true, model: w.model !== false && w.mode !== 'scripted', talk: w.talk ?? null });
  if (path === '/v1/maia/welcome' && req.method === 'DELETE') return json(res, 204);
  if (req.method !== 'POST') return json(res, 405, envelope('method_not_allowed', 'No.'));
  if (w.delayMs) await new Promise((r) => setTimeout(r, w.delayMs));
  const scripted = { mode: 'scripted', reason: 'cap_person', ack: null, echo: null, next: null, preAnswered: [], placed: null, followUp: null, helper: null };
  if (body.kind === 'plan') return json(res, 200, w.mode === 'scripted' ? { mode: 'scripted', reason: 'cap_person', plan: null } : { mode: 'model', plan: { answers: {}, helpers: w.planHelpers ?? [] } });
  if (w.mode === 'scripted' || w.model === false) return json(res, 200, scripted);
  const a = body.answer ?? {};
  const text = typeof a.text === 'string' ? a.text : '';
  return json(res, 200, {
    mode: 'model',
    ack: 'lovely',
    echo: text ? 'In your words, noted.' : `Noted for ${a.q}.`,
    next: null,
    preAnswered: [],
    placed: /mail/i.test(text) && a.q === 'q2' ? { q: 'q2', choices: ['email'] } : null,
    followUp: text.includes('[stub:followup]') ? { id: 'f1', question: 'Which kind of writing?', choices: ['Reports', 'Stories'] } : null,
    helper: a.q === 'q3' && text ? { name: 'Grants', desk: 'work', purpose: 'Drafts grant applications for you to check.' } : null,
  });
}

async function maiaTurn(req, res) {
  const m = state.maia;
  const body = JSON.parse((await readBody(req)) || '{}');
  // File bytes are never kept here: a turn is logged with each file's name, type and size.
  const files = Array.isArray(body.attachments) ? body.attachments.map((a) => ({ name: a.name, type: a.type, bytes: Buffer.from(String(a.data), 'base64').length })) : null;
  state.maiaTurns.push(files ? { ...body, attachments: files } : body);
  // As the service: any other field, here or in clientContext, is a 400.
  const keys = (o) => Object.keys(o ?? {}).sort().join(',');
  // An answer to a batch of web searches (ma-platform ADR 0137): no message, the chat it was asked in, one decision.
  if (body.webSearch !== undefined) return maiaWebAnswer(body, res);
  if ((keys(body) !== 'clientContext,conversationId,message' && !(files && keys(body) === 'attachments,clientContext,conversationId,message')) || keys(body.clientContext) !== 'appVersion,lastErrorCode,route,surface') {
    return json(res, 400, envelope('invalid_request', 'Unexpected field.'));
  }
  if (String(body.message).includes('[stub:attach-400]')) return json(res, 400, envelope('attachments_rejected', 'That PDF is locked, so Maia cannot read it.'));
  const fail = state.maiaTurnFail;
  if (fail) {
    if (!fail.times || --fail.times === 0) state.maiaTurnFail = null;
    return json(res, fail.status, envelope(fail.code, 'Refused.', fail.status === 503));
  }
  if (body.conversationId && !state.maiaConversations[body.conversationId]) return json(res, 404, envelope('not_found', 'Not found.'));
  state.maiaCount += 1;
  const n = state.maiaCount;
  const conversationId = body.conversationId ?? `c_harness${n}`;
  // Titled from its first message, as the server does (ma-platform loop.ts titleFrom), so a list can tell chats apart.
  state.maiaConversations[conversationId] ??= { title: String(body.message ?? '').slice(0, 60) || 'Harness chat', createdAt: new Date().toISOString(), messages: [] };
  const convo = state.maiaConversations[conversationId];
  const messageId = `m_harness${n}`;
  const message = String(body.message);
  // As the service stores it: the words, then a line for each file. The bytes are gone.
  const noted = (files ?? []).map((f) => `\n[Attached: ${f.name} (${(f.name.split('.').pop() ?? '').toUpperCase()}, ${Math.max(1, Math.round(f.bytes / 1000))} KB)]`).join('');
  convo.messages.push({ role: 'user', text: message + noted, at: new Date().toISOString() });
  convo.updatedAt = new Date().toISOString();
  let open = true;
  req.on('close', () => { open = false; });
  res.on('close', () => { open = false; });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Request-Id': 'r-harness' });
  const send = (frame) => { if (open) res.write(`data: ${JSON.stringify(frame)}\n\n`); };
  const wait = (ms) => new Promise((done) => { setTimeout(done, ms); });
  // Free Maia (ma-platform ADR 0104): `[stub:free]` switches this turn to her free model with the notice, once; later turns
  // stay on it while `m.freeUntil` is set; `[stub:free-ended]` comes back from it.
  const freeUntil = message.includes('[stub:free]') ? (m.freeUntil ??= new Date(Date.now() + 3 * 3_600_000).toISOString()) : message.includes('[stub:free-ended]') ? (m.freeUntil = null) : m.freeUntil ?? null;
  send({ type: 'start', conversationId, messageId, model: 'claude-opus-5-5', modelLabel: m.modelLabel ?? 'Claude Opus 5.5', newConversation: !body.conversationId, ...(freeUntil ? { free: { until: freeUntil } } : {}) });
  if (message.includes('[stub:free]')) {
    const upgrade = m.freeUpgrade !== false;
    send({ type: 'notice', code: 'free_mode', text: `You've used today's Maia allowance, so you're on free Maia until it resets in about 3 hours. It's a bit slower and simpler.${upgrade ? ' You can raise your limit by upgrading on your account page.' : ''}`, resetsAt: freeUntil, upgrade });
  }
  // A free trial (maia.md): the first message starts it, with the notice `trial_started`; `[stub:trial-over]` ends it, and a turn after that stops with `limit_trial`.
  if (m.trial === 'ended') {
    send({ type: 'stop', reason: 'limit_trial', text: "That was Maia's week.", retryable: false, upgrade: true });
    return res.end();
  }
  if (m.trial === 'unused') {
    m.trial = 'active';
    send({ type: 'notice', code: 'trial_started', text: 'Your week with Maia has started.', upgrade: true });
  }
  if (message.includes('[stub:trial-over]')) {
    m.trial = 'ended';
    send({ type: 'stop', reason: 'limit_trial', text: "That was Maia's week.", retryable: false, upgrade: true });
    return res.end();
  }
  if (message.includes('[stub:free-ended]')) send({ type: 'notice', code: 'free_ended', text: "Your Maia allowance has reset, so you're back to full Maia." });
  // Free Maia is slow to start (the eval: about 16 s): `m.freeFirstMs` holds her first words back that long.
  if (freeUntil && m.freeFirstMs) await wait(m.freeFirstMs);
  if (message.includes('[stub:free-busy]')) {
    send({ type: 'stop', reason: 'limit_personal', text: 'Free Maia is busy right now. Try again in a minute.', retryable: true, free: 'busy' });
    return res.end();
  }
  if (message.includes('[stub:attach-stop]')) {
    send({ type: 'stop', reason: 'attachments', text: 'Those files are too large for Maia to read.', retryable: false });
    return res.end();
  }
  if (message.includes('[stub:refusal]')) {
    send({ type: 'stop', reason: 'refusal', text: MAIA_STOP_TEXT, retryable: false });
    return res.end();
  }
  if (message.includes('[stub:notice]')) send({ type: 'notice', code: 'model_changed', text: "The model changed, so this is a new chat." });
  // Web search (ADR 0137): `[stub:web]` asks for a batch of three; in auto mode it runs at once, with the line and sources.
  if (message.includes('[stub:web]') && m.webSearch) {
    state.maiaCount += 1;
    const batchId = `w_${String(state.maiaCount).padStart(20, 'a').replace(/[^a-z2-7]/g, 'b')}`;
    const queries = ['firefox esr release schedule', 'chrome extended stable channel', 'safari 27 release date'];
    const expiresAt = new Date(Date.now() + (message.includes('[stub:web-expired]') ? -1000 : 10 * 60_000)).toISOString();
    if (m.webSearch === 'ask') {
      state.maiaWebBatches[batchId] = { conversationId, expiresAt, decided: false };
      send({ type: 'web_search', batchId, mode: 'ask', queries, expiresAt });
      send({ type: 'done', messageId });
      return res.end();
    }
    send({ type: 'status', code: 'web' });
    send({ type: 'web_search', batchId, mode: 'auto', queries: queries.slice(0, 1), expiresAt: null });
    send({ type: 'text', text: 'Firefox 152 ESR is due December 8 [1].' });
    send({ type: 'sources', messageId, sources: MAIA_SOURCES });
    send({ type: 'done', messageId });
    return res.end();
  }
  if (message.includes('[stub:status]')) {
    send({ type: 'status', code: 'kb' });
    await wait(300);
  }
  if (state.maiaHold) await new Promise((go) => { maiaHeld.add(go); });
  const plain = message.replace(/\[stub:[^\]]*\]/g, '').trim();
  const reply = message.includes('[stub:markdown]') ? maiaMarkdown() : `You asked: ${plain || 'nothing'}. Here's **a short answer**.`;
  for (let i = 0; i < reply.length && open; i += 12) {
    send({ type: 'text', text: reply.slice(i, i + 12) });
    await wait(m.slow ?? 15);
  }
  const proposals = [];
  const propose = (action, params, expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()) => {
    state.maiaCount += 1;
    const proposalId = `p_harness${state.maiaCount}`;
    state.maiaProposals[proposalId] = { action, params, decided: false, conversationId };
    proposals.push({ type: 'proposal', proposalId, action, params, expiresAt });
  };
  for (const [, deskId] of message.matchAll(/\[stub:desk:([^\]]+)\]/g)) propose('open_desk', { deskId });
  for (const [, page] of message.matchAll(/\[stub:page:([^\]]+)\]/g)) propose('open_page', { page });
  if (message.includes('[stub:lead]')) propose('lead_request', {});
  for (const [, kind] of message.matchAll(/\[stub:remember:([^\]]+)\]/g)) propose('remember', { kind, text: m.rememberText ?? 'Short answers, with the steps in a list.' });
  for (const [, memoryId] of message.matchAll(/\[stub:forget:([^\]]+)\]/g)) propose('forget', { memoryId });
  if (message.includes('[stub:expired]')) propose('remember', { kind: 'preference', text: 'Too late for this one.' }, new Date(Date.now() - 1000).toISOString());
  for (const p of proposals) send(p);
  send({ type: 'done', messageId });
  convo.messages.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
  if (m.animation !== false) {
    await wait(200);
    const routine = message.match(/\[stub:routine:([^\]]+)\]/)?.[1];
    send({ type: 'animation', messageId, score: routine ? { ...MAIA_SCORE, routine } : MAIA_SCORE });
  }
  return res.end();
}

/** The sources the fake's web searches cite: one real-looking page, one off our hosts on purpose. */
const MAIA_SOURCES = [
  { n: 1, title: 'Firefox ESR', url: 'https://www.mozilla.org/firefox/esr/', domain: 'mozilla.org' },
  { n: 2, title: 'Chrome release channels', url: 'https://chromereleases.example.org/', domain: 'chromereleases.example.org' },
];

/** The member's answer to a web search card, as `services/maia` takes it: a turn with no message. */
function maiaWebAnswer(body, res) {
  const b = state.maiaWebBatches[body.webSearch?.batchId];
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'clientContext,conversationId,webSearch' || !['approve', 'decline', 'always'].includes(body.webSearch?.decision)) return json(res, 400, envelope('invalid_request', 'Unexpected field.'));
  if (!b || b.decided || b.conversationId !== body.conversationId) return json(res, 404, envelope('web_search_not_found', 'That search request is gone.'));
  if (Date.parse(b.expiresAt) <= Date.now()) return json(res, 410, envelope('web_search_expired', 'This search request has expired.'));
  b.decided = body.webSearch.decision;
  if (b.decided === 'always') {
    state.maia.webSearch = 'auto';
    state.maiaWebModes.push('auto');
  }
  state.maiaCount += 1;
  const messageId = `m_harness${state.maiaCount}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Request-Id': 'r-harness' });
  const send = (frame) => res.write(`data: ${JSON.stringify(frame)}

`);
  send({ type: 'start', conversationId: body.conversationId, messageId, newConversation: false });
  if (b.decided === 'decline') {
    send({ type: 'text', text: "I didn't search the web, but here's what I know." });
  } else {
    send({ type: 'status', code: 'web' });
    send({ type: 'text', text: 'Firefox 152 ESR is due December 8 [1], and Chrome moves every four weeks [2].' });
    send({ type: 'sources', messageId, sources: MAIA_SOURCES });
  }
  send({ type: 'done', messageId });
  return res.end();
}

/** What a closed account's office token may still ask for (`closedAccount`); `connect` checks its own purpose. */
function closedAllows(req, path) {
  const get = req.method === 'GET';
  if (path === '/v1/me' || path === '/v1/me/export') return get;
  if (path === '/v1/me/sign-out') return req.method === 'POST';
  if (path === '/v1/desks') return get && state.closedAccount !== 'all';
  if (/^\/v1\/desks\/[^/]+$/.test(path) && path !== '/v1/desks/bandwidth') return get;
  return /^\/v1\/desks\/[^/]+\/connect$/.test(path) && req.method === 'POST';
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  state.log.push(`${req.method} ${path}`);

  if (path === '/v1/client-config' && url.searchParams.get('app') === 'platform-web') {
    // As services/member: Platform's own app gets the billing block, only where checkout is live.
    state.log.push('client-config platform-web');
    if (state.platformConfigDelayMs) await new Promise((r) => setTimeout(r, state.platformConfigDelayMs));
    if (state.platformBilling === 'fail') return json(res, 503, envelope('unavailable', 'Try again.', true));
    return json(res, 200, {
      app: 'platform-web', env: 'harness', api: ORIGIN,
      links: { billing: `${ORIGIN}/billing`, ...(state.accountLink ? { account: state.accountLink } : {}) },
      ...(state.platformBilling ? { billing: state.platformBilling } : {}),
      ...(state.platformFree ? { free: state.platformFree } : {}),
      ...(state.ageRules ? { ageRules: state.ageRules } : {}),
    });
  }
  if (path === '/v1/billing/status' && req.method === 'GET') {
    if (state.billingStatus === 'fail') return json(res, 503, envelope('unavailable', 'Try again.', true));
    if (state.billingStatus) return json(res, 200, state.billingStatus);
    return json(res, 404, envelope('not_found', 'Not found.'));
  }
  if (path === '/v1/client-config') {
    return json(res, 200, {
      app: 'desk-web', env: 'harness', version: state.releaseVersion ?? release.version, assetBase: `/v/${release.version}/`, api: ORIGIN,
      gateway: gatewayUrl(),
      auth: {
        domain: `${ORIGIN}/fake-auth`, clientId: 'harness-client', redirectUri: `${ORIGIN}/auth/callback`, logoutUri: `${ORIGIN}/signed-out`,
        scopes: ['openid', `${ORIGIN}/member`], identityProviders: ['COGNITO', 'Google'], googleSignIn: state.google ?? false,
        ...(state.signInPath ? { signInPath: state.signInPath } : {}),
        ...(state.sso !== null ? { sso: state.sso } : {}),
      },
      links: { billing: `${ORIGIN}/billing`, ...(state.accountLink ? { account: state.accountLink } : {}), ...(state.membershipLink ? { membership: state.membershipLink } : {}), ...(state.configExtra?.links ?? {}) },
      ...(state.maia ? { maia: { url: state.maia.url ?? ORIGIN } } : {}),
      ...(state.setupCircle ? { setupCircle: state.setupCircle } : {}),
      ...(state.walkthrough ? { walkthrough: state.walkthrough } : {}),
      ...(state.welcomeSwitch ? { welcome: state.welcomeSwitch } : {}),
      ...(state.configExtra ? Object.fromEntries(Object.entries(state.configExtra).filter(([k]) => k !== 'links')) : {}),
      ...(state.export ? { export: state.export } : {}),
      ...(state.simpleView ? { simpleView: state.simpleView } : {}),
      ...(state.deskApps ? { deskApps: state.deskApps } : {}),
      ...(state.files ? { files: state.files } : {}),
      ...(state.todo ? { todo: state.todo } : {}),
      ...(state.documents ? { documents: state.documents } : {}),
      ...(state.tierNames ? { tierNames: state.tierNames } : {}),
      ...(state.ageRules ? { ageRules: state.ageRules } : {}),
      ...(state.tierAllowances ? { tierAllowances: state.tierAllowances } : {}),
      ...(state.guildsConfig ? { guilds: state.guildsConfig } : {}),
    });
  }

  if (!authorized(req)) return json(res, 401, { message: 'Unauthorized' });
  if (state.sessionRevoked && path !== '/v1/me/sign-out') return json(res, 401, envelope('session_revoked', 'This session was signed out.'));
  if (state.closedAccount && !closedAllows(req, path)) return json(res, 403, envelope('account_closed', 'This account is closed.'));
  if (await streamQuality(req, res, path, state, { json, readBody, claimsOf, envelope })) return;
  if (await appearance(req, res, path, state, { json, readBody, claimsOf, envelope })) return;
  // Maia while away (ma-platform maiaAway, Maia Mode Phase 2): its rows under the account menu's Maia Mode. Off unless a spec
  // sets `maiaAway` through /__harness; before this route the menu's GET was a 404 that failed the room's console checks.
  if (path === '/v1/desks/maia-away' && (req.method === 'GET' || req.method === 'PATCH')) {
    if (req.method === 'PATCH') {
      let patch = {};
      try {
        patch = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, envelope('invalid_request', 'Check the fields.', false));
      }
      state.maiaAway = { ...(state.maiaAway ?? { enabled: false }), ...patch };
    }
    return json(res, 200, state.maiaAway ?? { enabled: false }, { 'Cache-Control': 'no-store' });
  }
  if (await guilds(req, res, path, state, { json, readBody, envelope, gatewayUrl })) return;
  if (await notifications(req, res, path, state, { json, readBody, envelope })) return;
  if (await courierRegistry(req, res, path, state, { json, readBody, envelope })) return;

  if (path === '/v1/me') {
    if (state.meDelayMs) await new Promise((done) => setTimeout(done, state.meDelayMs));
    return json(res, 200, {
      userId: claimsOf(req).sub,
      email: 'member-1@example.org',
      displayName: state.displayName ?? 'Test Member',
      membership: state.membership,
      ...(state.avatar ? { avatar: state.avatar } : {}),
      ...(state.roles ? { roles: state.roles } : {}),
      ...(state.meMaiaMode ? { maiaMode: state.meMaiaMode } : {}),
      ...(state.staySignedIn || state.officeTour !== 'absent'
        ? { preferences: { ...(state.staySignedIn ? { staySignedIn: state.staySignedIn } : {}), ...(state.officeTour !== 'absent' ? { officeTour: state.officeTour } : {}) } }
        : {}),
      ...(state.notices ? { notices: state.notices } : {}),
      ...(state.meGuilds ? { guilds: state.meGuilds } : {}),
    });
  }
  // The member's preferences (contract auth.md section 3.3): `platform-web`'s alone today, so this app's token is 403; once
  // Platform opens `officeTour` to the office (ADR 0056's proposal), that one field, `{off: boolean}`, and nothing else.
  if (path === '/v1/me/preferences' && req.method === 'PUT') {
    const raw = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* answered below */
    }
    const tour = body?.officeTour;
    const ok = state.officeTour !== 'absent' && body && Object.keys(body).length === 1 && tour && typeof tour.off === 'boolean' && Object.keys(tour).length === 1;
    const status = state.officeTour === 'absent' ? 403 : ok ? 200 : 400;
    state.preferencePuts.push({ body, status });
    if (status === 403) return json(res, 403, envelope('forbidden', 'Not allowed for this client.'));
    if (status === 400) return json(res, 400, envelope('invalid_request', 'Check the fields.'));
    state.officeTour = { off: tour.off, at: new Date().toISOString() };
    return json(res, 200, { ...(state.staySignedIn ? { staySignedIn: state.staySignedIn } : {}), officeTour: state.officeTour });
  }
  // The close hold's dismiss (ma-platform contract auth.md section 2.7): any app's token, no body. A kind the service doesn't
  // know is 404 not_found; one already gone is the same 200.
  const dismiss = /^\/v1\/me\/notices\/([^/]+)\/dismiss$/.exec(path);
  if (dismiss && req.method === 'POST') {
    const kind = decodeURIComponent(dismiss[1]);
    const body = await readBody(req);
    const fail = state.noticeDismissFail;
    const refuse = fail && (fail.times === undefined || fail.times > 0);
    const status = refuse ? fail.status ?? 503 : kind === 'close_hold_cancelled' ? 200 : 404;
    state.noticeDismisses.push({ kind, auth: req.headers.authorization ?? null, body, status });
    if (refuse) {
      if (fail.times !== undefined) fail.times -= 1;
      return json(res, status, envelope('unavailable', 'Try again.', true));
    }
    if (status === 404) return json(res, 404, envelope('not_found', 'No such notice.', false));
    if (Array.isArray(state.notices)) state.notices = state.notices.filter((n) => n?.kind !== kind);
    return json(res, 200, { kind, dismissed: true });
  }
  if (path === '/v1/me/sign-out') {
    state.signOuts.push(JSON.parse((await readBody(req)) || '{}'));
    if (state.signOutDelayMs) await new Promise((done) => { setTimeout(done, state.signOutDelayMs); });
    if (state.signOutFails) return json(res, state.signOutFails, envelope('unavailable', 'Try again.', true));
    return json(res, 204);
  }
  if (path === '/v1/me/lead-request' && req.method === 'POST') return json(res, 201, { requestId: 'lr-harness', status: 'pending', requestedAt: new Date().toISOString(), decidedAt: null });
  if (path.startsWith('/v1/maia/')) return handleMaia(req, res, url);
  if (path === '/v1/me/export') return handleMeExport(req, res);
  if (path === '/v1/moves') return handleMoves(req, res);
  const moveAction = /^\/v1\/moves\/([\w-]+)\/(cancel|remove-cloud-desk)$/.exec(path);
  if (moveAction) return handleMoveAction(req, res, moveAction[1], moveAction[2]);
  if (path === '/v1/me/desk-layout') return handleLayout(req, res);
  if (path === '/v1/desks') {
    if (state.desksDelayMs) await new Promise((done) => setTimeout(done, state.desksDelayMs));
    if (state.desksUnauthorized) return json(res, 401, { message: 'Unauthorized' });
    if (state.fleet) {
      // `refuse` is the harness's own: the list never says why `connect` would say no.
      const desks = state.fleet.map((d) => ({ ...DESK, ...d, phase: fleetPhase(d), refuse: undefined, ...named(d.deskId) }));
      return listReply(req, res, { desks, pollAfterSeconds: state.fleet.some((d) => TRANSITIONAL.has(d.state)) ? 2 : 60 });
    }
    switch (state.desks) {
      case 'forbidden':
        return json(res, 403, envelope('forbidden', 'Not allowed.'));
      case 'error':
        return json(res, 503, envelope('unavailable', 'Try again.', true));
      case 'empty':
        return listReply(req, res, { desks: [], pollAfterSeconds: 60 }); // services/desks sends no `membership`
      case 'unpaid':
        return listReply(req, res, { membership: { status: 'unpaid', billingUrl: `${ORIGIN}/billing` }, desks: [], pollAfterSeconds: 60 });
      default:
        return listReply(req, res, { membership: { status: 'active' }, desks: [state.shim ? { ...DESK, deskId: SHIM_DESK, ...named(SHIM_DESK) } : { ...DESK, ...named(DESK.deskId) }], pollAfterSeconds: 60 });
    }
  }
  if (path === '/v1/desks/bandwidth') return json(res, ...bandwidthReply(state.bandwidth));
  if (/^\/v1\/desks\/[^/]+$/.test(path) && req.method === 'PATCH') return handleRename(req, res, decodeURIComponent(path.slice('/v1/desks/'.length)));
  if (path.endsWith('/connect') && req.method === 'POST') return handleConnect(req, res, path);
  return json(res, 404, envelope('not_found', 'Not found.'));
}

/**
 * The log says whether the app read the whole answer ('revoke answered in full') or left before it ('revoke cut off'),
 * which is what Platform's sign-out fix and the Desk app's are about: `fetch` resolves on the headers.
 */
async function revoke(req, res) {
  const token = new URLSearchParams(await readBody(req)).get('token');
  res.on('close', () => state.log.push(res.writableFinished ? 'revoke answered in full' : 'revoke cut off'));
  if (state.revokeHolds) return;
  if (token) state.revoked.push(token);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (state.revokeBodyMs) {
    res.write(' '); // the headers go now
    await new Promise((done) => { setTimeout(done, state.revokeBodyMs); });
  }
  if (!res.destroyed) res.end('{}');
}

async function handleAuth(req, res, url) {
  const path = url.pathname.slice('/fake-auth'.length);
  state.log.push(`${req.method} /fake-auth${path}`);
  if (path === '/oauth2/authorize') {
    const q = url.searchParams;
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'invalid_request' });
    if (state.authorizeHolds) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><head><title>Managed login</title></head><body><h1>Managed login</h1></body></html>');
    }
    if (state.authorizeBounces) {
      res.writeHead(302, { Location: state.authorizeBounces === 'home' ? `${ORIGIN}/` : q.get('redirect_uri') });
      return res.end();
    }
    const code = `code-${codes.size + 1}`;
    codes.set(code, q.get('nonce'));
    res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` });
    return res.end();
  }
  if (path === '/oauth2/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    if (form.get('grant_type') === 'authorization_code') {
      if (!form.get('code_verifier') || state.codeExchangeFails) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, tokens(codes.get(form.get('code'))));
    }
    if (form.get('grant_type') === 'refresh_token') {
      const sent = form.get('refresh_token');
      state.refreshSent.push(sent);
      if (state.refreshDelayMs) await new Promise((done) => { setTimeout(done, state.refreshDelayMs); });
      if (state.refreshFails || state.refreshRefuses.includes(sent) || state.revoked.includes(sent)) return json(res, 400, { error: 'invalid_grant' });
      if (state.refreshFailure === 'drop') return res.destroy();
      if (state.refreshFailure) {
        const { status, body } = state.refreshFailure;
        if (typeof body !== 'string') return json(res, status, body);
        res.writeHead(status, { 'Content-Type': 'text/html' });
        return res.end(body);
      }
      return json(res, 200, tokens(undefined));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (path === '/oauth2/revoke') return revoke(req, res);
  if (path === '/logout') {
    res.writeHead(302, { Location: url.searchParams.get('logout_uri') });
    return res.end();
  }
  return json(res, 404, { error: 'not_found' });
}

function serveFile(res, file, cache) {
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache });
  res.end(readFileSync(file));
}

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;

  if (path === '/__harness') {
    if (req.method === 'POST') {
      const patch = JSON.parse((await readBody(req)) || '{}');
      state = patch.reset ? FRESH() : { ...state, ...ageState(patch.age), ...patch };
      if (!state.maiaHold) {
        for (const go of maiaHeld) go();
        maiaHeld.clear();
      }
    }
    return json(res, 200, state);
  }
  if (path.startsWith('/v1/')) return handleApi(req, res, url);
  if (path.startsWith('/fake-auth/')) return handleAuth(req, res, url);

  res.setHeader('Content-Security-Policy', csp());
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (path === '/_signin/') state.log.push(`GET /_signin/${url.search}`);
  if (path === '/_signin/' && !state.signInRouteMissing) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    return res.end(SIGNIN_HTML);
  }
  if (path === '/_signin/stub.js' && !state.signInRouteMissing) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(state.signInHolds ? '' : signinJs(state.staySignedIn));
  }
  // Anything that tries to load from here, such as an image in Maia's text, which must never happen.
  if (path.startsWith('/__pixel/')) {
    state.log.push(`GET ${path}`);
    res.writeHead(404);
    return res.end();
  }
  if (path === '/_loader/loader.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(loaderJs());
  }
  if (path === '/_loader/loading.css') {
    res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' });
    return res.end(LOADING_CSS);
  }
  if (path === '/_loader/theme.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(THEME_JS);
  }
  // The mock build is built with base /v/e2e/ but its manifest says "dev", so serve both.
  const versionPrefix = [`/v/${release.version}/`, '/v/e2e/'].find((p) => path.startsWith(p));
  if (versionPrefix && path.endsWith('/ma-release.json') && state.releaseManifest) {
    if (state.releaseManifest === 'fail') {
      res.writeHead(503);
      return res.end();
    }
    // 'noOverlay': a bundle from before the loading overlay (ADR 0058), which doesn't take it away itself.
    const before = { ...release };
    delete before.loadingOverlay;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(before));
  }
  if (versionPrefix) {
    const rel = normalize(path.slice(versionPrefix.length)).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST, rel);
    if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) {
      return serveFile(res, file, 'public, max-age=31536000, immutable');
    }
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
  res.end(LOADER_HTML);
}).listen(PORT, 'localhost', () => {
  console.log(`harness: ${DIST} (${release.version}) at ${ORIGIN}`);
});
