// To-do dedupe recall with the model naming `same_as` (docs/sub-status/mm-todo-store.md, "Why recall needs the model"), on the
// fleet desk's Lead in chat: the fleet desk has no To-do tools, so the decision `todo_add` asks of the agent ("if it's the same
// task as one already on the list, pass that one's id as same_as") is put to it in batches. Each batch gives the open items
// so far (the first line of every task seen in an earlier batch: an id, when it was added, sender, thread, due, title) and the
// next lines of services/deskd/src/test/resources/todo/dedupe/messages.jsonl in time order (title, sender, thread, due, time),
// and asks for one JSON line per to-do: the id of the open item it repeats, an earlier to-do of the same batch, or `new`.
// Scored against the labels (`task`): precision and recall of `same_as` (targets: recall >= 0.9, precision >= 0.98).
// The labels never reach the desk: ids are opaque (`t001` an open item, `n0001` a line).
//
//   cd web && flock -w 120 ~/work/.desk-d-teste5h2wnkq.lock timeout 120m env FLEET_DESK_LOCK=held MA_ENV=staging \
//     ~/.local/node-v24/bin/node tests/real-desk/rt-dedupe-real.mjs [--batch 90] [--budget-usd 2] [--resume]
//
// Batches of 90 (6 in all) and short rows: every batch's words stay in Lead's one thread and each later batch reads them
// again, so fewer, larger batches keep the cost under $2 (Nov 14: about $0.30 a batch).
//   node tests/real-desk/rt-dedupe-real.mjs --dry      (prints the first batch's prompt and the batch plan: no desk, no model)
//
// The rules are rt-agent-real.mjs's. Results: real-model/dedupe.json (per batch: the model's answers, and the scores).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { argsOf } from './agent-tools/pure.mjs';
import { RESULTS, lockProblems, readJson, runCost, spendLedger, writeJson } from './agent-tools/fleet-run.mjs';

const args = argsOf(process.argv.slice(2));
const SET = fileURLToPath(new URL('../../../services/deskd/src/test/resources/todo/dedupe/messages.jsonl', import.meta.url));
const OUT_FILE = `${RESULTS}/dedupe.json`;
const BATCH = Math.max(10, Math.min(120, Number(args.batch ?? 90) || 90));
const BUDGET = Math.round((Number(args['budget-usd'] ?? 2) || 2) * 1e6);
const RUN_MS = 8 * 60_000;

const lines = readFileSync(SET, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
lines.forEach((l, i) => (l.n = `n${String(i + 1).padStart(4, '0')}`));
const DAY0 = Date.UTC(2026, 10, 1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (l) => {
  const d = new Date(DAY0 + l.day * 86_400_000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${String(Math.floor(l.minute / 60)).padStart(2, '0')}:${String(l.minute % 60).padStart(2, '0')}`;
};
/** One row, short: `t001 Nov 1 07:00 · from alderbrook-elections · th-0001 · due 11-03 · Return your mail ballot by Nov 3`. */
const row = (id, l) => `${id} ${when(l)} · from ${l.contactId.replace(/^c-/, '')} · ${l.threadId} · ${l.due ? `due ${l.due.slice(5)}` : 'no due'} · ${l.title}`;

/** The batches, and before each the open items: the first line of every task seen in an earlier batch, in the order first seen. */
function plan() {
  const batches = [];
  const firstOf = new Map(); // task -> {id, line}
  for (let at = 0; at < lines.length; at += BATCH) {
    const open = [...firstOf.values()];
    const batch = lines.slice(at, at + BATCH);
    batches.push({ index: batches.length, open, batch });
    for (const l of batch) if (!firstOf.has(l.task)) firstOf.set(l.task, { id: `t${String(firstOf.size + 1).padStart(3, '0')}`, line: l });
  }
  return batches;
}

/** The words for one batch: the decision todo_add asks of the agent, with nothing about how the set was made. */
export function promptFor({ open, batch }) {
  return [
    'I want to add these to-dos to my To-do list. Each is one thing I need to do, pulled from one of my emails or chats. Before adding each one, make the call you make with todo_add: if it is the same task as an open to-do already on my list, name that to-do’s id as same_as (the new mention is then merged into it, so the list has no duplicates); if it isn’t, it’s new and gets added.',
    'Go through them in order, as if adding each in turn: a to-do earlier in this list that you called new is on my list by then, so a later repeat of it names that earlier to-do’s id (its n… id). Don’t use any tools for this, and don’t add anything: just decide.',
    'Answer with JSON lines only, one per to-do, in the same order, and nothing else: {"id":"n0001","same_as":"t001"} or {"id":"n0002","same_as":"new"}.',
    '',
    `My open to-dos (${open.length}; id, when added, sender, thread, due (2026), title):`,
    ...(open.length ? open.map((o) => row(o.id, o.line)) : ['(none yet)']),
    '',
    `The to-dos to add (${batch.length}; id, when, sender, thread, due (2026), title):`,
    ...batch.map((l) => row(l.n, l)),
  ].join('\n');
}

/** The model's answers: every {"id": "n…", "same_as": "…"} in its reply, the last one for an id winning. */
export function parseAnswers(text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/\{[^{}]*?"id"\s*:\s*"(n\d{4})"[^{}]*?"same_as"\s*:\s*"([^"]*)"[^{}]*\}/g)) out[m[1]] = m[2].trim();
  for (const m of String(text ?? '').matchAll(/\{[^{}]*?"same_as"\s*:\s*"([^"]*)"[^{}]*?"id"\s*:\s*"(n\d{4})"[^{}]*\}/g)) out[m[2]] ??= m[1].trim();
  return out;
}

/** One batch scored: a line whose task came before (an open item or earlier in the batch) is a positive. */
export function scoreBatch({ open, batch }, answers) {
  const taskOf = new Map(open.map((o) => [o.id, o.line.task]));
  const seen = new Set(open.map((o) => o.line.task));
  const s = { lines: batch.length, positives: 0, tp: 0, fp: 0, fn: 0, missing: 0, wrongTarget: 0, rows: [] };
  for (const l of batch) {
    const positive = seen.has(l.task);
    const a = answers[l.n];
    if (a === undefined) s.missing += 1;
    const said = a && a !== 'new' ? a : null;
    const target = said ? (taskOf.get(said) ?? null) : null;
    const right = said !== null && target === l.task;
    if (positive) s.positives += 1;
    if (right) s.tp += 1;
    else if (said !== null) {
      s.fp += 1;
      if (positive) s.wrongTarget += 1;
    }
    if (positive && !right) s.fn += 1;
    s.rows.push({ n: l.n, said: a ?? null, positive, right });
    taskOf.set(l.n, l.task);
    seen.add(l.task);
  }
  return s;
}

const totals = (batches) => {
  const t = batches.reduce((a, b) => ({ positives: a.positives + b.score.positives, tp: a.tp + b.score.tp, fp: a.fp + b.score.fp, fn: a.fn + b.score.fn, missing: a.missing + b.score.missing, lines: a.lines + b.score.lines, wrongTarget: a.wrongTarget + b.score.wrongTarget }), { positives: 0, tp: 0, fp: 0, fn: 0, missing: 0, lines: 0, wrongTarget: 0 });
  const r4 = (x) => Math.round(x * 10_000) / 10_000;
  return { ...t, recall: t.positives ? r4(t.tp / t.positives) : null, precision: t.tp + t.fp ? r4(t.tp / (t.tp + t.fp)) : null, targets: { recall: 0.9, precision: 0.98 } };
};

const batches = plan();
if (args.dry) {
  console.log(`rt-dedupe-real --dry: ${lines.length} lines, ${new Set(lines.map((l) => l.task)).size} tasks, ${batches.length} batches of ${BATCH}`);
  for (const b of batches) console.log(`  batch ${b.index + 1}: ${b.open.length} open items, ${b.batch.length} to-dos, ~${Math.round(promptFor(b).length / 4)} tokens`);
  console.log('\n--- the first batch\'s words, cut ---\n');
  console.log(promptFor(batches[1] ?? batches[0]).split('\n').slice(0, 12).join('\n'));
  process.exit(0);
}

const problems = [...lockProblems(process.env, 'd-teste5h2wnkq'), ...((process.env.MA_ENV ?? '') === 'staging' ? [] : ['MA_ENV=staging only'])];
if (problems.length) {
  for (const p of problems) console.error(`REFUSED: ${p}`);
  process.exit(2);
}
const { startFleet } = await import('./agent-tools/fleet-run.mjs');
const ledger = spendLedger();
const spent = () => ledger.data.proofs.dedupe?.realMicroUsd ?? 0;
const report = readJson(OUT_FILE, null) ?? { set: 'services/deskd/src/test/resources/todo/dedupe/messages.jsonl', lines: lines.length, batchSize: BATCH, batches: [] };
if (report.batchSize !== BATCH && report.batches.length) throw new Error(`dedupe.json was made with batches of ${report.batchSize}`);
const save = () => {
  report.totals = totals(report.batches);
  report.spendUsd = Math.round(spent() / 1e4) / 100;
  writeJson(OUT_FILE, report);
};
const { lib, driver, lead } = await startFleet({ out: `${RESULTS}/shots/dedupe` });
report.model = lead.model;
const say = lib.log;

async function waitRun(runId, until) {
  while (Date.now() < until) {
    const s = await driver.snapshot();
    if ((await driver.pendingOnPage(lead.id)) > 0) return 'card';
    const reply = Object.values(s.messages)
      .filter((m) => m.role === 'assistant' && m.runId === runId)
      .at(-1);
    if (reply && ['done', 'failed', 'stopped'].includes(reply.state)) return 'settled';
    await lib.wait(500);
  }
  return 'timeout';
}

let stopped = null;
for (const b of batches) {
  if (args.resume && report.batches.some((x) => x.index === b.index && x.state === 'done')) continue;
  if (spent() >= BUDGET || ledger.left() < 600_000) {
    stopped = spent() >= BUDGET ? `this proof's budget ($${BUDGET / 1e6}) is spent` : `the run's stop rule ($18) is near: $${(ledger.total() / 1e6).toFixed(2)}`;
    break;
  }
  const t0 = Date.now();
  const seq0 = (await driver.audit({ since: driver.auditSeq() })).entries.at(-1)?.seq ?? driver.auditSeq();
  const { runId } = await driver.send(lead.id, promptFor(b));
  let turn;
  for (;;) {
    turn = await waitRun(runId, t0 + RUN_MS);
    if (turn !== 'card') break;
    // No tools are wanted: a card is declined, and the run goes on.
    for (const card of await driver.cards(lead.id, 'pending')) await driver.decide(card, false, 'No tools for this one: just decide, in the reply.');
  }
  const reply = await driver.reply(lead.id, { timeoutMs: 20_000, runId });
  const answers = parseAnswers(reply.text);
  const score = scoreBatch(b, answers);
  const cost = await runCost(driver, { seq: seq0, runId });
  const { audit, ...c } = cost;
  ledger.add('dedupe', { item: `batch ${b.index + 1}`, runId, ...c });
  const entry = {
    index: b.index,
    state: reply.state === 'done' && score.missing === 0 ? 'done' : reply.state === 'done' ? 'done' : reply.state,
    replyState: reply.state,
    open: b.open.length,
    toAdd: b.batch.length,
    answered: Object.keys(answers).length,
    score: { ...score, rows: undefined },
    answers: score.rows,
    costUsd: Math.round(cost.realMicroUsd / 100) / 1e4,
    deskCostUsd: Math.round(cost.microUsd / 100) / 1e4,
    usage: cost.usage,
    llmCalls: cost.llmCalls,
    limitHits: cost.limitHits,
    ms: Date.now() - t0,
  };
  report.batches = report.batches.filter((x) => x.index !== b.index);
  report.batches.push(entry);
  report.batches.sort((x, y) => x.index - y.index);
  save();
  say(`batch ${b.index + 1}/${batches.length}: ${reply.state}, ${entry.answered}/${b.batch.length} answered; positives ${score.positives}, right ${score.tp}, wrong ${score.fp}, missed ${score.fn}; $${entry.costUsd} | so far recall ${report.totals.recall}, precision ${report.totals.precision}; total $${(ledger.total() / 1e6).toFixed(2)}`);
  if (reply.state !== 'done') await driver.shot(`batch-${b.index + 1}-${reply.state}`);
}
report.stopped = stopped;
report.ranBatches = report.batches.length;
report.notes = [
  'The fleet desk has no To-do tools: the decision todo_add asks of the agent (same_as or new) was put to Lead in chat, batch by batch, in Lead’s one thread.',
  'A positive is a line whose task came before it (an open item or an earlier line of its batch). Precision counts every same_as named; recall the positives named right.',
];
save();
say(`dedupe: recall ${report.totals.recall}, precision ${report.totals.precision} over ${report.totals.lines} lines (${report.totals.positives} repeats); ${stopped ?? 'all batches run'}`);
await driver.closeWindow();
await lib.shutdown(0, 'done');
