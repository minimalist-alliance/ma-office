// The Agent window on the real test desk as desk-1, with this checkout's own bundle in place of staging's (`dist/release`, served
// by page.route at the app's own origin, so sign-in, CSP and the gateway are the real ones). Hold ~/work/.test-desk.lock for the run.
// Never wakes anything: the desk must be running. Changes nothing on the desk but its audit log, the refused key's `key.add` and `key.drop`,
// and, on a desk where nothing sets a time zone, the zone this browser sets once (America/Denver), as any member's first visit does.
// The whole desk's day it sets, it clears again, so the desk follows its account as before.
//
// It proves: the window opens on the real `agent.*` relay; providers and agents list; a deliberately fake key is refused with the
// right words and appears in no console output, page record or log on the desk (a fake key costs nothing); limits and activity load;
// no CSP violations and no console errors; and the restart line shows or not according to what the real desk returns
// (`agent.key.list`'s `available`, or `agent.limits.get`'s `timeZone`).
// Limits (ADR 0043): the zone set once from the browser and days counted from midnight there; only what's changed sent; a whole
// desk's day set on this desk, then cleared back to the account's with null.
// It can't prove a real model reply: there's no provider key for tests.
//
//   npm run build:release && flock ~/work/.test-desk.lock node tests/real-desk/rt-agent.mjs
//   MA_EXPECT_VERSION=2026.11.07-abc1234 flock ~/work/.test-desk.lock node tests/real-desk/rt-agent.mjs   # staging's own bundle, once it's promoted there
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { ALLOWED, getDesk, INSTANCE, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const run = promisify(execFile);
const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-agent/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
/** Set: staging's own bundle, which must be this version. Unset: this checkout's `dist/release` in its place. */
const EXPECTED = process.env.MA_EXPECT_VERSION ?? null;
const release = EXPECTED ? { version: EXPECTED, entry: null } : JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
// Unmistakably a test's, and never anyone's: Anthropic's prefix so it passes the form, and refused by the provider's free model list.
const TAIL = randomBytes(12).toString('hex');
const FAKE_KEY = `sk-ant-test-not-a-real-key-${TAIL}`;
/** The browser's zone for this run, so the desk's days run somewhere that isn't UTC. */
const ZONE = 'America/Denver';

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const until = async (fn, ms, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await wait(every);
  }
  return null;
};

async function deskRun(command, timeoutS = 60) {
  const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
  const aws = async (...a) => (await run('aws', a, { encoding: 'utf8', env, maxBuffer: 16 << 20 })).stdout;
  const id = (await aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await wait(800);
    let inv;
    try {
      inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--output', 'json'));
    } catch {
      continue;
    }
    if (inv.Status === 'Success') return inv.StandardOutputContent;
    if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}: ${inv.StandardErrorContent.slice(0, 300)}`);
  }
  throw new Error('ssm timed out');
}

/**
 * What the page says on `rpc`, names and shapes only: never a value, and never a param. Records CSP violations too. A key leaves
 * this page only in the one frame `agent.key.add` writes, which is read here for its method name and nothing else.
 */
function agentProbe() {
  const w = window;
  const seen = (w.__rtAgent = { sent: [], replies: {}, violations: [], limits: [] });
  // A limit's kind, never more: absent, null, or set.
  const kind = (o, k) => (!o || !(k in o) ? 'absent' : o[k] === null ? 'null' : 'set');
  const layer = (l) => (l ? { deskDay: l.deskDay?.maxMicroUsd ?? (l.deskDay ? 'none' : null), deskMonth: l.deskMonth?.maxMicroUsd ?? (l.deskMonth ? 'none' : null), timeZone: l.timeZone ?? null } : null);
  const asked = new Map();
  document.addEventListener('securitypolicyviolation', (e) => seen.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile }));
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(d) {
    try {
      if (this.label === 'rpc' && d?.byteLength > 12) {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
        const m = /"m":"(agent\.[a-z.]+)"/.exec(new TextDecoder().decode(bytes.subarray(12, 200)));
        const t = /"topic":"(agent\.[a-z]+)/.exec(new TextDecoder().decode(bytes.subarray(12, 200)));
        if (m) {
          seen.sent.push(m[1]);
          asked.set(id, m[1]);
          if (m[1] === 'agent.limits.set') {
            // Which fields went, and whether each was null: the layering's whole point (deskd API.md section 11).
            const p = JSON.parse(new TextDecoder().decode(bytes.subarray(12))).p ?? {};
            seen.limits.push({ sent: { policy: kind(p, 'policy'), fields: p.policy ? Object.keys(p.policy).sort() : [], deskDay: kind(p.policy, 'deskDay'), deskMonth: kind(p.policy, 'deskMonth'), timeZone: kind(p, 'timeZone'), zone: typeof p.timeZone === 'string' ? p.timeZone : null } });
          }
        } else if (t) seen.sent.push(`SUB ${t[1]}`);
      }
    } catch {
      /* never in the way */
    }
    return send.call(this, d);
  };
  const Native = w.RTCPeerConnection;
  w.RTCPeerConnection = class extends Native {
    createDataChannel(label, init) {
      const dc = super.createDataChannel(label, init);
      if (label !== 'rpc') return dc;
      dc.addEventListener('message', (e) => {
        try {
          const bytes = new Uint8Array(e.data);
          const m = asked.get(new DataView(e.data).getUint32(4));
          if (!m) return;
          const b = JSON.parse(new TextDecoder().decode(bytes.subarray(12)));
          const shape = {};
          if (b.code) Object.assign(shape, { code: b.code, reason: b.details?.reason ?? null, detail: b.details?.detail ?? null });
          if (Array.isArray(b.providers)) shape.providers = b.providers.map((p) => p.id);
          if (Array.isArray(b.agents)) shape.agents = b.agents.map((a) => ({ id: a.id, role: a.role, status: a.status, bound: !!a.binding }));
          if (Array.isArray(b.keys)) shape.keys = { count: b.keys.length, sayAvailable: b.keys.filter((k) => typeof k.available === 'boolean').length, lost: b.keys.filter((k) => k.available === false).length };
          if (b.policy) {
            Object.assign(shape, { limits: true, timeZone: 'timeZone' in b });
            Object.assign(shape, {
              zone: b.timeZone ?? null,
              pricesAsOf: b.pricesAsOf ?? null,
              deskDay: b.policy.deskDay ? (b.policy.deskDay.maxMicroUsd ?? 'none') : 'absent',
              deskMonth: b.policy.deskMonth?.maxMicroUsd ?? 'none',
              desk: layer(b.desk),
              account: layer(b.account),
              dayResetsAt: (b.usage ?? []).find((u) => u.scope === 'agent_day')?.resetsAt ?? null,
            });
            seen.limits.push({ [m]: shape });
          }
          if (Array.isArray(b.entries)) shape.audit = b.entries.slice(0, 5).map((a) => `${a.action}:${a.decision}`);
          seen.replies[m] = shape;
        } catch {
          /* a piece of a long frame, or something else */
        }
      });
      return dc;
    }
  };
}

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 10 * 60 * 1000);
watchdog.unref();

const consoleLines = [];
const startedAt = Date.now();
await openSession({
  contextOptions: { timezoneId: ZONE },
  onContext: async (ctx) => {
    await ctx.addInitScript(agentProbe);
    ctx.on('page', (page) => {
      page.on('console', (m) => consoleLines.push({ type: m.type(), text: m.text() }));
      page.on('pageerror', (e) => consoleLines.push({ type: 'pageerror', text: String(e) }));
    });
    if (EXPECTED) return;
    await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
    await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
      const file = `${DIST}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
    });
  },
});
const p = S.page;
const seen = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__rtAgent)));

const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
if (EXPECTED) {
  const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
  step('bundle', Boolean(loaded?.includes(`/v/${EXPECTED}/`)), loaded ?? 'none');
}
const desk = await getDesk();
log('desk', desk.state, desk.phase ?? '');
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}, and opening an app would wake it`);
  await shutdown(1, 'desk not running');
}
const onDesk = await deskRun(`for c in deskd desk-agent desk-rtc; do echo "$c=$(basename "$(readlink -f /opt/ma/$c/current 2>/dev/null)")"; done; echo "image=$(grep '^version=' /etc/ma-release | cut -d= -f2)"; systemctl is-active desk-agent 2>/dev/null; curl -s -m 3 --unix-socket /run/desk/deskd-admin.sock http://desk/health | python3 -I -c 'import json,sys; print("agent", json.load(sys.stdin).get("agent"))' 2>/dev/null`).catch((e) => `unread: ${e.message.slice(0, 100)}`);
log('on the desk:', onDesk.trim().replace(/\n/g, ' '));

await btn.focus();
await p.keyboard.press('Enter');
const connected = await waitPanel(/online/, 60_000);
step('0 the link is open', connected);
const proxy = p.locator(`[id="proxy-${ALLOWED}:agent"]`);
await proxy.focus();
await p.keyboard.press('Enter');
const win = p.getByRole('dialog', { name: 'Agent' }).first();
await win.waitFor({ state: 'visible', timeout: 10_000 });

// ----- the first screen, whatever this desk has
const reached = await until(async () => {
  for (const id of ['key-setup', 'agent-state', 'thread']) if (await win.getByTestId(id).count()) return id;
  return null;
}, 45_000);
await shot(OUT, '1-opened');
const stateWord = reached === 'agent-state' ? await win.getByTestId('agent-state').getAttribute('data-state') : null;
step('1 the window opens on the real relay', reached === 'key-setup' || reached === 'thread', `${reached}${stateWord ? ` (${stateWord})` : ''}`);
const first = await seen();
log('sent', JSON.stringify([...new Set(first.sent)]));
log('replies', JSON.stringify(first.replies));
step('2 providers list', (first.replies['agent.providers']?.providers?.length ?? 0) > 0, JSON.stringify(first.replies['agent.providers'] ?? null));
step('3 agents list', (first.replies['agent.list']?.agents?.length ?? 0) > 0, JSON.stringify(first.replies['agent.list'] ?? null));
step('4 the topics are asked for', first.sent.includes('SUB agent.state') && first.sent.includes('SUB agent.conversation'), first.sent.filter((s) => s.startsWith('SUB')).join(', '));

// ----- the restart line, by what the desk says: keys last where a key carries `available` or the limits have `timeZone`
// (`keysLast` in web/agent's model/agents.ts, the stopgap until the Desk Engineer offers an explicit field)
await until(async () => (await seen()).replies['agent.limits.get'] ?? null, 15_000); // the line waits for both reads
await wait(300);
const keysWord = first.replies['agent.key.list']?.keys ?? null;
const limitsSay = () => seen().then((x) => x.replies['agent.limits.get']?.timeZone === true);
log('agent.key.list', JSON.stringify(keysWord), 'limits have timeZone:', await limitsSay());
const lineExpected = !(keysWord?.sayAvailable > 0) && !(await limitsSay());
if (reached === 'key-setup') {
  const lines = await win.getByTestId('key-restart-line').count();
  step('5 the restart line, on the key screen', lines === (lineExpected ? 1 : 0), `${lines} shown, expected ${lineExpected ? 1 : 0}, keys ${JSON.stringify(keysWord)}`);
  await shot(OUT, '2-key-screen');
} else {
  log('NOTE no key screen: this desk has a working key');
}

// ----- a fake key, refused
if (reached === 'key-setup') {
  const providerButton = win.getByRole('radio', { name: 'Anthropic' });
  if (await providerButton.count()) await providerButton.click();
  await win.getByTestId('key-input').fill(FAKE_KEY);
  await win.getByTestId('key-submit').click();
  const err = await until(async () => {
    const e = win.getByTestId('key-error');
    return (await e.count()) ? e.innerText() : null;
  }, 40_000);
  step('6 a fake key is refused with the right words', err === 'The provider refused this key. Check it in the provider’s console, then paste it again.', JSON.stringify(err));
  const r = (await seen()).replies['agent.key.add'];
  step('7 the desk said key_refused', r?.code === 'precondition_failed' && r?.reason === 'key_refused', JSON.stringify(r ?? null));
  step('8 the field is empty', (await win.getByTestId('key-input').inputValue()) === '');
  await shot(OUT, '3-key-refused');
}

// ----- limits and activity
await win.getByTestId('tab-usage').click();
const usage = await until(async () => ((await win.getByTestId('usage-rows').count()) ? win.getByTestId('usage-rows').innerText() : null), 15_000);
step('9 limits load', Boolean(usage) && (await seen()).replies['agent.limits.get']?.limits === true, (usage ?? '').replace(/\s+/g, ' ').slice(0, 120));
await shot(OUT, '4-usage');

// ----- limits (ADR 0043): the zone, set once from this browser; only what changed goes; a whole desk's day set, then cleared
const limitsSeen = async () => (await seen()).limits;
const firstView = (await limitsSeen()).find((x) => x['agent.limits.get'])?.['agent.limits.get'] ?? null;
const layered = Boolean(firstView?.desk && firstView?.account);
log('limits as found', JSON.stringify(firstView));
if (!layered) {
  step('9a a desk with layered limits', false, 'agent.limits.get has no desk or account: a desk-agent before ADR 0043');
} else {
  const zoneWasUnset = firstView.zone === null && firstView.desk.timeZone === null && firstView.account.timeZone === null;
  if (zoneWasUnset) await until(async () => (await limitsSeen()).some((x) => x['agent.limits.set']), 10_000);
  const zoneSets = (await limitsSeen()).filter((x) => x.sent && x.sent.policy === 'absent');
  if (zoneWasUnset) {
    const z = zoneSets[0]?.sent;
    step('9a the zone is set once from this browser, alone', zoneSets.length === 1 && z.timeZone === 'set' && z.zone === ZONE, JSON.stringify(zoneSets));
  } else {
    step('9a the desk already has a zone, so nothing is set', zoneSets.length === 0, `zone ${firstView.zone}, desk ${firstView.desk.timeZone}, account ${firstView.account.timeZone}`);
  }
  const now = (await limitsSeen()).filter((x) => x['agent.limits.get'] || x['agent.limits.set']).map((x) => x['agent.limits.get'] ?? x['agent.limits.set']).pop();
  const midnightThere = now?.dayResetsAt != null && new Intl.DateTimeFormat('en-US', { timeZone: now.zone ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now.dayResetsAt) === '00:00';
  step('9b today resets at midnight in the desk\'s zone', midnightThere && now.zone === (zoneWasUnset ? ZONE : now.zone), `zone ${now?.zone}, resetsAt ${now?.dayResetsAt ? new Date(now.dayResetsAt).toISOString() : null}`);
  const resetLine = await win.getByTestId('usage-reset').first().innerText().catch(() => null);
  step('9c the reset reads in words', resetLine === (now?.zone === ZONE ? 'Resets at midnight' : `Resets at midnight (${(now?.zone ?? 'UTC').replace(/_/g, ' ')})`), JSON.stringify(resetLine));
  const prices = await win.getByTestId('prices-as-of').innerText().catch(() => null);
  step('9d prices as of the table\'s date', now?.pricesAsOf ? /^Prices as of [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/.test(prices?.trim() ?? '') : prices === null, `${now?.pricesAsOf} -> ${JSON.stringify(prices)}`);

  // Set the whole desk's day on this desk: only it goes of the desk's values.
  const ownDayBefore = firstView.desk.deskDay;
  const panel = win.getByTestId('limits-panel');
  await panel.getByTestId('limits-edit').click();
  await win.getByTestId('limit-deskDay').fill('3.17');
  await shot(OUT, '4a-limits-form');
  await win.getByTestId('limits-save').click();
  await until(async () => (await win.getByTestId('limits-form').count()) === 0, 15_000);
  const afterSet = await limitsSeen();
  const setSent = afterSet.filter((x) => x.sent).pop()?.sent;
  const setView = afterSet.filter((x) => x['agent.limits.set']).pop()?.['agent.limits.set'];
  step('9e a day set: only deskDay of the desk\'s goes, as a limit', setSent?.deskDay === 'set' && setSent?.deskMonth === 'absent' && setSent?.timeZone === 'absent', JSON.stringify(setSent));
  step('9f the desk now sets its own day', setView?.desk?.deskDay === 3_170_000 && setView?.deskDay === 3_170_000, JSON.stringify(setView?.desk));
  const dayRow = await until(async () => {
    const r = panel.locator('[data-scope="desk_day"]');
    return (await r.count()) ? r.innerText() : null;
  }, 8000);
  step('9g the day shows in Usage', Boolean(dayRow?.includes('of $3.17')), JSON.stringify(dayRow));

  // Clear it again: back to the account's, with null, the month and zone untouched. A day the desk had before goes back as it was.
  await panel.getByTestId('limits-edit').click();
  if (ownDayBefore == null) await win.getByTestId('limit-deskDay-follow').click();
  else await win.getByTestId('limit-deskDay').fill(ownDayBefore === 'none' ? '' : String(ownDayBefore / 1_000_000));
  await shot(OUT, '4b-limits-follow');
  await win.getByTestId('limits-save').click();
  await until(async () => (await win.getByTestId('limits-form').count()) === 0, 15_000);
  const afterClear = await limitsSeen();
  const clearSent = afterClear.filter((x) => x.sent).pop()?.sent;
  const clearView = afterClear.filter((x) => x['agent.limits.set']).pop()?.['agent.limits.set'];
  if (ownDayBefore == null) {
    step('9h cleared with null, and nothing else of the desk\'s sent', clearSent?.deskDay === 'null' && clearSent?.deskMonth === 'absent' && clearSent?.timeZone === 'absent', JSON.stringify(clearSent));
    step('9i the desk follows its account again', clearView?.desk?.deskDay === null && clearView?.deskDay === (firstView.account.deskDay ?? 'none'), JSON.stringify({ desk: clearView?.desk, deskDay: clearView?.deskDay }));
  } else {
    step('9h the desk\'s own day is back as it was', clearView?.desk?.deskDay === ownDayBefore, JSON.stringify(clearView?.desk));
  }
  step('9j the month and zone are as they were', clearView?.desk?.deskMonth === firstView.desk.deskMonth && clearView?.zone === now?.zone, JSON.stringify({ before: firstView.desk, after: clearView?.desk, zone: clearView?.zone }));
  await shot(OUT, '4c-usage-after');
}
// At the window's default width the drawer covers the tabs, so it closes by its own button.
const closeDrawer = () => win.getByRole('button', { name: 'Close panel' }).click({ timeout: 5000 });
await closeDrawer();

await win.getByTestId('tab-keys').click();
await win.getByTestId('keys-panel').waitFor({ state: 'visible', timeout: 8000 });
const keysNow = (await seen()).replies['agent.key.list']?.keys ?? null;
const inKeys = await win.getByTestId('keys-panel').getByTestId('key-restart-line').count();
const lineNow = !(keysNow?.sayAvailable > 0) && !(await limitsSay());
step('10 the restart line, in Keys', inKeys === (lineNow ? 1 : 0), `${inKeys} shown, keys ${JSON.stringify(keysNow)}, limits have timeZone: ${await limitsSay()}`);
await shot(OUT, '5-keys');
await closeDrawer();

await win.getByTestId('tab-activity').click();
const activity = await until(async () => (await seen()).replies['agent.audit.list'] ?? null, 15_000);
step('11 activity loads', Boolean(activity?.audit), JSON.stringify(activity));
await wait(600);
await shot(OUT, '6-activity');

// ----- what it must not have done
const final = await seen();
step('12 no CSP violations', final.violations.length === 0, JSON.stringify(final.violations.slice(0, 5)));
const problems = consoleLines.filter((c) => c.type === 'error' || c.type === 'pageerror' || c.type === 'warning');
step('13 no console errors', problems.filter((c) => c.type !== 'warning').length === 0, JSON.stringify(problems.slice(0, 5).map((c) => c.text.slice(0, 160))));

// That the watch itself hears: a page this quiet could be one nobody's listening to.
await p.evaluate(() => console.info('rt-agent: the console watch is on'));
step('14 the console watch hears', Boolean(await until(async () => consoleLines.some((c) => c.text.includes('watch is on')), 3000)));
const allText = consoleLines.map((c) => c.text).join('\n');
const pageHas = await p.evaluate((tail) => {
  const stores = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie, location.href, document.documentElement.outerHTML, [...document.querySelectorAll('input, textarea')].map((e) => e.value).join(' ')];
  return stores.some((s) => s.includes(tail));
}, TAIL);
step('15 the key is in no console line', !allText.includes(TAIL), `${consoleLines.length} lines`);
step('16 the key is in no storage, cookie, URL or field', !pageHas);
// The desk's journal, for this run's minutes: a count, never a line.
const grep = await deskRun(`journalctl --since "-${Math.ceil((Date.now() - startedAt) / 60000) + 2} min" --no-pager 2>/dev/null | grep -c -- "${TAIL}" || true`).catch((e) => `unread: ${e.message.slice(0, 100)}`);
step('17 the key is in no log on the desk', grep.trim() === '0', `journal matches: ${grep.trim()}`);

await p.getByRole('button', { name: 'Close Agent' }).click({ timeout: 4000 }).catch(() => p.keyboard.press('Escape'));

const failed = results.filter((r) => !r.ok);
writeFileSync(`${OUT}result.json`, `${JSON.stringify({ bundle: release.version, onDesk: onDesk.trim(), results, final: { sent: [...new Set(final.sent)], replies: final.replies, limits: final.limits } }, null, 2)}\n`);
log(`${results.length - failed.length} of ${results.length} passed`);
log('NOT PROVEN: a real model reply. There is no provider key for tests.');
await shutdown(failed.length ? 1 : 0, 'done');
