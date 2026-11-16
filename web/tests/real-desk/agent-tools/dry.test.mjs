// Both scripts' `--dry` (no browser, no AWS), their refusals before a real run, and their usage errors. Every run here stops
// before rt-lib is imported, so nothing can open a browser or reach staging.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const HERE = new URL('..', import.meta.url).pathname;
const run = (script, args, extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['MA_TEST_DESK_LOCK', 'MA_AGENT_TEST_KEY_PARAM', 'MA_AGENT_FIXTURE_BASE', 'MA_EXPECT_VERSION']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, [`${HERE}${script}`, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n') };
};

test('rt-agent-tools --dry: the cases are valid and the plan is printed, with what a real run would need', () => {
  const r = run('rt-agent-tools.mjs', ['--tool', 'all', '--dry']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines[0], 'rt-agent-tools --dry: no browser, no AWS, nothing on the desk');
  assert.match(r.lines[1], /^cases: valid, \d+ in 3 tools \(files, notebook, browser\)$/);
  assert.match(r.out, /a real run would refuse: not under the test desk lock/);
  assert.match(r.out, /MA_AGENT_TEST_KEY_PARAM isn't set/);
  assert.match(r.out, /^TOOL files: /m);
  assert.match(r.out, /^TOOL notebook: /m);
  assert.match(r.out, /^TOOL browser: /m);
  assert.match(r.out, /browser-3-injection .*needs fixture/);
  assert.match(r.out, /files-6-restarts \[core step 6\]: SKIPPED/);
});

test('rt-agent-tools --dry for one tool, and with the lock and the key named', () => {
  const r = run('rt-agent-tools.mjs', ['--tool', 'notebook', '--dry'], { MA_TEST_DESK_LOCK: 'held', MA_AGENT_TEST_KEY_PARAM: '/ma/staging/agent-test-key', MA_AGENT_FIXTURE_BASE: 'https://fixtures.example' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.lines[1], /^cases: valid, 7 in 1 tools \(notebook\)$/);
  assert.match(r.out, /a real run would start/);
  assert.doesNotMatch(r.out, /^TOOL files/m);
});

test('rt-agent-tools refuses a real run off the lock, or with no key, before anything starts', () => {
  const off = run('rt-agent-tools.mjs', ['--tool', 'files']);
  assert.equal(off.code, 2);
  assert.match(off.err, /REFUSED: not under the test desk lock/);
  assert.match(off.err, /flock -w 1800 ~\/work\/\.test-desk\.lock/);
  const noKey = run('rt-agent-tools.mjs', ['--tool', 'files'], { MA_TEST_DESK_LOCK: 'held' });
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /REFUSED: MA_AGENT_TEST_KEY_PARAM isn't set/);
  const prod = run('rt-agent-tools.mjs', ['--tool', 'files'], { MA_TEST_DESK_LOCK: 'held', MA_AGENT_TEST_KEY_PARAM: '/ma/prod/agent-key' });
  assert.equal(prod.code, 2);
  assert.match(prod.err, /must name a parameter under \/ma\/staging\//);
});

test('rt-agent-tools: an unknown tool is a usage error', () => {
  const r = run('rt-agent-tools.mjs', ['--tool', 'todos', '--dry']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown tool todos/);
});

test('rt-agent-perf --dry: the profiles, the measures and their budgets', () => {
  const r = run('rt-agent-perf.mjs', ['--profiles', '30,70,90,lossy', '--runs', '4', '--dry']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines[0], 'rt-agent-perf --dry: no browser, no AWS, nothing on the desk');
  assert.equal(r.lines[1], 'profiles: 30 (round trip 30 ms); 70 (round trip 70 ms); 90 (round trip 90 ms); lossy (round trip 70 ms, 2% held 200 to 400 ms, head-of-line)');
  assert.match(r.lines[2], /^runs: 4 a measure and profile/);
  assert.match(r.out, /key: MA_AGENT_TEST_KEY_PARAM not set, so only the key-less measures/);
  for (const m of ['pendingList', 'setupOpen', 'cardShown', 'decideToStart', 'filesList', 'write', 'notebookRead', 'appendShows']) assert.match(r.out, new RegExp(`^  ${m} `, 'm'));
});

test('rt-agent-perf refuses off the lock, and a bad profile is a usage error', () => {
  const off = run('rt-agent-perf.mjs', ['--profiles', '30']);
  assert.equal(off.code, 2);
  assert.match(off.err, /REFUSED: not under the test desk lock/);
  const bad = run('rt-agent-perf.mjs', ['--profiles', '30,fast', '--dry']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown profile "fast"/);
});

test('rt-agent-tools --model standin --dry: no key needed, and the stand-in’s scripts built from the cases', () => {
  const r = run('rt-agent-tools.mjs', ['--tool', 'all', '--model', 'standin', '--dry']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^model: standin, a scripted stand-in/m);
  assert.doesNotMatch(r.out, /MA_AGENT_TEST_KEY_PARAM isn't set/);
  assert.match(r.out, /^stand-in: 15 scripted prompts, \d+ steps; desk-agent\.env gets one line for the run and goes back byte for byte$/m);
  const withFixture = run('rt-agent-tools.mjs', ['--tool', 'browser', '--model', 'standin', '--dry'], { MA_AGENT_FIXTURE_BASE: 'https://fixtures.example' });
  assert.match(withFixture.out, /^stand-in: 3 scripted prompts/m);
});

test('rt-agent-tools --model standin refuses off the lock, asks for no key on the lock, and an unknown model is a usage error', () => {
  const off = run('rt-agent-tools.mjs', ['--tool', 'files', '--model', 'standin']);
  assert.equal(off.code, 2);
  assert.match(off.err, /REFUSED: not under the test desk lock/);
  assert.doesNotMatch(off.err, /MA_AGENT_TEST_KEY_PARAM/);
  const bad = run('rt-agent-tools.mjs', ['--tool', 'files', '--model', 'gpt', '--dry']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--model is real .* or standin/);
});

test('rt-agent-perf --model standin --dry: every measure, with a script for each model run', () => {
  const r = run('rt-agent-perf.mjs', ['--profiles', '30,lossy', '--runs', '3', '--model', 'standin', '--dry']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /model: standin, .*every measure runs; 12 scripted prompts/);
});
