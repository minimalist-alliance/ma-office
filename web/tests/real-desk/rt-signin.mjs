// Sign-in on real staging, in a real browser, with an account that has no desk, so it can't start anything.
//   node tests/real-desk/rt-signin.mjs --expect-version 2026.11.06-abc1234 [--user direct-1] [--prod-version 2026.11.05-ca087a7]
// Secrets stay in memory and go through scrub(). No tracing, no storage state. It signs in at most twice, a fresh
// TOTP window apart, and each session it makes is ended by a real sign-out or revoked at the end.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { readTestUser, scrub, totp, wait } from './rt-lib.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const USER = arg('user', 'direct-1');
const EXPECT = arg('expect-version', null);
if (!['direct-1', 'e2e-signup'].includes(USER)) throw new Error('refusing: this check uses direct-1 or e2e-signup, which hold no desk');
if (!EXPECT) throw new Error('--expect-version is required');

const OFFICE = 'https://office.staging.minimalistalliance.com';
const PLATFORM = 'https://platform.staging.minimalistalliance.com';
const PROD_CONFIG = 'https://api.minimalistalliance.com/v1/client-config?app=desk-web';
const STAGING_CONFIG = 'https://api.staging.minimalistalliance.com/v1/client-config?app=desk-web';
const SHOTS = new URL('../../test-results/real-desk/signin/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const LAST_SIGNIN = new URL('../../test-results/real-desk/rt-last-signin.txt', import.meta.url).pathname; // a timestamp only, as rt-lib.mjs keeps it
// POST /v1/me/sign-out has no route on the API, so its 404 comes with no CORS headers, and the app's own
// try/catch carries on to revoke. Named here so it stays visible. Any other error still fails the run.
const KNOWN_GAPS = [/\/v1\/me\/sign-out/];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${scrub(detail)})` : ''}`);
};
const pathOf = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

const config = await (await fetch(STAGING_CONFIG, { headers: { Origin: OFFICE } })).json();
if (config.env !== 'staging') throw new Error('refusing: this is not staging');
check(`staging serves ${EXPECT}`, config.version === EXPECT, config.version);
const user = readTestUser(USER);

const browser = await chromium.launch();
/** Fresh browser state, watching for the sign-in card on every page, however briefly it shows. */
async function freshContext() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const card = { seen: false };
  await context.exposeBinding('__maCardSeen', () => {
    card.seen = true;
  });
  await context.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="sign-in"]')) window.__maCardSeen();
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(m.text());
  });
  return { context, page, card, problems };
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png` });

/** Never within 35 s of the last one, across runs too, since a code can't be used twice. A failure stops the run: no retrying a password. */
async function fillTheForm(page) {
  let last = 0;
  try {
    last = Number(readFileSync(LAST_SIGNIN, 'utf8'));
  } catch {
    /* first one */
  }
  const since = Date.now() - last;
  if (since < 35_000) await wait(35_000 - since);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const field = page.getByLabel('6-digit code');
  await field.waitFor({ timeout: 30_000 });
  // The start of a window nobody here has used, with room to spare before it ends.
  await wait((30 - (Date.now() / 1000) % 30 + 1) * 1000);
  await field.fill(totp(user.totpSecret)); // a full code submits by itself
  writeFileSync(LAST_SIGNIN, String(Date.now()));
  const outcome = await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith('/_signin/'), { timeout: 45_000 }).then(() => 'in'),
    page.locator('#code-err').waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'refused'),
  ]);
  // Wrong codes lock the account, so this never tries again by itself. Another process on this account can cause it.
  if (outcome === 'refused') throw new Error('the code was refused: stopping, with no retry');
}

// Where the app keeps it (tokenStore.ts): this tab's sessionStorage, then localStorage.
const storedRefresh = (page) => page.evaluate(() => sessionStorage.getItem('ma-desk-web-refresh') ?? localStorage.getItem('ma-desk-web-refresh'));
/** Whether real Cognito still takes this token. If it does, what that minted is revoked at once. */
async function stillGood(token) {
  const r = await fetch(`${config.auth.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.auth.clientId, refresh_token: token }),
  });
  const body = await r.json().catch(() => ({}));
  if (body.refresh_token) await revoke(body.refresh_token);
  return { good: r.ok, error: body.error ?? '' };
}
/** As web/platform/e2e/direct-auth.mjs does it. The token never leaves this process. */
const revoke = async (token) => (await fetch(`${config.auth.domain}/oauth2/revoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token, client_id: config.auth.clientId }),
})).status;

let open = null;
try {
  // 1. Signed out, /account goes to platform.'s /account, and that goes to its own sign-in.
  {
    const { context, page, card } = await freshContext();
    const went = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) went.push(f.url());
    });
    await page.goto(`${OFFICE}/account`);
    await page.waitForURL(/platform\.staging\.minimalistalliance\.com\/_signin\//, { timeout: 30_000 });
    const hosts = went.map((u) => new URL(u).hostname + new URL(u).pathname);
    check('1. signed out, /account goes to platform., and that to its own sign-in', went.some((u) => u === `${PLATFORM}/account`) && pathOf(page.url()).startsWith('/_signin/') && !card.seen && !hosts.some((h) => h.startsWith('office.') && h.endsWith('/_signin/')), hosts.join(' > '));
    await shot(page, '1-account-platform-signin');
    await context.close();
  }

  // 1b. And with the trailing slash.
  {
    const { context, page } = await freshContext();
    await page.goto(`${OFFICE}/account/`);
    await page.waitForURL(/platform\.staging\.minimalistalliance\.com\//, { timeout: 30_000 });
    check('1b. /account/ too', true, new URL(page.url()).hostname);
    await context.close();
  }

  // 2. Signed out, / goes to /_signin/ with no card.
  {
    const { context, page, card, problems } = await freshContext();
    await page.goto(`${OFFICE}/`);
    await page.waitForURL(/\/_signin\/\?return=%2F$/, { timeout: 30_000 });
    await page.locator('html[data-wired]').waitFor({ state: 'attached', timeout: 15_000 });
    check('2. signed out, / goes to the form, no card', !card.seen && pathOf(page.url()) === '/_signin/?return=%2F', pathOf(page.url()));
    await shot(page, '2-signed-out-form');
    check('2b. no console or page errors', problems.length === 0, problems.join(' | ').slice(0, 200));
    await context.close();
  }

  // 5. /auth/callback with a bad state, and bare, land on the form with the error.
  for (const [name, path] of [['bad state', '/auth/callback?code=not-a-code&state=wrong'], ['bare', '/auth/callback']]) {
    const { context, page, card } = await freshContext();
    await page.goto(`${OFFICE}${path}`);
    await page.waitForURL(/\/_signin\//, { timeout: 30_000 });
    const alert = page.getByRole('alert').first();
    await alert.waitFor({ timeout: 15_000 });
    const words = await alert.innerText();
    check(`5. /auth/callback, ${name}: the form with its error, no card`, words === "Google sign-in didn't finish. Try again." && !card.seen, words);
    await shot(page, `5-callback-${name.replace(' ', '-')}`);
    await context.close();
  }

  // 3, 4 and 6 share one browser and two sign-ins.
  const { context, page, card, problems } = await freshContext();
  open = page;
  await page.goto(`${OFFICE}/`);
  await page.waitForURL(/\/_signin\//, { timeout: 30_000 });
  await fillTheForm(page);
  await page.locator('.ma-shell').waitFor({ timeout: 45_000 });
  console.log('signed in, first time');

  // 3. The account menu's Account link works.
  const accountButton = page.getByRole('button', { name: 'Account', exact: true });
  await accountButton.click();
  const link = page.getByRole('link', { name: 'Account', exact: true });
  await link.waitFor({ timeout: 10_000 });
  const href = await link.getAttribute('href');
  await shot(page, '3-account-menu');
  const opened = context.waitForEvent('page');
  await link.click();
  const tab = await opened;
  await tab.waitForURL(/platform\.staging\.minimalistalliance\.com\//, { timeout: 30_000 });
  await tab.waitForLoadState();
  check('3. the menu\'s Account link opens platform., in its own tab, with this tab still in the office', href === `${PLATFORM}/account` && pathOf(page.url()) === '/', `${href} > ${new URL(tab.url()).hostname}${new URL(tab.url()).pathname}`);
  await tab.close();

  // 4. A real dead session: revoke this session's refresh token and load the page again.
  card.seen = false;
  const token = await storedRefresh(page);
  if (!token) throw new Error('no refresh token stored');
  const revoked = await revoke(token);
  check('4a. the refresh token is revoked', revoked === 200, String(revoked));
  await page.goto(`${OFFICE}/?back=1`);
  await page.waitForURL(/\/_signin\//, { timeout: 30_000 });
  await page.locator('html[data-wired]').waitFor({ state: 'attached', timeout: 15_000 });
  const line = await page.getByRole('alert').first().innerText();
  check('4b. a dead session lands on the form with the line, no card', line === 'Please sign in again.' && !card.seen, line);
  check('4c. it keeps the path, and the notice is out of the URL', pathOf(page.url()) === '/_signin/?return=%2F%3Fback%3D1', pathOf(page.url()));
  check('4d. the dead token is gone from the browser', (await storedRefresh(page)) === null);
  await shot(page, '4-dead-session-form');
  await fillTheForm(page);
  await page.waitForURL((u) => u.pathname === '/' , { timeout: 45_000 });
  await page.locator('.ma-shell').waitFor({ timeout: 45_000 });
  check('4e. signing in comes back to that path', pathOf(page.url()) === '/?back=1', pathOf(page.url()));
  await shot(page, '4-back-in-the-office');

  // 6. A real sign-out still shows the card.
  const lastToken = await storedRefresh(page);
  await accountButton.click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const signedOut = page.getByTestId('sign-in');
  await signedOut.waitFor({ timeout: 30_000 });
  const cardText = await signedOut.innerText();
  check('6. a real sign-out still shows its card', /You're signed out\./.test(cardText) && pathOf(page.url()) === '/', cardText.replace(/\s+/g, ' ').slice(0, 80));
  check('6b. and the token is gone from the browser', (await storedRefresh(page)) === null);
  const after = lastToken ? await stillGood(lastToken) : { good: true, error: 'no token to check' };
  check('6c. and real Cognito refuses it: the session is revoked', !after.good && after.error === 'invalid_grant', after.error);
  await shot(page, '6-signed-out-card');
  open = null;
  const known = problems.filter((p) => KNOWN_GAPS.some((gap) => gap.test(p)));
  for (const p of known) console.log(`NOTE  a known gap, not a pass: ${scrub(p).slice(0, 140)}`);
  const others = problems.filter((p) => !known.includes(p));
  check('no other console or page errors in the session', others.length === 0, others.join(' | ').slice(0, 400));
  await context.close();

  // 7. Prod is on what it was.
  const prod = await (await fetch(PROD_CONFIG)).json();
  check(`7. prod's client-config reports ${arg('prod-version', '2026.11.05-ca087a7')}`, prod.env === 'prod' && prod.version === arg('prod-version', '2026.11.05-ca087a7'), prod.version);
} catch (e) {
  check('the run finished', false, e.message.slice(0, 400));
  if (open) {
    try {
      await shot(open, 'failed');
      const left = await storedRefresh(open);
      if (left) console.log(`revoked what was left: ${await revoke(left)}`);
    } catch {
      /* the page is gone */
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
