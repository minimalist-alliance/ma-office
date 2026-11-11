// Dev and test only, like `mockDeskLink.ts`, which is all that imports this: never in a production bundle. `web/agent`'s mock
// behind a desk's wire, so `RpcAgentClient` and everything above it run for real. As deskd API.md section 11 says, on a small
// scale: mutations need `idem`, errors have `code` and `details`, and while `desk-agent` is down every call answers `unavailable`
// and subscriptions stay quiet until it's back, when each gets a fresh snapshot.
import { AgentError, type AgentClient } from '../../agent/src/client/agentClient';
import { KeySecret } from '../../agent/src/client/keySecret';
import type { AgentCaps, AttachLimits, AgentCreate, AgentLink, AgentPatch, ConversationEvent, LimitLayer, LimitsChange, TimerInput, ToolsEvent } from '../../agent/src/client/types';
import type { FixtureName } from '../../agent/src/mock/fixtures';
import { MockAgentClient } from '../../agent/src/mock/mockAgentClient';
import type { RpcOptions } from './deskLink';
import type { SubWire } from './rtc/subs';

/** What a dev or a `shell` test can steer, as `window.__maDeskMock.agent`. */
export interface MockAgentControl {
  /** `?agentFixture=fresh|ready|limit|tools`: what each desk starts with. `tools` is S-14's (approvals, running tools, memory). */
  fixture: FixtureName;
  /** `?speed=fast`: as the demo's. */
  fast: boolean;
  /** `?keysLast=1`: keys say `available` and last through a restart (ADR 0042), and limits layer desk, account, default (ADR 0043). */
  keysLast: boolean;
  /** `?accountDay=`, `?accountMonth=` (dollars, or `none`), `?accountZone=`: what the account sets, with `keysLast`. */
  account?: Partial<LimitLayer> | undefined;
  /** `?agentCap=3` and the rest of multi-agent.md section 2's caps, over the built-in defaults. */
  caps?: Partial<AgentCaps> | undefined;
  /** `desk-agent` isn't running. */
  down: boolean;
  setDown(down: boolean): void;
  /** Each desk's, once something has asked. */
  desks: Record<string, MockAgentDesk>;
  /** `desk-agent` restarts, as in `MockAgentClient.restart`. Every subscription gets a fresh snapshot. */
  restart(): void;
  /** Takes the session away for this long, as a dropped connection does. */
  dropLink(ms: number): void;
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
  'agent.tool.stop',
  'agent.memory.delete',
  'agent.memory.clear',
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
  ) {
    this.client = new MockAgentClient({
      fixture: control.fixture,
      keysLast: control.keysLast,
      ...(control.account ? { account: control.account } : {}),
      ...(control.caps ? { caps: control.caps } : {}),
      ...(deskName ? { deskName } : {}),
      ...(control.fast ? { latencyMs: 15, streamMs: 8 } : {}),
    });
  }

  answer(method: string, params: Record<string, unknown>, options?: RpcOptions): Promise<unknown> {
    if (this.control.down) return Promise.reject(wireError('unavailable', { reason: 'unavailable' }));
    if (MUTATIONS.has(method) && !options?.idem) return Promise.reject(wireError('bad_request', {}));
    return call(this.client, method, params, options?.idem ?? '').catch((err: unknown) => {
      if (!(err instanceof AgentError)) throw err;
      throw wireError(err.code, {
        ...(err.reason ? { reason: err.reason } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.scope ? { scope: err.scope } : {}),
        ...(err.file ? { name: err.file } : {}),
        ...(err.limit ? { limit: err.limit } : {}),
      });
    });
  }

  sub(body: { topic: string }): Promise<{ subId: number }> {
    const refusal = this.refuse[body.topic] ?? (body.topic.startsWith('agent.conversation:') ? this.refuse['agent.conversation'] : undefined);
    if (refusal) return Promise.reject(wireError(refusal, {}));
    const subId = this.nextSub;
    this.nextSub += 1;
    const sub = { topic: body.topic, off: null as (() => void) | null };
    this.subs.set(subId, sub);
    if (!this.control.down) this.start(subId, sub);
    return Promise.resolve({ subId });
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
      sub.off = this.client.watchAgents((agents, caps) => send('snapshot', caps ? { agents, caps } : { agents }));
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
      if (e.type === 'snapshot') send('snapshot', e.approvals ? { messages: e.messages, approvals: e.approvals } : { messages: e.messages });
      else if (e.type === 'message') send('message', { message: e.message });
      else if (e.type === 'approval') send('approval', { approval: e.approval });
      else send('delta', { messageId: e.messageId, runId: e.runId, text: e.text });
    });
  }
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
    default:
      throw wireError('not_found', {});
  }
}
