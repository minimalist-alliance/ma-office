// Dev and test only, like `mockDeskLink.ts`, which is all that imports this: never in a production bundle. `web/agent`'s mock
// behind a desk's wire, so `RpcAgentClient` and everything above it run for real. As deskd API.md section 11 says, on a small
// scale: mutations need `idem`, errors have `code` and `details`, and while `desk-agent` is down every call answers `unavailable`
// and subscriptions stay quiet until it's back, when each gets a fresh snapshot.
import { AgentError, type AgentClient } from '../../agent/src/client/agentClient';
import { KeySecret } from '../../agent/src/client/keySecret';
import type { AccessChange, AgentCaps, AttachLimits, AgentCreate, AgentLink, AgentPatch, Approval, ConversationEvent, LimitLayer, LimitsChange, Message, TimerInput, ToolsEvent } from '../../agent/src/client/types';
import type { FixtureName } from '../../agent/src/mock/fixtures';
import { MockAgentClient, type ApprovalSeed } from '../../agent/src/mock/mockAgentClient';
import type { RpcOptions } from './deskLink';
import type { SubWire } from './rtc/subs';

/** What a dev or a `shell` test can steer, as `window.__maDeskMock.agent`. */
export interface MockAgentControl {
  /**
   * `?agentFixture=fresh|ready|limit|tools`: what each desk starts with. `tools` is S-14's (approvals, running tools, memory).
   * Auto-approve's runs come from the client's hooks (`unasked`, `changeUnasked`, `ask(…, 'saveNotes')`), or from the demo's
   * "keep notes" once a switch is on.
   */
  fixture: FixtureName;
  /** `?speed=fast`: as the demo's. */
  fast: boolean;
  /** `?keysLast=1`: keys say `available` and last through a restart (ADR 0042), and limits layer desk, account, default (ADR 0043). */
  keysLast: boolean;
  /** `?accountDay=`, `?accountMonth=` (dollars, or `none`), `?accountZone=`: what the account sets, with `keysLast`. */
  account?: Partial<LimitLayer> | undefined;
  /** `?agentCap=3` and the rest of multi-agent.md section 2's caps, over the built-in defaults. */
  caps?: Partial<AgentCaps> | undefined;
  /** `?agentSetup=new|upgrade`: every agent the fixture starts with waits for its setup screen (draft ADR section 16). */
  setup?: 'new' | 'upgrade' | undefined;
  /** `?agentCredits=1`: the member's MA credits are usable, so a helper made with no key runs on them (API.md §24). */
  credits?: boolean | undefined;
  /**
   * `?approvalsWire=messages`: a conversation's snapshot carries each approval only in its reply, as desk-agent before
   * 2026-11-14's fix did (release 4 and `2026.11.14-dce379e`). Unset: as API.md section 18 says and desk-agent does now, the
   * snapshot's own `approvals` and each reply's.
   */
  approvalsWire?: 'messages' | undefined;
  /** `desk-agent` isn't running. */
  down: boolean;
  setDown(down: boolean): void;
  /** Each desk's, once something has asked. */
  desks: Record<string, MockAgentDesk>;
  /** A waiting approval with a known id on a desk, now or once its agent is first asked (a mock office's tray papers). */
  seedApproval(deskId: string, seed: ApprovalSeed): void;
  /** Seeds waiting for their desk's agent. */
  seeds: Record<string, ApprovalSeed[]>;
  /**
   * A conversation's snapshot keeps only its newest this many messages, with the approvals of those, and says how many it left
   * out in `omitted`, as deskd cuts a thread too long for one event (`EventFit`; API.md section 11). Null: whole.
   */
  cutSnapshots: number | null;
  /**
   * How long a SUB's reply takes, in ms. The subscription is made when it's asked, as deskd makes it, and its events can come
   * first (API.md section 5). A deskd that has just started answers its first ones slowly (release 3's bug B).
   */
  subDelayMs: number;
  /** `desk-agent` restarts, as in `MockAgentClient.restart`. Every subscription gets a fresh snapshot. */
  restart(): void;
  /** Takes the session away for this long, as a dropped connection does. */
  dropLink(ms: number): void;
  /**
   * Messages between desks (W6): every `agent.desks.*` call each desk answered and every `agent.desks.outbox` SUB, in order, with
   * `performance.now()` as it answered, the envelope ids a take gave or a deliver applied, and the outcome. For the shell spec.
   */
  desksLog: { desk: string; m: string; at: number; ids?: string[]; outcome?: string; refused?: string }[];
}

const MUTATIONS: ReadonlySet<string> = new Set([
  'agent.create',
  'agent.update',
  'agent.delete',
  'agent.links.set',
  'agent.bind',
  'agent.message.send',
  'agent.run.stop',
  'agent.key.add',
  'agent.key.delete',
  'agent.limits.set',
  'agent.proposal.answer',
  'agent.workspace.delete',
  'agent.workspace.share',
  'agent.timer.set',
  'agent.timer.delete',
  'agent.icon.upload',
  'agent.attach.put',
  'agent.attach.remove',
  'agent.attach.caps.set',
  // S-14
  'agent.approval.decide',
  'agent.approval.undo',
  'agent.tool.stop',
  'agent.memory.delete',
  'agent.memory.clear',
  // The setup screen (section 16)
  'agent.access.set',
  'agent.desks.revoke',
  // Messages between desks (W6)
  'agent.desks.answer',
  'agent.desks.deliver',
  'agent.desks.done',
]);

type Emit = (subId: number, seq: number, body: { type: string; data: unknown }) => void;

export class MockAgentDesk implements SubWire {
  readonly client: MockAgentClient;
  private nextSub = 1;
  private seq = 0;
  private readonly subs = new Map<number, { topic: string; off: (() => void) | null }>();

  constructor(
    private readonly control: MockAgentControl,
    private readonly refuse: Record<string, string>,
    /** To this desk's link, which sets it. */
    public emit: Emit,
    deskName: string | undefined,
    private readonly deskId = 'd-mock',
    /** A Guild Desk: every `agent.desks.*` method and the outbox are `forbidden` `guild` there (W6). */
    private readonly guildDesk = false,
  ) {
    this.client = new MockAgentClient({
      deskId,
      fixture: control.fixture,
      keysLast: control.keysLast,
      ...(control.account ? { account: control.account } : {}),
      ...(control.caps ? { caps: control.caps } : {}),
      ...(control.setup ? { setup: control.setup } : {}),
      ...(control.credits ? { credits: true } : {}),
      ...(deskName ? { deskName } : {}),
      ...(control.fast ? { latencyMs: 15, streamMs: 8 } : {}),
    });
  }

  answer(method: string, params: Record<string, unknown>, options?: RpcOptions): Promise<unknown> {
    if (this.control.down) return Promise.reject(wireError('unavailable', { reason: 'unavailable' }));
    if (MUTATIONS.has(method) && !options?.idem) return Promise.reject(wireError('bad_request', {}));
    if (method.startsWith('agent.desks.') && method !== 'agent.desks.revoke' && this.guildDesk) return Promise.reject(wireError('forbidden', { reason: 'guild' }));
    const carried = method === 'agent.desks.take' || method === 'agent.desks.deliver' || method === 'agent.desks.done';
    return call(this.client, method, params, options?.idem ?? '')
      .then((r) => {
        if (carried) this.logCarried(method, r);
        return r;
      })
      .catch((err: unknown) => {
        if (!(err instanceof AgentError)) throw err;
        if (carried) this.control.desksLog.push({ desk: this.deskId, m: method, at: performance.now(), refused: err.reason ?? err.code });
        throw wireError(err.code, {
          ...(err.reason ? { reason: err.reason } : {}),
          ...(err.detail ? { detail: err.detail } : {}),
          ...(err.scope ? { scope: err.scope } : {}),
          ...(err.file ? { name: err.file } : {}),
          ...(err.limit ? { limit: err.limit } : {}),
          ...(err.versionId ? { versionId: err.versionId } : {}),
        });
      });
  }

  /** What a carried call answered, for the shell spec's timing: the ids a take gave, the id a deliver applied. */
  private logCarried(method: string, r: unknown): void {
    const at = performance.now();
    const o = (r ?? {}) as { envelopes?: { id: string }[]; id?: string; outcome?: string };
    if (method === 'agent.desks.take') this.control.desksLog.push({ desk: this.deskId, m: method, at, ids: (o.envelopes ?? []).map((e) => e.id) });
    else if (method === 'agent.desks.deliver') this.control.desksLog.push({ desk: this.deskId, m: method, at, ids: o.id ? [o.id] : [], ...(o.outcome ? { outcome: o.outcome } : {}) });
    else this.control.desksLog.push({ desk: this.deskId, m: method, at });
  }

  sub(body: { topic: string }): Promise<{ subId: number }> {
    if (body.topic === 'agent.desks.outbox') {
      this.control.desksLog.push({ desk: this.deskId, m: 'sub agent.desks.outbox', at: performance.now() });
      if (this.guildDesk) return Promise.reject(wireError('forbidden', { reason: 'guild' }));
    }
    const refusal = this.refuse[body.topic] ?? (body.topic.startsWith('agent.conversation:') ? this.refuse['agent.conversation'] : undefined);
    if (refusal) return Promise.reject(wireError(refusal, {}));
    // As deskd does (API.md section 5): a SUB of a topic this session already has is that same subscription, with a fresh
    // snapshot, so an UNSUB of its id ends it for whoever asked.
    const live = [...this.subs].find(([, s]) => s.topic === body.topic);
    let subId: number;
    let sub: { topic: string; off: (() => void) | null };
    if (live) {
      [subId, sub] = live;
      sub.off?.();
      sub.off = null;
    } else {
      subId = this.nextSub;
      this.nextSub += 1;
      sub = { topic: body.topic, off: null };
      this.subs.set(subId, sub);
    }
    if (!this.control.down) this.start(subId, sub);
    const delay = this.control.subDelayMs;
    return delay > 0 ? new Promise((ok) => window.setTimeout(() => ok({ subId }), delay)) : Promise.resolve({ subId });
  }

  unsub(subId: number): Promise<unknown> {
    this.subs.get(subId)?.off?.();
    this.subs.delete(subId);
    return Promise.resolve({});
  }

  /** The session ended: nothing delivered, and the next asks for everything again. */
  closeSubs(): void {
    for (const sub of this.subs.values()) sub.off?.();
    this.subs.clear();
  }

  /** `desk-agent` went away: subscriptions stay, with no events. */
  quiet(): void {
    for (const sub of this.subs.values()) {
      sub.off?.();
      sub.off = null;
    }
  }

  /** `desk-agent` is back: a fresh snapshot for each. */
  resume(): void {
    for (const [subId, sub] of this.subs) {
      sub.off?.();
      this.start(subId, sub);
    }
  }

  private start(subId: number, sub: { topic: string; off: (() => void) | null }): void {
    const send = (type: string, data: unknown): void => {
      this.seq += 1;
      this.emit(subId, this.seq, { type, data });
    };
    if (sub.topic === 'agent.state') {
      // W6: `deskOffers`, the offers from other desks waiting here, beside the agents.
      sub.off = this.client.watchAgents((agents, caps, desk) => send('snapshot', { agents, ...(caps ? { caps } : {}), ...(desk && desk.deskOffers !== null ? { deskOffers: desk.deskOffers } : {}) }));
      return;
    }
    // W6: what waits in this desk's outbox, for each other desk, never content.
    if (sub.topic === 'agent.desks.outbox') {
      sub.off = this.client.watchOutbox((e) => send('snapshot', e));
      return;
    }
    // The spec's section 2.8: every tool call running on the desk. No deskd serves it yet; `refuse['agent.tools']` plays one.
    if (sub.topic === 'agent.tools') {
      sub.off = this.client.watchTools((e: ToolsEvent) => {
        if (e.type === 'snapshot') send('snapshot', { serverNow: e.serverNow, calls: e.calls });
        else if (e.type === 'call') send('call', { call: e.call });
        else send('end', { callId: e.callId, agentId: e.agentId, ...(e.result ? { result: e.result } : {}) });
      });
      return;
    }
    const agentId = sub.topic.slice('agent.conversation:'.length);
    sub.off = this.client.watchConversation(agentId, (e: ConversationEvent) => {
      if (e.type === 'snapshot') send('snapshot', cut(snapshotWire(e.messages, e.approvals, this.control.approvalsWire), this.control.cutSnapshots));
      else if (e.type === 'message') send('message', { message: e.message });
      else if (e.type === 'approval') send('approval', { approval: e.approval });
      else send('delta', { messageId: e.messageId, runId: e.runId, text: e.text });
    });
  }
}

/**
 * A conversation snapshot as a desk sends it (API.md section 18): each reply lists its approvals, and the snapshot carries them
 * all beside, unless `wire` is an older desk-agent's, which sent only the replies' own.
 */
function snapshotWire(messages: Message[], approvals: Approval[] | undefined, wire: MockAgentControl['approvalsWire']): Record<string, unknown> {
  if (!approvals) return { messages };
  const withTheirs = messages.map((m) => {
    const theirs = approvals.filter((a) => a.messageId === m.id);
    return theirs.length ? { ...m, approvals: theirs } : m;
  });
  return wire === 'messages' ? { messages: withTheirs } : { messages: withTheirs, approvals };
}

/**
 * A snapshot cut as deskd's `EventFit` cuts one too long for an event: its newest `keep` messages, with their approvals (a left-out
 * message's go with it), `omitted` the count left out and `older: true`.
 */
function cut(wire: Record<string, unknown>, keep: number | null): Record<string, unknown> {
  const messages = (wire['messages'] as Message[] | undefined) ?? [];
  if (keep === null || messages.length <= keep) return wire;
  const kept = messages.slice(messages.length - keep);
  const ids = new Set(kept.map((m) => m.id));
  const approvals = wire['approvals'] as Approval[] | undefined;
  return {
    ...wire,
    messages: kept,
    ...(approvals ? { approvals: approvals.filter((a) => ids.has(a.messageId)) } : {}),
    omitted: messages.length - kept.length,
    older: true,
  };
}

const wireError = (code: string, details: Record<string, unknown>): Error => Object.assign(new Error(code), { code, details });

const without = (p: Record<string, unknown>, key: string): Record<string, unknown> => {
  const rest = { ...p };
  delete rest[key];
  return rest;
};

async function call(c: AgentClient, method: string, p: Record<string, unknown>, idem: string): Promise<unknown> {
  const m = { idem };
  const agentId = p['agentId'] as string;
  const keyId = p['keyId'] as string;
  switch (method) {
    case 'agent.providers':
      return { providers: await c.providers() };
    case 'agent.list':
      return { agents: await c.listAgents() };
    case 'agent.get':
      return { agent: await c.getAgent(agentId) };
    case 'agent.caps':
      return { caps: await c.caps() };
    case 'agent.create':
      return { agent: await c.createAgent(p as unknown as AgentCreate, m) };
    case 'agent.update':
      return { agent: await c.updateAgent(agentId, without(p, 'agentId') as AgentPatch, m) };
    case 'agent.delete':
      await c.deleteAgent(agentId, m);
      return {};
    case 'agent.links.set':
      return { agent: await c.setLinks(agentId, { solo: p['solo'] as boolean, links: p['links'] as AgentLink[] }, m) };
    case 'agent.proposal.answer':
      return { proposal: await c.answerProposal(p['proposalId'] as string, p['accept'] === true, p['sha256'] as string, m) };
    case 'agent.a2a.list':
      return c.listA2a({ ...(typeof p['agentId'] === 'string' ? { agentId: p['agentId'] } : {}), ...(typeof p['before'] === 'number' ? { before: p['before'] } : {}) });
    case 'agent.workspace.get':
      return c.getWorkspace(agentId, typeof p['path'] === 'string' ? p['path'] : undefined);
    case 'agent.workspace.read':
      return c.readWorkspace(agentId, p['path'] as string, { ...(typeof p['offset'] === 'number' ? { offset: p['offset'] } : {}), ...(typeof p['length'] === 'number' ? { length: p['length'] } : {}) });
    case 'agent.workspace.delete':
      return c.deleteWorkspaceEntry(agentId, p['path'] as string, m);
    case 'agent.workspace.share':
      return { agent: await c.shareWorkspace(agentId, p['with'] as string[], m) };
    case 'agent.timer.list':
      return c.listTimers(agentId);
    case 'agent.timer.set':
      return { timer: await c.setTimer(agentId, p['timer'] as TimerInput, m) };
    case 'agent.timer.delete':
      await c.deleteTimer(agentId, p['timerId'] as string, m);
      return {};
    case 'agent.icon.upload':
      return { agent: await c.uploadIcon(agentId, p['png'] as string, m) };
    case 'agent.icon.get':
      return c.getIcon(agentId);
    case 'agent.bind':
      return { agent: await c.bindAgent(agentId, { keyId, model: p['model'] as string }, m) };
    case 'agent.thread.get':
      return c.getThread(agentId);
    case 'agent.message.send':
      return c.sendMessage(agentId, (p['text'] as string | undefined) ?? '', m, (p['attachments'] as string[] | undefined) ?? []);
    case 'agent.attach.put': {
      // The wire carries base64; the mock counts what it decodes to and keeps none of it.
      const data = String(p['data'] ?? '');
      const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      return (c as MockAgentClient).attachPut({ agentId, uploadId: p['uploadId'] as string, name: p['name'] as string, size: p['size'] as number, index: p['index'] as number, bytes });
    }
    case 'agent.attach.remove':
      await c.removeAttachment(agentId, p['uploadId'] as string, m);
      return {};
    case 'agent.attach.caps':
      return c.attachCaps(p['agentId'] as string | undefined);
    case 'agent.attach.caps.set':
      return c.setAttachCaps(p as Partial<AttachLimits>, m);
    case 'agent.run.stop':
      await c.stopRun(p['runId'] as string, m);
      return {};
    case 'agent.seen':
      await c.markSeen(agentId);
      return {};
    case 'agent.key.list':
      return { keys: await c.listKeys() };
    case 'agent.key.add': {
      const secret = KeySecret.fromText(p['secret'] as string);
      try {
        return { key: await c.addKey({ provider: p['provider'] as string, label: p['label'] as string, secret }, m) };
      } finally {
        secret.wipe();
      }
    }
    case 'agent.key.delete':
      await c.deleteKey(keyId, m);
      return {};
    case 'agent.key.models':
      return { models: await c.listModels(keyId) };
    case 'agent.limits.get':
      return c.getLimits(agentId);
    case 'agent.limits.set': {
      // Absent and null differ, so only what came goes on.
      const change: LimitsChange = {};
      if ('policy' in p) change.policy = p['policy'] as LimitsChange['policy'];
      if ('timeZone' in p) change.timeZone = p['timeZone'] as string | null;
      return c.setLimits(agentId, change, m);
    }
    case 'agent.audit.list':
      return c.listAudit(p);
    // S-14: deskd API.md section 18, and desk-agent's memory (relayed as the rest).
    case 'agent.approvals.list':
      return c.listApprovals({ ...(typeof p['agentId'] === 'string' ? { agentId: p['agentId'] } : {}), ...(p['state'] === 'all' || p['state'] === 'pending' ? { state: p['state'] } : {}), ...(typeof p['before'] === 'string' ? { before: p['before'] } : {}) });
    case 'agent.approval.get':
      return { approval: await c.getApproval(p['approvalId'] as string) };
    case 'agent.approval.decide':
      return { approval: await c.decideApproval(p['approvalId'] as string, { approve: p['approve'] === true, sha256: String(p['sha256'] ?? ''), ...(typeof p['note'] === 'string' ? { note: p['note'] } : {}) }, m) };
    // Auto-approve (API.md section 18, "Done without asking").
    case 'agent.approval.undo':
      return { approval: await c.undoApproval(p['approvalId'] as string, m) };
    case 'agent.tool.stop':
      await c.stopTool(p['callId'] as string, m);
      return {};
    case 'agent.memory.list':
      return c.listMemories(agentId);
    case 'agent.memory.delete':
      await c.deleteMemory(agentId, p['memoryId'] as string, m);
      return { deleted: true };
    case 'agent.memory.clear':
      return c.clearMemories(agentId, m);
    // The setup screen and its settings (draft ADR section 16).
    case 'agent.access.get':
      return { access: await c.getAccess(agentId) };
    case 'agent.access.set': {
      const change: AccessChange = {};
      if (p['apps'] !== undefined) change.apps = p['apps'] as AccessChange['apps'];
      if (p['auto'] !== undefined) change.auto = p['auto'] as AccessChange['auto'];
      if (p['desks'] !== undefined) change.desks = p['desks'] as AccessChange['desks'];
      return { access: await c.setAccess(agentId, change, m) };
    }
    case 'agent.desks.revoke':
      return c.revokeDeskGrant(p['grantId'] as string, m);
    // Messages between desks (W6; deskd API.md section 18).
    case 'agent.desks.list':
      return c.listDeskHalves();
    case 'agent.desks.answer':
      return { half: await c.answerDeskOffer(p['grantId'] as string, p['allow'] === true ? { allow: true, agentId: String(p['agentId'] ?? '') } : { allow: false }, m) };
    case 'agent.desks.take':
      return (c as MockAgentClient).takeOutbox(String(p['toDeskId'] ?? ''), typeof p['limit'] === 'number' ? p['limit'] : 50);
    case 'agent.desks.deliver':
      return (c as MockAgentClient).deliverEnvelope(p['envelope']);
    case 'agent.desks.done':
      return (c as MockAgentClient).doneOutbox(Array.isArray(p['results']) ? (p['results'] as { id: string; outcome: string; reason?: string }[]) : []);
    default:
      throw wireError('not_found', {});
  }
}
