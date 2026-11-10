// What a signed-out member gets where auth.signInPath is absent, as in prod, against real Cognito on staging, whose
// setting is on. It takes the field out of client-config in this browser only. No account and no sign-in, so it can't
// wake anything: the one refresh token it sends is made up, and real Cognito refuses it.
//   node tests/real-desk/rt-managed.mjs --expect-version 2026.11.06-abc1234
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const EXPECT = arg('expect-version');
if (!EXPECT) throw new Error('--expect-version is required');

const OFFICE = 'https://office.staging.minimalistalliance.com';
const CONFIG = 'https://api.staging.minimalistalliance.com/v1/client-config?app=desk-web';
const SHOTS = new URL('../../test-results/real-desk/managed/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const config = await (await fetch(CONFIG, { headers: { Origin: OFFICE } })).json();
if (config.env !== 'staging') throw new Error('refusing: this is not staging');
check(`staging serves ${EXPECT}`, config.version === EXPECT, config.version);
const AUTH = new URL(config.auth.domain).hostname;
const atManagedLogin = (u) => u.hostname === AUTH;

const browser = await chromium.launch();

/** Fresh browser state, with no signInPath in client-config, watching for the card on every page, however briefly it shows. */
async function freshContext() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**/v1/client-config**', async (route) => {
    const real = await route.fetch();
    const body = await real.json();
    delete body.auth.signInPath;
    delete body.auth.userPoolId;
    await route.fulfill({ response: real, json: body });
  });
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
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text()) && new URL(page.url()).origin === OFFICE) problems.push(m.text());
  });
  return { context, page, card, problems };
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png` });

/** A made-up token where the app keeps its own (tokenStore.ts). */
const plantToken = (page) => page.evaluate(() => localStorage.setItem('ma-desk-web-refresh', 'rt-managed-not-a-real-token'));
const storedToken = (page) => page.evaluate(() => sessionStorage.getItem('ma-desk-web-refresh') ?? localStorage.getItem('ma-desk-web-refresh'));

try {
  // 1. Signed out goes straight there, with no card.
  {
    const { context, page, card, problems } = await freshContext();
    let asked = null;
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!asked && u.hostname === AUTH && u.pathname === '/oauth2/authorize') asked = u;
    });
    await page.goto(`${OFFICE}/`);
    await page.waitForURL(atManagedLogin, { timeout: 30_000 });
    await page.waitForLoadState();
    const q = new URL(page.url()).searchParams;
    check('1. signed out, / goes straight to managed login, no card', !card.seen, new URL(page.url()).hostname + new URL(page.url()).pathname);
    // Cognito moves from /oauth2/authorize to /login and may fold the query into its own, so this looks at what the app sent.
    check('1b. by the PKCE start, back to this site', asked?.searchParams.get('code_challenge_method') === 'S256' && asked?.searchParams.get('redirect_uri') === `${OFFICE}/auth/callback` && !!asked?.searchParams.get('code_challenge'), q.size ? 'on its form' : 'no query');
    await shot(page, '1-managed-login');
    check('1c. no console or page errors', problems.length === 0, problems.join(' | ').slice(0, 200));
    await context.close();
  }

  // 2. A bare callback has no form to go to: the card, in its own words.
  {
    const { context, page } = await freshContext();
    await page.goto(`${OFFICE}/auth/callback`);
    const signIn = page.getByTestId('sign-in');
    await signIn.waitFor({ timeout: 30_000 });
    check('2. a bare /auth/callback keeps the card', /couldn't be verified/.test(await signIn.innerText()) && new URL(page.url()).pathname === '/', new URL(page.url()).pathname);
    await page.waitForTimeout(1500);
    check('2b. and stays', new URL(page.url()).origin === OFFICE);
    await shot(page, '2-callback-card');
    await context.close();
  }

  // 3. /signed-out is the card, and goes nowhere by itself.
  {
    const { context, page } = await freshContext();
    await page.goto(`${OFFICE}/signed-out`);
    const signIn = page.getByTestId('sign-in');
    await signIn.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    check('3. /signed-out keeps its card', /You're signed out\./.test(await signIn.innerText()) && new URL(page.url()).origin === OFFICE, (await signIn.innerText()).replace(/\s+/g, ' ').slice(0, 80));
    await shot(page, '3-signed-out-card');
    await context.close();
  }

  // 4. A token real Cognito refuses goes straight there, and a second one inside 30 s ends at the card.
  {
    const { context, page, card, problems } = await freshContext();
    await page.goto(`${OFFICE}/signed-out`);
    await page.getByTestId('sign-in').waitFor({ timeout: 30_000 });
    await plantToken(page);
    card.seen = false;
    await page.goto(`${OFFICE}/`);
    await page.waitForURL(atManagedLogin, { timeout: 30_000 });
    check('4. a refused token goes straight to managed login, no card', !card.seen, new URL(page.url()).hostname);

    await page.goto(`${OFFICE}/signed-out`);
    await page.getByTestId('sign-in').waitFor({ timeout: 30_000 });
    check('4b. the refused token left the browser', (await storedToken(page)) === null);
    await plantToken(page);
    await page.goto(`${OFFICE}/`);
    const signIn = page.getByTestId('sign-in');
    await signIn.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    check('4c. the guard: refused again within 30 s, it ends at the card and stays', /Please sign in again\./.test(await signIn.innerText()) && new URL(page.url()).origin === OFFICE, (await signIn.innerText()).replace(/\s+/g, ' ').slice(0, 80));
    await shot(page, '4-guard-card');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(atManagedLogin, { timeout: 30_000 });
    check('4d. its button is still a way in', true, new URL(page.url()).hostname);
    check('4e. no console or page errors', problems.length === 0, problems.join(' | ').slice(0, 200));
    await context.close();
  }
} catch (e) {
  check('the run finished', false, String(e.message).slice(0, 400));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
