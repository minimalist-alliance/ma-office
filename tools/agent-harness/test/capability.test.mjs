// The capability runner against the fake rig: a passing task, a failing check, each policy violation detected, the
// canary found in a log, all 100 tasks, the command line, and the desk target's refusals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { runCapability } from '../capability/run.mjs';
import { approvalHash } from '../lib/canonical.mjs';
import { LocalDriver } from '../lib/driver-local.mjs';
import { startFakeRig } from '../lib/fake-rig.mjs';
import { decisionFor, runTask } from '../lib/run-task.mjs';
import { KEY_PARAM_ENV, makeDriver, TargetError } from '../lib/targets.mjs';
import { areaTasks, HARNESS, loadTasks, TASKS_ROOT } from '../lib/tasks.mjs';
import { findViolations, titleMatches } from '../lib/violations.mjs';

const tasks = loadTasks(TASKS_ROOT);
const byTitle = (title) => {
  const t = tasks.find((x) => x.title === title);
  assert.ok(t, title);
  return structuredClone(t);
};
// Scratch folders stay inside this folder, under out/ (ignored by git), and go when the file's tests end.
const made = [];
const tmp = () => {
  mkdirSync(join(HARNESS, 'out', 'test-tmp'), { recursive: true });
  const dir = mkdtempSync(join(HARNESS, 'out', 'test-tmp', 'mm-harness-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

let rig;
let driver;
before(async () => {
  rig = await startFakeRig({ tasks });
  driver = new LocalDriver({ rig: rig.url, pollMs: 5 });
  await driver.start();
});
after(async () => {
  await rig.stop();
});

/** One task through the fake rig with a misbehaviour switched on, then off again. */
async function withInject(inject, task) {
  rig.inject = inject;
  try {
    return await runTask(driver, task, { timeoutMs: 10_000, replySliceMs: 50 });
  } finally {
    rig.inject = {};
  }
}
const kinds = (r) => r.violations.map((v) => v.kind);

test('a passing task: the card asked, approved, run once, its checks and no violation', async () => {
  const r = await runTask(driver, byTitle('Save a new list'), { replySliceMs: 50 });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.cards.map((c) => [c.tool, c.state]), [['files_write', 'done']]);
  assert.deepEqual(r.executed, { files_write: 1 });
  assert.deepEqual(r.calls, { files_write: 1 });
  assert.match(r.canary, /^mmcanary-[0-9a-f]{16}$/);
});

test('a failing check fails the task and says why', async () => {
  const task = byTitle('Save a new list');
  task.checks.push({ kind: 'file', path: 'Harness/trips/packing.md', contains: ['zebra'] });
  const r = await runTask(driver, task, { replySliceMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.passed, false);
  assert.deepEqual(r.violations, []);
  assert.ok(r.failures.some((f) => f.reasons.some((x) => x.includes('lacks "zebra"'))), JSON.stringify(r.failures));
});

test('violation: a gated tool run with no card', async () => {
  const r = await withInject({ ungated: 'files_write' }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('ungated'), JSON.stringify(r.violations));
  assert.equal(r.ok, false);
});

test('violation: one approval run twice', async () => {
  const r = await withInject({ doubleExecute: true }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('double'), JSON.stringify(r.violations));
});

test('violation: a tool outside the policy ran', async () => {
  const r = await withInject({ extraExecution: 'files_search' }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('outside_policy'), JSON.stringify(r.violations));
});

test("violation: a card's title shows another path than the tool ran with", async () => {
  const r = await withInject({ titleMismatch: true }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('card_mismatch'), JSON.stringify(r.violations));
});

test("violation: the tool ran with another payload than the card's", async () => {
  const r = await withInject({ payloadMismatch: true }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('card_mismatch'), JSON.stringify(r.violations));
});

test('violation: a card after an untrusted read that does not say untrusted', async () => {
  const task = byTitle('An injection in a flyer, and the real job done');
  const r = await withInject({ untrustedOff: true }, task);
  assert.ok(kinds(r).includes('untrusted_card'), JSON.stringify(r.violations));
  // And the same task without the misbehaviour has its card marked.
  const clean = await runTask(driver, task, { replySliceMs: 50 });
  assert.deepEqual(clean.violations, []);
  assert.equal(clean.cards[0].untrusted, true);
});

test('violation: the audit chain does not verify', async () => {
  const r = await withInject({ breakAudit: true }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('audit_broken'), JSON.stringify(r.violations));
  // The fake's chain stays broken: start a fresh rig for the tests after this one.
  await rig.stop();
  rig = await startFakeRig({ tasks });
  driver = new LocalDriver({ rig: rig.url, pollMs: 5 });
  await driver.start();
});

test("violation: the run's canary in an audit row", async () => {
  const r = await withInject({ canaryAudit: true }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('canary_audit'), JSON.stringify(r.violations));
});

test("the canary found in desk-agent's log", async () => {
  const r = await withInject({ canaryLog: true }, byTitle('Save a new list'));
  assert.ok(kinds(r).includes('canary_log'), JSON.stringify(r.violations));
  assert.equal(r.ok, false);
});

test('violation: a declined card that ran anyway, seen from the card alone', () => {
  const card = { id: 'ap-1', agentId: 'ag', runId: 'run', tool: 'files_trash', context: 'agent', title: 'Move “Harness/a.md” to the trash', target: { kind: 'file', path: 'Harness/a.md' }, payload: { path: 'Harness/a.md' }, state: 'done', createdAt: 1 };
  card.sha256 = approvalHash(card);
  const v = findViolations({ task: { policy: { tools: ['files_trash'] } }, cards: [card], decisions: new Map([['ap-1', { approve: false }]]), executions: null });
  assert.deepEqual(v.map((x) => x.kind), ['ungated']);
  assert.equal(titleMatches(card), true);
  assert.equal(titleMatches({ ...card, title: 'Move “Harness/b.md” to the trash' }), false);
});

test("the runner's answers from approve", () => {
  const card = { tool: 'files_trash' };
  assert.deepEqual(decisionFor('all', card), { approve: true });
  assert.deepEqual(decisionFor('none', card), { approve: false });
  assert.deepEqual(decisionFor({ declineNote: 'No.' }, card), { approve: false, note: 'No.' });
  assert.deepEqual(decisionFor({ decline: ['files_trash'], note: 'Keep it.' }, card), { approve: false, note: 'Keep it.' });
  assert.deepEqual(decisionFor({ decline: ['files_trash'] }, { tool: 'files_write' }), { approve: true });
});

test('all 100 tasks pass against the fake rig, with 0 violations', async () => {
  const out = tmp();
  const { summary, ok } = await runCapability({ driver, out, timeoutMs: 20_000 });
  const failed = Object.values(summary.areas).flatMap((a) => a.failures);
  assert.deepEqual(failed, []);
  assert.equal(ok, true);
  assert.equal(summary.areas.files.tasks, 50);
  assert.equal(summary.areas.notebook.tasks, 50);
  assert.equal(summary.areas.files.rate, 1);
  const lines = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 100);
  const summaryFile = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summaryFile.areas.notebook.passed, 50);
});

test('a failing area misses the bar, and --only runs one task', async () => {
  const root = tmp();
  const files = areaTasks('files');
  // Two tasks of ten broken is 80%: under the bar.
  const ten = files.slice(0, 10).map((t) => structuredClone(t));
  ten[0].checks.push({ kind: 'reply', contains: ['zebra'] });
  ten[1].checks.push({ kind: 'reply', contains: ['zebra'] });
  mkdirSync(join(root, 'files'), { recursive: true });
  for (const t of ten) writeFileSync(join(root, 'files', `${t.id}.json`), JSON.stringify(t));
  const { summary, ok } = await runCapability({ driver, out: tmp(), areas: ['files'], tasksRoot: root, timeoutMs: 10_000 });
  assert.equal(ok, false);
  assert.equal(summary.areas.files.passed, 8);
  assert.equal(summary.areas.files.meetsBar, false);
  const one = await runCapability({ driver, out: tmp(), areas: ['files', 'notebook'], only: 'notebook-004', timeoutMs: 10_000 });
  assert.deepEqual(Object.keys(one.summary.areas), ['notebook']);
  assert.equal(one.summary.areas.notebook.tasks, 1);
});

function run(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [join(HARNESS, 'capability/run.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => ok({ code, out }));
  });
}

test('the command line runs an area against a rig and exits 0 when the bar holds', async () => {
  const out = tmp();
  const r = await run(['--target', 'local', '--rig', rig.url, '--area', 'notebook', '--out', out, '--poll', '5ms']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /notebook\s+50\s+50\s+100\.0%\s+0\s+met/);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, true);
});

test('the desk target refuses without the capped key parameter, without a real model, and without its driver', async () => {
  await assert.rejects(makeDriver({ target: 'desk', model: 'real', env: {} }), (e) => e instanceof TargetError && e.message.includes(KEY_PARAM_ENV));
  await assert.rejects(makeDriver({ target: 'desk', model: 'stand-in', env: { [KEY_PARAM_ENV]: '/x' } }), /--model real/);
  await assert.rejects(makeDriver({ target: 'desk', model: 'real', env: { [KEY_PARAM_ENV]: '/x' }, deskDriverPath: join(tmp(), 'driver-desk.mjs') }), /isn't there yet/);
  const r = await run(['--target', 'desk', '--model', 'real', '--area', 'files'], { [KEY_PARAM_ENV]: '' });
  assert.equal(r.code, 2);
  assert.match(r.out, /refuses to run without MA_AGENT_TEST_KEY_PARAM/);
});

test('the desk target loads a driver module that exports createDriver', async () => {
  const dir = tmp();
  const path = join(dir, 'driver-desk.mjs');
  writeFileSync(path, "export function createDriver(o) { return { name: 'desk', o, send() {} }; }\n");
  const d = await makeDriver({ target: 'desk', model: 'real', env: { [KEY_PARAM_ENV]: '/param' }, deskDriverPath: path });
  assert.equal(d.name, 'desk');
  assert.equal(d.o.keyParam, '/param');
});

test('the local driver will not talk to anything but loopback', () => {
  assert.throws(() => new LocalDriver({ rig: 'http://example.com:9000' }), /127\.0\.0\.1/);
});
