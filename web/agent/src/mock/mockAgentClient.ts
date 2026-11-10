// The Agent app's backend for the demo and the tests: the whole `AgentClient` in memory, with no network and no
// model. It behaves like the desk in the ways the UI depends on: latency, streaming, limits that refuse before
// a call, provider badges, an audit log, and a key that's checked and then dropped, keeping only its last 4.
import { AgentError, type AgentClient, type Mutation } from '../client/agentClient';
import { uploadInChunks } from '../client/attachUpload';
import { keyFormatProblem, keyOwner, type KeySecret } from '../client/keySecret';
import type {
  AttachCapsView,
  AttachLimits,
  SentFile,
  A2aMessage,
  A2aPage,
  Agent,
  AgentIncoming,
  AgentCaps,
  AgentCreate,
  AgentLink,
  AgentPatch,
  AuditEntry,
  AuditPage,
  ConversationEvent,
  KeyMeta,
  Limit,
  LimitLayer,
  LimitPolicy,
  LimitsChange,
  LimitsView,
  Message,
  MessageOrigin,
  ModelInfo,
  Proposal,
  ProposalAction,
  Provider,
  ThreadSnapshot,
  Timer,
  TimerInput,
  TimerList,
  Usage,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceView,
} from '../client/types';
import { AGENT_ICONS } from '../look/icons';
import { TONES } from '../look/tones';
import { hasHiddenChars, nameKey } from '../model/agents';
import { extOf, isImageName } from '../model/attachments';
import { linkProblems } from '../model/links';
import { fromBase64, maskPixels, pngCheck, toBase64 } from '../model/png';
import { canonicalJson, sha256Hex } from '../model/proposals';
import { DAY, HOUR, MINUTE, nextRun, timerProblem } from '../model/timers';
import { MB, pathProblem, READ_PAGE_CHARS } from '../model/workspace';
import { DEFAULT_CAPS, DEFAULT_POLICY, DESK_DEFAULTS, MAX_OUTPUT_TOKENS, MODELS, PRICES_AS_OF, PROVIDERS, seed, type FixtureName } from './fixtures';
import { check, cost, estimate, totalTokens, usageView, type LedgerRow, type Price } from './ledger';
import { cannedReply, chunks } from './replies';

export interface MockOptions {
  fixture?: FixtureName;
  /** A read's delay. Mutations take a little longer, and a key check longer still. */
  latencyMs?: number;
  /** Between streamed pieces. */
  streamMs?: number;
  now?: () => number;
  /** The desk's name, where it isn't the fixture's. */
  deskName?: string;
  /**
   * A desk whose keys last through a restart, and so say so on each key (`available`, ADR 0042). Unset is a desk that keeps
   * them in memory, as today's do: no field, and `restart()` drops them. It came in the same release as ADR 0043's limits, so it
   * also brings those: `deskDay`, the member's zone, `pricesAsOf`, and `deskDay`, `deskMonth` and the zone layered desk, then
   * account, then default.
   */
  keysLast?: boolean;
  /** With `keysLast`: what the account sets, as the Platform's `agentDefaults` would. */
  account?: Partial<LimitLayer>;
  /** With `keysLast`: a `desk-agent` that audits a call of only `timeZone` as `limits.timezone` (deskd `ad82b2e`). Unset is an older one: `limits.set`. */
  zoneAudit?: boolean;
  /** The tier's values, over multi-agent.md section 2's built-in defaults: `{agentCap: 3}` to reach the cap quickly. */
  caps?: Partial<AgentCaps>;
}

interface Run {
  runId: string;
  agentId: string;
  messageId: string;
  timer: ReturnType<typeof setTimeout> | null;
  sent: string;
  rest: string[];
  full: string;
  price: Price | null;
  keyId: string;
  inputTokens: number;
  /** The lead's proposals, which the reply carries once it's written. */
  proposals: string[];
  /** A run that ends on the output cap or a refusal: it fails with this, keeping what was said. */
  ends?: 'cut_off' | 'refused';
  /** Files this run's agent couldn't save. */
  refusedWrites?: { path: string; reason: string }[];
  /** What a timer's or another agent's run does when it ends: its spend and its words. */
  after: ((spent: number | null, text: string, how: 'done' | 'stopped' | 'failed') => void) | null;
}

/** A proposal and where it lives: the lead's reply that made it. */
interface Held {
  p: Proposal;
  agentId: string;
  messageId: string;
}

const enc = new TextEncoder();
/** ADR 0049's defaults and ceilings (`attach/Caps`). */
const ATTACH_CAPS: AttachLimits = { maxFiles: 5, maxFileBytes: 8 * 1024 * 1024, maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024, maxFileChars: 100_000, maxTotalChars: 200_000, maxPdfPages: 100 };
const ATTACH_CEILING: AttachLimits = { maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024, maxFileChars: 400_000, maxTotalChars: 800_000, maxPdfPages: 300 };
const STAGED_TTL_MS = 10 * MINUTE;
/** A file the desk holds: no bytes, only what the put calls added up to. */
interface Staged {
  agentId: string;
  name: string;
  size: number;
  received: number;
  nextIndex: number;
  complete: boolean;
  lastAt: number;
}
const ICON_IDS = new Set(AGENT_ICONS.map((i) => i.id));
const TONE_IDS = new Set(TONES.map((t) => t.id));
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A reply another agent gets back as its tool's result is cut here (multi-agent.md section 4). */
const A2A_REPLY_MAX = 8000;
/** Timers due this soon run by themselves in the mock; later ones wait for `fireTimer`. */
const SCHEDULE_AHEAD_MS = 10 * MINUTE;
const isLead = (a: Pick<Agent, 'id' | 'lead' | 'role'>): boolean => a.lead === true || a.role === 'manager';
const bytesOf = (text: string): number => enc.encode(text).length;
/** What a file counts toward a workspace's use: its size, and at least 4 KiB. */
const unitsOf = (text: string): number => Math.max(4096, bytesOf(text));
/** What a sent file's `type` says: its extension, or `image` for a picture without one. */
const kindOf = (name: string): string => extOf(name) || (isImageName(name) ? 'image' : 'file');
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const clone = <T>(v: T): T => structuredClone(v);

export class MockAgentClient implements AgentClient {
  private readonly latency: number;
  private readonly streamMs: number;
  private readonly now: () => number;
  private keys: KeyMeta[];
  private agents: Agent[];
  private threads: Record<string, Message[]>;
  private policies: Record<string, LimitPolicy>;
  private ledger: LedgerRow[];
  private seqs: Record<string, number> = {};
  private audit: AuditEntry[] = [];
  private auditTail: Promise<void> = Promise.resolve();
  private head = '00'.repeat(32);
  private runs = new Map<string, Run>();
  private agentWatchers = new Set<(a: Agent[], caps: AgentCaps | null) => void>();
  private readonly capValues: AgentCaps;
  /** Each agent's workspace: path to text and when it changed. */
  private files: Record<string, Map<string, { text: string; modifiedAt: number }>> = {};
  private timerLists: Record<string, Timer[]> = {};
  private timerHandles = new Map<string, ReturnType<typeof setTimeout>>();
  private icons: Record<string, { png: string; version: number }> = {};
  private proposals = new Map<string, Held>();
  /** The agent-message log, newest first. */
  private a2a: A2aMessage[] = [];
  private threadWatchers = new Map<string, Set<(e: ConversationEvent) => void>>();
  private counter = 0;
  /** `agent.attach.put`'s files, by upload id: sizes only, as the real desk's are memory the mock doesn't need. */
  private staged = new Map<string, Staged>();
  private attachCapValues: AttachLimits = { ...ATTACH_CAPS };
  readonly deskName: string;
  private readonly keysLast: boolean;
  private readonly zoneAudit: boolean;
  /** Keys with a row and nothing behind it. */
  private readonly lost = new Set<string>();
  /** ADR 0043's layers, with `keysLast`: what this desk sets, and what the account does. */
  private own: LimitLayer = { deskDay: null, deskMonth: null, timeZone: null };
  private account: LimitLayer = { deskDay: null, deskMonth: null, timeZone: null };
  /** Every call, with its params as JSON would carry them: a key shows as "[redacted]". For tests. */
  readonly calls: { method: string; params: unknown }[] = [];

  constructor(opts: MockOptions = {}) {
    this.latency = opts.latencyMs ?? 90;
    this.streamMs = opts.streamMs ?? 28;
    this.now = opts.now ?? Date.now;
    const s = seed(opts.fixture ?? 'ready', this.now());
    this.deskName = opts.deskName ?? s.deskName;
    this.keysLast = opts.keysLast ?? false;
    this.zoneAudit = opts.zoneAudit ?? false;
    if (opts.account) this.setAccount(opts.account);
    this.capValues = { ...DEFAULT_CAPS, ...opts.caps };
    this.keys = s.keys;
    this.agents = s.agents;
    this.threads = s.threads;
    this.policies = s.policies;
    this.ledger = s.ledger;
    const at = this.now();
    for (const [id, files] of Object.entries(s.files)) this.files[id] = new Map(Object.entries(files).map(([path, text]) => [path, { text, modifiedAt: at - HOUR }]));
    for (const a of this.agents) {
      this.timerLists[a.id] = [];
      this.files[a.id] ??= new Map();
      this.usage(a.id);
    }
    for (const id of Object.keys(this.threads)) this.seqs[id] = (this.threads[id] ?? []).length;
    for (const k of s.keys) this.record('user', 'key.add', `key:${k.keyId}`, `provider:${k.provider}`, null, k.createdAt);
  }

  /** Everything the mock holds, as JSON. A test searches it for a key it must not find. */
  dump(): string {
    return JSON.stringify({ keys: this.keys, agents: this.agents, threads: this.threads, policies: this.policies, audit: this.audit, calls: this.calls, staged: [...this.staged.entries()], a2a: this.a2a, timers: this.timerLists });
  }

  /** An agent's own tool writes a file, as `workspace_write` would: inside its quota, or `workspace_full`. For tests and the demo. */
  writeFile(agentId: string, path: string, text: string): void {
    const a = this.agent(agentId);
    if (pathProblem(path)) throw new AgentError('bad_request', { detail: 'path' });
    const files = (this.files[agentId] ??= new Map());
    const used = (a.workspace?.usedBytes ?? 0) - (files.has(path) ? unitsOf(files.get(path)!.text) : 0) + unitsOf(text);
    if (used > (a.workspace?.quotaBytes ?? Infinity)) throw new AgentError('precondition_failed', { reason: 'workspace_full' });
    files.set(path, { text, modifiedAt: this.now() });
    this.usage(agentId);
    this.emitAgents();
  }

  /** A timer's time comes, now. The mock runs the ones due within ten minutes by itself; this runs any. */
  fireTimer(agentId: string, timerId: string): void {
    const t = (this.timerLists[agentId] ?? []).find((x) => x.id === timerId);
    if (t) this.fire(agentId, t, 0);
  }

  /** A proposal's 24 hours are up. */
  expireProposals(): void {
    for (const held of this.proposals.values()) held.p = { ...held.p, expiresAt: this.now() - 1 };
  }

  /**
   * desk-agent restarts. A reply that was streaming ends `failed`, `unavailable`, as it does at the next start. On a desk whose
   * keys don't last, every key is gone but its row: agents keep their binding and show `no_key`, as desk-agent's do.
   */
  restart(): void {
    for (const run of [...this.runs.values()]) {
      if (run.timer) clearTimeout(run.timer);
      this.runs.delete(run.runId);
      const base = (this.threads[run.agentId] ?? []).find((x) => x.id === run.messageId);
      if (base) {
        const failed: Message = { ...base, text: run.sent, state: 'failed', error: 'unavailable' };
        this.putMessage(run.agentId, failed);
        this.emit(run.agentId, { type: 'message', message: failed });
      }
      run.after?.(null, run.sent, 'failed');
    }
    // As desk-agent audits a restart: the keys leave memory at the stop, and with the store each start reads them back.
    const held = this.keys.filter((k) => !this.lost.has(k.keyId));
    if (held.length) this.record('system', 'key.drop', 'keys:all', `zeroed:${held.length}`);
    if (!this.keysLast) for (const k of this.keys) this.lost.add(k.keyId);
    else if (this.keys.length) {
      const unreadable = this.keys.filter((k) => this.lost.has(k.keyId)).length;
      this.record('system', 'key.restore', 'keys:all', `restored:${this.keys.length - unreadable}:unreadable:${unreadable}`);
    }
    for (const a of this.agents) {
      const gone = a.binding && this.lost.has(a.binding.keyId);
      this.patchAgent(a.id, gone ? { status: 'no_key', statusDetail: null } : { status: a.binding ? 'online' : 'no_key', statusDetail: null });
    }
  }

  /** The account's values changed, as deskd's `desk.account.set` push says. Nothing is audited, as on the desk. */
  setAccount(layer: Partial<LimitLayer>): void {
    this.account = { deskDay: layer.deskDay ?? null, deskMonth: layer.deskMonth ?? null, timeZone: layer.timeZone ?? null };
  }

  /** One key's sealed file is gone or won't open: `available: false`, and its agents show `no_key`. */
  loseKey(keyId: string): void {
    this.lost.add(keyId);
    for (const a of this.agents) if (a.binding?.keyId === keyId) this.patchAgent(a.id, { status: 'no_key', statusDetail: null });
  }

  // ------------------------------------------------------------ plumbing

  private log(method: string, params: unknown): void {
    this.calls.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) });
  }

  private wait(ms: number = this.latency): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.now().toString(36)}-${this.counter}`;
  }

  /** `ag-` and 12 lowercase base32 characters, as desk-agent makes them. */
  private agentId(): string {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return `ag-${[...b].map((x) => BASE32[x % 32]).join('')}`;
  }

  /** What the desk holds of a workspace: its use, from its files. */
  private usage(agentId: string): void {
    const a = this.agents.find((x) => x.id === agentId);
    if (!a) return;
    let used = 0;
    for (const f of (this.files[agentId] ?? new Map<string, { text: string }>()).values()) used += unitsOf(f.text);
    const ws = a.workspace ?? { quotaBytes: this.capValues.workspaceMb * MB, usedBytes: 0, sharedWith: [] };
    this.agents = this.agents.map((x) => (x.id === agentId ? { ...x, workspace: { ...ws, usedBytes: used } } : x));
  }

  private capsNow(): AgentCaps {
    return { ...this.capValues, agents: this.agents.length, workspaceTotalMb: this.workspaceTotalMb() };
  }

  /** The sum of every agent's quota, in whole MB (rounded up). */
  private workspaceTotalMb(except?: string): number {
    return Math.ceil(this.agents.filter((a) => a.id !== except).reduce((n, a) => n + (a.workspace?.quotaBytes ?? 0), 0) / MB);
  }

  /** What is left of the desk's budget for workspaces, in MB (`disk_budget` when a create or a raise wants more). */
  private workspaceLeftMb(except?: string): number {
    return (this.capValues.workspaceBudgetMb ?? Number.MAX_SAFE_INTEGER) - this.workspaceTotalMb(except);
  }

  /** A view of an agent with its workspace quota as it applies: never above the tier's most. */
  private viewOf(a: Agent): Agent {
    const out: Agent = this.pausedByCap(a.id) ? { ...a, status: 'paused', statusDetail: 'agent_cap' } : a;
    if (!out.workspace) return out;
    return { ...out, workspace: { ...out.workspace, quotaBytes: Math.min(out.workspace.quotaBytes, this.capValues.workspaceMaxMb * MB) } };
  }

  /** Agents past the plan's cap (the oldest kept, the lead never counted out) are paused, never deleted. */
  private pausedByCap(agentId: string): boolean {
    const staff = this.agents.filter((x) => !isLead(x));
    const lead = this.agents.length - staff.length;
    const i = staff.findIndex((x) => x.id === agentId);
    return i >= 0 && i >= this.capValues.agentCap - lead;
  }

  /** `agent.state`'s smaller agent: no purpose, no workspace, links without their rules (multi-agent.md section 1). */
  private slim(a: Agent): Agent {
    const out = clone(this.viewOf(a));
    delete out.purpose;
    delete out.workspace;
    out.links = (a.links ?? []).map((l) => ({ to: l.to }));
    return out;
  }

  private agent(agentId: string): Agent {
    const a = this.agents.find((x) => x.id === agentId);
    if (!a) throw new AgentError('not_found', { detail: 'agent' });
    return a;
  }

  private patchAgent(agentId: string, patch: Partial<Agent>): Agent {
    const next = { ...this.agent(agentId), ...patch };
    this.agents = this.agents.map((a) => (a.id === agentId ? next : a));
    this.emitAgents();
    return next;
  }

  private emitAgents(): void {
    const snapshot = this.agents.map((a) => this.slim(a));
    const caps = this.capsNow();
    queueMicrotask(() => this.agentWatchers.forEach((fn) => fn(clone(snapshot), clone(caps))));
  }

  private emit(agentId: string, e: Omit<Extract<ConversationEvent, { type: 'message' }>, 'seq'> | Omit<Extract<ConversationEvent, { type: 'delta' }>, 'seq'>): void {
    const seq = (this.seqs[agentId] ?? 0) + 1;
    this.seqs[agentId] = seq;
    const event = clone({ ...e, seq }) as ConversationEvent;
    queueMicrotask(() => this.threadWatchers.get(agentId)?.forEach((fn) => fn(clone(event))));
  }

  private putMessage(agentId: string, m: Message): void {
    const list = this.threads[agentId] ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    this.threads[agentId] = i >= 0 ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
    this.emit(agentId, { type: 'message', message: m });
  }

  /** Appends to the hash chain, as task 04's AuditLog does. The mock hashes its own JSON, not task 04's encoding. */
  private record(actor: string, action: string, target: string, decision: string, costMicroUsd: number | null = null, at: number = this.now()): void {
    this.auditTail = this.auditTail.then(async () => {
      const seq = this.audit.length + 1;
      const body = { seq, atMs: at, actor, action, target, payloadSha256: null, decision, costMicroUsd };
      const hash = hex(await crypto.subtle.digest('SHA-256', enc.encode(this.head + JSON.stringify(body))));
      this.head = hash;
      this.audit.push({ ...body, hash });
    });
  }

  /** A model's price; one the table doesn't list counts at its provider's highest by `output` (ADR 0043), so a dollar limit binds. */
  private price(provider: string, model: string): Price | null {
    const priced = (MODELS[provider] ?? []).flatMap((m) =>
      m.inputMicroUsdPerMTok != null && m.outputMicroUsdPerMTok != null ? [{ id: m.id, inputMicroUsdPerMTok: m.inputMicroUsdPerMTok, outputMicroUsdPerMTok: m.outputMicroUsdPerMTok }] : [],
    );
    const p = priced.find((x) => x.id === model) ?? [...priced].sort((x, y) => y.outputMicroUsdPerMTok - x.outputMicroUsdPerMTok)[0];
    return p ? { inputMicroUsdPerMTok: p.inputMicroUsdPerMTok, outputMicroUsdPerMTok: p.outputMicroUsdPerMTok } : null;
  }

  /** What's in force for an agent: with `keysLast`, the layered values over its own. */
  private policyOf(agentId: string): LimitPolicy {
    const own = this.policies[agentId] ?? { ...DEFAULT_POLICY };
    if (!this.keysLast) return own;
    return {
      ...own,
      deskDay: clone(this.own.deskDay ?? this.account.deskDay ?? DESK_DEFAULTS.deskDay),
      deskMonth: clone(this.own.deskMonth ?? this.account.deskMonth ?? DESK_DEFAULTS.deskMonth),
    };
  }

  /** The zone in force, null for UTC. */
  private timeZone(): string | null {
    return this.own.timeZone ?? this.account.timeZone;
  }

  private limitsView(agentId: string): LimitsView {
    const a = this.agent(agentId);
    const who = { agentId, keyId: a.binding?.keyId ?? null };
    if (!this.keysLast) return { agentId, policy: clone(this.policyOf(agentId)), usage: usageView(this.ledger, who, this.now()) };
    // A desk with the key store came with ADR 0043: its zone, the price table's date, and the two layers under what's in force.
    return {
      agentId,
      policy: clone(this.policyOf(agentId)),
      usage: usageView(this.ledger, who, this.now(), { zone: this.timeZone() ?? 'UTC', deskDay: true }),
      timeZone: this.timeZone(),
      pricesAsOf: PRICES_AS_OF,
      desk: clone(this.own),
      account: clone(this.account),
    };
  }

  // ------------------------------------------------------------ AgentClient

  async providers(): Promise<Provider[]> {
    await this.wait();
    return clone(PROVIDERS);
  }

  async listAgents(): Promise<Agent[]> {
    this.log('agent.list', {});
    await this.wait();
    return clone(this.agents.map((a) => this.viewOf(a)));
  }

  watchAgents(onAgents: (agents: Agent[], caps: AgentCaps | null) => void): () => void {
    this.agentWatchers.add(onAgents);
    const snapshot = this.agents.map((a) => this.slim(a));
    const caps = this.capsNow();
    queueMicrotask(() => this.agentWatchers.has(onAgents) && onAgents(snapshot, caps));
    return () => this.agentWatchers.delete(onAgents);
  }

  async getAgent(agentId: string): Promise<Agent> {
    await this.wait();
    return clone({ ...this.viewOf(this.agent(agentId)), incoming: this.incomingOf(agentId) });
  }

  /** The links into an agent, with their rules (`agent.get`'s `incoming`). */
  private incomingOf(agentId: string): AgentIncoming[] {
    return this.agents.flatMap((a) => {
      const l = (a.links ?? []).find((x) => x.to === agentId);
      return l ? [{ from: a.id, rules: l.rules ?? '' }] : [];
    });
  }

  async caps(): Promise<AgentCaps> {
    await this.wait();
    return this.capsNow();
  }

  async createAgent(input: AgentCreate, m: Mutation): Promise<Agent> {
    this.log('agent.create', { ...input, idem: m.idem });
    await this.wait(this.latency * 2);
    const agent = this.createNow(input, 'user');
    this.emitAgents();
    return clone(agent);
  }

  /** `agent.create`'s checks and its change, as the member's call and a confirmed proposal both make it. */
  private createNow(input: AgentCreate, actor: string): Agent {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 24) throw new AgentError('bad_request', { detail: 'name' });
    this.checkName(name);
    this.checkFields(input);
    if (this.agents.length >= this.capValues.agentCap) throw new AgentError('precondition_failed', { reason: 'agent_cap' });
    // A create with no size takes the tier's default or what the desk's budget has left, whichever is less, and at least 10 MB.
    const left = this.workspaceLeftMb();
    const quotaMb = input.workspaceMb ?? Math.min(this.capValues.workspaceMb, left);
    if (input.workspaceMb !== undefined ? input.workspaceMb > left : left < 10) throw new AgentError('precondition_failed', { reason: 'disk_budget' });
    const key = input.keyId ? this.keys.find((k) => k.keyId === input.keyId) : undefined;
    if (input.keyId && !key) throw new AgentError('bad_request', { detail: 'keyId' });
    const model = key ? (input.model ?? MODELS[key.provider]?.[0]?.id) : undefined;
    if (key && model && !(MODELS[key.provider] ?? []).some((x) => x.id === model)) throw new AgentError('bad_request', { detail: 'model' });
    const agent: Agent = {
      id: this.agentId(),
      name,
      role: 'staff',
      lead: false,
      status: key && !this.lost.has(key.keyId) ? 'online' : 'no_key',
      binding: key && model ? { keyId: key.keyId, provider: key.provider, providerName: key.providerName, model } : null,
      badgeHidden: false,
      badgeNotice: false,
      unseen: 0,
      purpose: input.purpose ?? '',
      look: { icon: input.icon ?? 'spark', tone: input.tone ?? this.unusedTone(), png: null },
      solo: input.solo ?? true,
      links: [],
      workspace: { quotaBytes: Math.max(quotaMb, input.workspaceMb === undefined ? 10 : 0) * MB, usedBytes: 0, sharedWith: [] },
      timers: 0,
      createdAt: this.now(),
    };
    this.agents = [...this.agents, agent];
    this.threads[agent.id] = [];
    this.seqs[agent.id] = 0;
    this.policies[agent.id] = { ...DEFAULT_POLICY };
    this.files[agent.id] = new Map();
    this.timerLists[agent.id] = [];
    this.record(actor, 'agent.create', `agent:${agent.id}`, 'ok');
    return agent;
  }

  /** Names are unique per desk (`name_taken`), and carry no hidden characters (`hidden_chars`). `exceptId`: the agent being renamed. */
  private checkName(name: string, exceptId?: string): void {
    if (hasHiddenChars(name)) throw new AgentError('bad_request', { detail: 'name', reason: 'hidden_chars' });
    const key = nameKey(name);
    if (this.agents.some((a) => a.id !== exceptId && nameKey(a.name) === key)) throw new AgentError('bad_request', { detail: 'name', reason: 'name_taken' });
  }

  /** An agent made with no tone: the first in wheel order, graphite skipped, that no agent here has; with all used, the least used. */
  private unusedTone(): string {
    const ids = TONES.map((t) => t.id).filter((id) => id !== 'graphite');
    const uses = (id: string): number => this.agents.filter((a) => a.look?.tone === id).length;
    return ids.find((id) => uses(id) === 0) ?? ids.reduce((best, id) => (uses(id) < uses(best) ? id : best), ids[0] ?? 'graphite');
  }

  /** The fields `agent.create` and `agent.update` share, checked as desk-agent does. */
  private checkFields(input: { purpose?: unknown; icon?: unknown; tone?: unknown; workspaceMb?: unknown; solo?: unknown }, agentId?: string): void {
    if (input.purpose !== undefined && (typeof input.purpose !== 'string' || input.purpose.length > this.capValues.purposeMax)) throw new AgentError('bad_request', { detail: 'purpose' });
    if (typeof input.purpose === 'string' && hasHiddenChars(input.purpose)) throw new AgentError('bad_request', { detail: 'purpose', reason: 'hidden_chars' });
    if (input.icon !== undefined && !(typeof input.icon === 'string' && (ICON_IDS.has(input.icon) || (input.icon === 'png' && !!agentId && !!this.icons[agentId])))) throw new AgentError('bad_request', { detail: 'icon' });
    if (input.tone !== undefined && !(typeof input.tone === 'string' && TONE_IDS.has(input.tone))) throw new AgentError('bad_request', { detail: 'tone' });
    if (input.solo !== undefined && typeof input.solo !== 'boolean') throw new AgentError('bad_request', { detail: 'solo' });
    const mb = input.workspaceMb;
    if (mb !== undefined && !(typeof mb === 'number' && Number.isInteger(mb) && mb >= 1 && mb <= this.capValues.workspaceMaxMb)) throw new AgentError('bad_request', { detail: 'workspaceMb' });
  }

  async updateAgent(agentId: string, patch: AgentPatch, m: Mutation): Promise<Agent> {
    this.log('agent.update', { agentId, ...patch, idem: m.idem });
    await this.wait();
    return clone(this.updateNow(agentId, patch, 'user'));
  }

  private updateNow(agentId: string, patch: AgentPatch, actor: string): Agent {
    const a = this.agent(agentId);
    const next: Partial<Agent> = {};
    if (patch.name !== undefined) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!name || name.length > 24) throw new AgentError('bad_request', { detail: 'name' });
      this.checkName(name, agentId);
      next.name = name;
    }
    this.checkFields(patch, agentId);
    if (patch.purpose !== undefined) next.purpose = patch.purpose;
    if (patch.icon !== undefined || patch.tone !== undefined) {
      const look = a.look ?? { icon: 'spark', tone: 'graphite', png: null };
      next.look = { ...look, ...(patch.icon !== undefined ? { icon: patch.icon } : {}), ...(patch.tone !== undefined ? { tone: patch.tone } : {}) };
    }
    if (patch.solo !== undefined) next.solo = patch.solo;
    if (patch.workspaceMb !== undefined) {
      const quotaBytes = patch.workspaceMb * MB;
      if (quotaBytes < (a.workspace?.usedBytes ?? 0)) throw new AgentError('precondition_failed', { reason: 'workspace_full' });
      if (patch.workspaceMb > this.workspaceLeftMb(agentId) && quotaBytes > (a.workspace?.quotaBytes ?? 0)) throw new AgentError('precondition_failed', { reason: 'disk_budget' });
      next.workspace = { ...(a.workspace ?? { usedBytes: 0, sharedWith: [] }), quotaBytes } as Agent['workspace'];
    }
    if (patch.badgeHidden !== undefined) next.badgeHidden = patch.badgeHidden;
    if (patch.dismissBadgeNotice) next.badgeNotice = false;
    const changed = Object.keys(next).filter((k) => k !== 'badgeNotice' && k !== 'badgeHidden');
    if (changed.length) this.record(actor, 'agent.update', `agent:${agentId}`, `fields:${changed.sort().join(',')}`);
    return this.patchAgent(agentId, next);
  }

  async deleteAgent(agentId: string, m: Mutation): Promise<void> {
    this.log('agent.delete', { agentId, idem: m.idem });
    await this.wait(this.latency * 2);
    this.deleteNow(agentId, 'user');
  }

  /** Its thread, workspace, timers, icon, links both ways and limits go. The audit log and the agent-message log keep their rows. */
  private deleteNow(agentId: string, actor: string): void {
    const a = this.agent(agentId);
    if (isLead(a)) throw new AgentError('bad_request', { detail: 'lead' });
    if ([...this.runs.values()].some((r) => r.agentId === agentId)) throw new AgentError('conflict', { reason: 'busy' });
    for (const t of this.timerLists[agentId] ?? []) this.unschedule(t.id);
    this.agents = this.agents
      .filter((x) => x.id !== agentId)
      .map((x) => {
        const links = (x.links ?? []).filter((l) => l.to !== agentId);
        const shared = (x.workspace?.sharedWith ?? []).filter((id) => id !== agentId);
        const linksChanged = links.length !== (x.links ?? []).length;
        const sharedChanged = shared.length !== (x.workspace?.sharedWith ?? []).length;
        if (!linksChanged && !sharedChanged) return x;
        return { ...x, links, ...(x.workspace ? { workspace: { ...x.workspace, sharedWith: shared } } : {}) };
      });
    delete this.threads[agentId];
    delete this.policies[agentId];
    delete this.files[agentId];
    delete this.timerLists[agentId];
    delete this.icons[agentId];
    this.record(actor, 'agent.delete', `agent:${agentId}`, 'ok');
    this.emitAgents();
  }

  async setLinks(agentId: string, change: { solo: boolean; links: AgentLink[] }, m: Mutation): Promise<Agent> {
    this.log('agent.links.set', { agentId, solo: change.solo, links: change.links.length, idem: m.idem });
    await this.wait();
    return clone(this.linksNow(agentId, change, 'user'));
  }

  private linksNow(agentId: string, change: { solo: unknown; links: unknown }, actor: string): Agent {
    this.agent(agentId);
    if (typeof change.solo !== 'boolean' || !Array.isArray(change.links)) throw new AgentError('bad_request', { detail: 'links' });
    const links = (change.links as unknown[]).map((l) => {
      const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
      return { to: typeof o['to'] === 'string' ? o['to'] : '', rules: typeof o['rules'] === 'string' ? o['rules'] : '' };
    });
    if (links.some((l) => hasHiddenChars(l.rules))) throw new AgentError('bad_request', { detail: 'links', reason: 'hidden_chars' });
    if (linkProblems(agentId, links, this.agents, this.capValues.rulesMax).length) throw new AgentError('bad_request', { detail: 'links' });
    this.record(actor, 'links.set', `agent:${agentId}`, change.solo ? 'solo' : `links:${links.length}`);
    return this.patchAgent(agentId, { solo: change.solo, links: links.map((l) => ({ to: l.to, rules: l.rules.trim() })) });
  }

  async bindAgent(agentId: string, binding: { keyId: string; model: string }, m: Mutation): Promise<Agent> {
    this.log('agent.bind', { agentId, ...binding, idem: m.idem });
    await this.wait();
    return clone(this.bindNow(agentId, binding));
  }

  private bindNow(agentId: string, binding: { keyId: string; model: string }): Agent {
    const key = this.keys.find((k) => k.keyId === binding.keyId);
    if (!key) throw new AgentError('not_found', { detail: 'key' });
    if (!(MODELS[key.provider] ?? []).some((x) => x.id === binding.model)) throw new AgentError('bad_request', { detail: 'model' });
    const a = this.agent(agentId);
    const changed = !!a.binding && a.binding.provider !== key.provider;
    this.record('user', 'agent.bind', `agent:${agentId} key:${key.keyId} model:${key.provider}/${binding.model}`, 'ok');
    return this.patchAgent(agentId, {
      binding: { keyId: key.keyId, provider: key.provider, providerName: key.providerName, model: binding.model },
      status: a.status === 'no_key' || a.status === 'error' ? 'online' : a.status,
      statusDetail: null,
      badgeNotice: a.badgeNotice || changed,
    });
  }

  async getThread(agentId: string): Promise<ThreadSnapshot> {
    await this.wait();
    return { agentId, messages: clone(this.threads[agentId] ?? []), seq: this.seqs[agentId] ?? 0 };
  }

  watchConversation(agentId: string, onEvent: (e: ConversationEvent) => void): () => void {
    let set = this.threadWatchers.get(agentId);
    if (!set) this.threadWatchers.set(agentId, (set = new Set()));
    set.add(onEvent);
    const snapshot: ConversationEvent = { type: 'snapshot', seq: this.seqs[agentId] ?? 0, messages: clone(this.threads[agentId] ?? []) };
    const s = set;
    queueMicrotask(() => s.has(onEvent) && onEvent(snapshot));
    return () => s.delete(onEvent);
  }

  async sendMessage(agentId: string, text: string, m: Mutation, attachments: readonly string[] = []): Promise<{ messageId: string; runId: string }> {
    this.log('agent.message.send', { agentId, chars: text.length, files: attachments.length, idem: m.idem });
    await this.wait();
    const body = text.trim();
    if (!body && !attachments.length) throw new AgentError('bad_request', { detail: 'text' });
    const held = this.stagedFor(agentId, attachments);
    const refusal = this.refusal(agentId, body);
    // The real desk checks a missing key and a busy desk before it takes the files, so those leave them staged. A refusal after
    // it has read them (a limit, an agent cap, a file it can't read) has deleted them already.
    if (refusal === 'no_key') throw new AgentError('precondition_failed', { reason: 'no_key' });
    if (refusal === 'busy') throw new AgentError('conflict', { reason: 'busy' });
    for (const id of attachments) this.staged.delete(id);
    if (refusal === 'agent_cap') throw new AgentError('precondition_failed', { reason: 'agent_cap' });
    if (refusal) throw new AgentError('precondition_failed', { reason: 'limit_reached', scope: refusal.scope });
    for (const f of held) {
      // The demo's stand-ins for a file the desk can't read, by name.
      if (/encrypted/i.test(f.name)) throw new AgentError('bad_request', { reason: 'encrypted', file: f.name });
      if (/scanned/i.test(f.name)) throw new AgentError('bad_request', { reason: 'no_text', file: f.name });
    }

    const a = this.agent(agentId);
    let reply = cannedReply(a.name, a.binding?.providerName ?? '', body);
    let proposals: Proposal[] = [];
    let after: Run['after'] = null;
    let ends: Run['ends'];
    let refusedWrites: Run['refusedWrites'];
    const lead = isLead(a) ? await this.leadTurn(body) : null;
    const save = /\bsave\s+(?:it\s+)?(?:as\s+|to\s+)?([\w][\w./-]*\.\w+)/i.exec(body);
    if (lead) {
      reply = lead.text;
      proposals = lead.proposals;
    } else if (/demo:cut_off/i.test(body)) {
      // A step that stops on the output cap ends the run, keeping what was said.
      reply = 'Here is the start of a long answer, which goes on until it reaches the length limit and';
      ends = 'cut_off';
    } else if (/demo:refused/i.test(body)) {
      reply = 'I’m not able to help with that.';
      ends = 'refused';
    } else if (save) {
      // The `workspace_write` tool, in the demo: inside the quota it saves; over it, the desk refuses and the thread says so.
      const path = save[1] as string;
      try {
        this.writeFile(agentId, path, 'Saved by the demo.\n');
        reply = `Saved ${path}.`;
      } catch (e) {
        reply = `I couldn’t save ${path}.`;
        refusedWrites = [{ path, reason: e instanceof AgentError && e.reason ? e.reason : 'workspace_full' }];
      }
    } else if (/\b(ask|tell|message)\b/i.test(body)) {
      // The `message_agent` tool, in the demo: the agent named, or the first it may message.
      const link = (a.links ?? []).find((l) => body.toLowerCase().includes((this.agents.find((x) => x.id === l.to)?.name ?? '\0').toLowerCase())) ?? a.links?.[0];
      const to = link ? this.agents.find((x) => x.id === link.to) : undefined;
      if (a.solo || !to) {
        reply = a.solo ? 'I’m solo, so I don’t message other agents. Turn on “Messages other agents” in my settings and pick who I may message.' : 'I’m not linked to any agent yet. Pick who I may message in my settings.';
      } else {
        reply = `I’ll ask ${to.name}, under the rules you set for us.`;
        const chainId = this.id('ch');
        after = (_spent, _text, how) => {
          if (how === 'done') this.sendA2a(agentId, to.id, body, 1, chainId, [agentId]);
        };
      }
    }
    const sent: SentFile[] = held.map((f) => ({ name: f.name, type: kindOf(f.name), size: f.size }));
    if (sent.length && !lead && !save && !/demo:/i.test(body)) {
      reply = `I see ${sent.length === 1 ? 'one file' : `${sent.length} files`}: ${sent.map((f) => f.name).join(', ')}. This is the demo, so ${a.binding?.providerName ?? 'the provider'} isn’t called and nothing is read. On a real desk the provider reads your files for this one answer, and your desk then deletes them.`;
    }
    const at = this.now();
    const userMsg: Message = { id: this.id('msg'), role: 'user', text: body, at, ...(sent.length ? { attachments: sent } : {}) };
    const runId = this.begin(agentId, userMsg, reply, { proposals, after, ...(ends ? { ends } : {}), ...(refusedWrites ? { refusedWrites } : {}) });
    return { messageId: userMsg.id, runId };
  }

  /**
   * Why a run of this agent can't start now, or null: no key, a run already going, or a limit, as task 04's gateway refuses
   * before any call. A limit is audited and shows in the agent's status.
   */
  private refusal(agentId: string, text: string): 'no_key' | 'busy' | 'agent_cap' | { scope: NonNullable<ReturnType<typeof check>>['scope'] } | null {
    const a = this.agent(agentId);
    if (this.pausedByCap(agentId)) return 'agent_cap';
    if (!a.binding || this.lost.has(a.binding.keyId)) return 'no_key';
    if ([...this.runs.values()].some((r) => r.agentId === agentId)) return 'busy';
    const { keyId, provider, model } = a.binding;
    const price = this.price(provider, model);
    const history = (this.threads[agentId] ?? []).map((x) => x.text).join('\n') + text;
    const est = estimate(price, enc.encode(history).length, MAX_OUTPUT_TOKENS);
    const refused = check(this.policyOf(agentId), this.ledger, { agentId, keyId }, est, this.now(), this.keysLast ? (this.timeZone() ?? 'UTC') : undefined);
    if (!refused) return null;
    // Refused before anything was sent, as task 04's gateway does: nothing spent, nothing added to the thread.
    this.record(`agent:${agentId}`, 'limit.hit', `scope:${refused.scope} key:${keyId} model:${provider}/${model}`, `refused:${refused.unit}`);
    this.patchAgent(agentId, { status: 'limit_reached', statusDetail: refused.scope });
    return { scope: refused.scope };
  }

  /** A run: the message that starts it goes in the thread, and the reply streams after it. */
  private begin(agentId: string, start: Message, reply: string, opts: { proposals?: Proposal[]; after?: Run['after']; ends?: Run['ends']; refusedWrites?: Run['refusedWrites'] } = {}): string {
    const a = this.agent(agentId);
    const { keyId, provider, providerName, model } = a.binding!;
    const price = this.price(provider, model);
    const history = (this.threads[agentId] ?? []).map((x) => x.text).join('\n') + start.text;
    this.putMessage(agentId, start);
    const runId = this.id('run');
    const replyMsg: Message = { id: this.id('msg'), role: 'assistant', text: '', at: start.at + 1, runId, badge: { provider, providerName, model }, state: 'streaming' };
    this.putMessage(agentId, replyMsg);
    for (const p of opts.proposals ?? []) this.proposals.set(p.id, { p, agentId, messageId: replyMsg.id });
    this.patchAgent(agentId, { status: 'working', statusDetail: null });
    const run: Run = {
      runId,
      agentId,
      messageId: replyMsg.id,
      timer: null,
      sent: '',
      rest: chunks(reply),
      full: reply,
      price,
      keyId,
      inputTokens: Math.ceil(enc.encode(history).length / 4) + 180,
      proposals: (opts.proposals ?? []).map((p) => p.id),
      after: opts.after ?? null,
      ...(opts.ends ? { ends: opts.ends } : {}),
      ...(opts.refusedWrites?.length ? { refusedWrites: opts.refusedWrites } : {}),
    };
    this.runs.set(runId, run);
    run.timer = setTimeout(() => this.step(run), this.streamMs * 4);
    return runId;
  }

  private step(run: Run): void {
    const piece = run.rest.shift();
    if (piece === undefined) {
      this.finish(run, run.ends ? 'failed' : 'done');
      return;
    }
    run.sent += piece;
    const live = (this.threads[run.agentId] ?? []).find((x) => x.id === run.messageId);
    if (live) live.text = run.sent;
    this.emit(run.agentId, { type: 'delta', messageId: run.messageId, runId: run.runId, text: piece });
    run.timer = setTimeout(() => this.step(run), this.streamMs);
  }

  /** The proposals a reply carries, as they stand now. */
  private proposalsOf(ids: readonly string[]): Proposal[] {
    return ids.flatMap((id) => {
      const held = this.proposals.get(id);
      return held ? [clone(held.p)] : [];
    });
  }

  private finish(run: Run, how: 'done' | 'stopped' | 'failed'): void {
    if (run.timer) clearTimeout(run.timer);
    this.runs.delete(run.runId);
    const usage: Usage = { inputTokens: run.inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: Math.ceil(run.sent.length / 4), reasoningTokens: 0 };
    const spent = cost(run.price, usage);
    this.ledger.push({ agentId: run.agentId, keyId: run.keyId, at: this.now(), microUsd: spent, tokens: totalTokens(usage) });
    const a = this.agent(run.agentId);
    const base = (this.threads[run.agentId] ?? []).find((x) => x.id === run.messageId);
    if (base) {
      this.putMessage(run.agentId, {
        ...base,
        text: run.sent,
        state: how,
        usage,
        costMicroUsd: spent,
        stopReason: how === 'done' ? 'end_turn' : how === 'failed' ? 'max_tokens' : 'cancelled',
        ...(how === 'failed' && run.ends ? { error: run.ends } : {}),
        ...(run.refusedWrites ? { workspaceRefused: run.refusedWrites } : {}),
        ...(run.proposals.length ? { proposals: this.proposalsOf(run.proposals) } : {}),
      });
    }
    this.record(`agent:${run.agentId}`, 'llm.call', `key:${run.keyId} model:${a.binding?.provider ?? '?'}/${a.binding?.model ?? '?'}`, how === 'done' ? 'ok' : how === 'failed' ? `error:${run.ends ?? 'unavailable'}` : 'error:cancelled', spent);
    this.patchAgent(run.agentId, { status: a.binding ? 'online' : 'no_key', unseen: a.unseen + (how === 'done' ? 1 : 0) });
    run.after?.(spent, run.sent, how);
  }

  // ---------------------------------------------------------------- attachments (ADR 0049)

  async attachFile(agentId: string, uploadId: string, file: File, opts: { signal?: AbortSignal; onProgress?: (done: number) => void } = {}): Promise<void> {
    const name = file.name.slice(0, 255);
    await uploadInChunks(file, async (c) => void (await this.attachPut({ agentId, uploadId, name, size: file.size, index: c.index, bytes: c.bytes })), { signal: opts.signal, onProgress: opts.onProgress });
  }

  /** `agent.attach.put`, as the desk counts it: only how many bytes came, never what they were. Public for the mock desk's wire. */
  async attachPut(p: { agentId: string; uploadId: string; name: string; size: number; index: number; bytes: number }): Promise<{ uploadId: string; received: number; complete: boolean }> {
    const { agentId, uploadId, name, size, index, bytes } = p;
    this.log('agent.attach.put', { agentId, uploadId, name, size, index, bytes });
    await this.wait();
    this.agent(agentId);
    const now = this.now();
    let st = this.staged.get(uploadId);
    if (index === 0) {
      const used = [...this.staged.values()].reduce((n, x) => n + x.size, 0);
      if (used + size > 24 * 1024 * 1024) throw new AgentError('conflict', { reason: 'staging_full' });
      if (size > this.attachCapValues.maxFileBytes) throw new AgentError('too_large', { reason: 'too_large', file: name, limit: this.attachCapValues.maxFileBytes });
      st = { agentId, name, size, received: 0, nextIndex: 0, complete: false, lastAt: now };
      this.staged.set(uploadId, st);
    }
    // A chunk out of order, or for a file the desk dropped, ends that upload.
    if (!st || st.agentId !== agentId || st.nextIndex !== index || st.size !== size) {
      this.staged.delete(uploadId);
      throw new AgentError('bad_request', { reason: 'bad_upload', file: name });
    }
    st.received += bytes;
    st.nextIndex += 1;
    st.lastAt = now;
    st.complete = st.received >= st.size;
    return { uploadId, received: st.received, complete: st.complete };
  }

  async removeAttachment(agentId: string, uploadId: string, m: Mutation): Promise<void> {
    this.log('agent.attach.remove', { agentId, uploadId, idem: m.idem });
    await this.wait();
    if (this.staged.get(uploadId)?.agentId === agentId) this.staged.delete(uploadId);
  }

  async attachCaps(agentId?: string): Promise<AttachCapsView> {
    this.log('agent.attach.caps', { agentId });
    await this.wait();
    const view: AttachCapsView = { caps: { ...this.attachCapValues }, ceiling: { ...ATTACH_CEILING }, chunkBytes: 512 * 1024 };
    if (agentId) view.vision = !!this.agent(agentId).binding;
    return view;
  }

  async setAttachCaps(change: Partial<AttachLimits>, m: Mutation): Promise<AttachCapsView> {
    this.log('agent.attach.caps.set', { ...change, idem: m.idem });
    await this.wait();
    const next = { ...this.attachCapValues };
    for (const [k, v] of Object.entries(change) as [keyof AttachLimits, number][]) {
      if (!Number.isInteger(v) || v < 1 || v > ATTACH_CEILING[k]) throw new AgentError('bad_request', { detail: k });
      next[k] = v;
    }
    this.attachCapValues = next;
    return { caps: { ...next }, ceiling: { ...ATTACH_CEILING }, chunkBytes: 512 * 1024 };
  }

  /** For tests: the desk's 10 minutes pass for everything staged. */
  expireStaged(): void {
    this.staged.clear();
  }

  /** Files this agent's member staged and finished, in order, or `bad_upload` / `missing` (the desk deleted them, or never had them). */
  private stagedFor(agentId: string, ids: readonly string[]): Staged[] {
    const now = this.now();
    return ids.map((id) => {
      const f = this.staged.get(id);
      if (!f || f.agentId !== agentId || now - f.lastAt > STAGED_TTL_MS) throw new AgentError('bad_request', { reason: 'missing' });
      if (!f.complete) throw new AgentError('bad_request', { reason: 'bad_upload', file: f.name });
      return f;
    });
  }

  async stopRun(runId: string, m: Mutation): Promise<void> {
    this.log('agent.run.stop', { runId, idem: m.idem });
    const run = this.runs.get(runId);
    if (run?.timer) clearTimeout(run.timer);
    await this.wait();
    if (run && this.runs.has(runId)) this.finish(run, 'stopped');
  }

  async markSeen(agentId: string): Promise<void> {
    if (this.agent(agentId).unseen) this.patchAgent(agentId, { unseen: 0 });
  }

  async listKeys(): Promise<KeyMeta[]> {
    this.log('agent.key.list', {});
    await this.wait();
    return clone(this.keysLast ? this.keys.map((k) => ({ ...k, available: !this.lost.has(k.keyId) })) : this.keys);
  }

  async addKey(input: { provider: string; label: string; secret: KeySecret }, m: Mutation): Promise<KeyMeta> {
    this.log('agent.key.add', { ...input, idem: m.idem });
    const p = PROVIDERS.find((x) => x.id === input.provider);
    if (!p) throw new AgentError('bad_request', { detail: 'provider' });
    // What deskd does: check the format, then ask the provider's free model list. Here, a key with "revoked" in it
    // stands in for one the provider refuses. Only the last 4 characters are kept.
    const owner = keyOwner(input.secret, PROVIDERS);
    const problem = owner && owner.id !== p.id ? 'provider_mismatch' : keyFormatProblem(input.secret, p.keyPrefix);
    const refused = input.secret.withPlaintext((k) => /revoked/i.test(k));
    const last4 = input.secret.withPlaintext((k) => k.slice(-4));
    await this.wait(this.latency * 6);
    if (problem) throw new AgentError('bad_request', { reason: 'key_malformed', detail: problem });
    if (refused) {
      this.record('user', 'key.add', `provider:${p.id}`, 'refused:auth');
      throw new AgentError('precondition_failed', { reason: 'key_refused', detail: 'auth' });
    }
    const key: KeyMeta = {
      keyId: this.id('k'),
      provider: p.id,
      providerName: p.name,
      label: input.label.trim() || `${p.name} key`,
      last4,
      createdAt: this.now(),
      createdByDesk: this.deskName,
    };
    this.keys = [...this.keys, key];
    this.record('user', 'key.add', `key:${key.keyId}`, `provider:${p.id}`);
    return clone(this.keysLast ? { ...key, available: true } : key);
  }

  async deleteKey(keyId: string, m: Mutation): Promise<void> {
    this.log('agent.key.delete', { keyId, idem: m.idem });
    await this.wait(this.latency * 2);
    if (!this.keys.some((k) => k.keyId === keyId)) throw new AgentError('not_found', { detail: 'key' });
    this.keys = this.keys.filter((k) => k.keyId !== keyId);
    for (const a of this.agents) if (a.binding?.keyId === keyId) this.patchAgent(a.id, { binding: null, status: 'no_key', statusDetail: null });
    this.record('user', 'key.delete', `key:${keyId}`, 'ok');
  }

  async listModels(keyId: string): Promise<ModelInfo[]> {
    await this.wait();
    const key = this.keys.find((k) => k.keyId === keyId);
    if (!key) throw new AgentError('not_found', { detail: 'key' });
    if (this.lost.has(keyId)) throw new AgentError('precondition_failed', { reason: 'no_key' });
    return clone(MODELS[key.provider] ?? []);
  }

  async getLimits(agentId: string): Promise<LimitsView> {
    await this.wait();
    return this.limitsView(agentId);
  }

  async setLimits(agentId: string, change: LimitsChange, m: Mutation): Promise<LimitsView> {
    this.log('agent.limits.set', { agentId, ...change, idem: m.idem });
    await this.wait(this.latency * 2);
    const a = this.agent(agentId);
    const policy = change.policy;
    const zoneGiven = this.keysLast && change.timeZone !== undefined; // an older desk has no zone, and ignores one
    if (!policy && !zoneGiven) return this.limitsView(agentId); // nothing to change, and nothing audited
    const isLimit = (l: unknown): l is Limit => typeof l === 'object' && l !== null && 'maxMicroUsd' in l && 'maxTokens' in l;
    const bad = (l: Limit): boolean => (l.maxMicroUsd ?? 0) < 0 || (l.maxTokens ?? 0) < 0;
    if (policy) {
      for (const f of ['agentDay', 'agentWeek', 'agentMonth', 'keyMonth', 'run'] as const) {
        if (!isLimit(policy[f]) || bad(policy[f])) throw new AgentError('bad_request', { detail: f });
      }
      if (!(policy.runMaxSteps >= 1)) throw new AgentError('bad_request', { detail: 'runMaxSteps' });
      for (const f of ['deskDay', 'deskMonth'] as const) {
        const l = policy[f];
        // An older desk needs `deskMonth`, and has no `deskDay`. A newer one takes either as absent, null or a limit.
        if (!this.keysLast && f === 'deskMonth' && !isLimit(l)) throw new AgentError('bad_request', { detail: f });
        if (l !== undefined && l !== null && (!isLimit(l) || bad(l))) throw new AgentError('bad_request', { detail: f });
      }
    }
    if (zoneGiven && change.timeZone !== null && !zoneKnown(change.timeZone as string)) throw new AgentError('bad_request', { reason: 'time_zone' });

    if (policy) {
      const { deskDay, deskMonth, ...agentOwn } = policy;
      const was = this.policies[agentId] ?? { ...DEFAULT_POLICY };
      this.policies[agentId] = clone({ ...agentOwn, deskMonth: was.deskMonth });
      if (this.keysLast) {
        if (deskDay !== undefined) this.own.deskDay = clone(deskDay);
        if (deskMonth !== undefined) this.own.deskMonth = clone(deskMonth);
      }
      // The key's cap is the desk's, and on an older desk so is `deskMonth`, so every agent's view of them follows.
      for (const id of Object.keys(this.policies)) {
        const p = this.policies[id] as LimitPolicy;
        this.policies[id] = { ...p, deskMonth: !this.keysLast && deskMonth ? clone(deskMonth) : p.deskMonth, keyMonth: id === agentId ? clone(policy.keyMonth) : p.keyMonth };
      }
    }
    if (zoneGiven) this.own.timeZone = change.timeZone ?? null;
    this.record('user', this.zoneAudit && !policy ? 'limits.timezone' : 'limits.set', `agent:${agentId}`, 'ok');
    if (a.status === 'limit_reached') this.patchAgent(agentId, { status: 'online', statusDetail: null });
    return this.limitsView(agentId);
  }

  async listAudit(opts: { beforeSeq?: number; limit?: number } = {}): Promise<AuditPage> {
    await this.wait();
    await this.auditTail;
    const limit = opts.limit ?? 50;
    const older = this.audit.filter((e) => opts.beforeSeq == null || e.seq < opts.beforeSeq).reverse();
    const entries = older.slice(0, limit);
    const last = entries[entries.length - 1];
    return { entries: clone(entries), headHash: this.head, nextBeforeSeq: older.length > limit && last ? last.seq : null };
  }

  // ------------------------------------------------------------ the lead's proposals (multi-agent.md section 3)

  /**
   * The lead in the demo, guided by what the member types: "set up two agents" proposes two, "link" proposes a pairing,
   * "remove <name>" a removal, "timer" a timer. Null for anything else, which gets a canned reply.
   */
  private async leadTurn(text: string): Promise<{ text: string; proposals: Proposal[] } | null> {
    const t = text.toLowerCase();
    const staff = this.agents.filter((a) => !isLead(a));
    const key = this.keys.find((k) => !this.lost.has(k.keyId));
    const bind = key ? { keyId: key.keyId, model: MODELS[key.provider]?.[0]?.id ?? '' } : {};
    if (/set ?up|two agents|new agents?|create|add (an? |two )?agents?/.test(t)) {
      const scout = {
        name: 'Scout',
        purpose: 'Each weekday morning, read the notes in your workspace and write a short brief of what changed.',
        icon: 'compass',
        tone: 'teal',
        ...bind,
        solo: true,
        workspaceMb: 50,
        timers: [{ label: 'Morning brief', kind: 'repeat', days: [1, 2, 3, 4, 5], time: '08:00', prompt: 'Read the workspace notes and write a short brief of what changed.' }],
      };
      const writer = { name: 'Writer', purpose: 'Draft and tidy the member’s writing. Ask Scout for its latest brief when it helps.', icon: 'pen', tone: 'plum', ...bind, solo: false, workspaceMb: 100 };
      return {
        text: 'Here’s what I’d set up: Scout, solo, with a brief each weekday at 8:00, and Writer, who can message Scout once you agree how. Nothing changes until you confirm each card.',
        proposals: [await this.propose('agent.create', 'Add Scout: compass on teal, solo, a weekday brief at 8:00', scout, null), await this.propose('agent.create', 'Add Writer: pen on plum', writer, null)],
      };
    }
    if (/\blink|may message|rules|let \S+ (message|talk)/.test(t)) {
      // The agents named, in the order they're named: the first may message the second.
      const named = staff.map((a) => ({ a, at: t.indexOf(a.name.toLowerCase()) })).filter((x) => x.at >= 0).sort((x, y) => x.at - y.at).map((x) => x.a);
      const from = named[0] ?? [...staff].reverse().find((a) => !a.solo) ?? staff[staff.length - 1];
      const to = named.find((a) => a.id !== from?.id) ?? staff.find((a) => a.id !== from?.id);
      if (!from || !to) return { text: 'Add two agents first, and then I can link them.', proposals: [] };
      const keep = (from.links ?? []).filter((l) => l.to !== to.id).map((l) => ({ to: l.to, rules: l.rules ?? '' }));
      const payload = { agentId: from.id, solo: false, links: [...keep, { to: to.id, rules: `Ask ${to.name} only for its latest brief. Never pass on the member’s own words.` }] };
      return { text: `I’d let ${from.name} message ${to.name}, under the rule on the card. ${to.name} stays as it is.`, proposals: [await this.propose('agent.links', `Let ${from.name} message ${to.name}`, payload, { solo: from.solo ?? true, links: (from.links ?? []).map((l) => ({ to: l.to, rules: l.rules ?? '' })) })] };
    }
    if (/\b(remove|delete)\b/.test(t)) {
      const who = staff.find((a) => t.includes(a.name.toLowerCase()));
      if (!who) return { text: 'Which agent? Say its name.', proposals: [] };
      return { text: `I’d remove ${who.name}. Its thread, workspace and timers go with it.`, proposals: [await this.propose('agent.delete', `Remove ${who.name}`, { agentId: who.id }, { name: who.name, look: who.look ?? null, usedBytes: who.workspace?.usedBytes ?? 0, timers: who.timers ?? 0, links: (who.links ?? []).length, incoming: staff.filter((x) => (x.links ?? []).some((l) => l.to === who.id)).length })] };
    }
    if (/\b(resize|change|update)\b/.test(t)) {
      const who = staff.find((a) => t.includes(a.name.toLowerCase())) ?? staff[0];
      if (!who) return { text: 'Add an agent first, and then I can change it.', proposals: [] };
      const to = this.keys.find((k) => !this.lost.has(k.keyId));
      const model = to ? MODELS[to.provider]?.[1]?.id : undefined;
      const payload: Record<string, unknown> = { agentId: who.id, purpose: `${who.name} keeps notes short and says when it is unsure.`, workspaceMb: 5, ...(to && model ? { keyId: to.keyId, model } : {}) };
      const before: Record<string, unknown> = { purpose: who.purpose ?? '', workspaceMb: Math.round((who.workspace?.quotaBytes ?? 0) / MB), usedBytes: who.workspace?.usedBytes ?? 0, ...(to && model ? { keyId: who.binding?.keyId ?? null, model: who.binding?.model ?? null } : {}) };
      return { text: `I’d change ${who.name}’s instructions and workspace, as the card shows.`, proposals: [await this.propose('agent.update', `Change ${who.name}`, payload, before)] };
    }
    if (/\b(timer|remind)/.test(t)) {
      const who = staff.find((a) => t.includes(a.name.toLowerCase())) ?? staff[0];
      if (!who) return { text: 'Add an agent first, and then I can give it a timer.', proposals: [] };
      const payload = { agentId: who.id, timer: { label: 'Check in', kind: 'once', inMinutes: 120, prompt: 'Check the workspace and say what changed since this morning.' } };
      return { text: `I’d have ${who.name} check in two hours from now.`, proposals: [await this.propose('timer.set', `A timer for ${who.name} in 2 hours`, payload, null)] };
    }
    return null;
  }

  /** `before` is read now and is not part of the hash; `origin` is always the member in the demo. */
  private async propose(action: ProposalAction, summary: string, payload: Record<string, unknown>, before: Record<string, unknown> | null): Promise<Proposal> {
    const sha256 = await sha256Hex(canonicalJson(payload));
    const p: Proposal = { id: this.id('pr'), action, summary, payload: clone(payload), sha256, state: 'pending', detail: null, answeredAt: null, expiresAt: this.now() + DAY, result: null, origin: { kind: 'member' }, before: before ? clone(before) : null };
    this.record('agent:manager', 'proposal.make', `proposal:${p.id}`, action);
    return p;
  }

  async answerProposal(proposalId: string, accept: boolean, sha256: string, m: Mutation): Promise<Proposal> {
    this.log('agent.proposal.answer', { proposalId, accept, idem: m.idem });
    await this.wait(this.latency * 2);
    const held = this.proposals.get(proposalId);
    if (!held) throw new AgentError('not_found', { detail: 'proposal' });
    if (typeof sha256 !== 'string' || sha256.toLowerCase() !== held.p.sha256) throw new AgentError('bad_request', { detail: 'sha256' });
    if (held.p.state !== 'pending') throw new AgentError('conflict', { reason: 'answered' });
    const now = this.now();
    let next: Proposal;
    if (held.p.expiresAt <= now) next = { ...held.p, state: 'expired' };
    else if (!accept) next = { ...held.p, state: 'declined', answeredAt: now };
    else {
      try {
        next = { ...held.p, state: 'applied', answeredAt: now, result: this.applyProposal(held.p) };
      } catch (err) {
        const why = err instanceof AgentError ? (err.reason ?? (err.code === 'not_found' ? 'not_found' : err.detail) ?? err.code) : 'internal';
        next = { ...held.p, state: 'failed', answeredAt: now, detail: why };
      }
    }
    held.p = next;
    this.record('user', 'proposal.answer', `proposal:${proposalId}`, next.state === 'failed' ? `failed:${next.detail}` : next.state);
    const msg = (this.threads[held.agentId] ?? []).find((x) => x.id === held.messageId);
    if (msg?.proposals) this.putMessage(held.agentId, { ...msg, proposals: msg.proposals.map((x) => (x.id === proposalId ? clone(next) : x)) });
    this.emitAgents();
    return clone(next);
  }

  /** A yes: the payload, checked again as if the member had made the change by hand. Everything is checked before anything changes. */
  private applyProposal(p: Proposal): { agentId?: string } | null {
    const pl = p.payload;
    const actor = 'user';
    switch (p.action) {
      case 'agent.create': {
        const links = Array.isArray(pl['links']) ? (pl['links'] as AgentLink[]) : [];
        const timers = Array.isArray(pl['timers']) ? (pl['timers'] as TimerInput[]) : [];
        if (linkProblems('(new)', links, this.agents, this.capValues.rulesMax).length) throw new AgentError('bad_request', { detail: 'links' });
        for (const t of timers) {
          const problem = timerProblem(t, this.capValues, this.now());
          if (problem) throw new AgentError('bad_request', { detail: problem });
        }
        if (timers.length > this.capValues.timersPerAgent) throw new AgentError('precondition_failed', { reason: 'timer_cap' });
        const a = this.createNow(pl as unknown as AgentCreate, actor);
        if (links.length) this.linksNow(a.id, { solo: (pl['solo'] as boolean | undefined) ?? false, links }, actor);
        for (const t of timers) this.timerNow(a.id, t, actor);
        this.emitAgents();
        return { agentId: a.id };
      }
      case 'agent.update': {
        const agentId = String(pl['agentId'] ?? '');
        const { agentId: _id, keyId, model, ...patch } = pl as Record<string, unknown>;
        void _id;
        this.updateNow(agentId, patch as AgentPatch, actor);
        if (typeof keyId === 'string' || typeof model === 'string') {
          const a = this.agent(agentId);
          this.bindNow(agentId, { keyId: typeof keyId === 'string' ? keyId : (a.binding?.keyId ?? ''), model: typeof model === 'string' ? model : (a.binding?.model ?? '') });
        }
        return { agentId };
      }
      case 'agent.delete':
        this.deleteNow(String(pl['agentId'] ?? ''), actor);
        return null;
      case 'agent.links':
        this.linksNow(String(pl['agentId'] ?? ''), { solo: pl['solo'], links: pl['links'] }, actor);
        return { agentId: String(pl['agentId']) };
      case 'timer.set':
        this.timerNow(String(pl['agentId'] ?? ''), pl['timer'] as TimerInput, actor);
        return { agentId: String(pl['agentId']) };
      case 'timer.delete':
        this.timerDeleteNow(String(pl['agentId'] ?? ''), String(pl['timerId'] ?? ''), actor);
        return { agentId: String(pl['agentId']) };
      default:
        throw new AgentError('bad_request', { detail: 'action' });
    }
  }

  // ------------------------------------------------------------ messages between agents (multi-agent.md section 4)

  /** One `message_agent` call, with every check before the receiver runs. Each outcome is in the log. */
  private sendA2a(fromId: string, toId: string, text: string, depth: number, chainId: string, chain: readonly string[]): A2aMessage {
    const from = this.agents.find((a) => a.id === fromId);
    const to = this.agents.find((a) => a.id === toId);
    const link = from?.links?.find((l) => l.to === toId);
    const now = this.now();
    const entry: A2aMessage = { id: this.id('am'), from: fromId, to: toId, chainId, depth, text: text.slice(0, A2A_REPLY_MAX), rules: link?.rules ?? '', at: now, state: 'delivered', reason: null, reply: null, costMicroUsd: null };
    const refuse = (reason: string): A2aMessage => {
      entry.state = 'refused';
      entry.reason = reason;
      this.a2a.unshift(entry);
      this.record(`agent:${fromId}`, 'a2a.refuse', `agent:${toId}`, `refused:${reason}`);
      return entry;
    };
    if (!from || !to) return refuse('no_link');
    if (from.solo) return refuse('solo');
    if (!link) return refuse('no_link');
    if (chain.includes(toId)) return refuse('loop');
    if (depth > this.capValues.a2aDepth) return refuse('depth');
    const lastHour = this.a2a.filter((x) => x.from === fromId && x.to === toId && x.at > now - HOUR && x.state !== 'refused');
    if (lastHour.length >= this.capValues.a2aPerHour) return refuse('rate');
    const deskHour = this.a2a.filter((x) => x.at > now - HOUR && x.state !== 'refused').length;
    if (this.capValues.a2aDeskPerHour != null && deskHour >= this.capValues.a2aDeskPerHour) return refuse('desk_rate');
    // The share is taken of the receiver's dollar cap: its day, else its week, else month, else the desk's day, else month.
    const pol = this.policyOf(toId);
    const base = [pol.agentDay, pol.agentWeek, pol.agentMonth, pol.deskDay, pol.deskMonth].find((l) => l?.maxMicroUsd != null)?.maxMicroUsd ?? null;
    const today = now - (now % DAY);
    if (base == null) return refuse('spend');
    const spentTo = this.a2a.filter((x) => x.to === toId && x.at >= today).reduce((n, x) => n + (x.costMicroUsd ?? 0), 0);
    if (spentTo >= (base * this.capValues.a2aSpendPct) / 100) return refuse('spend');
    const deskBase = [pol.deskDay, pol.deskMonth].find((l) => l?.maxMicroUsd != null)?.maxMicroUsd ?? null;
    const spentDesk = this.a2a.filter((x) => x.at >= today).reduce((n, x) => n + (x.costMicroUsd ?? 0), 0);
    if (deskBase != null && spentDesk >= (deskBase * this.capValues.a2aSpendPct) / 100) return refuse('desk_spend');
    const blocked = this.refusal(toId, text);
    if (blocked) return refuse(typeof blocked === 'string' ? blocked : 'limit_reached');
    this.a2a.unshift(entry);
    const origin: MessageOrigin = { kind: 'agent', agentId: fromId, rules: entry.rules, chainId, depth };
    const start: Message = { id: this.id('msg'), role: 'user', text, at: now, origin };
    const reply = `${to.name} here. This is the demo, so I can’t look anything up, but I read the rules you set for ${from.name} and kept to them.`;
    this.begin(toId, start, reply, {
      after: (spent, sent, how) => {
        entry.state = how === 'done' ? 'replied' : 'failed';
        entry.reason = how === 'done' ? null : how === 'stopped' ? 'stopped' : 'unavailable';
        entry.reply = sent.slice(0, A2A_REPLY_MAX);
        entry.costMicroUsd = spent;
      },
    });
    this.record(`agent:${fromId}`, 'a2a.send', `agent:${toId}`, 'ok');
    return entry;
  }

  async listA2a(opts: { agentId?: string; before?: number } = {}): Promise<A2aPage> {
    await this.wait();
    const all = this.a2a.filter((x) => (!opts.agentId || x.from === opts.agentId || x.to === opts.agentId) && (opts.before == null || x.at < opts.before));
    return { messages: clone(all.slice(0, 100)), older: all.length > 100 };
  }

  // ------------------------------------------------------------ workspaces (multi-agent.md section 5)

  private filesOf(agentId: string): Map<string, { text: string; modifiedAt: number }> {
    this.agent(agentId);
    return (this.files[agentId] ??= new Map());
  }

  async getWorkspace(agentId: string, path?: string): Promise<WorkspaceView> {
    await this.wait();
    const files = this.filesOf(agentId);
    const dir = path ?? '';
    if (dir && pathProblem(dir)) throw new AgentError('bad_request', { detail: 'path' });
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map<string, WorkspaceEntry>();
    for (const [p, f] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const full = prefix + name;
      const was = entries.get(full);
      const bytes = bytesOf(f.text);
      entries.set(full, { path: full, dir: slash >= 0, bytes: (was?.bytes ?? 0) + bytes, modifiedAt: Math.max(was?.modifiedAt ?? 0, f.modifiedAt) });
    }
    if (dir && !entries.size) throw new AgentError('not_found', { detail: 'path' });
    const ws = this.viewOf(this.agent(agentId)).workspace ?? { quotaBytes: this.capValues.workspaceMb * MB, usedBytes: 0, sharedWith: [] };
    const all = [...entries.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
    return { ...clone(ws), entries: all.slice(0, 500), ...(all.length > 500 ? { more: true } : {}) };
  }

  async readWorkspace(agentId: string, path: string, opts: { offset?: number; length?: number } = {}): Promise<WorkspaceFile> {
    await this.wait();
    if (pathProblem(path)) throw new AgentError('bad_request', { detail: 'path' });
    const f = this.filesOf(agentId).get(path);
    if (!f) throw new AgentError('not_found', { detail: 'path' });
    // A page of characters from `offset`, at most 128 Ki of them.
    const offset = Math.max(0, Math.min(opts.offset ?? 0, f.text.length));
    const end = Math.min(f.text.length, offset + Math.min(opts.length ?? READ_PAGE_CHARS, READ_PAGE_CHARS));
    const remaining = f.text.length - end;
    return { path, text: f.text.slice(offset, end), bytes: bytesOf(f.text), truncated: remaining > 0, offset, remaining };
  }

  async deleteWorkspaceEntry(agentId: string, path: string, m: Mutation): Promise<{ usedBytes: number }> {
    this.log('agent.workspace.delete', { agentId, path, idem: m.idem });
    await this.wait();
    if (pathProblem(path)) throw new AgentError('bad_request', { detail: 'path' });
    const files = this.filesOf(agentId);
    const gone = [...files.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
    if (!gone.length) throw new AgentError('not_found', { detail: 'path' });
    for (const p of gone) files.delete(p);
    this.usage(agentId);
    this.record('user', 'workspace.delete', `agent:${agentId}`, `entries:${gone.length}`);
    this.emitAgents();
    return { usedBytes: this.agent(agentId).workspace?.usedBytes ?? 0 };
  }

  async shareWorkspace(agentId: string, withAgents: string[], m: Mutation): Promise<Agent> {
    this.log('agent.workspace.share', { agentId, with: withAgents, idem: m.idem });
    await this.wait();
    const a = this.agent(agentId);
    if (!Array.isArray(withAgents) || new Set(withAgents).size !== withAgents.length || withAgents.some((id) => id === agentId || !this.agents.some((x) => x.id === id))) {
      throw new AgentError('bad_request', { detail: 'with' });
    }
    this.record('user', 'workspace.share', `agent:${agentId}`, `with:${withAgents.length}`);
    const ws = a.workspace ?? { quotaBytes: this.capValues.workspaceMb * MB, usedBytes: 0, sharedWith: [] };
    return clone(this.patchAgent(agentId, { workspace: { ...ws, sharedWith: [...withAgents] } }));
  }

  // ------------------------------------------------------------ timers (multi-agent.md section 6)

  private zoneNow(): string {
    return this.timeZone() ?? 'UTC';
  }

  async listTimers(agentId: string): Promise<TimerList> {
    await this.wait();
    this.agent(agentId);
    const now = this.now();
    const zone = this.zoneNow();
    return { timers: clone((this.timerLists[agentId] ?? []).map((t) => ({ ...t, zone, nextAt: nextRun(t, now, zone) }))), zone };
  }

  async setTimer(agentId: string, timer: TimerInput, m: Mutation): Promise<Timer> {
    this.log('agent.timer.set', { agentId, timer: { ...timer, prompt: `${(timer.prompt ?? '').length} chars` }, idem: m.idem });
    await this.wait();
    const t = this.timerNow(agentId, timer, 'user');
    this.emitAgents();
    return clone(t);
  }

  private timerNow(agentId: string, input: TimerInput, actor: string): Timer {
    this.agent(agentId);
    const now = this.now();
    if (!input || typeof input !== 'object') throw new AgentError('bad_request', { detail: 'timer' });
    for (const f of ['label', 'prompt'] as const) if (typeof input[f] === 'string' && hasHiddenChars(input[f] as string)) throw new AgentError('bad_request', { detail: f, reason: 'hidden_chars' });
    const problem = timerProblem(input, this.capValues, now);
    if (problem) throw new AgentError('bad_request', { detail: problem });
    const list = this.timerLists[agentId] ?? [];
    const was = input.id ? list.find((x) => x.id === input.id) : undefined;
    if (input.id && !was) throw new AgentError('not_found', { detail: 'timer' });
    if (!was && list.length >= this.capValues.timersPerAgent) throw new AgentError('precondition_failed', { reason: 'timer_cap' });
    const zone = this.zoneNow();
    const repeat = input.kind === 'repeat';
    const every = repeat && input.everyMinutes != null;
    const at = input.kind === 'once' ? (input.inMinutes != null ? now + input.inMinutes * MINUTE : (input.at as number)) : null;
    const t: Timer = {
      id: was?.id ?? this.id('tm'),
      label: input.label.trim(),
      kind: input.kind,
      days: repeat && !every ? [...(input.days ?? [])].sort((a, b) => a - b) : null,
      time: repeat && !every ? (input.time ?? null) : null,
      everyMinutes: every ? (input.everyMinutes as number) : null,
      at,
      prompt: input.prompt.trim(),
      enabled: input.enabled ?? true,
      zone,
      nextAt: null,
      // A one-shot timer moved to a new time can run again.
      lastAt: was && !(input.kind === 'once' && at !== was.at) ? was.lastAt : null,
      lastState: was?.lastState ?? null,
      spentMicroUsd: was?.spentMicroUsd ?? 0,
      createdAt: was?.createdAt ?? now,
    };
    t.nextAt = nextRun(t, now, zone);
    this.timerLists[agentId] = was ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t];
    this.schedule(agentId, t);
    this.record(actor, 'timer.set', `agent:${agentId} timer:${t.id}`, was ? 'changed' : 'added');
    this.patchAgent(agentId, { timers: this.timerLists[agentId]!.length });
    return t;
  }

  async deleteTimer(agentId: string, timerId: string, m: Mutation): Promise<void> {
    this.log('agent.timer.delete', { agentId, timerId, idem: m.idem });
    await this.wait();
    this.timerDeleteNow(agentId, timerId, 'user');
  }

  private timerDeleteNow(agentId: string, timerId: string, actor: string): void {
    this.agent(agentId);
    const list = this.timerLists[agentId] ?? [];
    if (!list.some((t) => t.id === timerId)) throw new AgentError('not_found', { detail: 'timer' });
    this.unschedule(timerId);
    this.timerLists[agentId] = list.filter((t) => t.id !== timerId);
    this.record(actor, 'timer.delete', `agent:${agentId} timer:${timerId}`, 'ok');
    this.patchAgent(agentId, { timers: this.timerLists[agentId]!.length });
  }

  private unschedule(timerId: string): void {
    const h = this.timerHandles.get(timerId);
    if (h) clearTimeout(h);
    this.timerHandles.delete(timerId);
  }

  /** Due soon: the mock runs it by itself. Later ones wait for `fireTimer`, so nothing in the demo waits hours on a clock. */
  private schedule(agentId: string, t: Timer): void {
    this.unschedule(t.id);
    if (t.nextAt == null || t.nextAt - this.now() > SCHEDULE_AHEAD_MS) return;
    this.timerHandles.set(t.id, setTimeout(() => this.fire(agentId, t, 0), Math.max(0, t.nextAt - this.now())));
  }

  /** A timer's run: its prompt in the thread, marked from the timer, then the reply, which counts toward every limit. */
  private fire(agentId: string, timer: Timer, attempt: number): void {
    this.timerHandles.delete(timer.id);
    const list = this.timerLists[agentId];
    const t = list?.find((x) => x.id === timer.id);
    if (!t || !list) return;
    const now = this.now();
    const zone = this.zoneNow();
    const blocked = this.refusal(agentId, t.prompt);
    const settle = (state: string): void => {
      t.lastAt = now;
      t.lastState = state;
      t.nextAt = t.kind === 'once' ? null : nextRun(t, now + 1, zone);
      this.schedule(agentId, t);
    };
    if (blocked === 'busy' && attempt < 10) {
      // Busy tries again a minute later, up to 10 times.
      t.lastState = 'busy';
      this.timerHandles.set(t.id, setTimeout(() => this.fire(agentId, t, attempt + 1), MINUTE));
      return;
    }
    if (blocked) {
      settle(typeof blocked === 'string' ? blocked : 'limit_reached');
      this.record('system', 'timer.fire', `agent:${agentId} timer:${t.id}`, `refused:${t.lastState}`);
      this.emitAgents();
      return;
    }
    const start: Message = { id: this.id('msg'), role: 'user', text: t.prompt, at: now, origin: { kind: 'timer', timerId: t.id, label: t.label } };
    const a = this.agent(agentId);
    this.begin(agentId, start, `${a.name} here, on the timer “${t.label}”. In the demo there’s nothing new to report, and that’s the whole brief.`, {
      after: (spent) => {
        t.spentMicroUsd += spent ?? 0;
      },
    });
    settle('ok');
    this.record('system', 'timer.fire', `agent:${agentId} timer:${t.id}`, 'ok');
  }

  // ------------------------------------------------------------ icons (multi-agent.md section 7)

  async uploadIcon(agentId: string, pngBase64: string, m: Mutation): Promise<Agent | null> {
    this.log('agent.icon.upload', { agentId, chars: typeof pngBase64 === 'string' ? pngBase64.length : 0, idem: m.idem });
    await this.wait(this.latency * 2);
    const a = this.agent(agentId);
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(pngBase64);
    } catch {
      throw new AgentError('bad_request', { detail: 'png', reason: 'not_png' });
    }
    const checked = pngCheck(bytes, { maxBytes: this.capValues.iconMaxBytes, maxPx: this.capValues.iconMaxPx });
    if (!checked.ok) {
      this.record('user', 'icon.upload', `agent:${agentId}`, `refused:${checked.reason}`);
      throw new AgentError('bad_request', { detail: 'png', reason: checked.reason });
    }
    const mask = await maskOf(bytes);
    if (mask === 'no_shape' || mask === 'too_thin') {
      this.record('user', 'icon.upload', `agent:${agentId}`, `refused:${mask}`);
      throw new AgentError('bad_request', { detail: 'png', reason: mask });
    }
    if (mask === false) {
      this.record('user', 'icon.upload', `agent:${agentId}`, 'refused:corrupt');
      throw new AgentError('bad_request', { detail: 'png', reason: 'corrupt' });
    }
    const version = (this.icons[agentId]?.version ?? a.look?.png ?? 0) + 1;
    this.icons[agentId] = { png: mask ?? pngBase64, version };
    this.record('user', 'icon.upload', `agent:${agentId}`, 'ok');
    const look = a.look ?? { icon: 'spark', tone: 'graphite', png: null };
    return clone(this.patchAgent(agentId, { look: { ...look, icon: 'png', png: version } }));
  }

  async getIcon(agentId: string): Promise<{ png: string; version: number }> {
    await this.wait();
    this.agent(agentId);
    const icon = this.icons[agentId];
    if (!icon) throw new AgentError('not_found', { detail: 'icon' });
    return { ...icon };
  }

}

/** As desk-agent's `knownZone`: a region the clock knows, or the literal `UTC`. Fixed offsets and `Etc/` names aren't zones there. */
function zoneKnown(name: string): boolean {
  if (name === 'UTC') return true;
  if (/^(Etc\/|GMT|UTC|[+-])/i.test(name) || !name.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * What desk-agent keeps of an upload: the mask of `maskPixels` (contract section 4), as a new white PNG with no other chunks.
 * In a browser the mock makes it the same way; with no canvas (the unit tests) it keeps the file as it came, which the window
 * draws by its alpha alone anyway. `false`: the picture didn't decode. A `PngRefusal` string: the desk's `no_shape` or `too_thin`.
 */
async function maskOf(bytes: Uint8Array): Promise<string | null | false | 'no_shape' | 'too_thin'> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }));
  } catch {
    return false;
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const result = maskPixels(image.data, bitmap.width, bitmap.height);
    if (!result.ok) return result.reason;
    const out = new OffscreenCanvas(result.size, result.size);
    const octx = out.getContext('2d');
    if (!octx) return null;
    octx.putImageData(new ImageData(result.rgba as Uint8ClampedArray<ArrayBuffer>, result.size, result.size), 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    return toBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
