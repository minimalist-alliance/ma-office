#!/usr/bin/env node
// The Courier relay transports' staging proof (the launch plan's Wave 2.5): deskd's own courier code, run on this machine,
// as two staging test desks against the REAL staging relay (ma-platform contract 0.4.0; staging only, its kill switch on
// there). STAGING and test accounts only.
//
//   MA_PLATFORM=<an ma-platform checkout with web/platform's node_modules> node services/deskd/e2e/courier-relay-proof.mjs
//   env: E2E_USER_A (default forums-adult-1), E2E_USER_B (default forums-adult-2): staging test accounts with an active
//        membership that may pair a self-hosted desk
//
// What it does: signs in as each test account (the managed login, as ma-platform's relay-proof does), pairs one
// self-hosted test desk on each, gives each a Courier name `e2e-<run>-t…` (names stay taken in staging for good, by design),
// writes the two desks' addresses and session credentials to a 0600 file in a fresh temporary directory, runs deskd's
// RelayStagingIT against them (it prints PASS and FAIL lines), then deletes the file and removes both desks. It never
// prints a password, a TOTP secret, a credential, a key or ciphertext.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '../..');
const PLATFORM = process.env.MA_PLATFORM;
if (!PLATFORM) throw new Error('set MA_PLATFORM to an ma-platform checkout with web/platform/node_modules');
const req = createRequire(resolve(PLATFORM, 'web/platform/package.json'));
const { assertTestUser, TEST_DOMAIN } = await import(resolve(PLATFORM, 'web/platform/e2e/guard.mjs'));
const { loadRecord, poolId } = await import(resolve(PLATFORM, 'web/platform/e2e/test-users.mjs'));
const { managedLoginPassword, enterTotp } = await import(resolve(PLATFORM, 'web/platform/e2e/helpers.ts'));

const ENV = 'staging';
const SUFFIX = 'staging.minimalistalliance.com';
const API = `https://api.${SUFFIX}`;
const APP_ORIGIN = `https://test.office.${SUFFIX}`;
const DOMAIN = `courier.${SUFFIX}`;
const RUN = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const rec = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

async function login(name) {
  const r0 = await loadRecord(name);
  const sub = await assertTestUser({ env: ENV, poolId: await poolId(), email: r0.email });
  if (!r0.email.endsWith(`@${TEST_DOMAIN}`) || !sub) throw new Error(`${name} is not a usable test user`);
  const cfg = await (await fetch(`${API}/v1/client-config?app=desk-web`)).json();
  const redirectUri = `${APP_ORIGIN}/auth/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let code;
  for (let attempt = 0; attempt < 2 && !code; attempt++) {
    const { chromium } = req('playwright');
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.route(`${APP_ORIGIN}/auth/callback**`, (route) => { code = new URL(route.request().url()).searchParams.get('code'); return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); });
      const q = new URLSearchParams({ client_id: cfg.auth.clientId, response_type: 'code', redirect_uri: redirectUri, scope: cfg.auth.scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e' });
      await page.goto(`${cfg.auth.domain}/oauth2/authorize?${q}`);
      await managedLoginPassword(page, r0.email, r0.password);
      await enterTotp(page, r0.totpSecret);
      try { await page.waitForURL(/\/auth\/callback/, { timeout: 25_000 }); } catch { /* a reused TOTP window: retried once */ }
    } finally { await browser.close(); }
    if (!code) await sleep(31_000);
  }
  if (!code) throw new Error('sign-in returned no code');
  const tr = await fetch(`${cfg.auth.domain}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.auth.clientId, code, redirect_uri: redirectUri, code_verifier: verifier }) });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error(`token exchange failed (${tr.status})`);
  return { sub, token: tj.access_token };
}

async function call(method, path, { token, body } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json };
}

// A self-hosted test desk: its pairing key, then its session (credentials deskd signs with), as relay-proof pairs one.
function selfHosted() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const PUB = publicKey.export({ format: 'jwk' }).x;
  const msg = (purpose, at, nonce, extra = '') => Buffer.from(['ma-selfhost/v1', purpose, ENV, PUB, at, nonce, extra].join('\n'), 'utf8');
  const stamp = () => ({ at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), nonce: randomBytes(16).toString('base64url') });
  const signed = (purpose, extra = '') => { const s = stamp(); return { v: 1, publicKey: PUB, ...s, sig: sign(null, msg(purpose, s.at, s.nonce, extra), privateKey).toString('base64url') }; };
  const FP = 'cd'.repeat(32);
  return {
    signed,
    sessionBody() {
      const sb = signed('session');
      return { ...sb, dtls: { fingerprintsSha256: [FP], sig: sign(null, msg('dtls', sb.at, sb.nonce, FP), privateKey).toString('base64url') } };
    },
  };
}

async function pairDesk(u, label) {
  const sh = selfHosted();
  const pair = await call('POST', '/v1/self-hosted/pair', { body: sh.signed('pair') });
  const claimed = await call('POST', '/v1/self-hosted/claim', { token: u.token, body: { code: pair.json?.code, name: label } });
  const deskId = claimed.json?.deskId;
  const session = await call('POST', '/v1/self-hosted/session', { body: sh.sessionBody() });
  return { deskId, creds: session.json?.credentials, ok: pair.status === 201 && claimed.status === 201 && session.status === 200 && !!session.json?.credentials, statuses: [pair.status, claimed.status, session.status] };
}

const USER_A = process.env.E2E_USER_A || 'forums-adult-1';
const USER_B = process.env.E2E_USER_B || 'forums-adult-2';
const a = await login(USER_A);
const b = await login(USER_B);
const desks = [];
const dir = mkdtempSync(join(tmpdir(), 'courier-proof-'));
const sessionFile = join(dir, 'session.json');
try {
  const A = await pairDesk(a, 'Courier transports proof A');
  const B = await pairDesk(b, 'Courier transports proof B');
  if (A.deskId) desks.push([a, A.deskId]);
  if (B.deskId) desks.push([b, B.deskId]);
  rec('setup: a self-hosted test desk on each staging test account, with a session', A.ok && B.ok, { a: A.statuses, b: B.statuses });
  if (!A.ok || !B.ok) throw new Error('setup failed');
  const nameA = `e2e-${RUN}-ta`;
  const nameB = `e2e-${RUN}-tb`;
  const ra = await call('PUT', `/v1/me/courier/desks/${A.deskId}/address`, { token: a.token, body: { name: nameA } });
  const rb = await call('PUT', `/v1/me/courier/desks/${B.deskId}/address`, { token: b.token, body: { name: nameB } });
  rec('setup: each desk has a Courier name', ra.status === 201 && rb.status === 201, { a: ra.status, b: rb.status });
  if (ra.status !== 201 || rb.status !== 201) throw new Error('names failed');
  writeFileSync(sessionFile, JSON.stringify({
    api: API,
    domain: DOMAIN,
    a: { address: ra.json.address.address, credentials: A.creds },
    b: { address: rb.json.address.address, credentials: B.creds },
  }), { mode: 0o600 });
  // deskd's own code: the module, keys, store, transport and signed client, as two desks.
  // With COURIER_PROOF_CP (deskd's test classpath, built elsewhere), a JRE runs it; otherwise Maven does.
  const cp = process.env.COURIER_PROOF_CP;
  const [cmd, args] = cp
    ? ['java', ['-cp', cp, 'com.minimalistalliance.desk.deskd.courier.relay.RelayStagingIT']]
    : ['flock', [join(process.env.HOME, 'work/.build.lock'), 'nice', '-n', '10', './mvnw', '-o', '-q', '-pl', 'deskd', '-am',
      '-Dtest=RelayStagingIT', '-Dsurefire.failIfNoSpecifiedTests=false', 'test']];
  const mvn = spawnSync(cmd, args, {
    cwd: SERVICES, env: { ...process.env, COURIER_STAGING_SESSION: sessionFile }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${mvn.stdout}\n${mvn.stderr}`;
  for (const line of out.split('\n')) {
    if (line.startsWith('PROOF ')) console.log(line.slice(6));
  }
  rec('deskd RelayStagingIT passed on the staging relay', mvn.status === 0, mvn.status === 0 ? '' : out.split('\n').filter((l) => /Tests run|FAIL|ERROR\]|Exception/.test(l)).slice(0, 20).join(' | '));
} finally {
  rmSync(dir, { recursive: true, force: true });
  for (const [u, deskId] of desks) {
    const rm = await call('POST', `/v1/self-hosted/desks/${deskId}/remove`, { token: u.token });
    rec('cleanup: self-hosted test desk removed', rm.status === 200, { status: rm.status });
  }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
