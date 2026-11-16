// The capability suites (draft ADR §17, "Capable": tools/agent-harness/capability/tasks/{files,notebook}) with the real model on
// the fleet desk, through tools/agent-harness's own runner parts: `makeDriver` (lib/targets.mjs) loads the desk driver
// dynamically (agent-tools/fleet-driver.mjs, with the key parameter this desk's stored key alone), `runTask` (lib/run-task.mjs)
// runs each task (reset, prompt, cards answered by `approve`, reply, checks, violations), and run.mjs's `summarize` scores each
// area against the bar (90% or more, 0 policy violations). Tasks go Files and Notebook in turn, so a run the budget cuts short
// is half of each. Each task's cost comes from the desk's own counts (agent-tools/fleet-run.mjs) into spend.json.
//
//   cd web && flock -w 120 ~/work/.desk-d-teste5h2wnkq.lock timeout 300m env FLEET_DESK_LOCK=held MA_ENV=staging \
//     ~/.local/node-v24/bin/node tests/real-desk/rt-capability-real.mjs [--budget-usd 11] [--max 100] [--only files-001]
//     [--resume]   (skips the tasks already in results.jsonl)
//
// The rules (binding) are rt-agent-real.mjs's. No execution log on a desk: the ungated and double checks use the cards alone,
// and tool.call rows of Activity (names only) stand in for "a tool outside policy.tools ran" as `auditOutsidePolicy`, which is
// reported beside the runner's own violations, not in them. Results: real-model/capability/results.jsonl and summary.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { argsOf } from './agent-tools/pure.mjs';
import { RESULTS, lockProblems, runCost, spendLedger, writeJson } from './agent-tools/fleet-run.mjs';
import { ALLOWED } from './agent-tools/fleet.mjs';
import { STORED_KEY } from './agent-tools/fleet-driver.mjs';

const HARNESS = fileURLToPath(new URL('../../../tools/agent-harness/', import.meta.url));
const { makeDriver } = await import(`${HARNESS}lib/targets.mjs`);
const { runTask, auditCalls } = await import(`${HARNESS}lib/run-task.mjs`);
const { areaTasks } = await import(`${HARNESS}lib/tasks.mjs`);
const { summarize, table, BAR } = await import(`${HARNESS}capability/run.mjs`);

const args = argsOf(process.argv.slice(2));
const problems = [...lockProblems(process.env, ALLOWED), ...((process.env.MA_ENV ?? '') === 'staging' ? [] : ['MA_ENV=staging only'])];
if (problems.length) {
  for (const p of problems) console.error(`REFUSED: ${p}`);
  process.exit(2);
}
const OUT = `${RESULTS}/capability`;
/** A single task (`--only`) is a trial: its line goes to trial-results.jsonl, and no summary is written. */
const RESULTS_FILE = `${OUT}/${typeof args.only === 'string' ? 'trial-' : ''}results.jsonl`;
mkdirSync(OUT, { recursive: true });
const BUDGET = Math.round((Number(args['budget-usd'] ?? 11) || 11) * 1e6);
const MAX = Number(args.max ?? 100) || 100;
const TASK_MS = 6 * 60_000;
const ledger = spendLedger();
const spent = () => ledger.data.proofs.capability?.realMicroUsd ?? 0;

// Files and Notebook in turn; `--order notebook,files` runs every one of the first area left, then the second.
const files = areaTasks('files');
const notebook = areaTasks('notebook');
let tasks = [];
if (typeof args.order === 'string') for (const a of args.order.split(',')) tasks.push(...(a === 'files' ? files : a === 'notebook' ? notebook : []));
else for (let i = 0; i < Math.max(files.length, notebook.length); i += 1) tasks.push(...[files[i], notebook[i]].filter(Boolean));
if (typeof args.only === 'string') tasks = tasks.filter((t) => t.id === args.only);
const done = existsSync(RESULTS_FILE) ? readFileSync(RESULTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
if (args.resume) {
  const ids = new Set(done.map((r) => r.id));
  tasks = tasks.filter((t) => !ids.has(t.id));
} else if (typeof args.only !== 'string' && done.length) {
  console.error(`REFUSED: ${RESULTS_FILE} has ${done.length} results; --resume to go on, or move it away`);
  process.exit(2);
}
tasks = tasks.slice(0, MAX);

const driver = await makeDriver({
  target: 'desk',
  model: 'real',
  env: { ...process.env, MA_AGENT_TEST_KEY_PARAM: STORED_KEY },
  deskDriverPath: fileURLToPath(new URL('./agent-tools/fleet-driver.mjs', import.meta.url)),
});
const health = await driver.start();
const lib = driver.lib();
const say = lib.log;
say(`capability: the fleet desk's ${health.agent} on ${health.modelId}; ${tasks.length} tasks to run; budget $${BUDGET / 1e6} for this proof, $${((spent()) / 1e6).toFixed(2)} spent so far`);

const results = [...done];
let stopped = null;
for (const task of tasks) {
  if (spent() >= BUDGET) {
    stopped = `this proof's budget ($${BUDGET / 1e6}) is spent`;
    break;
  }
  if (ledger.left() < 400_000) {
    stopped = `the whole run's stop rule ($18) is near: $${(ledger.total() / 1e6).toFixed(2)} spent`;
    break;
  }
  const seq0 = await driver.auditHead();
  let r;
  try {
    r = await runTask(driver, task, { timeoutMs: TASK_MS });
  } catch (e) {
    r = { id: task.id, area: task.area, title: task.title, ok: false, passed: false, ended: false, failures: [{ kind: 'driver', reasons: [`the driver failed: ${e?.code ?? ''} ${e?.message ?? e}`.trim()] }], violations: [], notes: [], ms: 0 };
    await driver.desk().shot(`${task.id}-error`).catch(() => {});
  }
  let cost = null;
  try {
    cost = await runCost(driver.desk(), { seq: seq0, runId: driver.lastRunId() });
  } catch (e) {
    say(`cost not read for ${task.id}: ${e.message}`);
  }
  const ran = auditCalls((cost?.audit ?? []).map((e) => ({ ...e, target: e.tool ? `tool:${e.tool}` : e.target })));
  const allowed = new Set(task.policy?.tools ?? []);
  const outside = Object.keys(ran).filter((t) => !allowed.has(t) && (cost?.audit ?? []).some((e) => e.action === 'tool.call' && e.tool === t && String(e.decision).startsWith('ok')));
  const { executions, trashBefore, canary, ...rest } = r;
  const row = {
    ...rest,
    reply: r.reply ? { ...r.reply, text: String(r.reply.text ?? '').slice(0, 600) } : null,
    auditCalls: ran,
    auditOutsidePolicy: outside,
    costUsd: cost ? Math.round(cost.realMicroUsd / 100) / 1e4 : null,
    deskCostUsd: cost ? Math.round(cost.microUsd / 100) / 1e4 : null,
    llmCalls: cost?.llmCalls ?? null,
    usage: cost?.usage ?? null,
  };
  if (cost) {
    const { audit, ...c } = cost;
    ledger.add('capability', { item: task.id, runId: driver.lastRunId(), ...c });
  }
  results.push(row);
  appendFileSync(RESULTS_FILE, `${JSON.stringify(row)}\n`);
  const why = [...r.failures.flatMap((f) => f.reasons), ...r.violations.map((v) => `violation ${v.kind}: ${v.detail}`)];
  say(`${r.ok ? 'PASS' : 'FAIL'} ${task.id} ${(r.ms / 1000).toFixed(1)}s $${row.costUsd}${outside.length ? ` [ran outside policy.tools: ${outside.join(', ')}]` : ''}${why.length ? `  ${why.join('; ').slice(0, 400)}` : ''} | total $${(ledger.total() / 1e6).toFixed(2)}`);
}

const areas = ['files', 'notebook'];
const summary = {
  ok: false,
  target: 'desk (fleet: d-teste5h2wnkq, staging)',
  model: health.modelId,
  agent: `${health.agent} (the desk's Lead, its stored key)`,
  bar: BAR,
  areas: summarize(results, areas),
  ran: Object.fromEntries(areas.map((a) => [a, { ran: results.filter((r) => r.area === a).length, of: a === 'files' ? files.length : notebook.length }])),
  stopped,
  spendUsd: Math.round(spent() / 1e4) / 100,
  auditOutsidePolicy: results.filter((r) => r.auditOutsidePolicy?.length).map((r) => ({ id: r.id, tools: r.auditOutsidePolicy })),
  notes: [
    'No execution log on a desk: the ungated and double checks used the cards alone; the audit chain was not verified (no audit-verify on a desk).',
    'Every task ran in Lead’s one thread (no agent may be made, and the window has no new-thread control): earlier tasks’ words are in each run’s context, and once a run read a file the thread starts tainted (untrusted) for the runs after it.',
    'The prompt’s `canary:` line was taken out before it was typed (the world texts carry the canary).',
    'auditOutsidePolicy lists tools Activity shows ran (tool.call ok) that a task’s policy.tools leaves out: reported beside the violations, not in them.',
  ],
  finishedAt: new Date().toISOString(),
};
summary.ok = Object.values(summary.areas).every((s) => s.meetsBar);
if (typeof args.only !== 'string') writeJson(`${OUT}/summary.json`, summary);
say(`\n${table(summary.areas)}\n${stopped ? `stopped: ${stopped}` : 'all tasks run'}; this proof's spend $${summary.spendUsd}`);
await driver.stop();
await lib.shutdown(0, 'done');
