// The soak against the fake rig: faults mid-run and between runs with nothing found, each severity found when it
// happens, data lost after a fault, resume, and the command line.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LocalDriver } from '../lib/driver-local.mjs';
import { startFakeRig } from '../lib/fake-rig.mjs';
import { KEY_PARAM_ENV } from '../lib/targets.mjs';
import { AREAS, areaTasks, HARNESS, loadTasks, TASKS_ROOT } from '../lib/tasks.mjs';
import { cycleOrder, runSoak } from '../soak/soak.mjs';

const tasks = loadTasks(TASKS_ROOT);
// Scratch folders stay inside this folder, under out/ (ignored by git), and go when the file's tests end.
const made = [];
const tmp = () => {
  mkdirSync(join(HARNESS, 'out', 'test-tmp'), { recursive: true });
  const dir = mkdtempSync(join(HARNESS, 'out', 'test-tmp', 'mm-soak-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const lines = (out) => readFileSync(join(out, 'soak.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function rigAndDriver(options = {}) {
  const rig = await startFakeRig({ tasks, stepDelayMs: 3, restartMs: 20, ...options });
  const driver = new LocalDriver({ rig: rig.url, pollMs: 5 });
  await driver.start();
  return { rig, driver };
}

const quick = { minCalls: 1, midDelayMaxMs: 20, healthWaitMs: 3_000, summaryEveryMs: 200, endTimeoutMs: 5_000 };

test('faults mid-run and between runs: every run and card ends, nothing doubled, nothing lost', async () => {
  const { rig, driver } = await rigAndDriver();
  try {
    const out = tmp();
    const { summary } = await runSoak({ driver, out, durationMs: 3_000, faults: true, faultEveryMs: 120, ...quick });
    assert.equal(summary.problems.severity1, 0, JSON.stringify(summary.recentProblems));
    assert.equal(summary.problems.severity2, 0, JSON.stringify(summary.recentProblems));
    assert.ok(summary.faults >= 4, `faults ${summary.faults}`);
    const all = lines(out);
    const faults = all.filter((l) => l.kind === 'fault');
    assert.ok(faults.some((f) => f.placement === 'mid' && f.injected));
    assert.ok(faults.some((f) => f.placement === 'between' && f.injected));
    assert.ok(faults.every((f) => f.recovered));
    const kinds = new Set(faults.map((f) => f.fault));
    for (const k of ['kill-desk-agent', 'restart-deskd', 'notebook-down', 'files-away']) assert.ok(kinds.has(k), `${k} injected`);
    assert.ok(all.filter((l) => l.kind === 'run').length >= 8);
    assert.ok(Object.values(summary.callsPerTool).reduce((a, b) => a + b, 0) > 0);
    const written = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.equal(written.done, true);
    assert.deepEqual(Object.keys(written.callsPerTool).length, 12);
  } finally {
    await rig.stop();
  }
});

test('a double execution is severity 1', async () => {
  const { rig, driver } = await rigAndDriver();
  rig.inject = { doubleExecute: true };
  try {
    const { summary, state } = await runSoak({ driver, out: tmp(), durationMs: 800, areas: ['files'], ...quick });
    assert.ok(summary.problems.severity1 >= 1);
    assert.ok(state.problems.some((p) => p.severity === 1 && p.kind === 'double'));
    assert.equal(summary.barHolds, false);
  } finally {
    await rig.stop();
  }
});

test('a gated call with no decision is severity 1', async () => {
  const { rig, driver } = await rigAndDriver();
  rig.inject = { ungated: 'notebook_write' };
  try {
    const { state } = await runSoak({ driver, out: tmp(), durationMs: 800, areas: ['notebook'], ...quick });
    assert.ok(state.problems.some((p) => p.severity === 1 && p.kind === 'ungated'));
  } finally {
    await rig.stop();
  }
});

test('a run that never ends is severity 2', async () => {
  const { rig, driver } = await rigAndDriver();
  rig.inject = { hang: true };
  try {
    const { state } = await runSoak({ driver, out: tmp(), durationMs: 600, ...quick, endTimeoutMs: 200 });
    assert.ok(state.problems.some((p) => p.severity === 2 && p.kind === 'never_ended'));
  } finally {
    await rig.stop();
  }
});

test('desk-agent dying with no fault is severity 2', async () => {
  const { rig, driver } = await rigAndDriver();
  rig.inject = { deskAgentDown: true };
  setTimeout(() => {
    rig.inject = {};
  }, 300);
  try {
    const { state } = await runSoak({ driver, out: tmp(), durationMs: 800, ...quick });
    assert.ok(state.problems.some((p) => p.severity === 2 && p.kind === 'died'));
  } finally {
    await rig.stop();
  }
});

test('data a fault loses is found: a check that passed before fails after', async () => {
  const { rig, driver } = await rigAndDriver();
  rig.inject = { loseOnFault: true };
  try {
    const out = tmp();
    const { state } = await runSoak({ driver, out, durationMs: 1_500, faults: true, faultEveryMs: 50, areas: ['files'], ...quick });
    assert.ok(state.problems.some((p) => p.severity === 1 && p.kind === 'data_lost'), JSON.stringify(state.problems.slice(0, 5)));
    assert.ok(lines(out).some((l) => l.kind === 'fault' && l.placement === 'between' && l.dataLost.length > 0));
  } finally {
    await rig.stop();
  }
});

test('a restarted soak resumes its counts from its folder', async () => {
  const { rig, driver } = await rigAndDriver();
  try {
    const out = tmp();
    const first = await runSoak({ driver, out, durationMs: 700, ...quick });
    const runs1 = first.state.runs;
    const calls1 = Object.values(first.summary.callsPerTool).reduce((a, b) => a + b, 0);
    const lines1 = lines(out).length;
    assert.ok(runs1 > 0);
    const second = await runSoak({ driver, out, resume: true, durationMs: 1_400, ...quick });
    assert.equal(second.state.sessions, 2);
    assert.ok(second.state.runs > runs1, `${second.state.runs} > ${runs1}`);
    assert.ok(Object.values(second.summary.callsPerTool).reduce((a, b) => a + b, 0) > calls1);
    assert.ok(lines(out).length > lines1, 'soak.jsonl goes on');
    assert.ok(second.state.elapsedMs >= 1_400);
    assert.equal(second.state.startedAt, first.state.startedAt);
  } finally {
    await rig.stop();
  }
});

test('the order takes the areas in turn, shuffled by the seed, the same for the same seed', () => {
  const byArea = Object.fromEntries(AREAS.map((a) => [a, areaTasks(a)]));
  const a = cycleOrder(byArea, 7, 0).map((t) => t.id);
  const b = cycleOrder(byArea, 7, 0).map((t) => t.id);
  const c = cycleOrder(byArea, 7, 1).map((t) => t.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 100);
  assert.equal(new Set(a).size, 100);
  assert.ok(a.slice(0, 10).every((id, i) => id.startsWith(i % 2 === 0 ? 'files-' : 'notebook-')));
});

function soakCli(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [join(HARNESS, 'soak/soak.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => ok({ code, out }));
  });
}

test('the command line soaks a rig, prints its table, and exits 0 when the bar holds', async () => {
  const { rig } = await rigAndDriver();
  try {
    const out = tmp();
    const r = await soakCli(['--target', 'local', '--rig', rig.url, '--duration', '1500ms', '--min-calls', '0', '--out', out, '--faults', 'on', '--fault-every', '300ms', '--mid-delay', '20ms', '--poll', '5ms']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /files_write/);
    assert.match(r.out, /The bar holds\./);
    const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.equal(s.done, true);
    assert.ok(s.runs > 0);
  } finally {
    await rig.stop();
  }
});

test('the command line refuses a desk without the capped key parameter', async () => {
  const r = await soakCli(['--target', 'desk', '--model', 'real', '--duration', '1m', '--out', tmp()], { [KEY_PARAM_ENV]: '' });
  assert.equal(r.code, 2);
  assert.match(r.out, /refuses to run without MA_AGENT_TEST_KEY_PARAM/);
});
