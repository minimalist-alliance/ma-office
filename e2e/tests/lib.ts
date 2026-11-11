// Shared helpers. No secret is ever printed: credentials are read into memory from SSM and used
// only through fill() and the TOTP generator; nothing here logs a page URL's query, a token or a body.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page, type BrowserContext } from '@playwright/test';
import { generate } from 'otplib';

export const REGION = 'us-east-1';
/** The staging test desk these suites drive, from the environment. `assertTestDesk()` refuses any other machine. */
export const INSTANCE = process.env['E2E_TEST_INSTANCE'] ?? '';
export const DESK_ID = process.env['E2E_TEST_DESK'] ?? '';
export const APP = process.env.TD_APP ?? 'https://test.office.staging.minimalistalliance.com';
export const API = 'https://api.staging.minimalistalliance.com';
export const B14_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aws(...args: string[]): string {
  return execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION } });
}

/** Refuses unless E2E_TEST_INSTANCE and E2E_TEST_DESK are set and the instance's tags say it's that staging test desk. */
export function assertTestDesk(): void {
  if (!/^i-[0-9a-f]{8,17}$/.test(INSTANCE) || !/^d-[a-z0-9]{12}$/.test(DESK_ID)) throw new Error('set E2E_TEST_INSTANCE and E2E_TEST_DESK to the staging test desk');
  const tags = JSON.parse(aws('ec2', 'describe-tags', '--filters', `Name=resource-id,Values=${INSTANCE}`, '--query', 'Tags', '--output', 'json')) as { Key: string; Value: string }[];
  const t: Record<string, string> = Object.fromEntries(tags.map((x) => [x.Key, x.Value]));
  if (t['DeskKind'] !== 'test' || t['Env'] !== 'staging' || t['DeskId'] !== DESK_ID) throw new Error(`refusing ${INSTANCE}: not the staging test desk`);
}

export interface TestUser { email: string; password: string; totpSecret: string }
export function loadUser(name: string): TestUser {
  const rec = JSON.parse(aws('ssm', 'get-parameter', '--with-decryption', '--name', `/ma/staging/test-users/${name}`, '--query', 'Parameter.Value', '--output', 'text'));
  if (!String(rec.email).endsWith('@test.minimalistalliance.com')) throw new Error(`${name} is not a test-domain user`);
  return { email: rec.email, password: rec.password, totpSecret: rec.totpSecret };
}

/** Run a shell command on the test desk over SSM. Only this one instance is ever addressed. */
export async function onDesk(command: string, timeoutS = 90): Promise<string> {
  const id = aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text').trim();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await sleep(1500);
    let inv: { Status: string; StandardOutputContent: string; StandardErrorContent: string };
    try { inv = JSON.parse(aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--output', 'json')); } catch { continue; }
    if (inv.Status === 'Success') return inv.StandardOutputContent;
    if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}: ${inv.StandardErrorContent.slice(0, 300)}`);
  }
  throw new Error('ssm command timed out');
}

/**
 * A template builder's slot (ADR 0077 1.3 item 9, browser-session.spec.ts's SESSION_SLOT): a shell command, as root, on the
 * builder that image/host/template-build.sh launched, over its SSH for that run (SESSION_SLOT_SSH=admin@<address>,
 * SESSION_SLOT_KEY=<key file>). Before the first command it asks EC2 which instance has that address and refuses unless it is
 * a running builder (Purpose=desk-image-build, Name ma-template-builder-*): never a desk, a member host or the test desk.
 */
let builderChecked = '';
export async function onBuilder(command: string, timeoutS = 90): Promise<string> {
  const target = process.env.SESSION_SLOT_SSH ?? '', key = process.env.SESSION_SLOT_KEY ?? '';
  const m = /^admin@(\d{1,3}(?:\.\d{1,3}){3})$/.exec(target);
  if (!m || !key) throw new Error('SESSION_SLOT needs SESSION_SLOT_SSH=admin@<builder address> and SESSION_SLOT_KEY');
  if (builderChecked !== target) {
    const tags = JSON.parse(aws('ec2', 'describe-instances', '--filters', `Name=ip-address,Values=${m[1]}`, 'Name=instance-state-name,Values=running',
      '--query', 'Reservations[].Instances[].Tags', '--output', 'json')) as { Key: string; Value: string }[][];
    const t = (k: string) => (tags.length === 1 ? tags[0].find((x) => x.Key === k)?.Value : undefined) ?? '';
    if (t('Purpose') !== 'desk-image-build' || !t('Name').startsWith('ma-template-builder-')) throw new Error(`${m[1]} isn't a running template builder`);
    builderChecked = target;
  }
  return execFileSync('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10',
    '-i', key, target, 'sudo bash -s'], { input: command, encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 64 << 20 });
}

export interface DeskTruth { deskId: string; deskdVersion: string; rtcVersion: string; publicIp: string; health: Record<string, unknown> }
/** What the desk itself says, gathered independently of the app and of Platform. */
export async function deskTruth(): Promise<DeskTruth> {
  const out = await onDesk(
    `echo "HEALTH=$(curl -s --unix-socket /run/desk/deskd-admin.sock http://desk/health)"; ` +
    `echo "RTC=$(journalctl -u desk-rtc --no-pager | grep 'desk-rtc listening' | tail -1)"; ` +
    `echo "BOOT=$(journalctl -u deskd --no-pager | grep 'BootSequence desk ' | tail -1)"`);
  const line = (k: string) => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? '';
  const health = JSON.parse(line('HEALTH'));
  const rtcVersion = /version=(\S+)/.exec(line('RTC'))?.[1] ?? '';
  const deskId = /desk (d-[a-z0-9]+)/.exec(line('BOOT'))?.[1] ?? '';
  const publicIp = aws('ec2', 'describe-instances', '--instance-ids', INSTANCE, '--query', 'Reservations[0].Instances[0].PublicIpAddress', '--output', 'text').trim();
  if (!health.version || !rtcVersion || !deskId) throw new Error(`could not read the desk's own values (health=${!!health.version} rtc=${!!rtcVersion} id=${!!deskId})`);
  return { deskId, deskdVersion: String(health.version), rtcVersion, publicIp, health };
}

let lastTotpWindow = 0;
const onOwnPages = (page: Page) => new URL(page.url()).pathname.startsWith('/_signin/');

/**
 * Sign-in by role and label, password then TOTP, on whichever the app sent us to: managed login (Cognito)
 * or our own pages at /_signin/ (Platform ADR 0084), where a code submits itself on the sixth digit.
 * Secrets only go through fill().
 */
async function managedLogin(page: Page, u: TestUser): Promise<void> {
  const step = (m: string) => console.log(`[e2e] login: ${m} (${new URL(page.url()).pathname})`);
  step('start');
  await page.waitForURL(/\/(login|oauth2\/authorize|_signin\/)/, { timeout: 30_000 });
  if (onOwnPages(page)) {
    const email = page.locator('#email');
    await email.waitFor({ timeout: 30_000 });
    if ((await email.inputValue()) !== u.email) await email.fill(u.email);
    step('email entered');
    await page.locator('#password').fill(u.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } else {
    const user = page.getByLabel(/email|username/i).first();
    await user.waitFor({ timeout: 30_000 });
    await user.fill(u.email);
    const pass = page.getByLabel(/^password$/i).first();
    if (!(await pass.isVisible().catch(() => false))) await page.getByRole('button', { name: /^(next|continue)$/i }).click();
    step('email entered');
    await pass.fill(u.password);
    await page.getByRole('button', { name: /^(sign in|log in|continue|next)$/i }).click();
  }
  const field = page.getByLabel(/code/i).first();
  await field.waitFor({ timeout: 30_000 });
  // Cognito refuses a TOTP code it has already seen, so never reuse a 30 s window (a rerun within 30 s of the last sign-in).
  // Other sessions sign in on staging too, so a code can already be spent: allow a third window.
  for (let attempt = 0; attempt < 3; attempt++) {
    let win = Math.floor(Date.now() / 30_000);
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (win <= lastTotpWindow || left < 4) { await page.waitForTimeout((left + 1) * 1000); win = Math.floor(Date.now() / 30_000); }
    lastTotpWindow = win;
    await field.fill(await generate({ secret: u.totpSecret }));
    if (!onOwnPages(page)) await page.getByRole('button', { name: /^(sign in|verify|confirm|next|continue|submit)$/i }).click();
    const left2 = await page.waitForURL((url) => !url.pathname.includes('/mfa') && !url.pathname.startsWith('/_signin/'), { timeout: 12_000 }).then(() => true, () => false);
    if (left2) return;
    step('totp not accepted, retrying in the next window');
  }
  throw new Error('sign-in: the TOTP code was refused three times');
}

/** Page hooks: RTCPeerConnection registry, session.open send time, first rpc message time. */
export const INIT_SCRIPT = () => {
  const w = window as unknown as Record<string, unknown>;
  const marks: Record<string, number[]> = { sessionOpen: [], rpcMsg: [], pcCreated: [] };
  const pcs: RTCPeerConnection[] = [];
  w.__e2e = { marks, pcs };
  const NativePC = window.RTCPeerConnection;
  const Wrapped = function (this: unknown, ...a: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new NativePC(...a);
    pcs.push(pc);
    marks.pcCreated.push(performance.now());
    const orig = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
      const dc = orig(label, init);
      if (label === 'rpc') dc.addEventListener('message', (ev: MessageEvent) => {
        marks.rpcMsg.push(performance.now());
        // The app's own `desk.status.get` reply (frame kind 8, one frame), kept for openAbout: see there.
        void (async () => {
          try {
            const d = ev.data as unknown;
            const buf: ArrayBuffer | null = d instanceof ArrayBuffer ? d : d instanceof Blob ? await d.arrayBuffer() : null;
            if (!buf || buf.byteLength < 14) return;
            const b = new Uint8Array(buf);
            if (b[1] !== 8) return;
            const txt = new TextDecoder().decode(b.subarray(12));
            if (!txt.includes('"deskdVersion"')) return;
            const find = (o: unknown): Record<string, unknown> | null => {
              if (!o || typeof o !== 'object') return null;
              if ('deskdVersion' in (o as object)) return o as Record<string, unknown>;
              for (const v of Object.values(o as object)) { const r = find(v); if (r) return r; }
              return null;
            };
            const st = find(JSON.parse(txt));
            if (st) (w.__e2e as { status?: unknown }).status = { at: performance.now(), pc: marks.pcCreated.length, s: st };
          } catch { /* not a status reply */ }
        })();
      });
      return dc;
    };
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = NativePC.prototype;
  Object.assign(Wrapped, NativePC);
  window.RTCPeerConnection = Wrapped;
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof d === 'string' && d.includes('"session.open"')) marks.sessionOpen.push(performance.now());
    return nativeSend.call(this, d);
  };
};

/**
 * The one console error the gate allows: the browser's own "Failed to load resource ... status of 429" for
 * `POST <api>/v1/desks/<id>/rtt`. The contract (desks.md, connect-time round trip) answers a member's 25th report of a UTC
 * day with `429 rate_limited`, which is normal, and each test starts with fresh storage so it can't remember the refusal.
 * Matches only that text with a 429 and a resource URL whose path is exactly `/v1/desks/<one segment>/rtt`; nothing else.
 */
export function isRttCapLog(text: string, url: string): boolean {
  if (!/^Failed to load resource: the server responded with a status of 429\b/.test(text)) return false;
  try {
    return /^\/v1\/desks\/[^/]+\/rtt$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface Watch { errors: string[]; desks: { deskId: string; name: string; state?: string }[]; connectStatuses: number[] }
/** Console + CSP errors, the desk list the API returned, and connect response statuses. Bodies and URLs with queries are never kept. */
export function watch(page: Page): Watch {
  const w: Watch = { errors: [], desks: [], connectStatuses: [] };
  page.on('console', (m) => { if (m.type() === 'error' && !isRttCapLog(m.text(), m.location().url)) w.errors.push(m.text().replace(/[?#]\S*/g, '')); });
  page.on('pageerror', (e) => w.errors.push(String(e).slice(0, 300)));
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (u.origin === API && u.pathname === '/v1/desks' && r.request().method() === 'GET') {
      try { const j = await r.json(); if (Array.isArray(j.desks)) w.desks = j.desks.map((d: { deskId: string; name: string; state?: string }) => ({ deskId: d.deskId, name: d.name, state: d.state })); } catch { /* not json */ }
    }
    if (u.origin === API && /\/connect$/.test(u.pathname)) w.connectStatuses.push(r.status());
  });
  return w;
}

export async function signInApp(context: BrowserContext, page: Page, u: TestUser): Promise<void> {
  await context.addInitScript(INIT_SCRIPT);
  await page.goto(APP);
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  await signIn.waitFor({ timeout: 30_000 });
  await signIn.click();
  await managedLogin(page, u);
  await page.waitForURL((url) => url.origin === APP, { timeout: 45_000 });
}

/** Wait for the desk list, pick the desk by ID (never by position), focus it. Returns its name. */
export async function focusTestDesk(page: Page, w: Watch): Promise<string> {
  await expect.poll(() => w.desks.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const d = w.desks.find((x) => x.deskId === DESK_ID);
  if (!d) throw new Error(`desk ${DESK_ID} is not in desk-1's list (${w.desks.length} desks)`);
  await page.locator('.ma-shell').waitFor({ timeout: 30_000 });
  return d.name;
}

/**
 * The desk's versions as the Desk app gets them. "About this desk" is the owner's only (menu in `AccountMenu.tsx`, Nov 9)
 * and the test account is not the owner, so the page shows none of it. The app reads it from `desk.status.get` over the
 * rpc data channel (`liveStore.ts` `refreshStatus`, every 15 s while the page is visible); INIT_SCRIPT keeps the last
 * reply and this waits for one no older than `maxAgeMs`, then returns it in the words the panel used, for `aboutValues`.
 * `afterPc`: only a reply that came on a peer connection created after that many were (a reconnect).
 */
export async function openAbout(page: Page, opts: { afterPc?: number; maxAgeMs?: number; timeoutMs?: number } = {}): Promise<string> {
  const { afterPc = 0, maxAgeMs = 20_000, timeoutMs = 60_000 } = opts;
  const handle = await page.waitForFunction(({ afterPc, maxAgeMs }) => {
    const st = (window as unknown as { __e2e?: { status?: { at: number; pc: number; s: Record<string, unknown> } } }).__e2e?.status;
    return st && st.pc > afterPc && performance.now() - st.at < maxAgeMs ? st.s : null;
  }, { afterPc, maxAgeMs }, { timeout: timeoutMs });
  const s = (await handle.jsonValue()) as Record<string, unknown>;
  const f = (v: unknown, d = 'not reported yet') => (v === null || v === undefined ? d : String(v));
  return `Service deskd ${f(s.deskdVersion)} Streaming desk-rtc ${f(s.rtcVersion)} Uptime ${f(s.uptimeSec)}s Instance ${f(s.instanceType)} Java ${f(s.javaVersion)} Desk ${f(s.deskId)} Boot ${f(s.bootId)}`;
}

export function aboutValues(text: string): Record<string, string> {
  const t = text.replace(/\s+/g, ' ');
  const pick = (k: string, re: string) => new RegExp(`${k} ${re}`).exec(t)?.[1] ?? '';
  return { deskdVersion: pick('Service deskd', '(\\S+)'), rtcVersion: pick('Streaming desk-rtc', '(\\S+)'), deskId: pick('Desk', '(d-[a-z0-9]+)'), connection: /Connection (.*)$/.exec(t)?.[1] ?? '' };
}

export const percentile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

// ---- API sign-in as a second account (PKCE, as the app does; the token stays in memory) ----
export async function apiToken(context: BrowserContext, u: TestUser): Promise<string> {
  const cfg = await (await fetch(`${API}/v1/client-config?app=desk-web`)).json();
  const redirectUri = `${APP}/auth/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const page = await context.newPage();
  let code: string | null = null;
  await page.route(`${APP}/auth/callback**`, (route) => { code = new URL(route.request().url()).searchParams.get('code'); return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); });
  const q = new URLSearchParams({ client_id: cfg.auth.clientId, response_type: 'code', redirect_uri: redirectUri, scope: cfg.auth.scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e' });
  await page.goto(`${cfg.auth.domain}/oauth2/authorize?${q}`);
  await managedLogin(page, u);
  await page.waitForURL(/\/auth\/callback/, { timeout: 30_000 }).catch(() => {});
  await page.close();
  if (!code) throw new Error('sign-in returned no code');
  const tr = await fetch(`${cfg.auth.domain}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.auth.clientId, code, redirect_uri: redirectUri, code_verifier: verifier }) });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error(`token exchange failed (${tr.status})`);
  return tj.access_token as string;
}
