// The Agent's tools on the real test desk, as desk-1, with a real model (draft ADR "the Agent's tools and approvals" §17,
// "A real desk"): each registered tool's cases (agent-tools/cases/), through the Agent window's own UI and the methods the
// Files and Notebook apps already call. Its world is the Files folder `Harness` and the Notebook tab `Harness`; nothing else
// of desk-1's is read or changed.
//
// It needs the capped staging model key: MA_AGENT_TEST_KEY_PARAM names its SSM parameter, which is read with the AWS CLI and
// kept out of every log, screenshot and file. The key goes onto the desk under the name of the test agent it makes
// ("Harness MMDD-HHMMSS"), and the agent and the key are removed at the end, with Harness's contents moved to the trashes.
// It never wakes the desk: the desk must be running. Hold the test desk's lock for the run:
//
//   flock -w 1800 ~/work/.test-desk.lock timeout 45m nice -n 15 env MA_TEST_DESK_LOCK=held \
//     MA_AGENT_TEST_KEY_PARAM=/ma/staging/<the key's parameter> node tests/real-desk/rt-agent-tools.mjs --tool all
//   node tests/real-desk/rt-agent-tools.mjs --tool all --dry      # validates the cases and prints the plan: no browser, no AWS
//
// --model standin (the default is --model real) needs no key: each case's `standIn` steps, filled in for the run, go to a
// scripted stand-in for Anthropic's API (agent-tools/standin_desk.py) on the test desk's loopback, as the release agent's
// proof of Nov 13 did: over SSM, as root, only on the instance rt-lib names once EC2 says it's DeskKind=test; desk-agent.env
// gets its documented DESK_AGENT_ANTHROPIC_URL line (backed up first with its sha256) and desk-agent restarts; a made-up key
// goes in through the Keys tab. It refuses if the env already has the line, a backup is left, the port is busy or a stand-in
// runs. At the end, and on a signal, the watchdog or a crash, the env goes back byte for byte (sha256 checked), the stand-in
// is stopped and removed, and desk-agent restarts on its real providers; the run fails if any of that isn't so.
//
//   flock -w 60 ~/work/.test-desk.lock env MA_TEST_DESK_LOCK=held timeout 45m nice -n 15 \
//     node tests/real-desk/rt-agent-tools.mjs --tool all --model standin
//
// Options: --tool files|notebook|browser|all (or a comma list), --only <case id>, --junit <file>, --remove-leftovers (agents
// and keys a crashed run left, by their name alone), --budget-min N (30: no case starts after it, so the cleanup runs).
// MA_AGENT_FIXTURE_BASE (an https origin serving agent-tools/cases/browser.mjs's FIXTURES) runs the injection case;
// MA_AGENT_FORM_URL picks the form; MA_AGENT_TEST_PROVIDER (Anthropic) and
// MA_AGENT_TEST_MODEL pick the key's provider and model. With MA_EXPECT_VERSION, staging's own bundle, which must be that
// version; otherwise this checkout's dist/release when built, else staging's own. Results go to
// test-results/real-desk/rt-agent-tools/ (report.json and shots), which the next Playwright run wipes, so copy them out.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { probeLock } from './agent-tools/lock.mjs';
import { REGISTERED } from './agent-tools/cases/index.mjs';
import {
  argsOf,
  cardMatches,
  fill,
  HARNESS_TAB,
  makeCanary,
  pickTools,
  planLines,
  policyChecks,
  preconditions,
  runChecks,
  standInScripts,
  validateCases,
  withCanary,
} from './agent-tools/pure.mjs';

/** The test desk's lock file, whose holder the run must be (lock.mjs probes it). */
const TEST_DESK_LOCK = resolvePath(homedir(), 'work/.test-desk.lock');

const CASE_MS = 240_000;
const args = argsOf(process.argv.slice(2));
const env = process.env;
/** No case starts after this many minutes, so the cleanup always runs inside the lock's `timeout`; the watchdog is 6 past it. */
const BUDGET_MIN = Math.max(5, Math.min(120, Number(args['budget-min'] ?? 30) || 30));
const WATCHDOG_MS = (BUDGET_MIN + 6) * 60 * 1000;
const names = REGISTERED.map((r) => r.tool);

let tools;
try {
  tools = pickTools(args.tool, names);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const chosen = REGISTERED.filter((r) => tools.includes(r.tool)).map((r) => (args.only ? { ...r, cases: r.cases.filter((c) => c.id === args.only) } : r)).filter((r) => r.cases.length);
const needs = { fixture: Boolean(env.MA_AGENT_FIXTURE_BASE) };
const problems = validateCases(chosen);
const MODEL = args.model ?? 'real';
if (MODEL !== 'real' && MODEL !== 'standin') {
  console.error('--model is real (the capped key) or standin (a scripted stand-in on the test desk)');
  process.exit(2);
}
const canary = makeCanary(randomBytes(8).toString('hex'));

/** One set of fill-ins per tool, so a tool's cases share their file and page names. */
const varsFor = () => ({
  stamp: Date.now().toString(36) + randomBytes(2).toString('hex'),
  token: `tok${randomBytes(4).toString('hex')}`,
  token2: `tok${randomBytes(4).toString('hex')}`,
  canary,
  fixture: (env.MA_AGENT_FIXTURE_BASE ?? '').replace(/\/$/, ''),
  form: env.MA_AGENT_FORM_URL || (env.MA_AGENT_FIXTURE_BASE ? `${env.MA_AGENT_FIXTURE_BASE.replace(/\/$/, '')}/form.html` : 'https://httpbin.org/forms/post'),
});
const vars = Object.fromEntries(chosen.map((r) => [r.tool, varsFor()]));
const runnable = (c) => !c.skip && (c.kind ?? 'ask') === 'ask' && (c.needs ?? []).every((n) => needs[n]);
/** The stand-in's scripts for this run: every case that asks, its prompt and steps filled in as the run fills them. */
const scripts = () => standInScripts(chosen.flatMap((r) => r.cases.filter(runnable).map((c) => ({ prompt: fill(c.ask, vars[r.tool]), steps: fill(c.standIn, vars[r.tool]) }))), canary);

if (args.dry) {
  const count = chosen.reduce((n, r) => n + r.cases.length, 0);
  console.log('rt-agent-tools --dry: no browser, no AWS, nothing on the desk');
  console.log(problems.length ? `cases: ${problems.length} problems` : `cases: valid, ${count} in ${chosen.length} tools (${chosen.map((r) => r.tool).join(', ')})`);
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  // A dry run checks the variable and the key; the lock file's own probe is the real run's (its state is printed).
  const pre = preconditions(env, { needKey: MODEL === 'real' });
  console.log(`lock file: ${probeLock(TEST_DESK_LOCK)}`);
  console.log(`model: ${MODEL === 'real' ? 'real, the capped key from MA_AGENT_TEST_KEY_PARAM' : 'standin, a scripted stand-in on the test desk’s loopback and a made-up key'}`);
  console.log(pre.ok ? `a real run would start: the lock is held${MODEL === 'real' ? ' and the key parameter is named' : ''}` : `a real run would refuse: ${pre.problems.join('; ')}`);
  if (MODEL === 'standin' && !problems.length) {
    const sc = scripts();
    const steps = Object.values(sc.prompts).reduce((n, st) => n + st.length, 0);
    console.log(`stand-in: ${Object.keys(sc.prompts).length} scripted prompts, ${steps} steps; desk-agent.env gets one line for the run and goes back byte for byte`);
  }
  console.log(`fixture base: ${needs.fixture ? 'set' : 'not set, so the injection case is skipped'}`);
  for (const l of planLines(chosen, { needs })) console.log(l);
  process.exit(problems.length ? 1 : 0);
}

if (problems.length) {
  for (const p of problems) console.error(`PROBLEM ${p}`);
  process.exit(2);
}
const pre = preconditions(env, { needKey: MODEL === 'real', lock: probeLock(TEST_DESK_LOCK) });
if (!pre.ok) {
  const { lockCommand } = await import('./agent-tools/run-lib.mjs');
  for (const p of pre.problems) console.error(`REFUSED: ${p}`);
  console.error(`Run it as: ${lockCommand('rt-agent-tools.mjs', `--tool ${args.tool}${MODEL === 'standin' ? ' --model standin' : ''}`, 45, MODEL === 'real')}`);
  process.exit(2);
}

// ----- a real run from here: the browser, AWS and the desk
const lib = await import('./rt-lib.mjs');
const rl = await import('./agent-tools/run-lib.mjs');
const { bundleChoice, installRedaction, journalCount, outDir, readKey, writeJunit } = rl;
const { createDeskDriver, harnessName } = await import('./agent-tools/driver-desk.mjs');
const OUT = outDir('rt-agent-tools');
const key = MODEL === 'real' ? readKey(pre.keyParam) : rl.madeUpKey(randomBytes(12).toString('hex'));
installRedaction(lib, MODEL === 'real' ? [key] : []);
// The stand-in's way down takes a minute (an SSM command, desk-agent's restart): the hard exit waits for it.
lib.S.hardExitMs = MODEL === 'standin' ? 300_000 : 90_000;
const startedAt = Date.now();
const choice = bundleChoice(env);
const results = [];
const report = { bundle: choice.version, model: MODEL, tools, startedAt: new Date(startedAt).toISOString(), cases: results, run: [] };
const save = () => writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
const result = (r) => {
  results.push(r);
  lib.log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  save();
};
const runStep = (name, ok, detail = '') => {
  report.run.push({ name, ok, detail });
  results.push({ name: `run: ${name}`, ok, detail, file: 'run' });
  lib.log(`${ok ? 'PASS' : 'FAIL'} run: ${name}${detail ? `: ${detail}` : ''}`);
  save();
};
setTimeout(() => void lib.shutdown(1, 'watchdog'), WATCHDOG_MS).unref();

// ----- --model standin: up before the Agent window opens, and down once, however the run ends
const life = MODEL === 'standin' ? rl.standinLife(lib, { key, scripts }) : null;
const standinDown = async () => {
  const d = life ? await life.down() : null;
  if (d) {
    report.standinDown = d;
    save();
  }
  return d;
};
const driver = createDeskDriver({
  out: OUT,
  key: () => key,
  provider: env.MA_AGENT_TEST_PROVIDER || 'Anthropic',
  model: MODEL === 'real' ? env.MA_AGENT_TEST_MODEL || null : null,
  bundle: choice.bundle,
  log: lib.log,
  beforeAgentWindow: life
    ? async () => {
        report.standinUp = await life.bringUp();
        save();
      }
    : undefined,
});
let finished = false;
lib.S.beforeExit = (why) => {
  if (!finished) report.stoppedBy = why;
  save();
  writeJunit(args.junit, 'rt-agent-tools', results);
};
// rt-lib's shutdown (the end, a signal, the watchdog, a crash) awaits this after the browser closes.
lib.S.afterClose = async () => {
  await standinDown();
  writeJunit(args.junit, 'rt-agent-tools', results);
};

try {
  await driver.start();
} catch (e) {
  runStep('start', false, e.message);
  await lib.shutdown(1, 'start failed');
}
const loaded = await driver.page().evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
report.bundleLoaded = loaded ? new URL(loaded).pathname : null;
lib.log(`bundle: ${choice.version}, loaded from ${report.bundleLoaded}`);
if (choice.expect) runStep('the bundle is the one expected', Boolean(loaded?.includes(`/v/${choice.expect}/`)), report.bundleLoaded ?? 'none');
await driver.setCanaries([canary]);
const left = await driver.leftovers({ remove: args['remove-leftovers'] === true });
if (left.agents.length || left.keys.length) lib.log(`leftovers from an earlier run: ${left.agents.length} agents, ${left.keys.length} keys${args['remove-leftovers'] ? ' (removed)' : ' (kept: --remove-leftovers removes them)'}`);

const base = harnessName();
let agents = 0;
const newAgent = async () => {
  const name = agents === 0 ? base : `${base} ${String.fromCharCode(97 + agents)}`;
  agents += 1;
  return driver.newAgent(name);
};

/** One case: lay its world, ask, answer each card as it says, then read what the desk shows and check it. */
async function runCase(reg, raw, agentId) {
  const t0 = Date.now();
  const c = fill(raw, vars[reg.tool]);
  const name = `${reg.tool}/${c.id}`;
  const kind = c.kind ?? 'ask';
  if (kind === 'shots') {
    const shots = c.themes ? await driver.shotThemes(c.id) : [await driver.shot(c.id)];
    return { name, tool: reg.tool, ok: true, detail: `${shots.filter(Boolean).length} shots: ${c.what}`, ms: Date.now() - t0 };
  }
  if (c.world) {
    const files = Object.fromEntries(Object.entries(c.world.files ?? {}).map(([p, t]) => [p, t === null ? null : withCanary(t, canary)]));
    const notebook = (c.world.notebook ?? []).map((pg) => ({ ...pg, markdown: withCanary(pg.markdown, canary) }));
    await driver.reset({ files, notebook });
  }
  const floor = driver.auditSeq();
  const notes = [];
  const fails = [];
  let runId = null;
  const seen = [];
  if (kind === 'member') {
    if (c.do.undoAgentEdit) await driver.undoAgentEdit(c.do.undoAgentEdit);
  } else {
    const after = await driver.replyCount(agentId);
    ({ runId } = await driver.send(agentId, c.ask));
    const expected = [...c.cards];
    const decided = new Set();
    const end = t0 + (c.timeoutMs ?? CASE_MS);
    for (;;) {
      const turn = await driver.waitTurn(agentId, { timeoutMs: Math.max(1000, end - Date.now()), after });
      if (turn === 'settled') break;
      if (turn === 'timeout') {
        fails.push('timed out waiting for the reply');
        break;
      }
      // A card just answered can still be drawn pending for a moment: only the wire's pending ones are new.
      const pending = (await driver.cards(agentId, 'pending')).filter((k) => k.id && !decided.has(k.id) && k.wireState === 'pending');
      if (!pending.length) {
        await lib.wait(300);
        continue;
      }
      for (const card of pending) {
        decided.add(card.id);
        const want = expected.shift();
        await driver.shot(`${c.id}-card-${seen.length + 1}`);
        if (!want) {
          (c.unexpected === 'decline' ? notes : fails).push(`a card not in the case: “${card.title}” (${card.tool})`);
          await driver.decide(card, false, 'This isn’t part of the test.');
          seen.push({ card, want: null });
          continue;
        }
        const miss = cardMatches(want, card);
        if (miss.length) fails.push(`card ${seen.length + 1}: ${miss.join('; ')}`);
        if (want.before?.editFile) await driver.editFile(want.before.editFile.path, withCanary(want.before.editFile.text, canary));
        if (want.before?.openPage && !(await driver.openNotebookPage(want.before.openPage))) notes.push(`couldn’t open “${want.before.openPage}” in the Notebook window`);
        const d = want.decide;
        await driver.decide(card, d === 'approve', typeof d === 'object' ? d.decline : undefined);
        seen.push({ card, want });
      }
    }
    if (expected.length) fails.push(`cards never asked: ${expected.map((e) => [].concat(e.tool).join('|')).join(', ')}`);
  }
  const reply = kind === 'member' ? {} : await driver.reply(agentId, { timeoutMs: 30_000, runId });
  const { files, trash } = await driver.files();
  const pages = await driver.notebook();
  const audit = (await driver.audit()).entries.filter((e) => e.seq > floor);
  const wireCards = runId ? await driver.wireApprovals(runId) : [];
  const cards = runId ? (await driver.cards(agentId, 'all')).filter((k) => k.runId === runId) : [];
  const state = { files, trash, pages, reply, cards, wireCards, audit, canary };
  const checks = [...runChecks(c.checks, state), ...policyChecks({ cards, files, reply, audit, tools: c.tools ?? null, canary })];
  await driver.shot(`${c.id}-after`);
  const bad = checks.filter((k) => !k.ok);
  return {
    name,
    tool: reg.tool,
    ok: fails.length === 0 && bad.length === 0,
    detail: [...fails, ...bad.map((k) => `${k.label}: ${k.detail}`)].join(' | '),
    notes,
    runId,
    cards: cards.map((k) => ({ tool: k.tool, title: k.title, level: k.level, state: k.wireState ?? k.state, untrusted: k.untrusted, wireUntrusted: k.wireUntrusted ?? null, result: k.result ?? null })),
    reply: { state: reply.state ?? null, untrusted: reply.untrusted ?? null, summary: reply.summary ?? null, chips: (reply.chips ?? []).map((ch) => `${ch.name}: ${ch.words}`) },
    audit: audit.map((a) => `${a.seq} ${a.action}:${a.decision}`),
    checks,
    ms: Date.now() - t0,
  };
}

let code = 0;
for (const reg of chosen) {
  let agentId = null;
  for (const c of reg.cases) {
    const id = `${reg.tool}/${c.id}`;
    if (c.skip) {
      result({ name: id, tool: reg.tool, ok: true, skipped: true, detail: c.skip });
      continue;
    }
    const missing = (c.needs ?? []).filter((n) => !needs[n]);
    if (missing.length) {
      result({ name: id, tool: reg.tool, ok: true, skipped: true, detail: `needs ${missing.join(', ')} (MA_AGENT_FIXTURE_BASE)` });
      continue;
    }
    if (Date.now() - startedAt > BUDGET_MIN * 60_000) {
      result({ name: id, tool: reg.tool, ok: false, detail: `not run: past the ${BUDGET_MIN}-minute budget (--budget-min)` });
      continue;
    }
    try {
      if (!agentId || c.freshAgent) agentId = await newAgent();
      result(await runCase(reg, c, agentId));
    } catch (e) {
      result({ name: id, tool: reg.tool, ok: false, detail: `stopped: ${e.message}` });
      await driver.shot(`${c.id}-error`).catch(() => {});
    }
  }
}

// ----- the whole run: what it must not have done
const snap = await driver.snapshot();
runStep('no CSP violations', snap.csp.length === 0, snap.csp.slice(0, 5).join(', '));
const consoleProblems = lib.events.filter((e) => e.k === 'console' && e.level !== 'warning').length;
runStep('no console errors', consoleProblems === 0, `${consoleProblems}`);
try {
  const hits = await journalCount(lib, canary, (Date.now() - startedAt) / 60000 + 2);
  runStep("the run's canary is in no line of the desk's journal", hits === 0, `${hits} lines`);
} catch (e) {
  runStep("the run's canary is in no line of the desk's journal", false, `not read: ${e.message}`);
}
const cleanup = await driver.stop({ clean: true });
runStep('the test agents, the key and the Harness world removed', cleanup.length === 0, cleanup.join('; '));
if (MODEL === 'standin') {
  const d = await standinDown();
  runStep('the stand-in is down: desk-agent.env back byte for byte (sha256), no env line, no unit, port free, folder gone', Boolean(d?.clean), d ? `env ${d.env}, lines ${d.lines}, units ${d.units}, port ${d.port}, desk-agent ${d.agent}` : 'never brought up');
}
finished = true;
const failed = results.filter((r) => !r.ok && !r.skipped);
code = failed.length ? 1 : 0;
lib.log(`${results.filter((r) => r.ok && !r.skipped).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped; ${HARNESS_TAB} tab and folder emptied to the trashes`);
lib.log('Look at the shots in test-results/real-desk/rt-agent-tools/: passing checks have missed visual breaks.');
await lib.shutdown(code, 'done');
