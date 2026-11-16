// Draft ADR §17's client-side numbers for the Agent's tools on the real test desk, as desk-1, at each round-trip profile of
// ADR 0028's perf-desk (30, 70 and 90 ms, and lossy), p50, p95 and n for each, against the budgets in agent-tools/pure.mjs
// (MEASURES). "Ours" is what's measured less the emulated round trip, so a profile's added delay isn't counted against us.
//
// The round trip is emulated in the page, without root (agent-tools/rtt-shim.mjs): the base round trip is measured first with a
// no-op method (`harness.noop`, which deskd answers `not_found` at once) and the shim adds half the difference each way on the
// `rpc`, `events` and `collab` channels. "lossy" is 70 ms where 2% of messages are held 200 to 400 ms more with every later one
// on that channel behind them: the effect of a lost packet on an ordered, reliable SCTP channel, as the page sees it. It isn't
// packet loss. `tc netem` on a box with root, on the path to the desk, is the real thing; trust its numbers over these.
//
// Key-less (no MA_AGENT_TEST_KEY_PARAM): the pending list's round trip (`agent.approvals.list`, which no window calls yet, so it's
// asked directly, timing only: its answer never leaves the page) and the setup screen opening (Settings' "What it can use", the
// same form, on a test agent made with no key). With the key, also: a card shown after the model's step asks, decision to tool
// start, Files list, a write, a Notebook read, and an append showing in the open page, each from a real model's run on a test
// agent, which costs the capped key a few cents a profile. The agent and the key are removed at the end. Never wakes the desk.
//
//   flock -w 1800 ~/work/.test-desk.lock timeout 60m nice -n 15 env MA_TEST_DESK_LOCK=held \
//     MA_AGENT_TEST_KEY_PARAM=/ma/staging/<the key's parameter> node tests/real-desk/rt-agent-perf.mjs --profiles 30,70,90,lossy
//   node tests/real-desk/rt-agent-perf.mjs --profiles 30,70,90,lossy --dry    # the plan: no browser, no AWS
//
// --runs N (10) samples per measure and profile; --budget-min N (45: no profile starts after it, so the cleanup runs);
// --junit <file>. Writes test-results/real-desk/rt-agent-perf/report.json and exits 1 on a budget miss.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { probeLock } from './agent-tools/lock.mjs';
import { argsOf, judge, makeCanary, MEASURES, oneWayDelay, ours, parseProfiles, preconditions, standInScripts, stats, withCanary } from './agent-tools/pure.mjs';

/** The test desk's lock file, whose holder the run must be (lock.mjs probes it). */
const TEST_DESK_LOCK = resolvePath(homedir(), 'work/.test-desk.lock');

const args = argsOf(process.argv.slice(2));
const env = process.env;
let profiles;
try {
  profiles = parseProfiles(args.profiles ?? '30,70,90,lossy');
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const RUNS = Math.max(1, Math.min(100, Number(args.runs ?? 10) || 10));
/** No profile starts after this many minutes, so the cleanup (the agent, the key) runs inside the lock's `timeout`. */
const BUDGET_MIN = Math.max(5, Math.min(120, Number(args['budget-min'] ?? 45) || 45));
const BASE_SAMPLES = 15;
const LABELS = ['rpc', 'events', 'collab'];
const MODEL = args.model ?? 'real';
if (MODEL !== 'real' && MODEL !== 'standin') {
  console.error('--model is real (the capped key, if named) or standin (a scripted stand-in on the test desk)');
  process.exit(2);
}

// Every model run of the perf run, made before it starts, so a stand-in can have its scripts from the first.
const stamp = Date.now().toString(36);
const perfPage = `Perf ${stamp}`;
const rounds = profiles.flatMap((prof) =>
  Array.from({ length: RUNS }, (_, i) => {
    const nonce = `${prof.name.replace(/\W/g, '')}x${i}x${randomBytes(3).toString('hex')}`;
    const path = `Harness/perf-${nonce}.md`;
    const marker = `Mark ${nonce}`;
    return {
      profile: prof.name,
      i,
      nonce,
      path,
      marker,
      write: `Use your Files tools to save a new file at exactly ${path} with exactly this text and nothing else: perf ${nonce}`,
      append: `Add one line at the end of the page "${perfPage}" in the Harness tab with exactly this text: ${marker}`,
    };
  }),
);
/** What a capable model does for each: one save; or the Harness tab, the page in it, and the append (as cases/notebook.mjs). */
const perfScripts = (canary) =>
  standInScripts(
    rounds.flatMap((r) => [
      { prompt: r.write, steps: [{ calls: [{ name: 'files_write', input: { path: r.path, text: `perf ${r.nonce}` } }] }, { text: `Saved ${r.path}.` }] },
      {
        prompt: r.append,
        steps: [
          { calls: [{ name: 'notebook_list', input: {} }] },
          { calls: [{ name: 'notebook_list', input: { tabId: { $re: { step: 0, call: 0, pattern: '"tabId":"([^"]+)","title":"Harness"' } } } }] },
          { calls: [{ name: 'notebook_write', input: { pageId: { $re: { step: 1, call: 0, pattern: `"pageId":"([^"]+)","title":"${perfPage}"` } }, op: 'append', markdown: r.marker } }] },
          { text: `Added the line to ${perfPage}.` },
        ],
      },
    ]),
    canary,
  );

if (args.dry) {
  // A dry run checks the variable; the lock file's own probe is the real run's (its state is printed).
  const pre = preconditions(env, { needKey: false });
  const withKey = MODEL === 'standin' || Boolean(pre.keyParam);
  console.log('rt-agent-perf --dry: no browser, no AWS, nothing on the desk');
  console.log(`profiles: ${profiles.map((p) => `${p.name} (round trip ${p.rttMs} ms${p.loss ? `, ${p.loss.p * 100}% held ${p.loss.minMs} to ${p.loss.maxMs} ms, head-of-line` : ''})`).join('; ')}`);
  console.log(`runs: ${RUNS} a measure and profile; base round trip from ${BASE_SAMPLES} harness.noop calls; shim on ${LABELS.join(', ')}; each way = (profile - base) / 2`);
  console.log(`lock file: ${probeLock(TEST_DESK_LOCK)}`);
  console.log(pre.ok ? 'a real run would start: the lock is held' : `a real run would refuse: ${pre.problems.join('; ')}`);
  if (MODEL === 'standin') console.log(`model: standin, a scripted stand-in on the test desk’s loopback and a made-up key: every measure runs; ${Object.keys(perfScripts(null).prompts).length} scripted prompts`);
  else console.log(withKey ? 'key: named, so every measure runs' : 'key: MA_AGENT_TEST_KEY_PARAM not set, so only the key-less measures (pendingList, setupOpen) would run');
  for (const [name, m] of Object.entries(MEASURES)) console.log(`  ${name.padEnd(14)} ${m.key ? 'key ' : '    '} budget ${String(m.budgetMs).padStart(3)} ms of ours (measured - ${m.rtt} x RTT): ${m.what}`);
  process.exit(0);
}

const pre = preconditions(env, { needKey: false, lock: probeLock(TEST_DESK_LOCK) });
if (!pre.ok) {
  const { lockCommand } = await import('./agent-tools/run-lib.mjs');
  for (const p of pre.problems) console.error(`REFUSED: ${p}`);
  console.error(`Run it as: ${lockCommand('rt-agent-perf.mjs', `--profiles ${args.profiles ?? '30,70,90,lossy'}${MODEL === 'standin' ? ' --model standin' : ''}`, 60, MODEL === 'real')}`);
  process.exit(2);
}

// ----- a real run from here
const lib = await import('./rt-lib.mjs');
const rl = await import('./agent-tools/run-lib.mjs');
const { bundleChoice, installRedaction, outDir, readKey, writeJunit } = rl;
const { createDeskDriver, harnessName } = await import('./agent-tools/driver-desk.mjs');
const { rttShim } = await import('./agent-tools/rtt-shim.mjs');
const OUT = outDir('rt-agent-perf');
const key = MODEL === 'standin' ? rl.madeUpKey(randomBytes(12).toString('hex')) : pre.keyParam ? readKey(pre.keyParam) : null;
const withKey = Boolean(key);
installRedaction(lib, key && MODEL === 'real' ? [key] : []);
lib.S.hardExitMs = MODEL === 'standin' ? 300_000 : 90_000;
const startedAt = Date.now();
setTimeout(() => void lib.shutdown(1, 'watchdog'), (BUDGET_MIN + 7) * 60 * 1000).unref();
const canary = makeCanary(randomBytes(8).toString('hex'));
const choice = bundleChoice(env);
const report = { bundle: choice.version, model: MODEL === 'standin' ? 'standin: a scripted stand-in on the test desk, so model steps take no model time' : withKey ? 'real' : 'none', when: new Date().toISOString(), withKey, runs: RUNS, labels: LABELS, baseRttMs: null, profiles: [], misses: [] };
const save = () => writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
if (!withKey) lib.log('NO KEY: only the key-less measures (pendingList, setupOpen) run; the rest need MA_AGENT_TEST_KEY_PARAM');
const life = MODEL === 'standin' ? rl.standinLife(lib, { key, scripts: () => perfScripts(canary) }) : null;

const driver = createDeskDriver({
  out: OUT,
  key: key ? () => key : null,
  provider: env.MA_AGENT_TEST_PROVIDER || 'Anthropic',
  model: env.MA_AGENT_TEST_MODEL || null,
  bundle: choice.bundle,
  initScripts: [[rttShim, { labels: LABELS }]],
  log: lib.log,
  beforeAgentWindow: life
    ? async () => {
        report.standinUp = await life.bringUp();
      }
    : undefined,
});
// rt-lib's shutdown (the end, a signal, the watchdog, a crash) awaits this after the browser closes.
lib.S.afterClose = async () => {
  if (life) report.standinDown = await life.down();
  save();
};
lib.S.beforeExit = () => {
  save();
  writeJunit(
    args.junit,
    'rt-agent-perf',
    report.profiles.flatMap((p) => Object.entries(p.measures).map(([m, v]) => ({ name: `${p.name}/${m}`, ok: v.ok, detail: `p50 ${v.oursP50} p95 ${v.oursP95} ms of ours, n ${v.n}, budget ${MEASURES[m].budgetMs}` }))),
  );
};

try {
  await driver.start();
} catch (e) {
  report.error = e.message;
  await lib.shutdown(1, 'start failed');
}
await driver.setCanaries([canary]);
const p = driver.page();
const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
report.bundleLoaded = loaded ? new URL(loaded).pathname : null;
lib.log(`bundle: ${choice.version}, loaded from ${report.bundleLoaded}`);
const win = driver.window();
const T = (method, params) => p.evaluate(([m, pr]) => window.__rtTools.call(m, pr, { mode: 'timing' }), [method, params]);
const snap = () => driver.snapshot();

// The world: one page to read and append to, and the folder to list.
await driver.reset({ files: { [`Harness/perf-${stamp}.md`]: withCanary('A file to list.', canary) }, notebook: [{ tab: 'Harness', title: perfPage, markdown: withCanary(`# ${perfPage}\nA page to read.`, canary) }] });
const perfPageId = (await driver.notebook()).find((x) => x.title === perfPage)?.pageId ?? null;
const agentId = await driver.newAgent(harnessName());

// ----- the base round trip, nothing in the way yet
const base = [];
for (let i = 0; i < BASE_SAMPLES; i += 1) {
  const r = await T('harness.noop', {});
  if (Number.isFinite(r.ms)) base.push(r.ms);
  await lib.wait(100);
}
report.baseRttMs = stats(base);
const baseMs = report.baseRttMs.p50 ?? 0;
lib.log(`base round trip: p50 ${baseMs} ms (n ${base.length})`);

const setProfile = (prof) => p.evaluate((x) => window.__rttShim.setProfile(x), { oneWayMs: oneWayDelay(prof.rttMs, baseMs), loss: prof.loss });

/** The clock offset (desk minus page) from the decisions' answers: the one with the shortest round trip, its midpoint. */
const deskOffset = (decides) => {
  const usable = decides.filter((d) => d.decidedAt && d.sentAt && d.gotAt).sort((a, b) => a.gotAt - a.sentAt - (b.gotAt - b.sentAt));
  const d = usable[0];
  return d ? { offset: d.decidedAt - (d.sentAt + d.gotAt) / 2, plusMinus: (d.gotAt - d.sentAt) / 2 } : null;
};

/**
 * The press goes to the control itself (`dispatchEvent`), so a Notebook window open beside the Agent's never sits in the way and
 * no hit test is timed. From the press to the form's Save in view: one `agent.access.get` and the render.
 */
async function settingsOpen() {
  const drawer = win.getByTestId('drawer');
  if (await drawer.isVisible().catch(() => false)) await win.getByRole('button', { name: 'Close panel' }).dispatchEvent('click');
  const t0 = Date.now();
  await win.getByTestId('tab-settings').dispatchEvent('click');
  await win.getByTestId('access-settings').getByTestId('access-save').waitFor({ state: 'visible', timeout: 10_000 });
  const ms = Date.now() - t0;
  await win.getByRole('button', { name: 'Close panel' }).dispatchEvent('click');
  await drawer.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  return ms;
}

/** One model run that writes a file: the card, the decision and the write, timed. */
async function writeRound(round) {
  const before = await snap();
  const after = await driver.replyCount(agentId);
  const { runId } = await driver.send(agentId, round.write);
  if ((await driver.waitTurn(agentId, { timeoutMs: 120_000, after })) !== 'card') return null;
  const [card] = await driver.cards(agentId, 'pending');
  if (!card) return null;
  await driver.decide(card, true);
  await driver.reply(agentId, { timeoutMs: 120_000, after, runId });
  const s = await snap();
  const a = s.approvals[card.id];
  const shown = s.cardsShown.slice(before.cardsShown.length).find((x) => x.at >= (s.sends.at(-1)?.sentAt ?? 0));
  const decide = s.decides.filter((d) => d.id === card.id).at(-1);
  const at = (state) => a?.states.find((x) => x.state === state)?.at ?? null;
  const started = [at('approved'), at('done'), at('failed'), decide?.gotAt].filter(Number.isFinite);
  return {
    createdAt: a?.createdAt ?? null,
    shownAt: shown?.at ?? null,
    decideToStart: decide && started.length ? Math.min(...started) - decide.sentAt : null,
    write: a?.result?.durationMs ?? (at('approved') && at('done') ? at('done') - at('approved') : null),
  };
}

/** One model run that appends to the open page: from the desk saying done to the line in the editor. */
async function appendRound(round) {
  const after = await driver.replyCount(agentId);
  const marker = round.marker;
  const { runId } = await driver.send(agentId, round.append);
  if ((await driver.waitTurn(agentId, { timeoutMs: 120_000, after })) !== 'card') return null;
  const [card] = await driver.cards(agentId, 'pending');
  if (!card) return null;
  const seen = p.evaluate(([m]) => window.__rtTools.waitText('[data-testid="note-editor"]', m, 20_000), [marker]);
  await driver.decide(card, true);
  const shownAt = await seen;
  await driver.reply(agentId, { timeoutMs: 120_000, after, runId });
  const a = (await snap()).approvals[card.id];
  const doneAt = a?.states.find((x) => x.state === 'done')?.at ?? null;
  return shownAt && doneAt ? Math.max(0, shownAt - doneAt) : null;
}

const pageOpen = withKey ? await driver.openNotebookPage(perfPage) : false;
if (withKey && !pageOpen) lib.log('NOTE the Perf page could not be opened in the Notebook window: appendShows is not measured');

for (const prof of profiles) {
  if (Date.now() - startedAt > BUDGET_MIN * 60_000) {
    lib.log(`PROFILE ${prof.name}: not run, past the ${BUDGET_MIN}-minute budget (--budget-min)`);
    report.profiles.push({ name: prof.name, rttMs: prof.rttMs, skipped: 'past the budget', measures: {} });
    continue;
  }
  const profStart = Date.now();
  const set = await setProfile(prof);
  await lib.wait(1000);
  const check = [];
  for (let i = 0; i < 5; i += 1) check.push((await T('harness.noop', {})).ms);
  const samples = Object.fromEntries(Object.keys(MEASURES).map((k) => [k, []]));
  lib.log(`PROFILE ${prof.name}: ${set.oneWayMs} ms each way${prof.loss ? ', lossy' : ''}; noop round trip now p50 ${stats(check).p50} ms`);
  for (let i = 0; i < RUNS; i += 1) {
    samples.pendingList.push((await T('agent.approvals.list', { state: 'pending' })).ms);
    samples.setupOpen.push(await settingsOpen());
    if (withKey) {
      samples.filesList.push((await T('files.list', { path: 'Harness' })).ms);
      if (perfPageId) samples.notebookRead.push((await T('notebook.page.content', { pageId: perfPageId })).ms);
    }
  }
  const raw = [];
  if (withKey) {
    for (const round of rounds.filter((r) => r.profile === prof.name)) {
      try {
        const w = await writeRound(round);
        if (w) raw.push(w);
        if (pageOpen) {
          const ms = await appendRound(round);
          if (ms !== null) samples.appendShows.push(ms);
        }
      } catch (e) {
        lib.log(`round ${round.i} under ${prof.name}: ${e.message.split('\n')[0]}`);
      }
    }
    const off = deskOffset((await snap()).decides.filter((d) => d.sentAt >= profStart));
    for (const w of raw) {
      if (off && w.createdAt && w.shownAt) samples.cardShown.push(Math.max(0, w.shownAt - (w.createdAt - off.offset)));
      if (Number.isFinite(w.decideToStart)) samples.decideToStart.push(w.decideToStart);
      if (Number.isFinite(w.write)) samples.write.push(w.write);
    }
    if (off) lib.log(`clock offset desk - page ${Math.round(off.offset)} ms, ±${Math.round(off.plusMinus)}`);
  }
  const measures = {};
  for (const [name, def] of Object.entries(MEASURES)) {
    if (def.key && !withKey) continue;
    const st = stats(samples[name].filter(Number.isFinite));
    const oursAll = samples[name].filter(Number.isFinite).map((ms) => ours(ms, name, prof.rttMs));
    const os = stats(oursAll);
    measures[name] = { ...st, oursP50: os.p50, oursP95: os.p95, budgetMs: def.budgetMs, rttCount: def.rtt, ok: st.n > 0 && os.p95 <= def.budgetMs };
    lib.log(`  ${name.padEnd(14)} n ${String(st.n).padStart(3)}  p50 ${st.p50} p95 ${st.p95} ms; ours p50 ${os.p50} p95 ${os.p95} of ${def.budgetMs}${measures[name].ok ? '' : '  MISS'}`);
  }
  report.profiles.push({ name: prof.name, rttMs: prof.rttMs, oneWayMs: set.oneWayMs, loss: prof.loss, noopAfter: stats(check), shim: await p.evaluate(() => window.__rttShim.counts()), measures });
  save();
}

await p.evaluate(() => window.__rttShim.setProfile({ oneWayMs: 0, loss: null }));
report.misses = judge(report.profiles, { withKey });
const cleanup = await driver.stop({ clean: true });
if (cleanup.length) report.cleanup = cleanup;
if (life) {
  report.standinDown = await life.down();
  if (!report.standinDown?.clean) report.misses.push({ profile: '-', measure: 'standin', why: `the stand-in isn't fully down: ${JSON.stringify(report.standinDown)}` });
}
for (const m of report.misses) lib.log(`MISS ${m.profile} ${m.measure}: ${m.why}`);
lib.log(report.misses.length ? `${report.misses.length} budget misses` : 'every measure within its budget');
if (!withKey) lib.log('NOT MEASURED: the key measures (no MA_AGENT_TEST_KEY_PARAM)');
await lib.shutdown(report.misses.length ? 1 : 0, 'done');
