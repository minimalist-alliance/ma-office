#!/usr/bin/env node
// Courier's 7-day staging soak (the launch plan §7, CR-4.1): setup and teardown of its two staging test desks. STAGING and
// test accounts only. The soak itself is deskd's CourierStagingSoak (test sources), run unattended by
// services/deskd/e2e/courier-soak-watchdog.sh from cron; its daily line goes to ma-platform docs/sub-status/courier-soak.md.
//
//   MA_PLATFORM=<ma-platform checkout with web/platform's node_modules> node services/deskd/e2e/courier-soak.mjs setup <run dir>
//   MA_PLATFORM=... node services/deskd/e2e/courier-soak.mjs remove <run dir>
//
// setup: makes the staging test accounts courier-soak-a and courier-soak-b if they don't exist (ma-platform's
// e2e/test-users.mjs), gives each an active Officer membership as billing would write it (staging test data only, behind
// guard.mjs), signs each in (managed login), pairs one self-hosted test desk on each, names them `soak-<run>-a` and `-b`
// (names stay taken in staging for good, by design), and writes <run dir>/session.json (0600): the API, the two desks'
// addresses and their pairing keys, which CourierStagingSoak signs its 15-minute sessions with. It never prints a password,
// a TOTP secret, a credential or a key.
// remove: signs in again and removes both desks (their keys stop working at once).
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const PLATFORM = process.env.MA_PLATFORM;
if (!PLATFORM) throw new Error('set MA_PLATFORM to an ma-platform checkout with web/platform/node_modules');
const [cmd, runDir] = process.argv.slice(2);
if (!['setup', 'remove'].includes(cmd) || !runDir) throw new Error('usage: courier-soak.mjs setup|remove <run dir>');
const req = createRequire(resolve(PLATFORM, 'web/platform/package.json'));
const { assertTestUser, TEST_DOMAIN } = await import(resolve(PLATFORM, 'web/platform/e2e/guard.mjs'));
const { loadRecord, poolId } = await import(resolve(PLATFORM, 'web/platform/e2e/test-users.mjs'));
const { managedLoginPassword, enterTotp } = await import(resolve(PLATFORM, 'web/platform/e2e/helpers.ts'));

const ENV = 'staging';
const SUFFIX = 'staging.minimalistalliance.com';
const API = `https://api.${SUFFIX}`;
const APP_ORIGIN = `https://test.office.${SUFFIX}`;
const MAIL_DOMAIN = `mail.${SUFFIX}`;
const USERS = { a: 'courier-soak-a', b: 'courier-soak-b' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aws = (...args) => execFileSync('aws', [...args, '--region', 'us-east-1', '--output', 'json'], { encoding: 'utf8' });

async function ensureUser(name) {
  let rec;
  try {
    rec = await loadRecord(name);
  } catch {
    execFileSync('node', ['e2e/test-users.mjs', 'create', name], { cwd: resolve(PLATFORM, 'web/platform'), stdio: 'inherit' });
    rec = await loadRecord(name);
  }
  const sub = await assertTestUser({ env: ENV, poolId: await poolId(), email: rec.email });
  if (!rec.email.endsWith(`@${TEST_DOMAIN}`) || !sub) throw new Error(`${name} is not a usable test user`);
  // Staging test data only (guard.mjs above): an active Officer membership, as billing writes it, so the desk may send mail.
  aws('dynamodb', 'update-item', '--table-name', `ma-${ENV}-memberships`, '--key', JSON.stringify({ user_id: { S: sub } }),
    '--update-expression', 'SET #s = :s, #t = :t, #b = :b',
    '--expression-attribute-names', JSON.stringify({ '#s': 'status', '#t': 'tier', '#b': 'age_band' }),
    '--expression-attribute-values', JSON.stringify({ ':s': { S: 'active' }, ':t': { S: 'officer' }, ':b': { S: 'adult' } }),
    '--condition-expression', 'attribute_exists(user_id)');
  const pool = JSON.parse(aws('cognito-idp', 'list-user-pools', '--max-results', '60')).UserPools.find((x) => x.Name === `ma-${ENV}-users`).Id;
  aws('cognito-idp', 'admin-add-user-to-group', '--user-pool-id', pool, '--username', sub, '--group-name', 'officer');
  return rec;
}

async function login(name) {
  const r0 = await loadRecord(name);
  const sub = await assertTestUser({ env: ENV, poolId: await poolId(), email: r0.email });
  if (!r0.email.endsWith(`@${TEST_DOMAIN}`) || !sub) throw new Error(`${name} is not a usable test user`);
  const cfg = await (await fetch(`${API}/v1/client-config?app=desk-web`)).json();
  const redirectUri = `${APP_ORIGIN}/auth/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let code;
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    const { chromium } = req('playwright');
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.route(`${APP_ORIGIN}/auth/callback**`, (route) => { code = new URL(route.request().url()).searchParams.get('code'); return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); });
      const q = new URLSearchParams({ client_id: cfg.auth.clientId, response_type: 'code', redirect_uri: redirectUri, scope: cfg.auth.scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: 'soak' });
      await page.goto(`${cfg.auth.domain}/oauth2/authorize?${q}`);
      await managedLoginPassword(page, r0.email, r0.password);
      await enterTotp(page, r0.totpSecret);
      try { await page.waitForURL(/\/auth\/callback/, { timeout: 25_000 }); } catch { /* a reused TOTP window: retried */ }
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

/** One self-hosted test desk: its pairing key (kept for the soak's sessions), paired and claimed on the account. */
async function pairDesk(u, label) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const PUB = publicKey.export({ format: 'jwk' }).x;
  const msg = (purpose, at, nonce, extra = '') => Buffer.from(['ma-selfhost/v1', purpose, ENV, PUB, at, nonce, extra].join('\n'), 'utf8');
  const s = { at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), nonce: randomBytes(16).toString('base64url') };
  const body = { v: 1, publicKey: PUB, ...s, sig: sign(null, msg('pair', s.at, s.nonce), privateKey).toString('base64url') };
  const pair = await call('POST', '/v1/self-hosted/pair', { body });
  const claimed = await call('POST', '/v1/self-hosted/claim', { token: u.token, body: { code: pair.json?.code, name: label } });
  return {
    deskId: claimed.json?.deskId,
    publicKey: PUB,
    pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    statuses: [pair.status, claimed.status],
    ok: pair.status === 201 && claimed.status === 201 && !!claimed.json?.deskId,
  };
}

const file = join(runDir, 'session.json');
if (cmd === 'setup') {
  if (existsSync(file)) throw new Error(`${file} exists: the soak is set up already (remove it first, or resume)`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const run = randomBytes(2).toString('hex');
  const out = { api: API, env: ENV, domain: `courier.${SUFFIX}`, mailDomain: MAIL_DOMAIN, inbox: `courier-soak@${MAIL_DOMAIN}`, bucket: `ma-${ENV}-courier-door`, prefix: 'tests/', run };
  for (const [k, name] of Object.entries(USERS)) {
    await ensureUser(name);
    const u = await login(name);
    const d = await pairDesk(u, `Courier soak ${k.toUpperCase()}`);
    if (!d.ok) throw new Error(`pairing desk ${k} failed: ${d.statuses}`);
    const named = await call('PUT', `/v1/me/courier/desks/${d.deskId}/address`, { token: u.token, body: { name: `soak-${run}-${k}` } });
    if (named.status !== 201) throw new Error(`naming desk ${k} failed: ${named.status} ${named.json?.error?.code ?? ''}`);
    out[k] = { user: name, deskId: d.deskId, address: named.json.address.address, publicKey: d.publicKey, pkcs8: d.pkcs8 };
    console.log(`desk ${k}: ${d.deskId} ${named.json.address.address}`);
  }
  writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`wrote ${file}`);
} else {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['a', 'b']) {
    const u = await login(s[k].user);
    const rm = await call('POST', `/v1/self-hosted/desks/${s[k].deskId}/remove`, { token: u.token });
    console.log(`desk ${k} ${s[k].deskId}: remove ${rm.status}`);
  }
}
