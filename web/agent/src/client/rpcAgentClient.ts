// `AgentClient` over deskd's RPC and subscriptions (deskd API.md section 11). The Desk app makes one over a desk's
// `DeskLink`, in web/src/agent/AgentBody.tsx.
//
// The key goes in `agent.key.add`'s params, on the desk's `rpc` data channel, end to end (design 9.5 step 1).
// This file is the only reader of `KeySecret`'s plaintext, and it reads it only to build that one frame.
import { AgentError, newIdem, type AgentClient, type Mutation } from './agentClient';
import { CHUNK_BYTES, uploadInChunks } from './attachUpload';
import type { KeySecret } from './keySecret';
import type {
  A2aPage,
  Agent,
  AgentCaps,
  AgentCreate,
  AgentErrorReason,
  AttachCapsView,
  AttachLimits,
  AgentLink,
  AgentPatch,
  AuditPage,
  ConversationEvent,
  DeskErrorCode,
  KeyMeta,
  LimitScope,
  LimitsChange,
  LimitsView,
  Message,
  ModelInfo,
  Provider,
  Proposal,
  ThreadSnapshot,
  Timer,
  TimerInput,
  TimerList,
  WorkspaceFile,
  WorkspaceView,
} from './types';

/** One EVT: `{...data, type, seq}`. */
export type TopicEvent = { seq: number; type?: string } & Record<string, unknown>;

/**
 * What `RpcAgentClient` needs of a desk link: `DeskLink.call` and `DeskLink.subscribe`, untyped. Once DeskRpc and
 * LinkTopics list the agent methods, the adapter is `{ call: (m, p, o) => link.call(m as never, p, o),
 * subscribe: (t, fn, r) => link.subscribe(t as never, fn as never, r) }`.
 */
export interface DeskTransport {
  call(method: string, params?: Record<string, unknown>, options?: { idem?: string; deadlineMs?: number }): Promise<unknown>;
  /**
   * Each EVT as the Desk's link delivers it: the event's `data` spread out, with `type` and `seq` added
   * (web/src/desk/rtc/rtcDeskLink.ts). Returns an unsubscribe.
   */
  subscribe(topic: string, onEvent: (msg: TopicEvent) => void, onRefused?: (code: string) => void): () => void;
}

const DEADLINE_MS = 15_000;
/** `agent.key.add` and `agent.key.models` call the provider, and deskd waits this long for them (API.md section 11). */
const KEY_DEADLINE_MS = 30_000;

/** A link's RpcError, or anything with deskd's `code` and `details`, as an AgentError. */
export function toAgentError(err: unknown): unknown {
  if (err instanceof AgentError) return err;
  const e = err as { code?: unknown; details?: unknown } | null;
  if (!e || typeof e.code !== 'string') return err;
  const d = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
  const word = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return new AgentError(e.code as DeskErrorCode, {
    reason: word(d['reason']) as AgentErrorReason | null,
    detail: word(d['detail']),
    file: word(d['name']),
    limit: typeof d['limit'] === 'number' ? d['limit'] : null,
    scope: word(d['scope']) as LimitScope | null,
    mayHaveApplied: d['mayHaveApplied'] === true,
  });
}

export class RpcAgentClient implements AgentClient {
  /** Raw bytes in one `agent.attach.put`: 512 KiB, or less if the desk says so. */
  private chunkBytes = CHUNK_BYTES;

  constructor(private readonly link: DeskTransport) {}

  private async call<T>(method: string, params: Record<string, unknown> = {}, m?: Mutation, deadlineMs = DEADLINE_MS): Promise<T> {
    try {
      return (await this.link.call(method, params, m ? { idem: m.idem, deadlineMs } : { deadlineMs })) as T;
    } catch (err) {
      throw toAgentError(err);
    }
  }

  async providers(): Promise<Provider[]> {
    return (await this.call<{ providers: Provider[] }>('agent.providers')).providers;
  }

  async listAgents(): Promise<Agent[]> {
    return (await this.call<{ agents: Agent[] }>('agent.list')).agents;
  }

  watchAgents(onAgents: (agents: Agent[], caps: AgentCaps | null) => void): () => void {
    // Each event is a whole snapshot (a coalescible topic), so a repeat or a jump in seq is harmless.
    return this.link.subscribe('agent.state', (msg) => {
      const caps = msg['caps'] && typeof msg['caps'] === 'object' ? (msg['caps'] as AgentCaps) : null;
      if (Array.isArray(msg['agents'])) onAgents(msg['agents'] as Agent[], caps);
    });
  }

  async getAgent(agentId: string): Promise<Agent> {
    return (await this.call<{ agent: Agent }>('agent.get', { agentId })).agent;
  }

  async createAgent(input: AgentCreate, m: Mutation): Promise<Agent> {
    return (await this.call<{ agent: Agent }>('agent.create', { ...input }, m)).agent;
  }

  async updateAgent(agentId: string, patch: AgentPatch, m: Mutation): Promise<Agent> {
    return (await this.call<{ agent: Agent }>('agent.update', { agentId, ...patch }, m)).agent;
  }

  async deleteAgent(agentId: string, m: Mutation): Promise<void> {
    await this.call('agent.delete', { agentId }, m);
  }

  async setLinks(agentId: string, change: { solo: boolean; links: AgentLink[] }, m: Mutation): Promise<Agent> {
    const links = change.links.map((l) => ({ to: l.to, rules: l.rules ?? '' }));
    return (await this.call<{ agent: Agent }>('agent.links.set', { agentId, solo: change.solo, links }, m)).agent;
  }

  async caps(): Promise<AgentCaps> {
    return (await this.call<{ caps: AgentCaps }>('agent.caps')).caps;
  }

  async answerProposal(proposalId: string, accept: boolean, sha256: string, m: Mutation): Promise<Proposal> {
    return (await this.call<{ proposal: Proposal }>('agent.proposal.answer', { proposalId, accept, sha256 }, m)).proposal;
  }

  listA2a(opts: { agentId?: string; before?: number } = {}): Promise<A2aPage> {
    const params: Record<string, unknown> = {};
    if (opts.agentId !== undefined) params['agentId'] = opts.agentId;
    if (opts.before !== undefined) params['before'] = opts.before;
    return this.call<A2aPage>('agent.a2a.list', params);
  }

  getWorkspace(agentId: string, path?: string): Promise<WorkspaceView> {
    return this.call<WorkspaceView>('agent.workspace.get', path === undefined || path === '' ? { agentId } : { agentId, path });
  }

  readWorkspace(agentId: string, path: string, opts: { offset?: number; length?: number } = {}): Promise<WorkspaceFile> {
    return this.call<WorkspaceFile>('agent.workspace.read', { agentId, path, ...(opts.offset ? { offset: opts.offset } : {}), ...(opts.length ? { length: opts.length } : {}) });
  }

  deleteWorkspaceEntry(agentId: string, path: string, m: Mutation): Promise<{ usedBytes: number }> {
    return this.call<{ usedBytes: number }>('agent.workspace.delete', { agentId, path }, m);
  }

  async shareWorkspace(agentId: string, withAgents: string[], m: Mutation): Promise<Agent> {
    return (await this.call<{ agent: Agent }>('agent.workspace.share', { agentId, with: [...withAgents] }, m)).agent;
  }

  listTimers(agentId: string): Promise<TimerList> {
    return this.call<TimerList>('agent.timer.list', { agentId });
  }

  async setTimer(agentId: string, timer: TimerInput, m: Mutation): Promise<Timer> {
    return (await this.call<{ timer: Timer }>('agent.timer.set', { agentId, timer }, m)).timer;
  }

  async deleteTimer(agentId: string, timerId: string, m: Mutation): Promise<void> {
    await this.call('agent.timer.delete', { agentId, timerId }, m);
  }

  async uploadIcon(agentId: string, pngBase64: string, m: Mutation): Promise<Agent | null> {
    const answer = await this.call<{ agent?: Agent } | null>('agent.icon.upload', { agentId, png: pngBase64 }, m);
    return answer && typeof answer === 'object' && answer.agent ? answer.agent : null;
  }

  getIcon(agentId: string): Promise<{ png: string; version: number }> {
    return this.call<{ png: string; version: number }>('agent.icon.get', { agentId });
  }

  async bindAgent(agentId: string, binding: { keyId: string; model: string }, m: Mutation): Promise<Agent> {
    return (await this.call<{ agent: Agent }>('agent.bind', { agentId, ...binding }, m)).agent;
  }

  getThread(agentId: string): Promise<ThreadSnapshot> {
    return this.call<ThreadSnapshot>('agent.thread.get', { agentId });
  }

  watchConversation(agentId: string, onEvent: (e: ConversationEvent) => void): () => void {
    let lastSeq = 0;
    let gone = false;
    let asking = false;
    // An EVT is at most 64 KiB and a thread can be longer: a snapshot says how many it left out, and a long message comes
    // cut. `agent.thread.get` has them all (API.md section 11). Its `seq` is the last event seen, so what follows still lands.
    const askForWhole = (): void => {
      if (asking) return;
      asking = true;
      this.getThread(agentId).then(
        (t) => {
          asking = false;
          if (!gone) onEvent({ type: 'snapshot', seq: lastSeq, messages: t.messages });
        },
        () => {
          asking = false; // what's shown stands, and the next snapshot asks again
        },
      );
    };
    const off = this.link.subscribe(`agent.conversation:${agentId}`, (msg) => {
      lastSeq = msg.seq;
      if (msg.type === 'snapshot') {
        const messages = (msg['messages'] as Message[] | undefined) ?? [];
        onEvent({ type: 'snapshot', seq: msg.seq, messages });
        if (Number(msg['omitted'] ?? 0) > 0 || messages.some((m) => m.truncated)) askForWhole();
      } else if (msg.type === 'message' && msg['message']) {
        const message = msg['message'] as Message;
        onEvent({ type: 'message', seq: msg.seq, message });
        if (message.truncated) askForWhole();
      } else if (msg.type === 'delta') {
        onEvent({ type: 'delta', seq: msg.seq, messageId: String(msg['messageId']), runId: String(msg['runId']), text: String(msg['text'] ?? '') });
      }
      // `resync` and `error` are the link's to handle: it subscribes again, and a snapshot follows.
    });
    return () => {
      gone = true;
      off();
    };
  }

  sendMessage(agentId: string, text: string, m: Mutation, attachments: readonly string[] = []): Promise<{ messageId: string; runId: string }> {
    return this.call('agent.message.send', attachments.length ? { agentId, text, attachments: [...attachments] } : { agentId, text }, m);
  }

  async attachFile(agentId: string, uploadId: string, file: File, opts: { signal?: AbortSignal; onProgress?: (done: number) => void } = {}): Promise<void> {
    const name = file.name.slice(0, 255);
    // Each chunk is its own action with its own key. A chunk sent again after a lost answer with a new key is `bad_upload`
    // (the desk counts chunks), so the caller starts that file over with a new id.
    await uploadInChunks(
      file,
      async (c) => {
        const params = { agentId, uploadId, name, size: file.size, index: c.index, data: c.data };
        const m = { idem: newIdem() };
        try {
          await this.call('agent.attach.put', params, m);
        } catch (err) {
          // An answer that never came may still have been applied; the same key gets the first answer back.
          if (!(err instanceof AgentError) || !(err.mayHaveApplied || err.code === 'deadline_exceeded')) throw err;
          await this.call('agent.attach.put', params, m);
        }
      },
      { chunkBytes: this.chunkBytes, signal: opts.signal, onProgress: opts.onProgress },
    );
  }

  async removeAttachment(agentId: string, uploadId: string, m: Mutation): Promise<void> {
    await this.call('agent.attach.remove', { agentId, uploadId }, m);
  }

  async attachCaps(agentId?: string): Promise<AttachCapsView> {
    const v = await this.call<AttachCapsView>('agent.attach.caps', agentId ? { agentId } : {});
    if (Number.isFinite(v.chunkBytes) && v.chunkBytes > 0) this.chunkBytes = Math.min(v.chunkBytes, CHUNK_BYTES);
    return v;
  }

  setAttachCaps(change: Partial<AttachLimits>, m: Mutation): Promise<AttachCapsView> {
    return this.call<AttachCapsView>('agent.attach.caps.set', { ...change }, m);
  }

  async stopRun(runId: string, m: Mutation): Promise<void> {
    await this.call('agent.run.stop', { runId }, m);
  }

  async markSeen(agentId: string): Promise<void> {
    await this.call('agent.seen', { agentId });
  }

  async listKeys(): Promise<KeyMeta[]> {
    return (await this.call<{ keys: KeyMeta[] }>('agent.key.list')).keys;
  }

  async addKey(input: { provider: string; label: string; secret: KeySecret }, m: Mutation): Promise<KeyMeta> {
    // The params object lives only for this call. Nothing here keeps it, logs it or retries with it.
    const params = input.secret.withPlaintext((secret) => ({ provider: input.provider, label: input.label, secret }));
    try {
      return (await this.call<{ key: KeyMeta }>('agent.key.add', params, m, KEY_DEADLINE_MS)).key;
    } finally {
      params.secret = '';
    }
  }

  async deleteKey(keyId: string, m: Mutation): Promise<void> {
    await this.call('agent.key.delete', { keyId }, m);
  }

  async listModels(keyId: string): Promise<ModelInfo[]> {
    return (await this.call<{ models: ModelInfo[] }>('agent.key.models', { keyId }, undefined, KEY_DEADLINE_MS)).models;
  }

  getLimits(agentId: string): Promise<LimitsView> {
    return this.call<LimitsView>('agent.limits.get', { agentId });
  }

  setLimits(agentId: string, change: LimitsChange, m: Mutation): Promise<LimitsView> {
    // Absent and null mean different things here (API.md section 11), so only what's in `change` goes, as it is.
    const params: Record<string, unknown> = { agentId };
    if (change.policy !== undefined) params['policy'] = change.policy;
    if (change.timeZone !== undefined) params['timeZone'] = change.timeZone;
    return this.call<LimitsView>('agent.limits.set', params, m);
  }

  listAudit(opts: { beforeSeq?: number; limit?: number } = {}): Promise<AuditPage> {
    return this.call<AuditPage>('agent.audit.list', { ...opts });
  }
}
