// validate.mjs over all 100 tasks, and over broken ones; and the JSON files being what gen.mjs writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { areaTasks, HARNESS, TASKS_ROOT } from '../lib/tasks.mjs';
import { registryTools, validateAll, validateTask } from '../capability/validate.mjs';

const registry = registryTools();

test('every task file passes: 50 Files and 50 Notebook, ids and prompts unique', () => {
  const { count, problems } = validateAll(TASKS_ROOT);
  assert.deepEqual(problems, []);
  assert.equal(count, 100);
  assert.equal(areaTasks('files').length, 50);
  assert.equal(areaTasks('notebook').length, 50);
});

test("ToolRegistry's names are read from its source, the twelve tools among them", () => {
  assert.ok(registry, 'ToolRegistry.java is in the clone');
  for (const t of ['files_list', 'files_search', 'files_read', 'files_write', 'files_mkdir', 'files_move', 'files_trash', 'notebook_search', 'notebook_list', 'notebook_read', 'notebook_write', 'notebook_trash']) {
    assert.ok(registry.has(t), t);
  }
});

test('the tasks use every tool of both areas', () => {
  const used = new Set([...areaTasks('files'), ...areaTasks('notebook')].flatMap((t) => t.standIn.flatMap((s) => (s.calls ?? []).map((c) => c.name))));
  assert.equal(used.size, 12);
});

test('a broken task gets each of its problems named', () => {
  const task = {
    id: 'files-900',
    area: 'files',
    title: 'Broken',
    prompt: 'A broken task.',
    setup: { files: { 'Elsewhere/a.md': 'x' } },
    approve: { decline: ['files_read'] },
    checks: [{ kind: 'zebra' }, { kind: 'cards', tools: ['files_read'] }, { kind: 'page', tab: 'Nowhere', title: 'X' }],
    policy: { tools: ['files_read'] },
    standIn: [
      { calls: [{ name: 'files_read', input: { path: { $re: { step: 1, pattern: '"x":(\\d+)' } } } }] },
      { calls: [{ name: 'files_write', input: { path: '/etc/passwd', text: 'x', color: 'blue' } }] },
      { calls: [{ name: 'shell_run', input: {} }] },
    ],
  };
  const problems = validateTask(task, { area: 'files', registry });
  const has = (re) => assert.ok(problems.some((p) => re.test(p)), `${re} in:\n${problems.join('\n')}`);
  has(/setup file Elsewhere\/a\.md is outside Harness/);
  has(/approve is/);
  has(/unknown kind zebra/);
  has(/files_read never asks/);
  has(/tab Nowhere isn't one the setup makes/);
  has(/\$re step 1 is not an earlier step/);
  has(/files_write takes no color/);
  has(/files_write path is outside Harness/);
  has(/shell_run isn't in ToolRegistry/);
  has(/policy doesn't cover files_write/);
  has(/the last step must be text alone/);
});

test('a $re to a call a step does not have, or with no capture group, is refused', () => {
  const task = {
    id: 'notebook-901',
    area: 'notebook',
    title: 'Bad refs',
    prompt: 'Bad refs.',
    setup: {},
    approve: 'all',
    checks: [{ kind: 'reply', contains: [] }],
    policy: { tools: ['notebook_list', 'notebook_read'] },
    standIn: [
      { calls: [{ name: 'notebook_list', input: {} }] },
      { calls: [{ name: 'notebook_read', input: { pageId: { $re: { step: 0, call: 2, pattern: '"pageId":"([^"]+)"' } } } }] },
      { calls: [{ name: 'notebook_read', input: { pageId: { $re: { step: 0, pattern: 'pageId' } } } }] },
      { text: 'Done.' },
    ],
  };
  const problems = validateTask(task, { area: 'notebook', registry });
  assert.ok(problems.some((p) => /\$re call 2 is not a call of step 0/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /no capture group/.test(p)), problems.join('\n'));
});

test("the JSON files are exactly what gen.mjs writes", () => {
  const r = spawnSync(process.execPath, [join(HARNESS, 'capability/gen.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('validate.mjs as a command exits 0 and says how many', () => {
  const r = spawnSync(process.execPath, [join(HARNESS, 'capability/validate.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /100 tasks \(files 50, notebook 50\), 0 problems/);
});
