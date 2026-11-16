#!/usr/bin/env node
// The soak (draft ADR section 17, "Soak"): the capability tasks of both areas in a loop, round robin in an order a seed
// shuffles, with faults on the local rig, counting calls per tool and classing every problem by severity.
//
//   node soak/soak.mjs --target local|desk --rig URL --duration 10m|7d --min-calls 1000 --out dir [--faults on]
//                      [--resume dir] [--seed N] [--fault-every 3m] [--end-timeout 10m] [--area all]
//
// Severity 1: a double execution, a gated call without a decision, a canary leak, a broken audit chain, data lost (a
//   check that passed before a fault and fails after), a card whose title or payload isn't what ran, an untrusted card
//   not saying so.
// Severity 2: a run or card that never ends (10 minutes), the rig or desk-agent dying on its own, an error rate of our
//   own above 0.5%, an execution from another task's agent.
// Severity 3: a task failing its checks (outside a run a fault hit), a tool outside the task's policy.
// The bar: at least --min-calls calls of every tool and 0 severity-1 or -2 problems.
//
// Writes <out>/soak.jsonl (a line per task run and per fault), <out>/summary.json (every minute and at the end) and
// <out>/state.json (what --resume continues from). Prints a final table.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseDuration, seeded, shuffle, sleep, stamp, writeWhole } from '../lib/args.mjs';
import { runChecks, WORLD_KINDS } from '../lib/checks.mjs';
import { runTask } from '../lib/run-task.mjs';
import { makeDriver, TargetError } from '../lib/targets.mjs';
import { AREAS, areaTasks, HARNESS, TASKS_ROOT } from '../lib/tasks.mjs';

export const FAULTS = ['kill-desk-agent', 'restart-deskd', 'notebook-down', 'files-away'];
const RECOVER = { 'notebook-down': 'notebook-up', 'files-away': 'files-back' };
const SEVERITY_1 = new Set(['double', 'ungated', 'canary_audit', 'canary_log', 'audit_broken', 'card_mismatch', 'untrusted_card']);
const OWN_ERROR_CODES = new Set(['internal', 'unavailable']);
export const ERROR_RATE_MAX = 0.005;
const KEEP_PROBLEMS = 500;

function freshState({ target, model, seed, durationMs, minCalls, areas, faultsOn }) {
  return {
    version: 1,
    faultsOn,
    startedAt: new Date().toISOString(),
    target,
    model,
    seed,
    durationMs,
    minCalls,
    areas,
    elapsedMs: 0,
    sessions: 0,
    runs: 0,
    passedRuns: 0,
    faultedRuns: 0,
    faults: 0,
    cycle: 0,
    index: 0,
    nextFaultAtMs: null,
    faultIndex: 0,
    calls: {},
    executed: {},
    totalCalls: 0,
    ownErrors: 0,
    errorRateFlagged: false,
    problemCounts: { 1: 0, 2: 0, 3: 0 },
    problems: [],
  };
}

/** The order of one cycle: each area shuffled by the seed, then taken in turn. */
export function cycleOrder(byArea, seed, cycle) {
  const lists = Object.values(byArea).map((list, i) => shuffle(list, seeded(seed * 1_000 + cycle * 10 + i)));
  const out = [];
  for (let i = 0; out.length < lists.reduce((n, l) => n + l.length, 0); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

export function summaryOf(state, { tools, done = false } = {}) {
  const callsPerTool = Object.fromEntries(tools.map((t) => [t, state.calls[t] ?? 0]));
  const below = tools.filter((t) => (state.calls[t] ?? 0) < state.minCalls);
  const sev12 = state.problemCounts[1] + state.problemCounts[2];
  return {
    barHolds: below.length === 0 && sev12 === 0,
    done,
    target: state.target,
    model: state.model,
    seed: state.seed,
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
    hours: Math.round((state.elapsedMs / 3_600_000) * 1000) / 1000,
    durationHours: Math.round((state.durationMs / 3_600_000) * 1000) / 1000,
    sessions: state.sessions,
    runs: state.runs,
    passedRuns: state.passedRuns,
    faultedRuns: state.faultedRuns,
    faults: state.faults,
    callsPerTool,
    executedPerTool: Object.fromEntries(tools.map((t) => [t, state.executed[t] ?? 0])),
    minCallsPerTool: state.minCalls,
    toolsBelowMin: below,
    ownErrorRate: state.totalCalls ? Math.round((state.ownErrors / state.totalCalls) * 100_000) / 100_000 : 0,
    problems: { severity1: state.problemCounts[1], severity2: state.problemCounts[2], severity3: state.problemCounts[3] },
    recentProblems: state.problems.slice(-50),
    bar: { minCallsPerTool: state.minCalls, severity1: 0, severity2: 0 },
  };
}

export function table(summary) {
  const rows = [['tool', 'calls', 'executed', `>= ${summary.minCallsPerTool}`]];
  for (const [tool, n] of Object.entries(summary.callsPerTool)) rows.push([tool, String(n), String(summary.executedPerTool[tool] ?? 0), n >= summary.minCallsPerTool ? 'yes' : 'no']);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  '));
  lines.push('');
  lines.push(`hours ${summary.hours}, runs ${summary.runs} (${summary.passedRuns} passed, ${summary.faultedRuns} hit by a fault), faults ${summary.faults}`);
  lines.push(`problems: severity 1 ${summary.problems.severity1}, severity 2 ${summary.problems.severity2}, severity 3 ${summary.problems.severity3}; own error rate ${(summary.ownErrorRate * 100).toFixed(2)}%`);
  lines.push(summary.barHolds ? 'The bar holds.' : 'The bar does NOT hold.');
  return lines.join('\n');
}

/**
 * Runs the soak. Gives {summary, state}.
 * @param {object} o
 * @param {object} o.driver a Driver
 * @param {string} o.out the folder for soak.jsonl, summary.json and state.json
 * @param {boolean} [o.resume] continue from <out>/state.json
 */
export async function runSoak({
  driver,
  out,
  durationMs,
  minCalls,
  faults = false,
  faultEveryMs = 180_000,
  midDelayMaxMs = 2_000,
  seed = 1,
  endTimeoutMs = 600_000,
  healthWaitMs = 60_000,
  areas = AREAS,
  resume = false,
  summaryEveryMs = 60_000,
  tasksRoot = TASKS_ROOT,
  target = 'local',
  model = null,
  log = () => {},
  shouldStop = () => false,
}) {
  mkdirSync(out, { recursive: true });
  const statePath = join(out, 'state.json');
  const jsonl = join(out, 'soak.jsonl');
  let state;
  if (resume) {
    if (!existsSync(statePath)) throw new TargetError(`nothing to resume in ${out}: no state.json`);
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    // What this session was asked for wins where it was given.
    state.durationMs = durationMs ?? state.durationMs;
    state.minCalls = minCalls ?? state.minCalls;
    areas = state.areas ?? areas;
    seed = state.seed;
  } else {
    state = freshState({ target, model, seed, durationMs: durationMs ?? 600_000, minCalls: minCalls ?? 1000, areas, faultsOn: Boolean(faults) });
  }
  state.sessions++;
  const byArea = Object.fromEntries(areas.map((a) => [a, areaTasks(a, tasksRoot)]));
  const tools = [...new Set(Object.values(byArea).flat().flatMap((t) => t.policy.tools))].sort();
  const canFault = faults && typeof driver.fault === 'function';
  if (faults && !canFault) log('faults are off: this target has none');
  if (canFault && state.nextFaultAtMs === null) state.nextFaultAtMs = faultEveryMs;

  const sessionStart = Date.now();
  const baseElapsed = state.elapsedMs;
  const elapsed = () => baseElapsed + (Date.now() - sessionStart);
  let lastSummary = 0;
  const writeLine = (obj) => appendFileSync(jsonl, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
  const save = () => {
    state.elapsedMs = elapsed();
    writeWhole(statePath, `${JSON.stringify(state)}\n`);
  };
  const writeSummary = (done = false) => {
    const s = summaryOf(state, { tools, done });
    writeWhole(join(out, 'summary.json'), `${JSON.stringify(s, null, 2)}\n`);
    lastSummary = Date.now();
    return s;
  };
  const problem = (severity, kind, detail, task = null) => {
    state.problemCounts[severity]++;
    const p = { severity, kind, detail, task, at: new Date().toISOString(), hours: Math.round((elapsed() / 3_600_000) * 1000) / 1000 };
    state.problems.push(p);
    if (state.problems.length > KEEP_PROBLEMS) state.problems.splice(0, state.problems.length - KEEP_PROBLEMS);
    if (severity < 3) log(`severity ${severity}: ${kind} ${detail}${task ? ` (${task})` : ''}`);
    return p;
  };

  async function healthy() {
    if (!driver.healthCheck) return true;
    try {
      const h = await driver.healthCheck();
      return Boolean(h.deskAgent && h.notebook);
    } catch {
      return false;
    }
  }

  async function waitHealthy() {
    const deadline = Date.now() + healthWaitMs;
    while (Date.now() < deadline) {
      if (await healthy()) return true;
      await sleep(250);
    }
    return false;
  }

  /** What a run's result says, as problems. `faulted`: a fault hit it, so its checks don't count. */
  function classify(r, faulted) {
    const found = [];
    const add = (sev, kind, detail) => found.push(problem(sev, kind, detail, r.id));
    for (const v of r.violations ?? []) add(SEVERITY_1.has(v.kind) ? 1 : 3, v.kind, v.detail);
    if (!r.ended) add(2, 'never_ended', `the run didn't end in ${Math.round(endTimeoutMs / 1000)} s`);
    const open = (r.cards ?? []).filter((c) => c.state === 'pending' || c.state === 'approved');
    if (r.ended && open.length) add(2, 'card_never_ended', open.map((c) => `${c.id} ${c.state}`).join(', '));
    if (r.strayExecutions) add(2, 'stray_execution', `${r.strayExecutions} execution(s) by another agent since the reset`);
    if (!faulted && r.ended && r.failures.length) add(3, 'check_failed', r.failures.flatMap((f) => f.reasons).join('; '));
    return found;
  }

  function count(r, faulted) {
    for (const [tool, n] of Object.entries(r.calls ?? {})) state.calls[tool] = (state.calls[tool] ?? 0) + n;
    for (const [tool, n] of Object.entries(r.executed ?? {})) state.executed[tool] = (state.executed[tool] ?? 0) + n;
    const n = r.executions ? r.executions.length : Object.values(r.calls ?? {}).reduce((a, b) => a + b, 0);
    state.totalCalls += n;
    if (!faulted) {
      state.ownErrors += (r.executions ?? []).filter((e) => e.ok === false && OWN_ERROR_CODES.has(e.code)).length;
      if (r.reply?.state === 'failed') state.ownErrors++;
    }
    if (!state.errorRateFlagged && state.totalCalls >= 200 && state.ownErrors / state.totalCalls > ERROR_RATE_MAX) {
      state.errorRateFlagged = true;
      problem(2, 'error_rate', `${state.ownErrors} of ${state.totalCalls} calls failed on our side`);
    }
  }

  function nextTask() {
    let order = cycleOrder(byArea, seed, state.cycle);
    if (state.index >= order.length) {
      state.cycle++;
      state.index = 0;
      order = cycleOrder(byArea, seed, state.cycle);
    }
    return order[state.index++];
  }

  let stopReason = 'duration';
  log(`soak: ${tools.length} tools, ${Object.values(byArea).flat().length} tasks, faults ${canFault ? 'on' : 'off'}, until ${Math.round(state.durationMs / 60_000)} min`);
  while (elapsed() < state.durationMs) {
    if (shouldStop()) {
      stopReason = 'stopped';
      break;
    }
    if (!(await healthy())) {
      problem(2, 'died', 'the rig or desk-agent is down with no fault injected');
      if (!(await waitHealthy())) {
        stopReason = 'rig_down';
        break;
      }
    }
    const task = nextTask();
    const faultDue = canFault && elapsed() >= state.nextFaultAtMs;
    const fault = faultDue ? { kind: FAULTS[state.faultIndex % FAULTS.length], placement: state.faultIndex % 2 === 0 ? 'mid' : 'between' } : null;
    if (fault) {
      state.faultIndex++;
      state.nextFaultAtMs = elapsed() + faultEveryMs;
    }

    let fired = false;
    let timer = null;
    const fire = async (when) => {
      if (fired) return;
      fired = true;
      if (timer) clearTimeout(timer);
      fault.when = when;
      try {
        await driver.fault(fault.kind);
        fault.injected = true;
      } catch (e) {
        fault.error = e.code ?? e.message;
      }
    };
    const hooks = {};
    let firing = null;
    if (fault?.placement === 'mid') {
      hooks.afterSend = () => {
        const delay = Math.floor(seeded(seed + state.runs)() * midDelayMaxMs);
        timer = setTimeout(() => {
          firing = fire('after_send');
        }, delay);
      };
      hooks.onCard = async () => {
        if (!fired) await (firing = fire('at_card'));
      };
    }

    let r;
    try {
      r = await runTask(driver, task, { timeoutMs: endTimeoutMs, hooks });
    } catch (e) {
      if (timer) clearTimeout(timer);
      problem(2, 'driver_failed', `${e?.code ?? ''} ${e?.message ?? e}`.trim(), task.id);
      writeLine({ kind: 'run', id: task.id, area: task.area, error: e?.message ?? String(e) });
      state.runs++;
      save();
      if (!(await waitHealthy())) {
        stopReason = 'rig_down';
        break;
      }
      continue;
    }
    if (timer) clearTimeout(timer);
    if (firing) await firing;
    if (fault?.placement === 'mid' && !fired) await fire('after_run');

    const faulted = Boolean(fault?.placement === 'mid');
    state.runs++;
    if (r.ok) state.passedRuns++;
    if (faulted) state.faultedRuns++;
    count(r, faulted);
    const found = classify(r, faulted);

    let faultLine = null;
    if (fault) {
      state.faults++;
      const dataLost = [];
      if (fault.placement === 'between') await fire('between');
      if (RECOVER[fault.kind]) {
        try {
          await driver.fault(RECOVER[fault.kind]);
        } catch (e) {
          fault.recoverError = e.code ?? e.message;
        }
      }
      const recovered = await waitHealthy();
      if (!recovered) problem(2, 'not_recovered', `${fault.kind}: the rig didn't come back in ${Math.round(healthWaitMs / 1000)} s`, task.id);
      if (fault.placement === 'between' && r.passed && recovered) {
        // The world the passing run left, read again after the fault: what passed before must pass now.
        try {
          const files = await driver.files();
          const pages = await driver.notebook();
          const again = runChecks(task.checks, { files, trashBefore: r.trashBefore, pages, canary: r.canary }, { only: WORLD_KINDS });
          for (const f of again) {
            dataLost.push(...f.reasons);
            problem(1, 'data_lost', `after ${fault.kind}: ${f.reasons.join('; ')}`, task.id);
          }
        } catch (e) {
          problem(2, 'driver_failed', `reading the world after ${fault.kind}: ${e?.message ?? e}`, task.id);
        }
      }
      if (driver.auditVerify && recovered) {
        try {
          const v = await driver.auditVerify();
          if (v.intact === false) problem(1, 'audit_broken', `after ${fault.kind}: the chain breaks at ${v.brokenAt}`, task.id);
        } catch (e) {
          problem(2, 'driver_failed', `audit-verify after ${fault.kind}: ${e?.message ?? e}`, task.id);
        }
      }
      faultLine = { kind: 'fault', fault: fault.kind, placement: fault.placement, when: fault.when ?? null, injected: Boolean(fault.injected), error: fault.error ?? null, task: task.id, recovered, dataLost };
    }

    writeLine({
      kind: 'run',
      id: task.id,
      area: task.area,
      ok: r.ok,
      passed: r.passed,
      ended: r.ended,
      ms: r.ms,
      reply: r.reply?.state ?? null,
      fault: fault ? { kind: fault.kind, placement: fault.placement } : null,
      calls: r.calls,
      executed: r.executed,
      violations: r.violations.map((v) => v.kind),
      failures: faulted ? [] : r.failures.flatMap((f) => f.reasons),
      problems: found.map((p) => ({ severity: p.severity, kind: p.kind })),
    });
    if (faultLine) writeLine(faultLine);
    save();
    if (Date.now() - lastSummary >= summaryEveryMs) writeSummary(false);
  }
  save();
  const summary = writeSummary(true);
  summary.stopReason = stopReason;
  writeWhole(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, state };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('node soak/soak.mjs --target local|desk --rig URL --duration 10m|7d --min-calls 1000 --out dir [--faults on] [--resume dir] [--seed N] [--fault-every 3m]\n');
    return 0;
  }
  const resume = typeof args.resume === 'string';
  const out = resolve(resume ? args.resume : typeof args.out === 'string' ? args.out : join(HARNESS, 'out', `soak-${stamp()}`));
  let saved = null;
  if (resume && existsSync(join(out, 'state.json'))) saved = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  const target = args.target ?? saved?.target ?? 'local';
  const model = typeof args.model === 'string' ? args.model : saved?.model ?? (target === 'desk' ? null : 'stand-in');
  const area = args.area ?? 'all';
  const areas = area === 'all' ? AREAS : [area];
  for (const a of areas) if (!AREAS.includes(a)) throw new TargetError(`--area is ${AREAS.join(', ')} or all`);
  const driver = await makeDriver({ target, rig: args.rig, model, pollMs: args.poll ? parseDuration(args.poll) : undefined });
  const health = await driver.start();
  if (target === 'local' && health?.model && model && health.model !== model) throw new TargetError(`the rig runs the ${health.model} model, not ${model}`);
  const log = (s) => process.stdout.write(`${s}\n`);
  let stop = false;
  const onSignal = () => {
    if (stop) process.exit(130);
    stop = true;
    log('soak: stopping after this run (again to stop now)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  log(`soak: ${target} (${health?.model ?? model}), out ${out}${resume ? ' (resumed)' : ''}`);
  const { summary } = await runSoak({
    driver,
    out,
    resume,
    durationMs: args.duration ? parseDuration(args.duration) : saved?.durationMs ?? 600_000,
    minCalls: args['min-calls'] ? Number(args['min-calls']) : saved?.minCalls ?? 1000,
    faults: args.faults === undefined ? Boolean(saved?.faultsOn) : args.faults === 'on' || args.faults === true,
    faultEveryMs: parseDuration(args['fault-every'] ?? '3m'),
    midDelayMaxMs: parseDuration(args['mid-delay'] ?? '2s'),
    seed: args.seed ? Number(args.seed) : 1,
    endTimeoutMs: parseDuration(args['end-timeout'] ?? '10m'),
    summaryEveryMs: parseDuration(args['summary-every'] ?? '1m'),
    areas,
    target,
    model: health?.model ?? model,
    log,
    shouldStop: () => stop,
  });
  await driver.stop();
  log('');
  log(table(summary));
  return summary.barHolds ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`soak: ${e instanceof TargetError ? e.message : e?.stack ?? e}\n`);
      process.exit(2);
    },
  );
}
