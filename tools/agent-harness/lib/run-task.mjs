// One task through a driver, as both runners do it: reset the world, a new agent, the prompt with the canary line,
// cards answered by the task's `approve`, the reply waited for, then its checks and the policy violations.
import { sleep } from './args.mjs';
import { makeCanary, promptWithCanary, worldWithCanary } from './canary.mjs';
import { runChecks } from './checks.mjs';
import { findViolations } from './violations.mjs';

/** The runner's answer to a card, from the task's `approve`. */
export function decisionFor(approve, card) {
  if (approve === undefined || approve === 'all') return { approve: true };
  if (approve === 'none') return { approve: false };
  if (approve && typeof approve === 'object') {
    if (typeof approve.declineNote === 'string') return { approve: false, note: approve.declineNote };
    if (Array.isArray(approve.decline)) {
      return approve.decline.includes(card.tool) ? { approve: false, note: approve.note } : { approve: true };
    }
  }
  return { approve: true };
}

/** A read tried again on errors until it works or the time is up; then its last error is thrown. */
export async function retry(read, forMs) {
  const deadline = Date.now() + forMs;
  while (true) {
    try {
      return await read();
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(250);
    }
  }
}

/** tool.call rows counted by tool: their target starts `tool:<name> `. */
export function auditCalls(rows) {
  const out = {};
  for (const row of rows ?? []) {
    if (row.action !== 'tool.call') continue;
    const m = /^tool:([a-z0-9_]+)/.exec(String(row.target ?? ''));
    if (m) out[m[1]] = (out[m[1]] ?? 0) + 1;
  }
  return out;
}

export function executionCalls(executions) {
  const out = {};
  for (const e of executions ?? []) out[e.tool] = (out[e.tool] ?? 0) + 1;
  return out;
}

/**
 * Runs one task. Never throws for what the run did; a driver that can't be reached throws.
 * @param {object} driver a Driver (contract section 4)
 * @param {object} task a task file's contents
 * @param {object} [o]
 * @param {number} [o.timeoutMs] how long the run may take to end (10 minutes)
 * @param {Set<string>} [o.autoGroups] auto groups the runner switched on (none by default)
 * @param {object} [o.hooks] afterSend({agentId}), onCard({agentId, card}): the soak's fault points
 * @param {number} [o.replySliceMs] how long one reply() wait lasts before the cards are looked at again: reply() waits
 *     while a card is pending (contract section 4), so the runner asks for it in short slices and answers cards between
 */
export async function runTask(driver, task, { timeoutMs = 600_000, autoGroups = new Set(), hooks = {}, replySliceMs = 300, readRetryMs = 30_000 } = {}) {
  const t0 = Date.now();
  const canary = makeCanary();
  const result = {
    id: task.id,
    area: task.area,
    title: task.title,
    ok: false,
    passed: false,
    ended: false,
    failures: [],
    violations: [],
    notes: [],
    ms: 0,
    canary,
  };
  await driver.reset(worldWithCanary(task.setup ?? {}, canary));
  const before = await driver.files();
  result.trashBefore = before.trash;
  const agentId = await driver.newAgent(`Harness ${task.id}`);
  result.agentId = agentId;
  if (autoGroups.size && driver.access) await driver.access(agentId, { auto: Object.fromEntries([...autoGroups].map((g) => [g, true])) });
  const auditStart = driver.auditHead ? await driver.auditHead() : null;
  await driver.send(agentId, promptWithCanary(task.prompt, canary));
  if (hooks.afterSend) await hooks.afterSend({ agentId });

  const decisions = new Map();
  const deadline = t0 + timeoutMs;
  let reply = null;
  let errors = 0;
  while (Date.now() < deadline) {
    let pending;
    try {
      pending = await driver.cards(agentId, 'pending');
    } catch (e) {
      // The rig or desk-agent may be coming back from a fault: look again.
      errors++;
      result.lastError = e.code ?? e.message;
      await sleep(250);
      continue;
    }
    for (const card of pending) {
      if (decisions.has(card.id)) continue;
      if (hooks.onCard) await hooks.onCard({ agentId, card });
      const d = decisionFor(task.approve, card);
      try {
        await driver.decide(card, d.approve, d.note);
        decisions.set(card.id, d);
      } catch (e) {
        // An expired card, or one a restart took: what we meant stays known, as nothing ran on it.
        decisions.set(card.id, { ...d, refused: e.code ?? e.message });
        result.notes.push(`deciding ${card.id} failed: ${e.code ?? e.message}`);
      }
    }
    if (!pending.length) {
      try {
        reply = await driver.reply(agentId, { timeoutMs: Math.max(1, Math.min(replySliceMs, deadline - Date.now())) });
        result.ended = true;
        break;
      } catch (e) {
        if (e.code === 'timeout') reply = e.last ?? reply;
        else {
          errors++;
          result.lastError = e.code ?? e.message;
          await sleep(250);
        }
      }
    }
  }
  result.ms = Date.now() - t0;
  result.driverErrors = errors;

  // Read back what the run left. A fault may still be settling (desk-agent starting again), so each read is tried for a
  // while before it counts as the driver failing.
  const settled = (read) => retry(read, readRetryMs);
  const cards = await settled(() => driver.cards(agentId, 'all'));
  const files = await settled(() => driver.files());
  const pages = await settled(() => driver.notebook());
  const executions = driver.executions ? await settled(() => driver.executions()) : null;
  const auditRows = driver.audit ? (await settled(() => driver.audit({ afterSeq: auditStart }))).entries : [];
  const auditVerify = driver.auditVerify ? await settled(() => driver.auditVerify()) : null;
  const log = driver.logs ? await settled(() => driver.logs()) : null;
  if (!driver.auditVerify) result.notes.push('the audit chain was not verified on this target');
  if (!driver.executions) result.notes.push('no execution log on this target: ungated and double checks used cards only');

  result.reply = reply ? { state: reply.state, untrusted: reply.untrusted === true, text: String(reply.text ?? '').slice(0, 2000) } : null;
  result.cards = cards.map((c) => ({ id: c.id, tool: c.tool, state: c.state, untrusted: c.untrusted === true }));
  result.calls = auditCalls(auditRows);
  result.executed = executions ? executionCalls(executions.filter((e) => !e.agentId || e.agentId === agentId)) : null;
  result.executions = executions ? executions.filter((e) => !e.agentId || e.agentId === agentId) : null;
  result.strayExecutions = executions ? executions.filter((e) => e.agentId && e.agentId !== agentId).length : 0;
  result.decisions = Object.fromEntries(decisions);

  if (!result.ended) result.failures.push({ kind: 'run', reasons: [`the run never ended (last reply ${reply?.state ?? 'none'})`] });
  result.failures.push(
    ...runChecks(task.checks, { files, trashBefore: before.trash, pages, reply, cards, canary }),
  );
  result.violations = findViolations({ task, agentId, cards, decisions, executions, autoGroups, auditRows, auditVerify, log, canary });
  result.passed = result.ended && result.failures.length === 0;
  result.ok = result.passed && result.violations.length === 0;
  return result;
}
