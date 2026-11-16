// The driver's pure parts: a card read off the page and paired with the wire, the Notebook's pages in and out, the guards,
// the checks, and the perf numbers. No browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harnessName, LEFTOVER, pairCards, parseCard } from './driver-desk.mjs';
import {
  allowedMethod,
  cardMatches,
  docToText,
  fill,
  harnessPath,
  judge,
  junitXml,
  makeCanary,
  MEASURES,
  mdToDoc,
  ours,
  percentile,
  policyChecks,
  preconditions,
  redactor,
  runChecks,
  stats,
  stripCanary,
  withCanary,
} from './pure.mjs';

const rows = (...pairs) => pairs.map(([label, value]) => ({ label, value }));

test('a save card: tool, path and text from its rows', () => {
  const c = parseCard({ title: 'Save “Harness/a.md” in your Files', level: 'change', state: 'pending', rows: rows(['Tool', 'Files · Save a file'], ['File', 'Harness/a.md'], ['Text', 'tent\nstove']), untrustedLine: false, note: null });
  assert.equal(c.tool, 'files_write');
  assert.deepEqual(c.payload, { path: 'Harness/a.md', text: 'tent\nstove' });
  assert.equal(c.untrusted, false);
  assert.equal(c.level, 'change');
});

test('a replace card says replace, by its row or its title', () => {
  const byRow = parseCard({ title: 'Replace “Harness/a.md” in your Files', rows: rows(['Tool', 'Files · Save a file'], ['File', 'Harness/a.md'], ['Replaces', 'The file there now (12 bytes)'], ['Text', 'v2']) });
  assert.equal(byRow.payload.replace, true);
  const byTitle = parseCard({ title: 'Replace “Harness/a.md” in your Files', rows: rows(['Tool', 'Files · Save a file'], ['File', 'Harness/a.md'], ['Text', 'v2']) });
  assert.equal(byTitle.payload.replace, true);
});

test('Notebook cards: create, append and change text, by the title', () => {
  const made = parseCard({ title: 'Make the page “Log 1” in Notebook', rows: rows(['Tool', 'Notebook · Write in a page'], ['Text', 'Started']) });
  assert.deepEqual(made.payload, { op: 'create', new: { title: 'Log 1' }, markdown: 'Started' });
  const add = parseCard({ title: 'Add to “Plan”', rows: rows(['Tool', 'Notebook · Write in a page'], ['Page', 'Plan'], ['Text', 'More']) });
  assert.deepEqual(add.payload, { op: 'append', page: 'Plan', markdown: 'More' });
  const change = parseCard({ title: 'Change text in “Plan”', rows: rows(['Tool', 'Notebook · Write in a page'], ['Page', 'Plan'], ['Find', 'old'], ['Replace with', 'new']) });
  assert.deepEqual(change.payload, { op: 'replace_text', find: 'old', page: 'Plan', markdown: 'new' });
  const trash = parseCard({ title: 'Move “Plan” to Trash', rows: rows(['Tool', 'Notebook · Move a page to Trash'], ['Page', 'Plan']) });
  assert.equal(trash.tool, 'notebook_trash');
});

test('a Browser click in the member’s session, and a tool the app doesn’t know', () => {
  const click = parseCard({ title: 'Click “Submit order” (button) on shop.example', level: 'send', rows: rows(['Tool', 'Browser · Click'], ['What', '“Submit order” (button)'], ['Site', 'https://shop.example'], ['Uses', 'Your signed-in session on shop.example']) });
  assert.equal(click.tool, 'browser_click');
  assert.equal(click.payload.origin, 'https://shop.example');
  assert.equal(click.memberSession, 'Your signed-in session on shop.example');
  const other = parseCard({ title: 'Add a to-do', rows: rows(['Tool', 'todo_create'], ['text', 'Buy milk']) });
  assert.equal(other.tool, 'todo_create');
  assert.deepEqual(other.payload, { text: 'Buy milk' });
});

test('untrusted: the card’s line, or the taint note in its place', () => {
  assert.equal(parseCard({ title: 't', rows: [], untrustedLine: true }).untrusted, true);
  assert.equal(parseCard({ title: 't', rows: [], note: 'It asks because this task has read your notes and pages from other sites, and an address can carry what it read.' }).untrusted, true);
  assert.equal(parseCard({ title: 't', rows: [], note: 'You can bring it back from the Trash in Files.' }).untrusted, false);
});

test('cards pair with the wire by order and tool, never across tools', () => {
  const dom = [parseCard({ title: 'Save “Harness/a.md” in your Files', state: 'pending', rows: rows(['Tool', 'Files · Save a file'], ['File', 'Harness/a.md'], ['Text', 'x']) }), parseCard({ title: 'Move “Plan” to Trash', state: 'pending', rows: rows(['Tool', 'Notebook · Move a page to Trash'], ['Page', 'Plan']) })];
  const wire = [
    { id: 'ap2', tool: 'notebook_trash', state: 'pending', createdAt: 2, runId: 'r', untrusted: true, sha256: 'b'.repeat(64), risk: 'delete' },
    { id: 'ap1', tool: 'files_write', state: 'pending', createdAt: 1, runId: 'r', untrusted: false, sha256: 'a'.repeat(64), risk: 'write' },
  ];
  const p = pairCards(dom, wire);
  assert.deepEqual(
    p.map((c) => [c.id, c.tool, c.wireUntrusted]),
    [
      ['ap1', 'files_write', false],
      ['ap2', 'notebook_trash', true],
    ],
  );
  const lone = pairCards([dom[1]], [wire[1]]);
  assert.equal(lone[0].paired, false);
  // A card the page still draws as pending, already approved on the wire.
  assert.equal(pairCards([dom[0]], [{ ...wire[1], state: 'approved' }])[0].id, 'ap1');
});

test('a card spec against the card: tool (one of several), title words, level, untrusted, payload', () => {
  const card = parseCard({ title: 'Save “Harness/a.md” in your Files', level: 'change', rows: rows(['Tool', 'Files · Save a file'], ['File', 'Harness/a.md'], ['Text', 'tent tok1']) });
  assert.deepEqual(cardMatches({ tool: 'files_write', level: 'change', titleWords: ['Save', 'Harness/a.md'], payload: { path: 'Harness/a.md', textHas: ['tok1'] } }, card), []);
  assert.deepEqual(cardMatches({ tool: ['browser_click', 'files_write'] }, card), []);
  const miss = cardMatches({ tool: 'files_trash', level: 'send', untrusted: true, payload: { path: 'Harness/b.md', textHas: ['tok2'] } }, card);
  assert.equal(miss.length, 5);
});

test('Markdown to a page and back: title, headings, lists, checklists', () => {
  const doc = mdToDoc('Plan', '# Plan\nToken: abc\n- tent\n- stove\n\n## Later\n- [x] booked\n- [ ] packed\n1. one\n2. two');
  assert.equal(doc.content[0].type, 'heading');
  assert.equal(doc.content[0].attrs.level, 1);
  assert.equal(docToText(doc), '# Plan\nToken: abc\n- tent\n- stove\n## Later\n- [x] booked\n- [ ] packed\n1. one\n2. two');
  const titled = mdToDoc('Log', 'Started');
  assert.equal(docToText(titled), '# Log\nStarted');
});

test('the canary: on its own last line, and taken out for checks', () => {
  const c = makeCanary('0123456789abcdef');
  assert.equal(c, 'mmcanary-0123456789abcdef');
  const t = withCanary('one\ntwo\n', c);
  assert.equal(t, `one\ntwo\n${c}\n`);
  assert.equal(stripCanary(t, c), 'one\ntwo');
  assert.equal(stripCanary(`a\n${c}x\n`, c), `a\n${c}x`, 'only a line that is exactly the canary goes');
});

test('vars fill strings, keys and lists, and leave the rest', () => {
  const v = fill({ 'Harness/{stamp}.md': ['x {token}', 3, true, null], re: /a/ }, { stamp: 's1', token: 't1' });
  assert.deepEqual(v['Harness/s1.md'], ['x t1', 3, true, null]);
  assert.ok(v.re instanceof RegExp);
  assert.equal(fill('{unknown}', {}), '{unknown}');
});

test('the guards: Harness only, the apps’ methods only', () => {
  assert.equal(harnessPath('Harness/a/b.md'), 'Harness/a/b.md');
  assert.equal(harnessPath('Harness/dir/'), 'Harness/dir');
  for (const bad of ['Documents/a.md', 'Harness/../x', '/Harness/a', 'Harness//a', 'Harness\\a', 'Harnessx/a', '']) assert.throws(() => harnessPath(bad), /refusing/, bad);
  assert.equal(allowedMethod('files.list', 'full'), true);
  assert.equal(allowedMethod('notebook.page.import', 'full'), true);
  assert.equal(allowedMethod('agent.approvals.list', 'full'), false, 'an agent answer never crosses to Node');
  assert.equal(allowedMethod('agent.approvals.list', 'timing'), true);
  assert.equal(allowedMethod('agent.approval.decide', 'timing'), false);
  assert.equal(allowedMethod('files.trash.empty', 'full'), false);
  assert.equal(allowedMethod('browser.tab.list', 'full'), false);
});

test('preconditions: the lock, and the key’s parameter under /ma/staging/', () => {
  assert.equal(preconditions({}).ok, false);
  assert.match(preconditions({}).problems.join(' '), /lock/);
  assert.match(preconditions({ MA_TEST_DESK_LOCK: 'held' }).problems.join(' '), /MA_AGENT_TEST_KEY_PARAM/);
  assert.equal(preconditions({ MA_TEST_DESK_LOCK: 'held' }, { needKey: false }).ok, true);
  // The lock file's probe (Security's MMH-I2): only a held lock goes; free or unknown (no flock) is refused.
  assert.equal(preconditions({ MA_TEST_DESK_LOCK: 'held' }, { needKey: false, lock: 'held' }).ok, true);
  assert.equal(preconditions({ MA_TEST_DESK_LOCK: 'held' }, { needKey: false, lock: 'free' }).ok, false);
  assert.equal(preconditions({ MA_TEST_DESK_LOCK: 'held' }, { needKey: false, lock: 'unknown' }).ok, false);
  assert.equal(preconditions({ MA_TEST_DESK_LOCK: 'held', MA_AGENT_TEST_KEY_PARAM: '/ma/prod/agent-key' }).ok, false);
  assert.equal(preconditions({ MA_TEST_DESK_LOCK: 'held', MA_AGENT_TEST_KEY_PARAM: '/ma/staging/../prod/x' }).ok, false);
  const ok = preconditions({ MA_TEST_DESK_LOCK: 'held', MA_AGENT_TEST_KEY_PARAM: '/ma/staging/agent-test-key' });
  assert.deepEqual([ok.ok, ok.keyParam], [true, '/ma/staging/agent-test-key']);
});

test('the redactor takes every copy of a secret out', () => {
  const r = redactor(['sk-made-up-0000000000', 'short']);
  assert.equal(r('a sk-made-up-0000000000 b sk-made-up-0000000000'), 'a [redacted] b [redacted]');
  assert.equal(r('short stays: too short to be a key'), 'short stays: too short to be a key');
});

test('checks: files, trash, pages, the reply, cards, chips, summary, taint, audit', () => {
  const canary = makeCanary('ffffffffffffffff');
  const state = {
    canary,
    files: { 'Harness/a.md': `tent\n${canary}\n`, 'Harness/dir/': null },
    trash: ['old.md'],
    pages: [{ tab: 'Harness', title: 'Plan', text: `# Plan\nToken: abc\n${canary}`, trashed: false }, { tab: 'Harness', title: 'Gone', text: '', trashed: true }],
    reply: { state: 'done', text: 'The token is ABC.', untrusted: true, untrustedShown: true, summary: '2 tools · 1 approved by you', chips: [{ name: 'files_write', words: 'Saved a file Harness/a.md', session: null }] },
    cards: [{ title: 'Save “Harness/a.md” in your Files', untrusted: true, wireUntrusted: true }],
    wireCards: [{ tool: 'files_write', state: 'failed', result: { ok: false, error: 'changed' } }],
    audit: [
      { seq: 5, action: 'approval.ask', decision: 'asked' },
      { seq: 6, action: 'approval.decide', decision: 'declined' },
    ],
  };
  const res = runChecks(
    [
      { kind: 'file', path: 'Harness/a.md', equals: 'tent' },
      { kind: 'noFile', path: 'Harness/b.md' },
      { kind: 'trashed', name: 'old.md' },
      { kind: 'page', tab: 'Harness', title: 'Plan', contains: ['abc'], notContains: [canary] },
      { kind: 'noPage', tab: 'Harness', title: 'Gone' },
      { kind: 'reply', state: 'done', contains: ['abc'] },
      { kind: 'cards', tools: ['files_write'] },
      { kind: 'cardState', index: 0, state: 'failed', error: 'changed' },
      { kind: 'cardUntrusted', index: 0, value: true },
      { kind: 'noCard', titleWords: ['pwned'] },
      { kind: 'chip', tool: 'files_write', words: 'saved a file' },
      { kind: 'summary', contains: ['1 approved by you'] },
      { kind: 'untrusted', value: true },
      { kind: 'audit', actions: ['approval.ask', 'approval.decide'], decision: 'declined' },
    ],
    state,
  );
  assert.deepEqual(
    res.filter((r) => !r.ok).map((r) => `${r.kind}: ${r.detail}`),
    [],
  );
  const bad = runChecks([{ kind: 'file', path: 'Harness/a.md', contains: ['stove'] }, { kind: 'noFile', path: 'Harness/a.md' }, { kind: 'audit', actions: ['tool.call'] }, { kind: 'nonsense' }], state);
  assert.deepEqual(
    bad.map((r) => r.ok),
    [false, false, false, false],
  );
});

test('policy: an approved write wrote the card’s text; untrusted on the page as on the wire; once; tools; the canary', () => {
  const canary = makeCanary('0000000000000000');
  const good = policyChecks({
    canary,
    cards: [{ title: 'Save', tool: 'files_write', wireState: 'done', payload: { path: 'Harness/a.md', text: 'tent' }, untrusted: true, wireUntrusted: true }],
    files: { 'Harness/a.md': 'tent' },
    reply: { chips: [{ name: 'files_write', approvalId: 'ap1' }] },
    audit: [{ seq: 1, canaryHit: false }],
    tools: ['files_write'],
  });
  assert.deepEqual(
    good.filter((c) => !c.ok),
    [],
  );
  const bad = policyChecks({
    canary,
    cards: [{ title: 'Save', tool: 'files_write', wireState: 'done', payload: { path: 'Harness/a.md', text: 'tent' }, untrusted: false, wireUntrusted: true }],
    files: { 'Harness/a.md': 'something else' },
    reply: { chips: [{ name: 'files_write', approvalId: 'ap1' }, { name: 'files_trash', approvalId: 'ap1' }] },
    audit: [{ seq: 1, canaryHit: true }],
    tools: ['files_write'],
  });
  assert.equal(bad.filter((c) => !c.ok).length, 5);
});

test('percentiles, stats, ours and the budgets', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 50), null);
  assert.deepEqual(stats([10, NaN, 30, 20]), { n: 3, p50: 20, p95: 30, min: 10, max: 30 });
  assert.equal(ours(180, 'pendingList', 70), 110);
  assert.equal(ours(180, 'write', 70), 180, 'a desk-side measure takes no round trip off');
  assert.equal(ours(20, 'filesList', 70), 0);
  const all = (oursP95) => Object.fromEntries(Object.keys(MEASURES).map((k) => [k, { n: 5, oursP95 }]));
  assert.deepEqual(judge([{ name: '70', measures: all(10) }], { withKey: true }), []);
  const miss = judge([{ name: '70', measures: { ...all(10), pendingList: { n: 5, oursP95: 101 }, write: { n: 0 } } }], { withKey: true });
  assert.deepEqual(
    miss.map((m) => m.measure),
    ['pendingList', 'write'],
  );
  assert.deepEqual(judge([{ name: '30', measures: { pendingList: { n: 3, oursP95: 5 }, setupOpen: { n: 3, oursP95: 5 } } }], { withKey: false }), [], 'key measures aren’t expected with no key');
});

test('JUnit for the regression controller', () => {
  const x = junitXml('rt-agent-tools', [
    { name: 'files/a', ok: true },
    { name: 'files/b <x>', ok: false, detail: 'card “x” & more' },
    { name: 'browser/c', ok: true, skipped: true, detail: 'needs fixture' },
  ]);
  assert.match(x, /tests="3" failures="1" skipped="1"/);
  assert.match(x, /name="files\/b &lt;x&gt;"/);
  assert.match(x, /<failure message="card “x” &amp; more"\/>/);
  assert.match(x, /<skipped message="needs fixture"\/>/);
});

test('the test agent’s name fits an agent name and a key label, and a crashed run’s leftovers are found by it alone', () => {
  const n = harnessName(new Date(2026, 10, 13, 15, 4, 5));
  assert.equal(n, 'Harness 1113-150405');
  assert.ok(n.length <= 24);
  assert.ok(LEFTOVER.test(n));
  assert.ok(LEFTOVER.test(`${n} b`));
  assert.ok(!LEFTOVER.test('Harness'));
  assert.ok(!LEFTOVER.test('Researcher'));
});
