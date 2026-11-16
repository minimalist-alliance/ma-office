// standin_desk.py on this machine's loopback (python3 -I, a free port, a temp scripts file): the key, /v1/models, a script
// by its prompt, the step by the assistant turns after it, `$re` from an earlier result, the canary on what it writes,
// readAll through each page's `next`, and the cases' scripts built for a run. No desk, no browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REGISTERED } from './cases/index.mjs';
import { fill, standInProblems, standInScripts } from './pure.mjs';

const KEY = 'sk-ant-harness-standin-000000000000000000000000';
const CANARY = 'mmcanary-0123456789abcdef';
const PLAN = 'Find the page Plan x1 and tell me its token.';
const READ = 'Read Harness/long.txt to its end.';
let dir;
let child;
let url;

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rt-standin-'));
  const scripts = standInScripts(
    [
      {
        prompt: PLAN,
        steps: [
          { calls: [{ name: 'notebook_list', input: {} }] },
          { calls: [{ name: 'notebook_write', input: { pageId: { $re: { step: 0, call: 0, pattern: '"pageId":"([^"]+)","title":"Plan x1"' } }, op: 'append', markdown: 'More' } }] },
          { text: 'Done with Plan x1.' },
        ],
      },
      { prompt: READ, steps: [{ readAll: { path: 'Harness/long.txt', pattern: 'Last line: (tok[0-9a-f]+)', say: 'It says {match}.' } }] },
    ],
    CANARY,
  );
  writeFileSync(join(dir, 'scripts.json'), JSON.stringify(scripts));
  const port = await freePort();
  child = spawn('python3', ['-I', new URL('./standin_desk.py', import.meta.url).pathname, String(port), join(dir, 'scripts.json'), KEY, dir], { stdio: 'ignore' });
  url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`${url}/v1/models`, { headers: { 'x-api-key': KEY } });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('the stand-in never came up');
});

after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** The step's blocks, read back from its SSE as desk-agent reads them. */
async function step(messages) {
  const r = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: true, messages }) });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const events = (await r.text())
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  const out = [];
  for (const e of events) {
    if (e.type === 'content_block_start') out[e.index] = e.content_block.type === 'text' ? { text: '' } : { id: e.content_block.id, name: e.content_block.name, json: '' };
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') out[e.index].text += e.delta.text;
    if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') out[e.index].json += e.delta.partial_json;
  }
  assert.equal(events[0].type, 'message_start');
  assert.equal(events.at(-1).type, 'message_stop');
  return out.map((b) => (b.name ? { id: b.id, name: b.name, input: JSON.parse(b.json) } : b));
}
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (blocks) => ({ role: 'assistant', content: blocks.map((b) => (b.name ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : { type: 'text', text: b.text })) });
const result = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] });

test('the key, and /v1/models with one model', async () => {
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  assert.equal((await fetch(`${url}/v1/models`, { headers: { 'x-api-key': 'sk-ant-other' } })).status, 401);
  const m = await (await fetch(`${url}/v1/models`, { headers: { 'x-api-key': KEY } })).json();
  assert.deepEqual(
    m.data.map((x) => x.id),
    ['claude-sonnet-5-5'],
  );
});

test('a script by its prompt, step by step, with $re from an earlier result and the canary on what it writes', async () => {
  const thread = [user('An earlier question.'), assistant([{ text: 'An earlier answer.' }]), user(PLAN)];
  const s0 = await step(thread);
  assert.deepEqual([s0[0].name, s0[0].input], ['notebook_list', {}]);
  // desk-agent fences a result; the stand-in reads the fence's content.
  const fenced = `Approved by the member.\n${JSON.stringify({ source: 'notebook_list', content: JSON.stringify({ pages: [{ pageId: 'pg7', title: 'Plan x1' }] }) })}`;
  const t1 = [...thread, assistant(s0), result(s0[0].id, fenced)];
  const s1 = await step(t1);
  assert.equal(s1[0].name, 'notebook_write');
  assert.deepEqual(s1[0].input, { pageId: 'pg7', op: 'append', markdown: `More\n${CANARY}` });
  const s2 = await step([...t1, assistant(s1), result(s1[0].id, 'The member declined this; nothing was done.')]);
  assert.deepEqual(s2, [{ text: 'Done with Plan x1.' }]);
});

test('a trailing canary line, a summary before the prompt, and an unknown message', async () => {
  const withCanary = await step([user(`${PLAN}\ncanary: ${CANARY}`)]);
  assert.equal(withCanary[0].name, 'notebook_list');
  const joined = await step([user(`A summary of earlier turns.\n\n${PLAN}`)]);
  assert.equal(joined[0].name, 'notebook_list');
  assert.deepEqual(await step([user('Something no script knows.')]), [{ text: "I don't know this task." }]);
});

test('an unresolved $re ends the run with words, not a call', async () => {
  const s0 = await step([user(PLAN)]);
  const s1 = await step([user(PLAN), assistant(s0), result(s0[0].id, '{"pages": []}')]);
  assert.match(s1[0].text, /couldn't find what I needed/);
});

test('readAll: files_read from the start and on by each next, then the reply with the match', async () => {
  const t = [user(READ)];
  const r0 = await step(t);
  assert.deepEqual([r0[0].name, r0[0].input], ['files_read', { path: 'Harness/long.txt' }]);
  const t1 = [...t, assistant(r0), result(r0[0].id, JSON.stringify({ path: 'Harness/long.txt', text: 'Line 1\nLine 2', next: 13 }))];
  const r1 = await step(t1);
  assert.deepEqual(r1[0].input, { path: 'Harness/long.txt', offset: 13 });
  const t2 = [...t1, assistant(r1), result(r1[0].id, JSON.stringify({ path: 'Harness/long.txt', text: 'Line 3\nLast line: tok1a2b3c4d', next: null }))];
  assert.deepEqual(await step(t2), [{ text: 'It says tok1a2b3c4d.' }]);
});

test('every case that asks has stand-in steps, and a run’s scripts give each its own prompt', () => {
  for (const reg of REGISTERED) {
    for (const c of reg.cases) {
      if (c.skip || (c.kind ?? 'ask') !== 'ask') continue;
      assert.deepEqual(standInProblems(c.standIn), [], c.id);
    }
  }
  const vars = { stamp: 's1', token: 'tokA', token2: 'tokB', canary: CANARY, fixture: 'https://fixtures.example', form: 'https://forms.example/form.html' };
  const entries = REGISTERED.flatMap((r) => r.cases.filter((c) => !c.skip && (c.kind ?? 'ask') === 'ask').map((c) => ({ prompt: fill(c.ask, vars), steps: fill(c.standIn, vars) })));
  const sc = standInScripts(entries, CANARY);
  assert.equal(Object.keys(sc.prompts).length, entries.length);
  assert.equal(sc.canary, CANARY);
  const patterns = JSON.stringify(sc).match(/"pattern":"((?:[^"\\]|\\.)*)"/g) ?? [];
  assert.ok(patterns.some((p) => p.includes('Plan s1')), 'the page patterns are filled in');
  assert.ok(!JSON.stringify(sc).includes('{stamp}'));
  assert.throws(() => standInScripts([entries[0], entries[0]]), /two cases ask the same thing/);
});

test('stand-in steps: what the validator refuses', () => {
  assert.deepEqual(standInProblems([{ text: 'hi' }]), []);
  assert.match(standInProblems(undefined)[0], /missing/);
  assert.match(standInProblems([])[0], /list of steps/);
  assert.match(standInProblems([{ shout: 1 }]).join(' '), /one of calls, text or readAll/);
  assert.match(standInProblems([{ calls: [{ input: {} }] }]).join(' '), /tool name and an input/);
  assert.match(standInProblems([{ readAll: { path: 'p', pattern: 'x' } }, { text: 'after' }]).join(' '), /last step/);
  assert.match(standInProblems([{ calls: [{ name: 'files_read', input: { path: { $re: { step: 0, pattern: 'x' } } } }] }]).join(' '), /can't have/);
});
