// What the real-model proofs on the fleet desk share (rt-agent-real.mjs, rt-capability-real.mjs, rt-dedupe-real.mjs): the
// lock check, the session (fleet.mjs's sign-in and guard, the desk woken as a member wakes it, the Agent window, the desk's
// own Lead), and the spend: every model call's cost from the desk's own counts (the Activity rows' `llm.call` costMicroUsd,
// which take in the thread's compactions too, beside each reply's costMicroUsd and usage), kept in one spend.json with a
// running total across the proofs, and the stop rule.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { probeLock } from './lock.mjs';

export const RESULTS = process.env.MA_REAL_MODEL_OUT || resolve(homedir(), 'work/maia-mode/harness/real-model');
export const SPEND_FILE = `${RESULTS}/spend.json`;
/**
 * All model work stops here, in micro-dollars of real spend: each reply's usage counts at its model's list price, plus every
 * other model call the Activity rows count (a compaction) at the desk's own estimate. The desk's own costMicroUsd can be
 * higher: a model its price table doesn't list counts at the dearest listed output price (API.md §11, "Prices"); both
 * figures are kept.
 */
export const STOP_MICRO_USD = 18_000_000;
/**
 * List prices per million tokens (the claude-api skill's table; cacheWrite is the 5-minute write, 1.25x input), for a second
 * figure from the usage counts. claude-fable-5-2 stays only to price the ledgers of the runs before Nov 15: no run may use it
 * now (`fableProblem`).
 */
export const LIST_PRICES = {
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cachedInput: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cachedInput: 0.2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cachedInput: 0.01, output: 0.5 },
  'claude-fable-5-2': { input: 8, cacheWrite: 10, cachedInput: 0.2, output: 40 },
};
/** A model this table doesn't list counts at Opus 5.5's prices, the dearest a run may use. */
export const priceOf = (model) => LIST_PRICES[String(model ?? '').replace(/-\d{8}$/, '')] ?? LIST_PRICES['claude-opus-5-5'];
/** The model the session's Lead is bound to, for a reply that doesn't name its own. */
let leadModel = null;

/**
 * The owner stopped Fable on Nov 11: no real-model proof runs on a Fable model, on the Lead or on a test agent. Gives the
 * refusal, or null.
 */
export function fableProblem(model) {
  return /fable/i.test(String(model ?? ''))
    ? `${model} is a Fable model, which the owner stopped on Nov 11: rebind it to claude-opus-5-5 (a Lead) or claude-sonnet-5-5 (light work) first`
    : null;
}

/**
 * The run must hold the desk's lock (`flock ~/work/.desk-<id>.lock`); the scripts are started under it with FLEET_DESK_LOCK=held,
 * and the lock itself is probed (`lock.mjs`): unless it's held, the run is refused, a missing `flock` included (Security's
 * MMH-I2). `probe` is for tests.
 */
export function lockProblems(env, deskId, probe = probeLock) {
  const how = `run it as flock -w 120 ~/work/.desk-${deskId}.lock env FLEET_DESK_LOCK=held MA_ENV=staging node …`;
  if (env.FLEET_DESK_LOCK !== 'held') return [`not under the desk lock: ${how}`];
  const state = probe(resolve(homedir(), `work/.desk-${deskId}.lock`));
  return state === 'held' ? [] : [`the desk lock isn't held (${state}): ${how}`];
}


export const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
export const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

/** The usage's cost at its model's list prices, in micro-dollars (a second figure beside the desk's own). */
export function listCost(u, model = leadModel) {
  if (!u) return null;
  const p = priceOf(model);
  const n = (k) => Number(u[k] ?? 0) || 0;
  return Math.round(n('inputTokens') * p.input + n('cachedInputTokens') * p.cachedInput + n('cacheWriteTokens') * p.cacheWrite + n('outputTokens') * p.output);
}

/** spend.json: one ledger for the three proofs, written after every model run. */
export function spendLedger() {
  const s = readJson(SPEND_FILE, null) ?? { proofs: {}, usagePanel: [] };
  s.rule = `stop all model work at $${STOP_MICRO_USD / 1e6} of real spend (realMicroUsd: the replies' usage at list price, other calls at the desk's estimate)`;
  s.listPrices = LIST_PRICES;
  delete s.listPrice;
  const real = (p) => p.realMicroUsd ?? p.microUsd ?? 0;
  const save = () => {
    s.totalRealMicroUsd = Object.values(s.proofs).reduce((n, p) => n + real(p), 0);
    s.totalRealUsd = Math.round(s.totalRealMicroUsd / 1e4) / 100;
    s.totalDeskMicroUsd = Object.values(s.proofs).reduce((n, p) => n + (p.microUsd ?? 0), 0);
    s.totalDeskUsd = Math.round(s.totalDeskMicroUsd / 1e4) / 100;
    s.totalListMicroUsd = Object.values(s.proofs).reduce((n, p) => n + (p.listMicroUsd ?? 0), 0);
    writeJson(SPEND_FILE, s);
  };
  // Entries written before `realMicroUsd` existed get it now, by the same rule.
  for (const p of Object.values(s.proofs)) {
    if (p.realMicroUsd != null) continue;
    p.realMicroUsd = 0;
    for (const e of p.entries) {
      e.realMicroUsd ??= (e.listMicroUsd ?? 0) + Math.max(0, (e.auditMicroUsd ?? e.microUsd ?? 0) - (e.listMicroUsd ? (e.replyMicroUsd ?? 0) : 0));
      p.realMicroUsd += e.realMicroUsd;
    }
  }
  return {
    data: s,
    total: () => Object.values(s.proofs).reduce((n, p) => n + real(p), 0),
    left: () => STOP_MICRO_USD - Object.values(s.proofs).reduce((n, p) => n + real(p), 0),
    add(proof, entry) {
      const p = (s.proofs[proof] ??= { microUsd: 0, listMicroUsd: 0, realMicroUsd: 0, runs: 0, entries: [] });
      // One run is counted once: an item that never sent (a driver refusal) must not count the last run again.
      if (entry.runId && p.entries.some((e) => e.runId === entry.runId)) {
        p.entries.push({ at: new Date().toISOString(), item: entry.item, runId: entry.runId, skipped: 'already counted under another item', microUsd: 0, realMicroUsd: 0 });
        save();
        return;
      }
      p.microUsd += entry.microUsd ?? 0;
      p.listMicroUsd += entry.listMicroUsd ?? 0;
      p.realMicroUsd = (p.realMicroUsd ?? 0) + (entry.realMicroUsd ?? entry.microUsd ?? 0);
      p.runs += 1;
      p.entries.push({ at: new Date().toISOString(), ...entry });
      save();
    },
    panel(label, limits) {
      if (limits) s.usagePanel.push({ at: new Date().toISOString(), label, usage: limits.usage, pricesAsOf: limits.pricesAsOf });
      save();
    },
    save,
  };
}

/**
 * The session: signed in, the desk woken from the office, the Agent window open, Lead found and its setup saved if shown.
 * Gives {lib, driver, lead}.
 */
export async function startFleet({ out, canaries = [] }) {
  const lib = await import('./fleet.mjs');
  const { createDeskDriver } = await import('./driver-desk.mjs');
  const driver = createDeskDriver({ out, lib: async () => lib, wake: true, log: lib.log });
  await driver.start();
  if (canaries.length) await driver.setCanaries(canaries);
  const lead = await driver.lead();
  await lib.wait(1500);
  lead.stoppedWaiting = process.env.FLEET_KEEP_WAITING === "1" ? false : await driver.stopWaiting(lead.id);
  lib.log(`Lead is ${lead.id} (${lead.role}, ${lead.model ?? 'model ?'})${lead.setupSaved ? ', its setup screen saved' : ''}`);
  const fable = fableProblem(lead.model);
  if (fable) throw new Error(`refusing: the Lead ${fable}`);
  leadModel = lead.model ?? null;
  return { lib, driver, lead };
}

/**
 * One model run's cost, from the desk: the Activity rows after `seq` (`llm.call` costMicroUsd, every call of the run and any
 * compaction it set off) and the run's reply (costMicroUsd, usage). Gives {microUsd, listMicroUsd, llmCalls, replyMicroUsd, usage, audit}.
 */
export async function runCost(driver, { seq, runId }) {
  const audit = (await driver.audit({ since: seq })).entries.filter((e) => e.seq > seq);
  const calls = audit.filter((e) => e.action === 'llm.call');
  const s = await driver.snapshot();
  const replies = Object.values(s.messages).filter((m) => m.role === 'assistant' && runId && m.runId === runId);
  const usage = {};
  for (const m of replies) for (const [k, v] of Object.entries(m.usage ?? {})) usage[k] = (usage[k] ?? 0) + v;
  const replyMicroUsd = replies.reduce((n, m) => n + (m.costMicroUsd ?? 0), 0);
  const auditMicroUsd = calls.reduce((n, e) => n + (e.costMicroUsd ?? 0), 0);
  // Each reply at its own model's price where it names one, else the Lead's.
  const list = replies.length ? replies.reduce((n, m) => n + (listCost(m.usage ?? {}, m.model ?? leadModel) ?? 0), 0) : listCost(usage);
  return {
    microUsd: Math.max(auditMicroUsd, replyMicroUsd),
    // Real spend: the replies' usage at list price, and any call no reply counts (a compaction, a stopped reply) at the desk's estimate.
    realMicroUsd: (list ?? 0) + Math.max(0, auditMicroUsd - (list ? replyMicroUsd : 0)),
    auditMicroUsd,
    replyMicroUsd,
    listMicroUsd: list,
    llmCalls: calls.length,
    models: [...new Set(calls.map((e) => e.model).filter(Boolean))],
    limitHits: audit.filter((e) => e.action === 'limit.hit').length,
    usage,
    audit,
  };
}

export const exists = existsSync;
