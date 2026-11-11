// What the Agent app and the desk say to each other: the shapes of the proposed `agent.*` methods and topics
// (README.md, "Interface"). Names and units follow task 04's `desk-agent` code where it already has them:
// provider ids, status words, limit scopes, µ$ amounts, the audit row. Everything here is data from the desk,
// so any text in it (names, replies, targets) is untrusted and renders as text only.

/** `anthropic`, `openai`, `google`, `xai`; a string, so an OpenAI-compatible endpoint is one more value. */
export type ProviderId = string;

/** Who produced an answer: what a provider badge shows (design 9.4). Task 04's `ManagerAgent.Badge`. */
export interface Badge {
  provider: ProviderId;
  /** The badge's text, such as "Anthropic". */
  providerName: string;
  /** The model the provider says answered, which can differ from the one asked for. */
  model: string;
}

/**
 * An agent's state (design 9.1), in task 04's wire words (`ManagerAgent.Status`), plus `needs_you` for approvals,
 * which come with tools.
 */
export type AgentStatus = 'no_key' | 'online' | 'working' | 'needs_you' | 'limit_reached' | 'error' | 'paused';

export type AgentRole = 'manager' | 'staff';

/** design 9.2's `chat_binding`, as the client sees it. */
export interface Binding {
  keyId: string;
  provider: ProviderId;
  providerName: string;
  model: string;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  /** A word with the status, never content: the limit's scope, or the provider's error kind. */
  statusDetail?: string | null;
  /** Null while dormant (`no_key`). */
  binding: Binding | null;
  /** The member hid this agent's badge (a desk setting, design 9.4). */
  badgeHidden: boolean;
  /** The provider changed while the badge was hidden: it shows until the member dismisses it. */
  badgeNotice: boolean;
  /** Finished replies the member hasn't seen. */
  unseen: number;
  // ----- task 49 (multi-agent.md section 1). Optional: a desk before it sends none of these, and `agent.state` leaves some out.
  /** The desk's first agent, `manager`: the lead. It can't be deleted. */
  lead?: boolean;
  /** Its instructions, up to `caps.purposeMax`. `""` uses the built-in default for its role. Not in `agent.state`. */
  purpose?: string;
  look?: AgentLook;
  /** True (the default): it sends no messages to other agents, whatever `links` says. It still receives from any agent whose link names it. */
  solo?: boolean;
  /** Full view only: the links into this agent, with the rules each one's sender gives it. */
  incoming?: AgentIncoming[];
  /** Whom it may message, with the member's rules for each. `agent.state` has `[{to}]` only. */
  links?: AgentLink[];
  /** Its folder's quota and use. Not in `agent.state`. */
  workspace?: WorkspaceInfo;
  /** How many timers it has. */
  timers?: number;
  createdAt?: number;
  // ----- S-14 (deskd API.md section 18). Absent from a desk before approvals.
  /** Its approvals waiting for the member. While above 0 the desk says `working` with `statusDetail: "awaiting_approval"`. */
  approvalsPending?: number;
}

/** An agent's tile: a library icon's id (or `png`), a tone's id, and the upload's version (`web/agent/src/look/`). */
export interface AgentLook {
  icon: string;
  tone: string;
  /** The uploaded mask's version, a counter, or null. A client refetches `agent.icon.get` when it changes. */
  png: number | null;
}

/** One link into an agent: `from` is the sending agent's id. */
export interface AgentIncoming {
  from: string;
  rules: string;
}

/** One pairing: this agent may message `to`, under the member's rules of engagement (1 to `caps.rulesMax` characters). */
export interface AgentLink {
  to: string;
  /** Absent in `agent.state`, which leaves the rules' text out. */
  rules?: string;
}

export interface WorkspaceInfo {
  quotaBytes: number;
  usedBytes: number;
  /** Agents the member shared this workspace with, read only. */
  sharedWith: string[];
}

/** The tier's defaults as the desk applies them (multi-agent.md section 2). `agentCap` counts every agent, the lead included. */
export interface AgentCaps {
  agentCap: number;
  agents: number;
  workspaceMb: number;
  workspaceMaxMb: number;
  /** The sum of every agent's quota, and the most that may add up to (50% of the desk's disk). */
  workspaceTotalMb?: number;
  workspaceBudgetMb?: number;
  timersPerAgent: number;
  timerMinMinutes: number;
  a2aPerHour: number;
  /** Messages an hour across the whole desk. */
  a2aDeskPerHour?: number;
  a2aDepth: number;
  a2aSpendPct: number;
  runsAtOnce: number;
  rulesMax: number;
  purposeMax: number;
  promptMax: number;
  iconMaxBytes: number;
  iconMaxPx: number;
}

/** What `agent.create` takes. */
export interface AgentCreate {
  name: string;
  purpose?: string;
  icon?: string;
  tone?: string;
  keyId?: string;
  model?: string;
  solo?: boolean;
  workspaceMb?: number;
}

/** What `agent.update` takes: any of these. */
export interface AgentPatch {
  name?: string;
  purpose?: string;
  icon?: string;
  tone?: string;
  solo?: boolean;
  workspaceMb?: number;
  badgeHidden?: boolean;
  dismissBadgeNotice?: boolean;
}

// ----- the lead's proposals (multi-agent.md section 3)

export type ProposalAction = 'agent.create' | 'agent.update' | 'agent.delete' | 'agent.links' | 'timer.set' | 'timer.delete';
/** `applied_partly` (with `detail` and `result`): only if something can still apply partly after the desk's checks and rollback. */
export type ProposalState = 'pending' | 'applied' | 'applied_partly' | 'declined' | 'failed' | 'expired';

/** What started the lead's run that made a proposal (task 49 fix contract section 5). */
export type ProposalOrigin =
  | { kind: 'member' }
  | { kind: 'agent'; agentId: string; name: string }
  | { kind: 'timer'; agentId: string; timerId: string; label: string };

/** A change the lead asks the member to confirm. It applies only on the member's yes, with this card's `sha256`. */
export interface Proposal {
  id: string;
  action: ProposalAction;
  /** The lead's own words for it. Untrusted text. */
  summary: string;
  /** What will change, exactly. Its canonical JSON's SHA-256 is `sha256`. */
  payload: Record<string, unknown>;
  /** Hex. */
  sha256: string;
  state: ProposalState;
  /** Why it failed, a word (such as `agent_cap`). */
  detail: string | null;
  answeredAt: number | null;
  expiresAt: number;
  /** `{agentId}` for an applied create. */
  result: { agentId?: string } | null;
  /** What started the run that made it. Absent from a desk before the fix: read as the member. Not part of the hash. */
  origin?: ProposalOrigin;
  /**
   * The current state of what it changes, read when it was made (not part of the hash): `agent.update` the payload fields'
   * current values (and `usedBytes` with `workspaceMb`); `agent.links` `{solo, links}`; `timer.set` with an id and
   * `timer.delete` `{timer}`; `agent.delete` `{name, look, usedBytes, timers, links, incoming}`; null for a create.
   */
  before?: Record<string, unknown> | null;
}

/** Where a thread message came from when the member didn't write it: another agent (with the rules of that pairing) or a timer. */
export type MessageOrigin =
  | { kind: 'agent'; agentId: string; rules?: string | null; chainId?: string | null; depth?: number | null }
  | { kind: 'timer'; timerId: string; label?: string | null };

// ----- messages between agents (multi-agent.md section 4)

export type A2aState = 'delivered' | 'replied' | 'failed' | 'refused';

/** One row of the agent-message log. Text, rules and reply are untrusted and render as text only. */
export interface A2aMessage {
  id: string;
  from: string;
  to: string;
  chainId: string;
  depth: number;
  text: string;
  rules: string;
  at: number;
  state: A2aState;
  /** For `refused` and `failed`: `rate`, `depth`, `loop`, `spend`, `busy`, `no_key`, `limit_reached`, `solo`, `no_link`. */
  reason: string | null;
  reply: string | null;
  costMicroUsd: number | null;
}

export interface A2aPage {
  /** Newest first, 100 a page. */
  messages: A2aMessage[];
  /** There are older ones: ask again with `before` the oldest one's `at`. */
  older: boolean;
}

// ----- a workspace per agent (multi-agent.md section 5)

export interface WorkspaceEntry {
  /** Relative, `/`-separated. */
  path: string;
  dir: boolean;
  bytes: number;
  modifiedAt: number;
}

export interface WorkspaceView extends WorkspaceInfo {
  /** A folder's entries, 500 at most. */
  entries: WorkspaceEntry[];
  /** The folder holds over 500 entries: these are the first. */
  more?: boolean;
}

export interface WorkspaceFile {
  path: string;
  text: string;
  bytes: number;
  /** There is more after this page: `text` is one page (up to 128 Ki characters) from `offset`. */
  truncated: boolean;
  /** Where this page starts, in characters. Absent from a desk before paging: the start. */
  offset?: number;
  /** Characters left after this page. Absent from a desk before paging. */
  remaining?: number;
}

// ----- timers (multi-agent.md section 6)

export type TimerKind = 'once' | 'repeat';

export interface Timer {
  id: string;
  label: string;
  kind: TimerKind;
  /** `repeat` on days: 1 Monday to 7 Sunday, with `time`. */
  days: number[] | null;
  /** `HH:MM`, 24-hour, in `zone`. */
  time: string | null;
  /** `repeat` every so many minutes, at least `caps.timerMinMinutes`. */
  everyMinutes: number | null;
  /** `once`: when, epoch ms. */
  at: number | null;
  prompt: string;
  enabled: boolean;
  /** The member's zone, the one the limits use. */
  zone: string | null;
  nextAt: number | null;
  lastAt: number | null;
  /** `ok`, `busy`, `no_key`, `limit_reached`, `failed`, `missed`, or null before its first run. */
  lastState: string | null;
  spentMicroUsd: number;
  createdAt: number;
}

/** What `agent.timer.set` takes. `once` takes `at` or `inMinutes`; `repeat` takes `days` and `time`, or `everyMinutes`. With `id`, a change. */
export interface TimerInput {
  id?: string;
  label: string;
  kind: TimerKind;
  days?: number[] | null;
  time?: string | null;
  everyMinutes?: number | null;
  at?: number | null;
  inMinutes?: number | null;
  prompt: string;
  enabled?: boolean;
}

export interface TimerList {
  timers: Timer[];
  zone: string | null;
}

/** Task 04's `Usage`, normalized so each count is billed at one price. */
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** `awaiting_approval` (API.md section 18): between `streaming` and its end, while the run waits on the member's answers. */
export type MessageState = 'streaming' | 'awaiting_approval' | 'done' | 'stopped' | 'failed';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch ms, from the desk. */
  at: number;
  runId?: string;
  /** Assistant messages only. Every one has its own, since the model can change mid-thread. */
  badge?: Badge;
  usage?: Usage;
  /** Estimated, from provider-reported usage. Null for a model with no price. */
  costMicroUsd?: number | null;
  stopReason?: string | null;
  state?: MessageState;
  /** Why a reply failed: an `AgentErrorReason`, never the provider's own message. */
  error?: AgentErrorReason | null;
  errorDetail?: string | null;
  /** On a `free_limit` reply: when the provider's free requests come back, epoch ms (`X-RateLimit-Reset`). Not served yet. */
  errorResetAt?: number | null;
  /** Too long for one event (deskd API.md section 11): this has the start of its text, and `agent.thread.get` the whole. */
  truncated?: boolean;
  /** A `user` message the member didn't write: from another agent, or a timer (task 49). */
  origin?: MessageOrigin | null;
  /** Files this reply's run couldn't save to its workspace, and why (`workspace_full`, `disk_low`, `too_many_folders`). Paths are the agent's own words. */
  workspaceRefused?: { path: string; reason: string }[] | null;
  /** An assistant reply of the lead's: the changes it proposes, each for the member to confirm (task 49). */
  proposals?: Proposal[] | null;
  /** Files this `user` message carried (ADR 0049): a name, a kind, a size and maybe a note, never the content. */
  attachments?: SentFile[] | null;
  // ----- S-14 (API.md section 18)
  /** The tool calls of this reply's run, as chips. A few words the desk writes, never content. */
  tools?: ToolChip[] | null;
  /** While `awaiting_approval`: the approvals it waits on. */
  pendingApprovals?: string[] | null;
  /** Its run read untrusted content (pages, files, another agent's message). */
  untrusted?: boolean;
  /** How many `egress` calls its run made, approved and run. Absent for none. */
  egressCount?: number;
}

// ----- S-14: tools, approvals, running tools and memory (deskd API.md section 18, desk-agent README "Memory")

/**
 * A call's class, the desk's, with taint applied (API.md section 18). It can be higher than the tool's usual one, never lower.
 * `read` never asks; `own` asks only as a memory save in an untrusted run.
 */
export type Risk = 'read' | 'own' | 'write' | 'delete' | 'send' | 'spend' | 'egress';

/** `pending` → `approved` (running) → `done`, `failed` or `interrupted`; or `pending` → `declined` or `expired`. */
export type ApprovalState = 'pending' | 'approved' | 'done' | 'failed' | 'declined' | 'expired' | 'interrupted';

/** What a call acts on, read by the desk. Not hashed: a card shows it as context, never as what runs. */
export type ApprovalTarget =
  | { kind: 'file'; path: string; to?: string }
  | { kind: 'page'; pageId: string; title: string }
  | { kind: 'element'; origin: string; pageTitle: string; label: string; role: string }
  | { kind: 'site'; site?: string; origin?: string }
  | { kind: 'timer'; at: number }
  | { kind: 'memory' };

/**
 * One request for the member's yes (API.md section 18, "The approval"). Every string in it came from a model, a page or a file
 * except `title`, the desk's: render it as plain text only. `sha256` is the hash the app checks against what it shows.
 */
export interface Approval {
  id: string;
  agentId: string;
  runId: string;
  messageId: string;
  tool: string;
  risk: Risk;
  /** The desk's words, from the tool's template. The card builds its own per `tool` and uses this only for a tool it doesn't know. */
  title: string;
  /** `agent` (the agent's own signed-out Browser, or none) or `member:<site>` (the member's signed-in session for that site). Hashed. */
  context: string;
  target: ApprovalTarget | null;
  /** The exact arguments, hashed. Left out of events over 32 KiB (`payloadOmitted`): `agent.approval.get` has it. */
  payload?: Record<string, unknown> | null;
  payloadOmitted?: boolean;
  payloadBytes?: number;
  /** What the change replaces, read when asked, not hashed. */
  before: Record<string, unknown> | null;
  /** Hex SHA-256 of the canonical JSON of `{v: 1, agentId, runId, tool, context, payload}`. */
  sha256: string;
  /** The run read web pages, files or another agent's messages before asking. */
  untrusted: boolean;
  origin: ProposalOrigin;
  state: ApprovalState;
  /** `expired`: `timeout`, `stopped`, `restart`, `age_band`. */
  detail: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  /** `owner`, or a guild member's id. */
  decidedBy: string | null;
  note: string | null;
  /** After the tool ran: `{ok: true}` or `{ok: false, error}`, `error` a word such as `changed`, `gone`, `off_site`. Never content. */
  result: { ok: boolean; error?: string | null; durationMs?: number } | null;
  // ----- the Product Designer's spec section 1.10, not in section 18 yet: absent on today's desk, drawn when a desk sends them.
  /** The agent's own reason, at most 300 characters. Untrusted, not hashed. */
  reason?: string | null;
  /** Spend only: what it costs, estimated. */
  cost?: { microUsd: number } | null;
}

/** A tool chip on a reply (API.md section 18, "Tool chips"). */
export interface ToolChip {
  /** The tool's wire name. */
  name: string;
  /** A few words the desk writes, never content. */
  summary: string;
  ok: boolean;
  path?: string | null;
  reason?: string | null;
  risk?: Risk;
  /** When the call asked. */
  approval?: { id: string; decision: 'approved' | 'declined' | 'expired' | 'interrupted' } | null;
  target?: ApprovalTarget | null;
  untrusted?: boolean;
  /** Browser calls: the agent's own context or the member's session. */
  session?: 'agent' | 'member';
  // ----- the spec's section 2.8, not in section 18 yet
  durationMs?: number | null;
  /** The member stopped it. */
  stopped?: boolean;
}

/**
 * A tool call running now (the Product Designer's spec section 2.8, topic `agent.tools`; not in section 18 yet: the Desk Engineer's
 * to build). Uses section 18's risk words.
 */
export interface RunningCall {
  callId: string;
  agentId: string;
  runId: string;
  tool: string;
  /** "Reading a web page", from the tool's declaration. */
  doing: string;
  /** Short: host and path for an address, a page's title, a file name. Untrusted text. */
  target: string;
  risk: Risk;
  /** The desk's clock, epoch ms. */
  startedAt: number;
  approvedBy: 'member' | 'rule' | 'none';
  stoppable: boolean;
  state: 'running' | 'stopping';
}

/** Events on topic `agent.tools`: a snapshot first, then each call as it starts or changes, and its end. */
export type ToolsEvent =
  | { type: 'snapshot'; serverNow: number; calls: RunningCall[] }
  | { type: 'call'; call: RunningCall }
  | { type: 'end'; callId: string; agentId: string; result?: 'done' | 'failed' | 'stopped' };

/** One line an agent remembers (desk-agent `agent.memory.list`, S-14). Its text is the member's data. */
export interface MemoryLine {
  id: string;
  text: string;
  createdAt: number;
  /** Saved in a run that read untrusted content, which only happens after the member approved it. */
  untrusted: boolean;
  // ----- the spec's section 3.6, not on today's desk
  source?: MemorySource;
  pinned?: boolean;
  updatedAt?: number;
}

export type MemorySource =
  | { kind: 'chat'; messageId?: string }
  | { kind: 'member' }
  | { kind: 'edited' }
  | { kind: 'timer'; timerLabel?: string }
  | { kind: 'agent'; fromAgentId?: string }
  | { kind: 'approval'; approvalId?: string };

/** `agent.memory.list`'s answer: what the agent remembers, newest first, and its thread's summary, which the Memory tab doesn't list. */
export interface MemoryList {
  agentId: string;
  memories: MemoryLine[];
  summary: { id: string; text: string; messages: number; throughId: string; at: number; untrusted: boolean } | null;
  /** At most `items` lines of `chars` characters. */
  limits: { items: number; chars: number };
  /** The spec's switch (`memoryOn`), not on today's desk: absent means no switch is drawn. */
  on?: boolean;
}

/** What the thread keeps of a file sent with a message. `note` is the desk's own words, e.g. that the text was cut. */
export interface SentFile {
  name: string;
  type: string;
  size: number;
  note?: string | null;
}

/** `agent.attach.caps`'s `caps` (ADR 0049): what one message may carry. The desk is the authority; the client checks first to say so early. */
export interface AttachLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxImageBytes: number;
  maxTotalBytes: number;
  maxFileChars: number;
  maxTotalChars: number;
  maxPdfPages: number;
}

export interface AttachCapsView {
  caps: AttachLimits;
  /** The most the owner may set each cap to. */
  ceiling: AttachLimits;
  /** The most raw bytes in one `agent.attach.put`. */
  chunkBytes: number;
  /** Whether the agent's model takes pictures (only with an `agentId`). Absent: unknown, so the desk says. */
  vision?: boolean;
}

export interface ThreadSnapshot {
  agentId: string;
  messages: Message[];
  /** Every approval of these messages (API.md section 18). Absent from a desk before approvals. */
  approvals?: Approval[];
  /** The conversation topic's latest seq, for `since`. */
  seq: number;
}

/**
 * Events on topic `agent.conversation:<agentId>`. `message` adds or replaces a whole message by id, so a repeat is
 * harmless (deskd API.md section 5). `delta` appends text to a streaming reply.
 */
export type ConversationEvent =
  | { type: 'snapshot'; seq: number; messages: Message[]; approvals?: Approval[] }
  | { type: 'message'; seq: number; message: Message }
  | { type: 'approval'; seq: number; approval: Approval }
  | { type: 'delta'; seq: number; messageId: string; runId: string; text: string };

/** A provider key as the desk describes it. The key itself never comes back. */
export interface KeyMeta {
  keyId: string;
  provider: ProviderId;
  providerName: string;
  label: string;
  last4: string;
  createdAt: number;
  /** The desk it was entered on (design 9.5). */
  createdByDesk: string;
  /**
   * Whether the desk can use this key now. Only a desk whose keys last through a restart says (ADR 0042): `false` is a key
   * it can't read any more, still listed. No field at all is a desk that keeps keys in memory, so a restart drops them.
   */
  available?: boolean;
  /**
   * An OpenRouter key's free requests (agent-free-key spec 9): a day's allowance, what's left of it, and when it comes back, in
   * epoch ms. Not served yet; without it, no numbers show.
   */
  free?: { perDay: number; leftToday: number; resetsAt: number } | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  /**
   * Null when the desk's price table doesn't list it. It still counts, at its provider's highest listed price, so a dollar limit
   * always binds (deskd API.md section 11): the app says it has no listed price.
   */
  inputMicroUsdPerMTok: number | null;
  outputMicroUsdPerMTok: number | null;
  /** Its provider serves it free (OpenRouter's `:free` models, desk-agent's `ProviderId.servesFree`): $0 here, whatever a table says. */
  free?: boolean;
  /** Whether it takes tools. False is a model that only chats: the desk sends it none (desk-agent README, "OpenRouter"). */
  tools?: boolean;
}

export interface Provider {
  id: ProviderId;
  name: string;
  /** The provider's console, where a member makes a key and sets a spend limit. Shown as text, never fetched. */
  console: string;
  /** What this provider's keys start with, for a quick check before anything goes to the desk. */
  keyPrefix: string;
}

/** Task 04's `Limit`: a cap in estimated µ$, in tokens, or both. Null means no cap in that unit. */
export interface Limit {
  maxMicroUsd: number | null;
  maxTokens: number | null;
}

/** Task 04's `LimitPolicy` (design 9.9). Members change it; agents can't. */
export interface LimitPolicy {
  agentDay: Limit;
  agentWeek: Limit;
  agentMonth: Limit;
  /** The whole desk's day (ADR 0043). Only desks from that release send it. */
  deskDay?: Limit;
  deskMonth: Limit;
  keyMonth: Limit;
  run: Limit;
  runMaxSteps: number;
}

/** Task 04's `Scope`, by wire name. */
export type LimitScope = 'agent_day' | 'agent_week' | 'agent_month' | 'desk_day' | 'desk_month' | 'key_month' | 'run' | 'run_steps';

/** What's been spent against one scope's current period. */
export interface ScopeUsage {
  scope: LimitScope;
  spentMicroUsd: number;
  spentTokens: number;
  /** When the period rolls over, epoch ms. Null for `run`. */
  resetsAt: number | null;
}

/**
 * What one layer sets of the values that layer, desk then account then default (ADR 0043): each null where that layer sets nothing.
 * A `Limit` with both caps null is "no limit", set there.
 */
export interface LimitLayer {
  deskDay: Limit | null;
  deskMonth: Limit | null;
  timeZone: string | null;
}

export interface LimitsView {
  agentId: string;
  /** What's in force for this agent, the layered values included. */
  policy: LimitPolicy;
  usage: ScopeUsage[];
  /** The zone periods run in (ADR 0043), null for UTC. Its presence, even null, is how a desk says it keeps keys (`keysLast`). */
  timeZone?: string | null;
  /** The `checked` date of the price table in use, `yyyy-MM-dd`, or null if it has none. From ADR 0043's desks. */
  pricesAsOf?: string | null;
  /** What this desk sets itself. From ADR 0043's desks, as `account` is. */
  desk?: LimitLayer;
  /** What the member's account sets, for every desk that doesn't set its own. */
  account?: LimitLayer;
}

/**
 * `agent.limits.set`'s change. In `policy`, `deskDay` and `deskMonth` absent change nothing, null clears this desk's so it follows
 * the account, and a `Limit` sets this desk's own; every other field is required. `timeZone` the same: absent, null or a zone.
 */
export type PolicyChange = Omit<LimitPolicy, 'deskDay' | 'deskMonth'> & { deskDay?: Limit | null; deskMonth?: Limit | null };

export interface LimitsChange {
  policy?: PolicyChange;
  timeZone?: string | null;
}

/** Task 04's audit row (`AuditLog`), camelCased. Ids and hashes only, never a prompt, a reply or a key. */
export interface AuditEntry {
  seq: number;
  atMs: number;
  /** `user`, `support`, `system`, `agent:<id>` or `desk:<id>`. */
  actor: string;
  /** Such as `key.add`, `key.drop`, `llm.call`, `limit.hit`, `limits.set`, `limits.timezone`. */
  action: string;
  target: string;
  /** Hex, or null. */
  payloadSha256: string | null;
  decision: string;
  costMicroUsd: number | null;
  /** Hex: `SHA-256(prev ‖ entry)`. */
  hash: string;
  /** The words for a tool, approval or memory row, joined in at read time and not chained (the spec's section 4.5; not on today's desk). */
  detail?: AuditDetail | null;
}

export interface AuditDetail {
  agentId?: string;
  tool?: string;
  risk?: Risk;
  done?: string;
  asked?: string;
  /** Short. An address shows its host only. */
  target?: string | null;
  approvedBy?: 'member' | 'rule' | 'none' | null;
  approval?: 'declined' | 'expired' | 'cancelled' | null;
  undoable?: boolean;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** The chain's newest hash, hex. */
  headHash: string;
  /** Pass as `beforeSeq` for the next page; null when there's no more. */
  nextBeforeSeq: number | null;
}

/** deskd's error codes (deskd API.md section 4). */
export type DeskErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'step_up_required'
  | 'not_found'
  | 'precondition_failed'
  | 'conflict'
  | 'too_large'
  | 'rate_limited'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'unavailable'
  | 'internal';

/**
 * `details.reason` on an `agent.*` error: task 04's `AgentException.Code`, plus the key checks deskd makes before
 * a key reaches desk-agent.
 */
export type AgentErrorReason =
  | 'no_key'
  | 'busy'
  | 'limit_reached'
  | 'provider_error'
  | 'unavailable'
  | 'key_refused'
  | 'key_malformed'
  | 'agent_cap'
  | 'storage'
  | 'time_zone'
  // task 49
  | 'workspace_full'
  | 'timer_cap'
  | 'answered'
  | 'expired'
  | 'not_png'
  | 'too_large'
  | 'too_many_pixels'
  | 'corrupt'
  | 'no_shape'
  | 'too_thin'
  | 'name_taken'
  | 'disk_low'
  | 'disk_budget'
  | 'too_many_folders'
  | 'hidden_chars'
  | 'cut_off'
  | 'refused'
  // Files on a message (ADR 0049). `too_large` above is also a file's.
  | 'too_many'
  | 'total_too_large'
  | 'too_long'
  | 'unsupported_type'
  | 'legacy_office'
  | 'binary'
  | 'empty'
  | 'encrypted'
  | 'no_text'
  | 'unreadable'
  | 'too_complex'
  | 'timeout'
  | 'image_too_big'
  | 'no_vision'
  | 'missing'
  | 'bad_upload'
  | 'staging_full'
  // S-14: a message to an agent whose run waits on the member; a call that can't be stopped once it began.
  | 'awaiting_approval'
  | 'not_stoppable';
