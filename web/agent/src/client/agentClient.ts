// The only way the Agent app reaches its backend. `MockAgentClient` (src/mock/) answers it today;
// `RpcAgentClient` maps it onto deskd's `agent.*` methods and topics once deskd and desk-agent serve them.
// Each method is one row of README.md's interface table, which is what task 04 is asked to agree.
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
  ModelInfo,
  Provider,
  ProviderId,
  Proposal,
  ThreadSnapshot,
  Timer,
  TimerInput,
  TimerList,
  WorkspaceFile,
  WorkspaceView,
} from './types';

/**
 * A mutation's options. `idem` is one member action's key, kept across every retry of that action
 * (deskd API.md section 4). `newIdem()` makes one.
 */
export interface Mutation {
  idem: string;
}

export interface AgentClient {
  /** Providers the desk can use (design 9.3). Phase 1 is Anthropic and OpenAI. */
  providers(): Promise<Provider[]>;

  /** `agent.list`. */
  listAgents(): Promise<Agent[]>;
  /**
   * Topic `agent.state`: every change to any agent, as the whole list, smaller than `agent.get`'s (no purpose, workspace or
   * rules' text), with the caps where the desk sends them (task 49). Returns an unsubscribe.
   */
  watchAgents(onAgents: (agents: Agent[], caps: AgentCaps | null) => void): () => void;
  /** `agent.get`: one agent, whole. */
  getAgent(agentId: string): Promise<Agent>;
  /** `agent.create`: a staff agent. `precondition_failed`, `agent_cap` at the desk's cap. */
  createAgent(input: AgentCreate, m: Mutation): Promise<Agent>;
  /** `agent.update`: what the member may change on an agent besides its key, links and icon upload. */
  updateAgent(agentId: string, patch: AgentPatch, m: Mutation): Promise<Agent>;
  /** `agent.delete`: never the lead. Its thread, workspace, timers, icon, links both ways and limits go; the logs keep their rows. */
  deleteAgent(agentId: string, m: Mutation): Promise<void>;
  /** `agent.links.set`: solo, or whom it may message and under which rules. */
  setLinks(agentId: string, change: { solo: boolean; links: AgentLink[] }, m: Mutation): Promise<Agent>;
  /** `agent.caps`: the tier's defaults as this desk applies them. */
  caps(): Promise<AgentCaps>;

  /** `agent.proposal.answer`: the member's yes or no to one of the lead's proposals, with the card's own `sha256`. */
  answerProposal(proposalId: string, accept: boolean, sha256: string, m: Mutation): Promise<Proposal>;
  /** `agent.a2a.list`: the agent-message log, newest first, for one agent or all. */
  listA2a(opts?: { agentId?: string; before?: number }): Promise<A2aPage>;

  /** `agent.workspace.get`: a folder's entries (the top without `path`), with the quota and use. */
  getWorkspace(agentId: string, path?: string): Promise<WorkspaceView>;
  /** `agent.workspace.read`: one file's text, a page of up to 128 Ki characters from `offset`. */
  readWorkspace(agentId: string, path: string, opts?: { offset?: number; length?: number }): Promise<WorkspaceFile>;
  /** `agent.workspace.delete`: a file or a folder. */
  deleteWorkspaceEntry(agentId: string, path: string, m: Mutation): Promise<{ usedBytes: number }>;
  /** `agent.workspace.share`: which agents may read this one's workspace. */
  shareWorkspace(agentId: string, withAgents: string[], m: Mutation): Promise<Agent>;

  /** `agent.timer.list`. */
  listTimers(agentId: string): Promise<TimerList>;
  /** `agent.timer.set`: a new timer, or with `timer.id` a change. */
  setTimer(agentId: string, timer: TimerInput, m: Mutation): Promise<Timer>;
  /** `agent.timer.delete`. */
  deleteTimer(agentId: string, timerId: string, m: Mutation): Promise<void>;

  /** `agent.icon.upload`: a PNG, base64. The desk keeps only its mask. Answers the agent where the desk sends it, else null. */
  uploadIcon(agentId: string, pngBase64: string, m: Mutation): Promise<Agent | null>;
  /** `agent.icon.get`: the mask, base64, and its version. Only ever shown in this page, through a `blob:` URL. */
  getIcon(agentId: string): Promise<{ png: string; version: number }>;
  /** `agent.bind`: which key and model an agent uses. */
  bindAgent(agentId: string, binding: { keyId: string; model: string }, m: Mutation): Promise<Agent>;

  /** `agent.thread.get`. */
  getThread(agentId: string): Promise<ThreadSnapshot>;
  /** Topic `agent.conversation:<agentId>`. The first event is a snapshot. Returns an unsubscribe. */
  watchConversation(agentId: string, onEvent: (e: ConversationEvent) => void): () => void;
  /**
   * `agent.message.send`. The reply streams on the conversation topic. Closing the window never stops it. `attachments` are
   * upload ids from `attachFile`; the desk takes them and deletes them once the model has answered (ADR 0049). `text` may be
   * empty with files. A `busy` refusal leaves them staged, so the same call can be made again.
   */
  sendMessage(agentId: string, text: string, m: Mutation, attachments?: readonly string[]): Promise<{ messageId: string; runId: string }>;
  /**
   * `agent.attach.put`, once per chunk of at most `chunkBytes` (512 KiB), in order: stages one file on the desk, in its memory
   * only, for 10 minutes at most. The file is read a chunk at a time and nothing here keeps a byte of it. `onProgress` gets the
   * share sent so far, 0 to 1. Aborting stops after the chunk in flight; the caller then `removeAttachment`s the id.
   */
  attachFile(agentId: string, uploadId: string, file: File, opts?: { signal?: AbortSignal; onProgress?: (done: number) => void }): Promise<void>;
  /** `agent.attach.remove`: the desk zeroes a staged file. Harmless for an id it no longer has. */
  removeAttachment(agentId: string, uploadId: string, m: Mutation): Promise<void>;
  /** `agent.attach.caps`. A desk without the method answers `not_found`, and the composer then offers no files. */
  attachCaps(agentId?: string): Promise<AttachCapsView>;
  /** `agent.attach.caps.set`: the desk owner's. Send only the fields that change. */
  setAttachCaps(change: Partial<AttachLimits>, m: Mutation): Promise<AttachCapsView>;
  /** `agent.run.stop`. */
  stopRun(runId: string, m: Mutation): Promise<void>;
  /** Marks an agent's replies as seen. Not a mutation in deskd's sense: repeating it is harmless. */
  markSeen(agentId: string): Promise<void>;

  /** `agent.key.list`: metadata only. */
  listKeys(): Promise<KeyMeta[]>;
  /**
   * `agent.key.add`: the one call that carries a key. The desk validates it with the provider's free model-list
   * call, encrypts it and keeps it for this desk only (design 9.5). The caller wipes `secret` when this settles.
   */
  addKey(input: { provider: ProviderId; label: string; secret: KeySecret }, m: Mutation): Promise<KeyMeta>;
  /** `agent.key.delete`. Agents bound to it go back to `no_key`. May ask for step-up (`step_up_required`). */
  deleteKey(keyId: string, m: Mutation): Promise<void>;
  /** `agent.key.models`: the models this key may use, with prices from the release's `pricing.json`. */
  listModels(keyId: string): Promise<ModelInfo[]>;

  /** `agent.limits.get`: the agent's policy and what's been spent in each scope. */
  getLimits(agentId: string): Promise<LimitsView>;
  /** `agent.limits.set`. Only the member can: the tools RPC has no method for it. Send only what the member changed. */
  setLimits(agentId: string, change: LimitsChange, m: Mutation): Promise<LimitsView>;

  /** `agent.audit.list`: newest first. */
  listAudit(opts?: { beforeSeq?: number; limit?: number }): Promise<AuditPage>;
}

/** An `ERR` from the desk, kept to what the UI branches on. `message` is for logs, never shown. */
export class AgentError extends Error {
  readonly code: DeskErrorCode;
  readonly reason: AgentErrorReason | null;
  /** A word, never content: the provider's error kind, or a field name. */
  readonly detail: string | null;
  /** For a refused file: its name, as the desk says it (`details.name`). */
  readonly file: string | null;
  /** For a refused file: the number the desk limits it by (`details.limit`). */
  readonly limit: number | null;
  /** For `limit_reached`: which limit refused. */
  readonly scope: LimitScope | null;
  /** deskd's `details.mayHaveApplied`. */
  readonly mayHaveApplied: boolean;

  constructor(
    code: DeskErrorCode,
    opts: { reason?: AgentErrorReason | null; detail?: string | null; file?: string | null; limit?: number | null; scope?: LimitScope | null; mayHaveApplied?: boolean } = {},
  ) {
    super(opts.reason ? `${code}: ${opts.reason}` : code);
    this.name = 'AgentError';
    this.code = code;
    this.reason = opts.reason ?? null;
    this.detail = opts.detail ?? null;
    this.file = opts.file ?? null;
    this.limit = opts.limit ?? null;
    this.scope = opts.scope ?? null;
    this.mayHaveApplied = opts.mayHaveApplied ?? false;
  }
}

/** A UUIDv7, as deskd wants for `idem` (same as web/src/desk/idem.ts). */
export function newIdem(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  for (let i = 0; i < 6; i += 1) b[i] = Math.floor(now / 256 ** (5 - i)) % 256;
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
