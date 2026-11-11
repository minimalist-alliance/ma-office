// deskd's /run/desk/idle.json on the staging test desk (docs/interfaces/desk-runtime.md section 6.1), read over SSM, with no
// session and then with one open. desk-batch's own idle_now() judges each file (read-only: the module is loaded, nothing is
// ticked, no batch is offered). Run after the gate:  npx playwright test -c release-1110 idle.spec.ts
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { APP, apiToken, loadUser, onDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

const note = (k: string, v: unknown) => console.log(`[idle] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const READ = `stat -c "owner=%U mode=%a" /run/desk/idle.json; date -u +now=%FT%TZ; cat /run/desk/idle.json; echo; python3 -I -c '
import importlib.machinery as m, importlib.util as u
l=m.SourceFileLoader("db","/usr/local/lib/ma/desk-batch"); s=u.spec_from_loader("db",l); mod=u.module_from_spec(s); l.exec_module(mod)
print("desk-batch idle_now:", mod.idle_now())'`;

test('idle.json: owner, mode, content with no session and with one open', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  note('no session (before)', (await onDesk(READ)).trim().replace(/\n/g, ' | '));
  const context = await browser.newContext();
  const bearer = await apiToken(context, loadUser('desk-1'));
  const page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  const client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 8 && !opened.ok; i++) { opened = await client.open(false); if (!opened.ok) await sleep(5000); }
  expect(opened.ok).toBe(true);
  await sleep(20_000);
  const open1 = (await onDesk(READ)).trim();
  note('one session open (+20 s)', open1.replace(/\n/g, ' | '));
  expect(open1).toContain('"sessions":1');
  await sleep(40_000);
  note('one session open (+60 s)', (await onDesk(READ)).trim().replace(/\n/g, ' | '));
  await client.finish().catch(() => {});
  await context.close();
  await sleep(25_000);
  const after = (await onDesk(READ)).trim();
  note('closed (+25 s)', after.replace(/\n/g, ' | '));
  expect(after).toContain('"sessions":0');
});
