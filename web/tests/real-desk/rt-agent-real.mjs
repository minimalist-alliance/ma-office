// The core's real-desk plan (docs/sub-status/lsub-agent-tools-core.md, "The real-desk proof: a plan, not run", steps 1 to 9)
// with a real model, on the fleet desk (agent-tools/fleet.mjs) and its own Lead and stored key, through the Agent window's UI and
// the Files and Notebook apps' own calls. The ask cases are agent-tools/cases/files.mjs's; what a desk-1 run can't do is here:
// step 6 (desk-agent restarted over SSM while a card waits), step 7's FIFO (mkfifo as uid desk over SSM, removed after), step 8
// (decide to done from the browser's timing of the approval events) and step 9's tint check. "deskd restarted between a yes and
// the call" (step 6's second half) is not run: it can't be timed by hand.
//
//   cd web && flock -w 120 ~/work/.desk-d-teste5h2wnkq.lock timeout 60m env FLEET_DESK_LOCK=held MA_ENV=staging \
//     ~/.local/node-v24/bin/node tests/real-desk/rt-agent-real.mjs [--steps 1,2,3,4,5,6,7,8,9] [--timing-runs 10]
//
// The rules (binding): only d-teste5h2wnkq of fleet-officer in staging's office; Lead and its stored key only (never a key
// typed, added, deleted or rotated, never an agent made); SSM only for steps 6 and 7, only on the instance found read only by
// its tags; every world text carries the run's canary, and no Activity row may hold it; all model work stops at $18 (the
// desk's own counts, real-model/spend.json). Results: real-model/nine-steps.json and shots/nine-steps/.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REGISTERED } from './agent-tools/cases/index.mjs';
import { argsOf, cardMatches, fill, makeCanary, percentile, policyChecks, runChecks, withCanary } from './agent-tools/pure.mjs';
import { RESULTS, STOP_MICRO_USD, lockProblems, readJson, runCost, spendLedger, startFleet, writeJson } from './agent-tools/fleet-run.mjs';
import { ALLOWED } from './agent-tools/fleet.mjs';

const args = argsOf(process.argv.slice(2));
const problems = [...lockProblems(process.env, ALLOWED), ...((process.env.MA_ENV ?? '') === 'staging' ? [] : ['MA_ENV=staging only'])];
if (problems.length) {
  for (const p of problems) console.error(`REFUSED: ${p}`);
  process.exit(2);
}
const STEPS = new Set(String(args.steps ?? '1,2,3,4,5,6,7,8,9').split(',').map((s) => s.trim()));
const TIMING_RUNS = Math.max(1, Math.min(10, Number(args['timing-runs'] ?? 10) || 10));
const OUT_FILE = `${RESULTS}/nine-steps.json`;
/** Step 9's count: the share of a window shot's pixels that are saturated warm (red, orange, yellow, brown) or green hues. */
const TINT_PY = `
import sys, json, colorsys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
warm = green = n = 0
for r, g, b in im.getdata():
    n += 1
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if s < 0.18 or v < 0.15:
        continue
    d = h * 360
    if d < 65 or d >= 330:
        warm += 1
    elif d < 170:
        green += 1
print(json.dumps({'warmShare': warm / n, 'greenShare': green / n, 'pixels': n}))
`;
const SHOTS = `${RESULTS}/shots/nine-steps`;
const CASE_MS = 300_000;
const files = REGISTERED.find((r) => r.tool === 'files');
const caseOf = (id) => files.cases.find((c) => c.id === id);
const canary = makeCanary(randomBytes(8).toString('hex'));
const vars = {
  stamp: Date.now().toString(36) + randomBytes(2).toString('hex'),
  token: `tok${randomBytes(4).toString('hex')}`,
  token2: `tok${randomBytes(4).toString('hex')}`,
  canary,
};
const ledger = spendLedger();
const report = readJson(OUT_FILE, null) ?? { desk: ALLOWED, account: 'fleet-officer', agent: 'Lead', model: null, runs: [] };
const thisRun = { startedAt: new Date().toISOString(), canary, steps: [], stamp: vars.stamp };
report.runs.push(thisRun);
const save = () => writeJson(OUT_FILE, report);
save();

const { lib, driver, lead } = await startFleet({ out: SHOTS, canaries: [canary] });
report.model = lead.model;
const floorSeq = (await driver.audit({ older: false })).entries.at(-1)?.seq ?? 0;
thisRun.auditFloor = floorSeq;
const say = lib.log;

const step = (n, name, data) => {
  const s = { step: n, name, ...data };
  thisRun.steps.push(s);
  say(`${s.result ?? ''} step ${n}: ${name}${s.detail ? `: ${s.detail}` : ''}`);
  save();
  return s;
};
const spendOk = (reserve = 300_000) => {
  if (ledger.left() > reserve) return true;
  say(`STOP: the spend is $${(ledger.total() / 1e6).toFixed(2)}; the rule stops model work at $${STOP_MICRO_USD / 1e6}`);
  return false;
};
/** Each card's untrusted line as the page showed it while the card waited, by approval id. */
const pageUntrusted = new Map();
const headSeq = async () => (await driver.audit({ since: driver.auditSeq() })).entries.at(-1)?.seq ?? driver.auditSeq();

/** The wire's word on a run: `card` while one of its approvals is pending, `settled` once its reply is done, failed or stopped. */
async function waitRun(runId, until) {
  while (Date.now() < until) {
    const s = await driver.snapshot();
    const pending = Object.values(s.approvals).filter((a) => a.runId === runId && a.state === 'pending');
    if (pending.length || (await driver.pendingOnPage(lead.id)) > 0) return 'card';
    const reply = Object.values(s.messages)
      .filter((m) => m.role === 'assistant' && m.runId === runId)
      .sort((a, b) => a.firstAt - b.firstAt)
      .at(-1);
    if (reply && ['done', 'failed', 'stopped'].includes(reply.state)) return 'settled';
    await lib.wait(400);
  }
  return 'timeout';
}

/**
 * One ask: the world laid (with the canary), the words sent to Lead, each card answered as the spec says (or `onCard`), then
 * what the desk shows read back and checked. Gives the step's record, with its cost from the desk's own counts.
 */
async function ask(raw, { onCard = null, label = raw.id } = {}) {
  const c = fill(raw, vars);
  const t0 = Date.now();
  if (c.world) {
    const fs = Object.fromEntries(Object.entries(c.world.files ?? {}).map(([p, t]) => [p, t === null ? null : withCanary(t, canary)]));
    const nb = (c.world.notebook ?? []).map((pg) => ({ ...pg, markdown: withCanary(pg.markdown, canary) }));
    await driver.reset({ files: fs, notebook: nb });
  }
  const seq0 = await headSeq();
  const { runId } = await driver.send(lead.id, c.ask);
  const expected = [...(c.cards ?? [])];
  const decided = new Set();
  const fails = [];
  const notes = [];
  const seen = [];
  const end = t0 + (c.timeoutMs ?? CASE_MS);
  for (;;) {
    const turn = await waitRun(runId, end);
    if (turn === 'settled') break;
    if (turn === 'timeout') {
      fails.push('timed out waiting for the reply');
      break;
    }
    // The wire's pending cards of this run; a card the page draws that the wire never sent (its events gone quiet) by its title.
    const pending = (await driver.cards(lead.id, 'pending')).filter((k) => (k.id ? !decided.has(k.id) && k.wireState === 'pending' && k.runId === runId : !decided.has(`title:${k.title}`)));
    if (!pending.length) {
      await lib.wait(300);
      continue;
    }
    for (const card of pending) {
      decided.add(card.id ?? `title:${card.title}`);
      if (!card.id) notes.push(`the wire never sent the card “${card.title}”: answered from the page alone`);
      // A decided card shows "What it was" without its untrusted line: what the page said is read while it waits.
      pageUntrusted.set(card.id, card.untrusted);
      await driver.shot(`${label}-card-${seen.length + 1}`);
      if (onCard) {
        const r = await onCard(card, { runId, seen });
        seen.push({ card, handled: r });
        if (r === 'stop') return { runId, stopped: true, seq0, t0, notes, fails, seen };
        continue;
      }
      const want = expected.shift();
      if (!want) {
        (c.unexpected === 'decline' ? notes : fails).push(`a card not in the case: “${card.title}” (${card.tool})`);
        await driver.decide(card, false, 'This isn’t part of the test.');
        seen.push({ card, want: null });
        continue;
      }
      const miss = cardMatches(want, card);
      if (miss.length) fails.push(`card ${seen.length + 1}: ${miss.join('; ')}`);
      if (want.before?.editFile) await driver.editFile(want.before.editFile.path, withCanary(want.before.editFile.text, canary));
      const d = want.decide;
      await driver.decide(card, d === 'approve', typeof d === 'object' ? d.decline : undefined);
      seen.push({ card, want });
    }
  }
  if (expected.length) fails.push(`cards never asked: ${expected.map((e) => [].concat(e.tool).join('|')).join(', ')}`);
  return finish(c, { runId, seq0, t0, fails, notes, label });
}

/** What the desk shows after a run, its checks and its cost. */
async function finish(c, { runId, seq0, t0, fails = [], notes = [], label }) {
  const reply = await driver.reply(lead.id, { timeoutMs: 30_000, runId });
  const { files: fl, trash } = await driver.files();
  const pages = await driver.notebook();
  const cost = await runCost(driver, { seq: seq0, runId });
  const audit = cost.audit;
  const wireCards = await driver.wireApprovals(runId);
  const cards = (await driver.runCards(lead.id, runId)).map((k) => (k.id && pageUntrusted.has(k.id) ? { ...k, untrusted: pageUntrusted.get(k.id) } : k));
  const state = { files: fl, trash, pages, reply, cards, wireCards, audit, canary };
  const checks = [...runChecks(c.checks ?? [], state), ...policyChecks({ cards, files: fl, reply, audit, tools: c.tools ?? null, canary })];
  await driver.shot(`${label}-after`);
  const bad = checks.filter((k) => !k.ok);
  const { audit: _a, ...costOut } = cost;
  ledger.add('nine', { item: label, runId, ...costOut });
  return {
    runId,
    ok: fails.length === 0 && bad.length === 0,
    detail: [...fails, ...bad.map((k) => `${k.label}: ${k.detail}`)].join(' | '),
    notes,
    model: {
      reply: { state: reply.state, untrusted: reply.untrusted, untrustedShown: reply.untrustedShown, summary: reply.summary, text: String(reply.text ?? '').slice(0, 800) },
      chips: (reply.chips ?? []).map((ch) => `${ch.name ?? '?'}: ${ch.words} (${ch.result ?? '?'})`),
      cards: cards.map((k) => ({ tool: k.tool, title: k.title, level: k.level, state: k.wireState ?? k.state, untrusted: k.untrusted, wireUntrusted: k.wireUntrusted ?? null, result: k.result ?? null })),
    },
    audit: audit.filter((a) => a.action !== 'llm.call').map((a) => `${a.seq} ${a.action}:${a.decision}${a.tool ? ` ${a.tool}` : ''}`),
    llmCalls: cost.llmCalls,
    costUsd: Math.round(cost.realMicroUsd / 100) / 1e4,
    deskCostUsd: Math.round(cost.microUsd / 100) / 1e4,
    listCostUsd: cost.listMicroUsd == null ? null : Math.round(cost.listMicroUsd / 100) / 1e4,
    checks: checks.map((k) => ({ label: k.label, ok: k.ok, detail: k.detail })),
    ms: Date.now() - t0,
  };
}

const record = (n, name, r) => step(n, name, { result: r.ok ? 'PASS' : 'FAIL', ...r });

try {
  if (STEPS.has('1')) {
    // The window on the real relay: shots now, CSP and console counted for the whole run at its end.
    await driver.shot('step1-window');
    step(1, 'the Agent window opened on the real relay (staging’s own bundle)', { result: 'PENDING', detail: 'CSP and console errors are counted at the end of the run' });
  }
  if (STEPS.has('2') && spendOk()) record(2, 'a save, declined with a note', await ask(caseOf('files-2-decline-note')));
  if (STEPS.has('3') && spendOk()) record(3, 'the same save, approved', await ask(caseOf('files-3-approve')));
  if (STEPS.has('4') && spendOk()) {
    record(4, 'a replace while the member edits the file: changed', await ask(caseOf('files-4-replace-changed')));
    if (spendOk()) record(4, 'the replace again, approved: the old one in the trash', await ask(caseOf('files-4-replace-again')));
  }
  if (STEPS.has('5') && spendOk()) {
    if (args['case-5'] === 'files') {
      // files.mjs's own words: "read it all the way to its end" pages through 150 KB, and Lead's run limit ($2 at the desk's
      // price for this model) stopped it after 4 pages on Nov 13 (limit.hit), and the next ask read it again.
      record(5, 'a long file (over 100 KB) read to its end', await ask(caseOf('files-5-long-read')));
      if (spendOk()) record(5, 'a write after the read asks as untrusted', await ask(caseOf('files-5-write-after-read')));
    } else {
      // Just over 100 KB, and the words leave the model free to use `offset` (the `next` of a page) to reach the end.
      const long = 'Harness/long-{stamp}.txt';
      const text = `${Array.from({ length: 1900 }, (_, i) => `Line ${i + 1}: the ferry leaves at seven forty from pier two.`).join('\n')}\nLast line: {token}`;
      record(
        5,
        'a long file (104 KB) read to its end, page by page',
        await ask({
          id: 'step5-long-read',
          world: { files: { [long]: text } },
          ask: `${long} is a long text file, over 100 KB. Read it with your Files tools a page at a time (you may go on from any page with its offset) until you reach its very end, then tell me the text of its last line exactly.`,
          cards: [],
          unexpected: 'decline',
          checks: [
            { kind: 'reply', state: 'done', contains: ['{token}'] },
            { kind: 'chip', tool: 'files_read' },
            { kind: 'untrusted', value: true },
            { kind: 'audit', actions: ['tool.call'] },
          ],
          tools: ['files_list', 'files_search', 'files_read'],
        }),
      );
      if (spendOk())
        record(
          5,
          'a write after the read asks as untrusted ("This agent has read …")',
          await ask({
            id: 'step5-write-after-read',
            world: null,
            ask: 'Without reading anything again, save a new file at exactly Harness/long-summary-{stamp}.md with exactly this one line: Ferry times from pier two.',
            cards: [{ tool: 'files_write', titleWords: ['Harness/long-summary-{stamp}.md'], untrusted: true, decide: { decline: 'Not now: this is a harness test.' } }],
            checks: [
              { kind: 'cardUntrusted', index: 0, value: true },
              { kind: 'noFile', path: 'Harness/long-summary-{stamp}.md' },
              { kind: 'cardState', index: 0, state: 'declined' },
            ],
          }),
        );
    }
  }

  if (STEPS.has('6') && spendOk()) {
    // desk-agent restarted over SSM while a card waits: the card ends expired (restart) and nothing is written.
    const inst = await lib.findInstance();
    const path = `Harness/restart-${vars.stamp}.md`;
    let ssm = null;
    let restartAt = null;
    const raw = {
      id: 'step6-restart',
      world: { files: { 'Harness/readme.md': 'This folder belongs to the harness.' } },
      ask: `Use your Files tools to save a new file at exactly ${path} with exactly this text and nothing else: Restart test {token}`,
      checks: [{ kind: 'noFile', path }],
    };
    const r0 = await ask(raw, {
      onCard: async (card) => {
        await driver.shot('step6-card-waiting');
        restartAt = Date.now();
        ssm = await lib.ssmRun('systemctl restart desk-agent && sleep 2 && systemctl is-active desk-agent', { timeoutS: 120 });
        say(`SSM restart desk-agent: ${ssm.status} ${ssm.out.trim()}`);
        // The card's end: expired, its detail `restart`, from the window's own events once it reconnects.
        const ended = await (async () => {
          const end = Date.now() + 120_000;
          while (Date.now() < end) {
            const snap = await driver.snapshot();
            const a = snap.approvals[card.id];
            if (a && a.state !== 'pending') return a;
            // The window may never hear of the card's end: the run's reply settling is enough to go and read Activity.
            const reply = Object.values(snap.messages).find((m) => m.role === 'assistant' && m.runId === card.runId && ['stopped', 'failed', 'done'].includes(m.state));
            if (reply) break;
            await lib.wait(1000);
          }
          return (await driver.snapshot()).approvals[card.id] ?? null;
        })();
        card.ended = ended;
        return 'stop';
      },
      label: 'step6',
    });
    const card = r0.seen?.[0]?.card ?? null;
    const ended = card?.ended ?? null;
    await lib.wait(3000);
    const fin = await finish(fill(raw, vars), { runId: r0.runId, seq0: r0.seq0, t0: r0.t0, label: 'step6' });
    // The desk's word is Activity's row (approval.expire, decision restart, for this card's tool); the window's is the card's state.
    const expireRow = (await driver.audit({ since: r0.seq0 })).entries.find((e) => e.action === 'approval.expire' && e.tool === 'files_write');
    const windowSaw = ended && ended.state !== 'pending' ? `${ended.state}${ended.detail ? ` (${ended.detail})` : ''}` : 'still pending on the wire, and the page drew no card after the restart';
    const ok = Boolean(card) && expireRow?.decision === 'restart' && fin.checks.every((k) => k.ok || k.label.startsWith('the reply'));
    record(6, 'desk-agent restarted over SSM while a card waits', {
      ...fin,
      ok,
      detail: [card ? `Activity: ${expireRow ? `${expireRow.action}:${expireRow.decision}` : 'no approval.expire row'}; the window: ${windowSaw}; the reply ${fin.model.reply.state}` : 'no card was asked', fin.detail].filter(Boolean).join(' | '),
      windowSaw,
      instance: { env: inst.env, kind: inst.kind },
      ssm: ssm ? { status: ssm.status, out: ssm.out.trim().slice(0, 200) } : null,
      expiredAfterMs: ended?.states?.find((x) => x.state === 'expired')?.at && restartAt ? ended.states.find((x) => x.state === 'expired').at - restartAt : null,
    });
    step(6, 'deskd restarted between a yes and the call', { result: 'SKIPPED', detail: 'not run: the gap between the yes and the call is milliseconds, so it can’t be timed by hand' });
  }

  if (STEPS.has('7') && spendOk()) {
    record(7, 'a path with a zero-width space: refused, no card', await ask(caseOf('files-7-bad-path')));
    // A FIFO in Harness/ as uid desk (SSM), listed from the Files app's own call and from the agent; then removed (SSM).
    if (spendOk()) {
      await driver.reset({ files: { 'Harness/readme.md': withCanary('This folder belongs to the harness.', canary) } });
      const fifo = `fifo-${vars.stamp}`;
      await lib.findInstance();
      const made = await lib.ssmRun(`set -e; d=/data/files/Harness; test -d "$d"; runuser -u desk -- mkfifo "$d/${fifo}"; stat -c '%U %F' "$d/${fifo}"`, { timeoutS: 60 });
      say(`SSM mkfifo: ${made.status} ${made.out.trim()} ${made.err.trim()}`);
      let filesList = null;
      let agentRun = null;
      try {
        const t = Date.now();
        const l = await driver.page().evaluate(() => window.__rtTools.call('files.list', { path: 'Harness' }));
        filesList = { ok: l.ok, ms: l.ms ?? Date.now() - t, code: l.code ?? null, entries: l.ok ? l.result.entries.map((e) => `${e.name} (${e.type})`) : null };
        agentRun = await ask(
          { id: 'step7-fifo', ask: 'Use your Files tools to list what is in the Harness folder and tell me every name you see, nothing else.', checks: [{ kind: 'reply', state: 'done' }] },
          { label: 'step7-fifo' },
        );
      } finally {
        const gone = await lib.ssmRun(`rm -f /data/files/Harness/${fifo}; test ! -e /data/files/Harness/${fifo} && echo removed`, { timeoutS: 60 });
        say(`SSM rm fifo: ${gone.status} ${gone.out.trim()}`);
        thisRun.fifoRemoved = gone.out.includes('removed');
      }
      thisRun.fifoListed = { files: Boolean(filesList?.entries?.some((e) => e.startsWith(fifo))), agent: String(agentRun?.model?.reply?.text ?? '').includes(fifo) };
      const ok = made.status === 'Success' && filesList?.ok && filesList.ms < 5000 && agentRun?.model?.reply?.state === 'done' && agentRun.ms < 120_000;
      record(7, 'a FIFO (mkfifo as uid desk): listed from Files and from the agent, both at once', {
        ...(agentRun ?? {}),
        ok: Boolean(ok),
        detail: `mkfifo ${made.status} (${made.out.trim()}); files.list ${filesList?.ok ? `${filesList.ms} ms` : filesList?.code}; the agent's run ${agentRun?.model?.reply?.state} in ${agentRun?.ms} ms${agentRun?.detail ? ` | ${agentRun.detail}` : ''}; removed ${thisRun.fifoRemoved}`,
        filesList,
      });
    }
  }

  if (STEPS.has('8') && spendOk()) {
    // Decide to done, from the browser's clock: Approve pressed (the decide call sent) to the approval's `done` event.
    const samples = [];
    const runs = [];
    for (let i = 1; i <= TIMING_RUNS && spendOk(); i += 1) {
      const path = `Harness/timing-${i}-${vars.stamp}.md`;
      const r = await ask(
        {
          id: `step8-${i}`,
          world: i === 1 ? { files: { 'Harness/readme.md': 'This folder belongs to the harness.' } } : null,
          ask: `Save a new file at exactly ${path} with exactly this text and nothing else: timing ${i}`,
          cards: [{ tool: 'files_write', titleWords: [path], decide: 'approve' }],
          unexpected: 'decline',
          checks: [{ kind: 'file', path, contains: [`timing ${i}`] }],
        },
        { label: `step8-${i}` },
      );
      const s = await driver.snapshot();
      const a = Object.values(s.approvals).find((x) => x.runId === r.runId && x.tool === 'files_write');
      const dec = a ? s.decides.find((d) => d.id === a.id) : null;
      const done = a?.states?.find((x) => x.state === 'done')?.at ?? null;
      const ms = dec && done ? done - dec.sentAt : null;
      if (ms != null) samples.push(ms);
      runs.push({ i, ok: r.ok, ms, decideRttMs: dec ? dec.gotAt - dec.sentAt : null, costUsd: r.costUsd, detail: r.detail });
    }
    record(8, `decide to done, ${samples.length} runs`, {
      ok: samples.length >= Math.min(TIMING_RUNS, 3),
      detail: `p50 ${percentile(samples, 50)} ms, p95 ${percentile(samples, 95)} ms over ${samples.length} runs`,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      samples,
      runs,
      costUsd: Math.round(runs.reduce((n, x) => n + (x.costUsd ?? 0), 0) * 1e4) / 1e4,
    });
  }

  if (STEPS.has('9')) {
    // The thread with its cards in Light, Zen and Dark: the Agent window cut out of each, and its pixels counted for warm hues.
    const shots = [];
    for (const theme of ['Light', 'Zen', 'Dark']) {
      try {
        await driver.page().getByRole('button', { name: 'Account', exact: true }).click({ timeout: 5000 });
        await driver.page().getByRole('dialog', { name: 'Account' }).getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: theme }).click({ timeout: 5000 });
        await driver.page().keyboard.press('Escape');
        await lib.wait(600);
        const full = await driver.shot(`step9-${theme.toLowerCase()}`);
        const cut = `${SHOTS}/step9-${theme.toLowerCase()}-window.png`;
        await driver.window().screenshot({ path: cut });
        const tint = JSON.parse(
          execFileSync('python3', ['-I', '-c', TINT_PY, cut], { encoding: 'utf8' }),
        );
        shots.push({ theme, full, window: cut, ...tint });
      } catch (e) {
        shots.push({ theme, error: e.message.split('\n')[0] });
      }
    }
    const warm = shots.filter((s) => s.warmShare + s.greenShare > 0.002);
    step(9, 'shots in Light, Zen and Dark, checked for green, brown or warm tints', { result: shots.every((s) => !s.error) && !warm.length ? 'PASS' : 'FAIL', detail: shots.map((s) => (s.error ? `${s.theme}: ${s.error}` : `${s.theme}: warm ${(s.warmShare * 100).toFixed(2)}% of the window's pixels, green ${(s.greenShare * 100).toFixed(2)}%`)).join('; '), shots });
  }
} catch (e) {
  step('?', 'the run stopped', { result: 'FAIL', detail: e.message });
  await driver.shot('error').catch(() => {});
}

// ----- the whole run: CSP and console, the canary in no Activity row, the world emptied
const snap = await driver.snapshot();
const consoleProblems = lib.events.filter((e) => e.k === 'console' && e.level !== 'warning').length;
const s1 = thisRun.steps.find((s) => s.step === 1);
if (s1) Object.assign(s1, { result: snap.csp.length === 0 && consoleProblems === 0 ? 'PASS' : 'FAIL', detail: `${snap.csp.length} CSP violations${snap.csp.length ? ` (${snap.csp.slice(0, 5).join(', ')})` : ''}, ${consoleProblems} console errors` });
const allRows = (await driver.audit({ since: floorSeq })).entries;
thisRun.canary = { rows: allRows.length, hits: allRows.filter((a) => a.canaryHit).map((a) => a.seq), ok: !allRows.some((a) => a.canaryHit) };
say(`the canary in ${thisRun.canary.hits.length} of ${allRows.length} Activity rows since the run began`);
await driver.reset({}).catch((e) => say(`world not emptied: ${e.message}`));
thisRun.finishedAt = new Date().toISOString();
thisRun.spendUsd = ledger.data.proofs.nine ? Math.round(ledger.data.proofs.nine.microUsd / 100) / 1e4 : 0;
thisRun.windowClosed = await driver.closeWindow();
save();
await lib.shutdown(0, 'done');
