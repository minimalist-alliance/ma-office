// The local driver (contract section 4): the rig's HTTP API on 127.0.0.1 (contract section 1), or the fake rig's.
import { sleep } from './args.mjs';

export class RigError extends Error {
  constructor(code, reason, status) {
    super(`rig: ${code}${reason ? ` (${reason})` : ''}`);
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}

export class TimeoutError extends Error {
  constructor(what, last) {
    super(`timed out: ${what}`);
    this.code = 'timeout';
    this.last = last;
  }
}

const ENDED = new Set(['done', 'failed', 'stopped']);

export class LocalDriver {
  name = 'local';

  /**
   * @param {object} o
   * @param {string} o.rig the rig's base URL, http://127.0.0.1:<port>
   * @param {number} [o.pollMs] how often reply() looks
   * @param {number} [o.requestTimeoutMs] one HTTP request's limit
   */
  constructor({ rig, pollMs = 200, requestTimeoutMs = 30_000 } = {}) {
    if (!rig) throw new Error('the local driver needs the rig URL');
    const url = new URL(rig);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('the rig must be on 127.0.0.1');
    this.rig = rig.replace(/\/$/, '');
    this.pollMs = pollMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.health = null;
  }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch(this.rig + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new RigError('unreachable', e?.cause?.code ?? e?.name ?? 'fetch failed');
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new RigError('bad_reply', `status ${res.status}`, res.status);
    }
    if (!json || json.ok !== true) throw new RigError(json?.code ?? 'failed', json?.reason ?? null, res.status);
    return json;
  }

  async call(method, params = {}) {
    return (await this.request('POST', '/call', { method, params })).result;
  }

  /** Waits for the rig's health: desk-agent and Notebook up. */
  async start({ timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (true) {
      try {
        last = await this.request('GET', '/health');
        if (last.deskAgent && last.notebook) break;
      } catch (e) {
        last = e;
      }
      if (Date.now() > deadline) throw new TimeoutError('the rig to be healthy', last);
      await sleep(250);
    }
    this.health = last;
    return last;
  }

  async stop() {}

  async healthCheck() {
    return this.request('GET', '/health');
  }

  async reset(world) {
    const r = await this.request('POST', '/reset', world ?? {});
    return { tabs: r.tabs ?? {}, pages: r.pages ?? [] };
  }

  async newAgent(name) {
    return (await this.request('POST', '/agent', { name })).agentId;
  }

  async access(agentId, { apps, auto } = {}) {
    return (await this.request('POST', '/access', { agentId, apps, auto })).access;
  }

  async send(agentId, text) {
    const r = await this.call('agent.message.send', { agentId, text });
    return { runId: r?.runId ?? null, messageId: r?.messageId ?? null };
  }

  /** The agent's cards, oldest first. state: 'pending' or 'all'. */
  async cards(agentId, state = 'pending') {
    const out = [];
    let before;
    for (let page = 0; page < 200; page++) {
      const params = { agentId, state };
      if (before) params.before = before;
      const r = await this.call('agent.approvals.list', params);
      const list = r?.approvals ?? [];
      out.push(...list);
      if (!r?.older || !list.length) break;
      before = list.at(-1).id;
    }
    // The list is newest first. Reversed, then sorted by time alone (a stable sort), cards of one step keep the order
    // they were asked in even when they share a millisecond.
    const seen = new Set();
    return out
      .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
      .reverse()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  async card(approvalId) {
    return (await this.call('agent.approval.get', { approvalId }))?.approval ?? null;
  }

  async decide(card, approve, note) {
    const body = { approvalId: card.id, approve: Boolean(approve) };
    if (!approve && note) body.note = note;
    return (await this.request('POST', '/decide', body)).state;
  }

  async thread(agentId) {
    return (await this.call('agent.thread.get', { agentId }))?.messages ?? [];
  }

  /** Waits until the newest reply has ended and no card is pending. Throws a TimeoutError with the last reply seen. */
  async reply(agentId, { timeoutMs = 600_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (true) {
      const messages = await this.thread(agentId);
      last = messages.at(-1) ?? null;
      if (last?.role === 'assistant' && ENDED.has(last.state)) {
        const pending = await this.cards(agentId, 'pending');
        if (!pending.length) return last;
      }
      if (Date.now() >= deadline) throw new TimeoutError('the reply to end', last);
      await sleep(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  async files() {
    const r = await this.request('GET', '/files');
    return { files: r.files ?? {}, trash: r.trash ?? [] };
  }

  async notebook() {
    return (await this.request('GET', '/notebook')).pages ?? [];
  }

  /** Every audit row, oldest first, or only those after a seq. */
  async audit({ afterSeq = null } = {}) {
    const entries = [];
    let headHash = null;
    let beforeSeq;
    for (let page = 0; page < 100_000; page++) {
      const params = { limit: 200 };
      if (beforeSeq != null) params.beforeSeq = beforeSeq;
      const r = await this.call('agent.audit.list', params);
      if (headHash === null) headHash = r?.headHash ?? '';
      let stop = false;
      for (const e of r?.entries ?? []) {
        if (afterSeq != null && e.seq <= afterSeq) {
          stop = true;
          break;
        }
        entries.push(e);
      }
      if (stop || r?.nextBeforeSeq == null) break;
      beforeSeq = r.nextBeforeSeq;
    }
    entries.reverse();
    return { entries, headHash };
  }

  /** The newest audit row's seq, or 0. */
  async auditHead() {
    const r = await this.call('agent.audit.list', { limit: 1 });
    return r?.entries?.[0]?.seq ?? 0;
  }

  async executions() {
    return (await this.request('GET', '/executions')).executions ?? [];
  }

  async fault(kind) {
    await this.request('POST', '/fault', { kind });
  }

  async auditVerify() {
    const r = await this.request('GET', '/audit-verify');
    return { intact: r.intact, rows: r.rows, brokenAt: r.brokenAt ?? null };
  }

  async logs() {
    return (await this.request('GET', '/logs')).deskAgent ?? '';
  }
}

export function createDriver(options) {
  return new LocalDriver(options);
}
