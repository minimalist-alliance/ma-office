// Platform's question before the Desk CSP goes to prod: does anything an app window loads break it? Opens every
// app window on the real test desk as desk-1, and counts CSP violations and console problems. The desk must be
// running already: nothing here is allowed to wake it, and opening an app on a stopped desk would.
import { mkdirSync } from 'node:fs';
import { ALLOWED, events, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const SHOTS = new URL('../../test-results/real-desk/rt-shots-csp/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 5 * 60 * 1000);
watchdog.unref();

await openSession();
const p = S.page;
await p.locator(`#proxy-${ALLOWED}`).waitFor({ state: 'attached', timeout: 60_000 });
const desk = await getDesk();
log('desk', desk.state, desk.phase);
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}, and opening an app would wake it`);
  await shutdown(1, 'desk not running');
}

const csp = await p.evaluate(async () => {
  const r = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
  return r.headers.get('content-security-policy');
});
log('CSP has form-action, base-uri, object-src:', /form-action/.test(csp ?? ''), /base-uri/.test(csp ?? ''), /object-src/.test(csp ?? ''));

await p.evaluate(() => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber });
  });
});

const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.focus();
await p.keyboard.press('Enter');
await waitPanel(/online/, 60_000);
await wait(1500);
await shot(SHOTS, 'focused');

const results = [];
for (const [id, label] of [['chat', 'Chat'], ['notebook', 'Notebook'], ['browser', 'Browser'], ['agent', 'Agent']]) {
  const proxy = p.locator(`[id="proxy-${ALLOWED}:${id}"]`);
  await proxy.focus();
  await p.keyboard.press('Enter');
  let opened = true;
  try {
    await p.getByRole('dialog', { name: label }).first().waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    opened = false;
  }
  await wait(4000); // long enough for what the window loads, and a first reply from the desk
  await shot(SHOTS, `window-${id}`);
  results.push({ id, opened });
  log(`window ${label}: opened ${opened}`);
  await p.getByRole('button', { name: `Close ${label}` }).click({ timeout: 4000 }).catch(() => p.keyboard.press('Escape'));
  await wait(600);
}

const violations = await p.evaluate(() => window.__violations);
const consoleProblems = events.filter((e) => e.k === 'console').length;
log('RESULT', JSON.stringify({ windows: results, violations, consoleProblems }));
log(violations.length === 0 && consoleProblems === 0 && results.every((r) => r.opened) ? 'PASS' : 'CHECK');
await shutdown(violations.length === 0 ? 0 : 1, 'done');
