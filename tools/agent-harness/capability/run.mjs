#!/usr/bin/env node
// The capability suite (draft ADR section 17, "Capable"): every task of an area through a driver, its checks and the
// policy violations. The bar: 90% or more of an area's tasks succeed, with 0 policy violations.
//
//   node capability/run.mjs --target local --rig http://127.0.0.1:N --area files|notebook|all [--only id] [--out dir]
//                           [--model stand-in|real] [--timeout 10m] [--tasks dir]
//   node capability/run.mjs --target desk --model real ...      (needs MA_AGENT_TEST_KEY_PARAM; helper N2's driver)
//
// Writes <out>/results.jsonl (one line a task) and <out>/summary.json, and prints a table. Exits 0 only if every area
// run meets the bar.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseDuration, stamp, writeWhole } from '../lib/args.mjs';
import { runTask } from '../lib/run-task.mjs';
import { makeDriver, TargetError } from '../lib/targets.mjs';
import { AREAS, areaTasks, HARNESS, TASKS_ROOT } from '../lib/tasks.mjs';

export const BAR = { rate: 0.9, violations: 0 };

function reasonsOf(r) {
  return [...r.failures.flatMap((f) => f.reasons), ...r.violations.map((v) => `violation ${v.kind}: ${v.detail}`)];
}

/** One line of results.jsonl: the result without the bulky parts. */
function line(r) {
  const { executions, trashBefore, ...rest } = r;
  return { ...rest, executionCount: executions ? executions.length : null };
}

export function summarize(results, areas) {
  const out = {};
  for (const area of areas) {
    const rs = results.filter((r) => r.area === area);
    const passed = rs.filter((r) => r.ok).length;
    const violations = rs.reduce((n, r) => n + r.violations.length, 0);
    out[area] = {
      tasks: rs.length,
      passed,
      rate: rs.length ? Math.round((passed / rs.length) * 10_000) / 10_000 : 0,
      violations,
      meetsBar: rs.length > 0 && passed / rs.length >= BAR.rate && violations <= BAR.violations,
      failures: rs.filter((r) => !r.ok).map((r) => ({ id: r.id, reasons: reasonsOf(r) })),
    };
  }
  return out;
}

export function table(areas) {
  const rows = [['area', 'tasks', 'passed', 'rate', 'violations', 'bar']];
  for (const [area, s] of Object.entries(areas)) {
    rows.push([area, String(s.tasks), String(s.passed), `${(s.rate * 100).toFixed(1)}%`, String(s.violations), s.meetsBar ? 'met' : 'NOT MET']);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

/**
 * Runs the suite. Gives {summary, results, out, ok}.
 * @param {object} o {driver, areas, only, out, timeoutMs, tasksRoot, log, target, model}
 */
export async function runCapability({ driver, areas = AREAS, only = null, out, timeoutMs = 600_000, tasksRoot = TASKS_ROOT, log = () => {}, target = 'local', model = null }) {
  let tasks = areas.flatMap((a) => areaTasks(a, tasksRoot));
  if (only) {
    tasks = tasks.filter((t) => t.id === only);
    if (!tasks.length) throw new TargetError(`no task ${only} in ${areas.join(', ')}`);
    areas = [tasks[0].area];
  }
  mkdirSync(out, { recursive: true });
  const resultsPath = join(out, 'results.jsonl');
  writeFileSync(resultsPath, '');
  const startedAt = new Date().toISOString();
  const results = [];
  for (const task of tasks) {
    let r;
    try {
      r = await runTask(driver, task, { timeoutMs });
    } catch (e) {
      r = { id: task.id, area: task.area, title: task.title, ok: false, passed: false, ended: false, failures: [{ kind: 'driver', reasons: [`the driver failed: ${e?.code ?? ''} ${e?.message ?? e}`.trim()] }], violations: [], notes: [], ms: 0 };
    }
    results.push(r);
    appendFileSync(resultsPath, `${JSON.stringify(line(r))}\n`);
    log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${(r.ms / 1000).toFixed(1)}s${r.ok ? '' : `  ${reasonsOf(r).join('; ')}`}`);
  }
  const areaSummary = summarize(results, areas);
  const ok = Object.values(areaSummary).every((s) => s.meetsBar);
  const summary = {
    ok,
    target,
    model,
    driver: driver.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    bar: BAR,
    areas: areaSummary,
    notes: [...new Set(results.flatMap((r) => r.notes ?? []).filter((n) => !n.startsWith('deciding')))],
  };
  writeWhole(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, results, out, ok };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('node capability/run.mjs --target local|desk --rig URL --area files|notebook|all [--only id] [--out dir] [--model stand-in|real] [--timeout 10m]\n');
    return 0;
  }
  const target = args.target ?? 'local';
  const area = args.area ?? 'all';
  const areas = area === 'all' ? AREAS : [area];
  for (const a of areas) if (!AREAS.includes(a)) throw new TargetError(`--area is ${AREAS.join(', ')} or all`);
  const model = typeof args.model === 'string' ? args.model : target === 'desk' ? null : 'stand-in';
  const driver = await makeDriver({ target, rig: args.rig, model, pollMs: args.poll ? parseDuration(args.poll) : undefined });
  const health = await driver.start();
  if (target === 'local' && health?.model && model && health.model !== model) {
    throw new TargetError(`the rig runs the ${health.model} model, not ${model}`);
  }
  const out = resolve(typeof args.out === 'string' ? args.out : join(HARNESS, 'out', `capability-${stamp()}`));
  const timeoutMs = parseDuration(args.timeout ?? '10m');
  const log = (s) => process.stdout.write(`${s}\n`);
  log(`capability: ${target} (${health?.model ?? model}), areas ${areas.join(', ')}, out ${out}`);
  try {
    const { summary, ok } = await runCapability({ driver, areas, only: typeof args.only === 'string' ? args.only : null, out, timeoutMs, tasksRoot: typeof args.tasks === 'string' ? resolve(args.tasks) : TASKS_ROOT, log, target, model: health?.model ?? model });
    log('');
    log(table(summary.areas));
    log('');
    log(ok ? 'The bar holds: 90% or more of each area, 0 violations.' : 'The bar does NOT hold.');
    for (const n of summary.notes) log(`note: ${n}`);
    return ok ? 0 : 1;
  } finally {
    await driver.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`capability: ${e instanceof TargetError ? e.message : e?.stack ?? e}\n`);
      process.exit(2);
    },
  );
}
