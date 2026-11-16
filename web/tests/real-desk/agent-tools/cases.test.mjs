// The registered cases are valid, and the validator catches what would make a real run do the wrong thing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REGISTERED } from './cases/index.mjs';
import { FIXTURES } from './cases/browser.mjs';
import { pickTools, planLines, validateCases } from './pure.mjs';

const good = () => ({
  tool: 'demo',
  cases: [
    {
      id: 'demo-1',
      world: { files: { 'Harness/a.md': 'x' }, notebook: [{ tab: 'Harness', title: 'P', markdown: '# P' }] },
      ask: 'Save a file at Harness/b.md',
      cards: [{ tool: 'files_write', level: 'change', decide: 'approve' }],
      standIn: [{ calls: [{ name: 'files_write', input: { path: 'Harness/b.md', text: 'x' } }] }, { text: 'Saved.' }],
      checks: [{ kind: 'file', path: 'Harness/b.md' }],
    },
  ],
});

test('every registered case is valid', () => {
  assert.deepEqual(validateCases(REGISTERED), []);
});

test('files, notebook and browser are registered, in that order, with unique ids', () => {
  assert.deepEqual(
    REGISTERED.map((r) => r.tool),
    ['files', 'notebook', 'browser'],
  );
  const ids = REGISTERED.flatMap((r) => r.cases.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('the Files cases follow the core plan: all nine steps are there, run or skipped with a reason', () => {
  const files = REGISTERED.find((r) => r.tool === 'files');
  for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok(files.cases.some((c) => c.from?.startsWith(`core step ${step}`)), `step ${step}`);
  for (const c of files.cases.filter((x) => x.skip)) assert.ok(c.skip.length > 20, c.id);
});

test('every card a case expects is answered, and every world stays in Harness', () => {
  for (const reg of REGISTERED) {
    for (const c of reg.cases) {
      for (const k of c.cards ?? []) assert.ok(k.decide, `${c.id} answers its card`);
      for (const p of Object.keys(c.world?.files ?? {})) assert.match(p, /^Harness\//);
      for (const pg of c.world?.notebook ?? []) assert.equal(pg.tab, 'Harness');
    }
  }
});

test('a decline with a note fits the card’s 500 characters, and nothing is ever submitted by the browser cases', () => {
  for (const reg of REGISTERED) for (const c of reg.cases) for (const k of c.cards ?? []) if (typeof k.decide === 'object') assert.ok(k.decide.decline.length <= 500);
  const browser = REGISTERED.find((r) => r.tool === 'browser');
  const send = browser.cases.flatMap((c) => c.cards ?? []).filter((k) => k.level === 'send');
  assert.ok(send.length > 0);
  for (const k of send) assert.notEqual(k.decide, 'approve');
});

test('the fixtures to host are plain HTML with no script', () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), ['/form.html', '/inject.html', '/thanks.html']);
  for (const html of Object.values(FIXTURES)) assert.doesNotMatch(html, /<script/i);
  assert.match(FIXTURES['/inject.html'], /Harness\/pwned\.md/);
});

test('the validator: a good case passes', () => {
  assert.deepEqual(validateCases([good()]), []);
});

test('the validator: paths outside Harness, in worlds, cards, edits and checks', () => {
  const r = good();
  r.cases[0].world.files = { 'Documents/a.md': 'x' };
  r.cases[0].cards[0].payload = { path: 'Desktop/b.md' };
  r.cases[0].cards[0].before = { editFile: { path: 'Other/c.md', text: 'x' } };
  r.cases[0].checks.push({ kind: 'noFile', path: '../x' });
  r.cases[0].world.notebook[0].tab = 'Work';
  const p = validateCases([r]);
  assert.equal(p.length, 5, p.join('\n'));
});

test('the validator: decide, level, before, checks, kinds, needs and ids', () => {
  const r = good();
  r.cases[0].cards[0].decide = 'maybe';
  r.cases[0].cards[0].level = 'loud';
  r.cases[0].cards[0].before = { reboot: true };
  r.cases[0].checks.push({ kind: 'vibes' });
  r.cases.push({ ...good().cases[0] });
  r.cases.push({ id: 'Bad Id', kind: 'dance', checks: [] });
  r.cases.push({ id: 'demo-4', needs: ['moon'], ask: 'Ask something real', cards: [], checks: [{ kind: 'reply' }] });
  r.cases.push({ id: 'demo-5', kind: 'member', do: { format: 1 }, checks: [{ kind: 'reply' }] });
  r.cases.push({ id: 'demo-6', kind: 'shots' });
  r.cases.push({ id: 'demo-7', ask: 'Ask something real', cards: [], checks: [] });
  const p = validateCases([r]);
  for (const want of ['decides', 'level loud', 'before', 'unknown check vibes', 'the id is taken', 'an id of lower case', 'kind dance', 'unknown need moon', 'do is one of', 'says what to look at', 'at least one check']) assert.ok(p.some((x) => x.includes(want)), `${want} in ${p.join(' | ')}`);
});

test('the plan names every case, its cards and checks, and what this run skips', () => {
  const lines = planLines(REGISTERED, { needs: { fixture: false } });
  for (const reg of REGISTERED) {
    assert.ok(lines.includes(`TOOL ${reg.tool}: ${reg.cases.length} cases (${reg.title})`));
    for (const c of reg.cases) assert.ok(lines.some((l) => l.trimStart().startsWith(c.id)), c.id);
  }
  assert.ok(lines.some((l) => l.includes('browser-3-injection') && l.includes('needs fixture')));
  assert.ok(lines.some((l) => l.includes('card: files_write (change)') && l.includes('then decline, saying')));
  assert.ok(!planLines(REGISTERED, { needs: { fixture: true } }).some((l) => l.includes('needs fixture')));
});

test('--tool picks registered tools, or all of them', () => {
  const names = REGISTERED.map((r) => r.tool);
  assert.deepEqual(pickTools('all', names), names);
  assert.deepEqual(pickTools('notebook,files', names), ['notebook', 'files']);
  assert.throws(() => pickTools('todos', names), /unknown tool todos/);
  assert.throws(() => pickTools(undefined, names), /--tool is one of/);
});
