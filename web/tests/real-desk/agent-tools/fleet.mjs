// The fleet desk's lib: what `driver-desk.mjs` asks of `rt-lib.mjs` (`ALLOWED`, `S`, `openSession`, `getDesk`, `closeTour`,
// `waitPanel`, `wait`, `log`, `logConfig`, `shot`, `shutdown`, `events`), for one staging desk of a fleet test account in
// staging's own office, in place of desk-1's test desk. The real-model proofs (rt-agent-real.mjs, rt-capability-real.mjs,
// rt-dedupe-real.mjs) run on it with the desk's own Lead agent and its stored key: nothing here types, reads or prints a key.
//
// The sign-in, the staging guard and the redactor are ma-platform's fleet tooling (tests/fleet-mcp/src: signin.ts
// createSignIn, loadFleetAccount, e2eSources; guard.ts stagingPolicy; redact.ts Redactor), imported read only from a clone
// named by MA_PLATFORM_CLONE, exactly as test-key/check-keys.mjs does: every request goes through the guard, every line
// printed or saved through the redactor. Only `FLEET_DESK` may be woken or connected; a call for any other desk is refused in
// the page before it leaves it (and seen and refused again from Node). The desk is woken as a member wakes one, from the office.
//
// The two AWS writes the proofs may make (SSM send-command: restart desk-agent, a FIFO in Harness/) go only to the instance
// found read only by its tags (DeskId=FLEET_DESK, Env=staging, one instance), through `ssmRun`.
//
//   MA_ENV=staging (required), MA_PLATFORM_CLONE (default ~/work/maia-mode/test-key/ma-platform),
//   the account fleet-officer and the desk d-teste5h2wnkq, both fixed in code (ALLOWED, ACCOUNT). Node 24.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Constants, not settings: no environment can point these scripts at another desk or account (Security's MMH-I2).
export const ALLOWED = 'd-teste5h2wnkq';
export const ACCOUNT = 'fleet-officer';
export const OFFICE = 'https://office.staging.minimalistalliance.com/';
export const MP = process.env.MA_PLATFORM_CLONE || resolve(homedir(), 'work/maia-mode/test-key/ma-platform');
/** Filled by `findInstance()`, read only, before any SSM step. */
export let INSTANCE = null;
const mod = (p) => import(pathToFileURL(resolve(MP, p)).href);

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- the redactor and the log

let redactor = null;
const pending = [];
/** Every line out goes through the fleet Redactor (and the line hook, if a script set one). */
export function scrub(v) {
  const s = String(v);
  return redactor ? redactor.text(s) : s.replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, '[jwt]');
}
/** A secret the run holds: masked in every line from now on. */
export function addSecret(s) {
  if (redactor) redactor.add(s);
  else pending.push(s);
}
export const logConfig = { line: null };
export const events = [];
const T0 = Date.now();
export function logAt(at, ...parts) {
  const text = scrub(parts.join(' '));
  if (logConfig.line) return logConfig.line(at, text);
  console.log(`${((at - T0) / 1000).toFixed(3).padStart(9)} | ${text}`);
}
export const log = (...parts) => logAt(Date.now(), ...parts);

export const S = {
  browser: null,
  context: null,
  page: null,
  closing: false,
  guardTripped: false,
  shot: 0,
  hardExitMs: 30_000,
  beforeExit: null,
  afterClose: null,
  layoutReadAt: 0,
  tourAsked: false,
  found: null,
};

async function tripGuard(what) {
  if (S.guardTripped) return;
  S.guardTripped = true;
  log('!!! GUARD TRIPPED: refused or saw', JSON.stringify(what), '- aborting at once');
  try {
    await S.browser?.close();
  } catch {
    /* closing anyway */
  }
  process.exit(2);
}

export async function shutdown(code, why) {
  if (S.closing) return;
  S.closing = true;
  setTimeout(() => process.exit(code), S.hardExitMs).unref();
  log('SHUTDOWN', why ?? '', `exit=${code}`);
  try {
    await S.beforeExit?.(why);
  } catch (e) {
    log('beforeExit failed', e.message);
  }
  try {
    if (S.page) {
      await S.page.goto('about:blank', { timeout: 5000 });
      await wait(800);
    }
  } catch {
    /* closing anyway */
  }
  try {
    await S.browser?.close();
  } catch {
    /* gone */
  }
  log('browser closed');
  try {
    await S.afterClose?.();
  } catch (e) {
    log('afterClose failed', e.message);
  }
  process.exit(code);
}

// ----- the page's guard: only this desk, refused in the page before anything leaves it

/** In the page. Any desk action for another desk is refused (connect too, so the probe sees one desk's channels); for this desk, only connect. */
function fleetPageGuard({ allowed }) {
  if (window.__fleetGuard) return;
  window.__fleetGuard = true;
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const m = /\/v1\/desks\/([^/?]+)\/(connect|start|stop|resize|destroy|export|move)(?:\?|$)/.exec(url);
    if (m && method === 'POST' && (m[1] !== allowed || m[2] !== 'connect')) {
      try {
        window.__fleetRefused({ desk: m[1] === allowed ? 'this' : 'other', action: m[2] });
      } catch {
        /* binding not there yet */
      }
      return Promise.reject(new TypeError('refused by the fleet harness'));
    }
    return nativeFetch.apply(this, arguments);
  };
}

/** Desk proxies' accessible names, as check-keys.mjs reads them. */
const DESK_LABEL = /^(.*?) desk, (\d+) apps?, (.*)$/s;
const WAKING = /^(waking\b|waiting for capacity|setting up|checking|not connected yet|connecting|reconnecting)/;
const PROBLEM = /^(couldn't wake|access denied|membership not active|stopped · |can't reach desk|no longer in this guild)/;
export function deskState(label) {
  const status = DESK_LABEL.exec(label ?? '')?.[3] ?? '';
  if (!status) return { state: 'unknown', status };
  if (/^asleep\b/.test(status)) return { state: 'asleep', status };
  if (WAKING.test(status)) return { state: 'waking', status };
  if (/^going to sleep/.test(status)) return { state: 'stopping', status };
  if (PROBLEM.test(status)) return { state: 'problem', status };
  return { state: 'online', status };
}
export const testLabel = async () => (S.page ? await S.page.locator(`[id="proxy-${ALLOWED}"]`).getAttribute('aria-label', { timeout: 2000 }).catch(() => '') : '');

/**
 * The fleet account signed in, in staging's office, through the guard. `onContext(ctx)` runs before the first page (the
 * driver's probe goes there). Same shape as rt-lib's `openSession`.
 */
export async function openSession({ onContext = null, contextOptions = {} } = {}) {
  if ((process.env.MA_ENV ?? '') !== 'staging') throw new Error('refusing: MA_ENV=staging only');
  if (!existsSync(resolve(MP, 'tests/fleet-mcp/src/signin.ts'))) throw new Error(`no ma-platform clone with the fleet tooling at ${MP}`);
  const { Redactor } = await mod('tests/fleet-mcp/src/redact.ts');
  redactor = new Redactor();
  for (const s of pending.splice(0)) redactor.add(s);
  process.on('uncaughtException', (e) => {
    log('FATAL', e?.message ?? e);
    void shutdown(1, 'uncaught');
  });
  process.on('unhandledRejection', (e) => {
    log('FATAL', e?.message ?? e);
    void shutdown(1, 'unhandled');
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(1, sig));

  const { chromium } = await import(pathToFileURL(resolve(MP, 'tests/fleet-mcp/node_modules/playwright/index.mjs')).href);
  const { stagingPolicy, stagingServices } = await mod('tests/fleet-mcp/src/guard.ts');
  const policy = stagingPolicy(await stagingServices());
  S.browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: [`--host-resolver-rules=${policy.resolverRules}`, '--disable-breakpad', '--disable-crash-reporter'] });
  log('browser', S.browser.version());
  const ctx = await S.browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: false, ...contextOptions });
  ctx.setDefaultTimeout(15_000);
  S.context = ctx;
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    let ok;
    if (req.isNavigationRequest() || req.resourceType() === 'document') ok = policy.allows(url);
    else {
      let from;
      try {
        from = req.frame().url();
      } catch {
        from = undefined;
      }
      ok = policy.allowsAsset(url, { type: req.resourceType(), from }) || !!policy.allowsService?.(url, { method: req.method(), headers: req.headers(), postData: req.postData() });
    }
    return ok ? route.fallback() : route.abort('blockedbyclient');
  });
  await ctx.routeWebSocket(/.*/, (ws) => (policy.allows(ws.url()) ? ws.connectToServer() : ws.close({ code: 1008, reason: 'blocked' })));
  await ctx.exposeBinding('__fleetRefused', (_src, e) => log('the page refused a desk call:', JSON.stringify(e)));
  await ctx.addInitScript(fleetPageGuard, { allowed: ALLOWED });
  // From Node too: a desk action that got past the page's own guard is refused and ends the run.
  ctx.on('request', (r) => {
    let url;
    try {
      url = new URL(r.url());
    } catch {
      return;
    }
    if (/\/TourLayer-[^/]*\.js$/.test(url.pathname)) S.tourAsked = true;
    const m = /^\/v1\/desks\/([^/]+)\/(connect|start|stop|resize|destroy|export|move)$/.exec(url.pathname);
    if (m && r.method() === 'POST' && (m[1] !== ALLOWED || m[2] !== 'connect')) void tripGuard({ desk: m[1] === ALLOWED ? 'this' : 'other', action: m[2] });
  });
  ctx.on('response', (r) => {
    try {
      const url = new URL(r.url());
      if (url.pathname === '/v1/me/desk-layout' && r.request().method() === 'GET' && !S.layoutReadAt) S.layoutReadAt = Date.now();
      if (url.hostname.startsWith('api.') && r.request().method() !== 'OPTIONS' && r.status() >= 400) log('http', r.status(), r.request().method(), url.pathname);
    } catch {
      /* not a URL */
    }
  });
  await onContext?.(ctx);
  S.page = await ctx.newPage();
  S.page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      events.push({ at: Date.now(), k: 'console', level: t });
      log('CONSOLE', t, m.text().slice(0, 300));
    }
  });
  S.page.on('pageerror', (e) => {
    events.push({ at: Date.now(), k: 'console', level: 'pageerror' });
    log('PAGEERROR', e.message.slice(0, 300));
  });
  const { createSignIn, e2eSources, loadFleetAccount } = await mod('tests/fleet-mcp/src/signin.ts');
  const account = await loadFleetAccount(ACCOUNT, await e2eSources(), redactor);
  const signIn = createSignIn({ account, appUrl: OFFICE, redactor });
  const page = S.page;
  await signIn({ pages: [page], current: 0, page: () => page, newPage: async () => page });
  log(`signed in as ${ACCOUNT}, at ${new URL(page.url()).pathname}`);
  return S;
}

/** The desk as the office says it (its proxy's name), in rt-lib's words: `running` once online. */
export async function getDesk() {
  const s = deskState(await testLabel());
  return { state: s.state === 'online' ? 'running' : s.state === 'asleep' ? 'stopped' : s.state, status: s.status };
}

/** Wakes the desk as a member does from the office: focus its desk and press Enter (check-keys.mjs's way). */
export async function wakeDesk(timeoutMs = 5 * 60_000) {
  const btn = S.page.locator(`[id="proxy-${ALLOWED}"]`);
  await btn.waitFor({ state: 'attached', timeout: 60_000 });
  const found = deskState(await btn.getAttribute('aria-label'));
  S.found ??= found;
  log(`the desk was ${found.state} ("${found.status}")`);
  if (found.state !== 'online') {
    await btn.focus();
    await S.page.keyboard.press('Enter');
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = deskState(await btn.getAttribute('aria-label').catch(() => ''));
    if (s.state === 'problem') throw new Error(`the desk says "${s.status}"`);
    if (s.state === 'online') {
      log(`the desk is online ("${s.status}")`);
      return s;
    }
    await wait(1000);
  }
  throw new Error('the desk did not come online in 5 minutes');
}

/** As rt-lib's: closes the office tour with its own close button if it started by itself. */
export async function closeTour(timeoutMs = 60_000) {
  const p = S.page;
  const tour = p.getByTestId('tour');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await tour.isVisible().catch(() => false)) {
      await p.getByTestId('tour-close').click();
      await tour.waitFor({ state: 'detached', timeout: 5000 });
      log('the office tour started by itself: closed it with its close button');
      return true;
    }
    if (S.layoutReadAt && !S.tourAsked && Date.now() - S.layoutReadAt > 5000) return false;
    await wait(250);
  }
  return false;
}

export const CONNECTED = /online|no key|working|needs you|limit reached|agent error/;
export async function waitPanel(_re, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (deskState(await testLabel()).state === 'online') return true;
    await wait(250);
  }
  return false;
}

/** A screenshot, with its metadata stripped (PIL's re-save keeps pixels only). */
export async function shot(dir, name) {
  S.shot += 1;
  mkdirSync(dir, { recursive: true });
  const path = `${dir.replace(/\/$/, '')}/${String(S.shot).padStart(3, '0')}-${name.replace(/[^\w.+-]+/g, '_')}.png`;
  try {
    await S.page.screenshot({ path });
    await run('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]); im.load(); Image.frombytes(im.mode, im.size, im.tobytes()).save(sys.argv[1])', path]).catch(() => undefined);
    log('shot', path);
  } catch (e) {
    log('shot failed', e.message.slice(0, 120));
  }
  return path;
}

// ----- AWS: the instance found read only, and the proofs' two SSM steps on it alone

const awsEnv = () => ({ ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' });
const aws = async (...a) => (await run('aws', a, { encoding: 'utf8', env: awsEnv(), maxBuffer: 16 << 20 })).stdout;

/** The desk's instance by its tags, read only. Exactly one, tagged DeskId=ALLOWED, Env=staging, Project=minimalist-alliance; else it throws. */
export async function findInstance() {
  const out = JSON.parse(await aws('ec2', 'describe-instances', '--filters', `Name=tag:DeskId,Values=${ALLOWED}`, '--query', 'Reservations[].Instances[].{id:InstanceId,state:State.Name,tags:Tags}', '--output', 'json'));
  const live = out.filter((i) => i.state !== 'terminated');
  if (live.length !== 1) throw new Error(`${live.length} instances tagged DeskId=${ALLOWED}: unclear, so no SSM step`);
  const tag = (k) => live[0].tags.find((t) => t.Key === k)?.Value ?? null;
  if (tag('Env') !== 'staging' || tag('DeskId') !== ALLOWED || tag('Project') !== 'minimalist-alliance') throw new Error('the instance is not tagged as this staging desk: no SSM step');
  INSTANCE = live[0].id;
  return { instance: INSTANCE, state: live[0].state, env: tag('Env'), kind: tag('DeskKind') };
}

/** One shell command on the desk over SSM (AWS-RunShellScript), only on the instance `findInstance` confirmed. Its output, redacted. */
export async function ssmRun(command, { timeoutS = 180, waitForIt = true } = {}) {
  if (!INSTANCE) throw new Error('refusing: findInstance() first');
  const id = (await aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--timeout-seconds', String(Math.max(30, timeoutS)), '--parameters', JSON.stringify({ commands: [command], executionTimeout: [String(timeoutS)] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
  const get = async () => {
    const end = Date.now() + (timeoutS + 60) * 1000;
    while (Date.now() < end) {
      await wait(1500);
      let inv;
      try {
        inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--output', 'json'));
      } catch {
        continue;
      }
      if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) return { status: inv.Status, out: scrub(inv.StandardOutputContent ?? ''), err: scrub(inv.StandardErrorContent ?? ''), code: inv.ResponseCode };
    }
    return { status: 'Unknown', out: '', err: '', code: null };
  };
  return waitForIt ? get() : { commandId: id, result: get };
}
