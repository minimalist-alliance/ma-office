// The capability runner's desk driver (tools/agent-harness CONTRACT.md §4) on the fleet desk: driver-desk.mjs through
// fleet.mjs, with the desk's own Lead and its stored key. `tools/agent-harness/lib/targets.mjs`'s makeDriver loads it with
// `deskDriverPath` pointing here (rt-capability-real.mjs does), and its `createDriver(options)` refuses unless `keyParam` is
// exactly `desk-stored-key:<this desk>`: the key-parameter rule relaxed for this desk's stored key alone, never an SSM key.
//
// What differs from the contract on a desk, and why:
// - `newAgent` gives Lead's id: no agent is made (the rules), and the Agent window has no way to start a new thread, so every
//   task runs in Lead's one thread. Its history goes with each run (desk-agent's window, up to 48k tokens, compacted after),
//   and a thread whose earlier reply read a file starts tainted (`U`), so a reply's `untrusted` can't be false once one has.
// - `send` takes off the prompt's `canary:` line (the stand-in's matching key): the world's texts carry the canary, as the
//   contract says, and a real model given the line in the member's words could write it into a file.
// - No `executions`, `fault`, `auditVerify` or `logs`: a desk shows none of them.
// - `audit` rows are names, decisions and ids only (`tool:<name>` in `target`); a row the page found holding the run's canary
//   carries it under `leak`, so the runner's own canary check sees it.
import { ALLOWED } from './fleet.mjs';
import { RESULTS, startFleet } from './fleet-run.mjs';

export const STORED_KEY = `desk-stored-key:${ALLOWED}`;
const CANARY = /mmcanary-[0-9a-f]{16}/;

function timeout(last) {
  const e = new Error('timeout');
  e.code = 'timeout';
  e.last = last;
  return e;
}

export async function createDriver(options = {}) {
  if (options.model !== 'real') throw new Error('the fleet desk runs its own real model only');
  if (options.keyParam !== STORED_KEY) throw new Error(`refusing: on the fleet desk the key is the desk's own stored key (${STORED_KEY}); no other key parameter is read`);
  const out = options.out ?? `${RESULTS}/shots/capability`;
  let lib = null;
  let d = null;
  let lead = null;
  let canary = null;
  let runId = null;
  let sentAt = 0;
  const pageUntrusted = new Map();
  const seenOnPage = new Map();

  const settled = async () => {
    const s = await d.snapshot();
    const msg = Object.values(s.messages)
      .filter((m) => m.role === 'assistant' && m.runId === runId)
      .sort((a, b) => a.firstAt - b.firstAt)
      .at(-1);
    const pendingWire = Object.values(s.approvals).some((a) => a.runId === runId && a.state === 'pending');
    if (pendingWire || (await d.pendingOnPage(lead.id)) > 0) return null;
    if (msg && ['done', 'failed', 'stopped'].includes(msg.state)) return msg;
    return null;
  };

  const driver = {
    name: 'desk',
    desk: () => d,
    lib: () => lib,
    lead: () => lead,
    lastRunId: () => runId,

    async start() {
      ({ lib, driver: d, lead } = await startFleet({ out }));
      return { model: 'real', agent: lead.id, modelId: lead.model };
    },

    async stop() {
      if (!d) return;
      await d.reset({}).catch(() => {});
      await d.closeWindow().catch(() => false);
    },

    async reset(world = {}) {
      const texts = [...Object.values(world.files ?? {}).filter((t) => typeof t === 'string'), ...(world.notebook ?? []).map((p) => p.markdown ?? '')];
      const found = texts.map((t) => CANARY.exec(t)?.[0]).find(Boolean);
      if (found && found !== canary) {
        canary = found;
        await d.setCanaries([canary]);
      }
      pageUntrusted.clear();
      seenOnPage.clear();
      runId = null; // a task that fails before it sends has no run, and no cost of another's
      return d.reset(world);
    },

    /** Lead, every time: see the header. */
    async newAgent() {
      return lead.id;
    },

    async auditHead() {
      const a = await d.audit({ since: d.auditSeq() });
      return a.entries.at(-1)?.seq ?? d.auditSeq();
    },

    async send(agentId, text) {
      // A run an earlier task left going (its deadline passed) is stopped first: the composer takes nothing while one runs.
      await d.stopWaiting(agentId);
      const prompt = String(text).replace(/\ncanary: mmcanary-[0-9a-f]+[ \t]*$/, '');
      const r = await d.send(agentId, prompt);
      runId = r.runId;
      sentAt = Date.now();
      return r;
    },

    async cards(agentId, state = 'pending') {
      if (state === 'pending') {
        const list = await d.cards(agentId, 'pending');
        const mine = list.filter((k) => (k.id ? k.wireState === 'pending' && k.runId === runId : true));
        return mine.map((k) => {
          const id = k.id ?? `title:${k.title}`;
          pageUntrusted.set(id, k.untrusted);
          const card = { id, tool: k.tool, state: 'pending', untrusted: k.untrusted, title: k.title, payload: k.payload, runId: k.runId ?? runId, createdAt: k.createdAt ?? null };
          seenOnPage.set(id, card);
          return card;
        });
      }
      const paired = runId ? await d.runCards(agentId, runId) : [];
      const out = paired.map((k) => ({
        id: k.id,
        tool: k.tool ?? null,
        state: k.wireState ?? k.state,
        untrusted: pageUntrusted.has(k.id) ? pageUntrusted.get(k.id) : Boolean(k.wireUntrusted),
        wireUntrusted: k.wireUntrusted ?? null,
        title: k.title,
        payload: k.payload,
        runId: k.runId,
        createdAt: k.createdAt ?? null,
        result: k.result ?? null,
      }));
      // A card the page drew that the wire never sent (its events quiet after a restart) still counts, as the page last showed it.
      for (const [id, c] of seenOnPage) if (id.startsWith('title:') && !out.some((o) => o.title === c.title)) out.push({ ...c, state: 'unknown' });
      return out;
    },

    async decide(card, approve, note) {
      const real = card.id && !String(card.id).startsWith('title:') ? card.id : null;
      await d.decide({ ...card, id: real }, approve, note);
    },

    /** The contract's reply: the run's reply once it's done, failed or stopped with no card waiting; else `timeout` after `timeoutMs`. */
    async reply(agentId, { timeoutMs = 300 } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const msg = await settled();
        if (msg) {
          const r = await d.reply(agentId, { timeoutMs: 5000, runId });
          return { state: msg.state, text: r.text ?? '', untrusted: msg.untrusted === true, untrustedShown: r.untrustedShown, chips: r.chips, summary: r.summary, costMicroUsd: msg.costMicroUsd, usage: msg.usage };
        }
        if (Date.now() >= end) throw timeout(null);
        await lib.wait(Math.min(400, Math.max(50, end - Date.now())));
      }
    },

    async files() {
      return d.files();
    },

    async notebook() {
      return d.notebook();
    },

    async audit({ afterSeq = null } = {}) {
      const a = await d.audit({ since: afterSeq ?? d.auditSeq() });
      const entries = a.entries
        .filter((e) => afterSeq == null || e.seq > afterSeq)
        .map((e) => ({ seq: e.seq, action: e.action, decision: e.decision, target: e.tool ? `tool:${e.tool}` : e.target, run: e.run, costMicroUsd: e.costMicroUsd, ...(e.canaryHit && canary ? { leak: canary } : {}) }));
      return { entries, headHash: a.headHash };
    },
  };
  return driver;
}

export default createDriver;
