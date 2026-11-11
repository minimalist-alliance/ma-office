// The mock's desks. Prices are illustrative, not anyone's real price list, and no key here is real: a mock key
// is metadata only (label and last 4), because the mock never keeps a key.
import type { Agent, AgentCaps, Binding, KeyMeta, LimitLayer, LimitPolicy, MemoryLine, Message, ModelInfo, Provider } from '../client/types';
import type { AskName } from './asks';
import type { LedgerRow } from './ledger';

export type FixtureName = 'fresh' | 'ready' | 'limit' | 'tools';
export const FIXTURES: readonly FixtureName[] = ['fresh', 'ready', 'limit', 'tools'];

export const PROVIDERS: Provider[] = [
  { id: 'anthropic', name: 'Anthropic', console: 'console.anthropic.com', keyPrefix: 'sk-ant-' },
  { id: 'openai', name: 'OpenAI', console: 'platform.openai.com', keyPrefix: 'sk-' },
  // desk-agent's fourth (ma-desk `2b6b5534`): only its free models are listed. Connected by the free card, or pasted.
  { id: 'openrouter', name: 'OpenRouter', console: 'openrouter.ai', keyPrefix: 'sk-or-' },
];

const M = 1_000_000;
export const MODELS: Record<string, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', inputMicroUsdPerMTok: 3 * M, outputMicroUsdPerMTok: 15 * M },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inputMicroUsdPerMTok: 1 * M, outputMicroUsdPerMTok: 5 * M },
    // One the price table doesn't list: it counts at the provider's highest, and the app says it has no listed price.
    { id: 'claude-preview', label: 'Claude preview', inputMicroUsdPerMTok: null, outputMicroUsdPerMTok: null },
  ],
  openai: [
    { id: 'gpt-5', label: 'GPT-5', inputMicroUsdPerMTok: 1.25 * M, outputMicroUsdPerMTok: 10 * M },
    { id: 'gpt-5-mini', label: 'GPT-5 mini', inputMicroUsdPerMTok: 0.25 * M, outputMicroUsdPerMTok: 2 * M },
  ],
  // Free models, $0 by their id as desk-agent prices them, the first the default. The second is made up, and chats only.
  openrouter: [
    { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'NVIDIA: Nemotron 3.5 Super VL (free)', inputMicroUsdPerMTok: 0, outputMicroUsdPerMTok: 0, free: true, tools: true },
    { id: 'example-labs/chat-8b:free', label: 'Example Labs: Chat 8B (free)', inputMicroUsdPerMTok: 0, outputMicroUsdPerMTok: 0, free: true, tools: false },
  ],
};

/** Design 9.9's defaults, as task 04's `LimitPolicy.DEFAULTS`: agent $5 a day, desk $20 a month, run $2 or 50 steps. */
export const DEFAULT_POLICY: LimitPolicy = {
  agentDay: { maxMicroUsd: 5 * M, maxTokens: null },
  agentWeek: { maxMicroUsd: null, maxTokens: null },
  agentMonth: { maxMicroUsd: null, maxTokens: null },
  deskMonth: { maxMicroUsd: 20 * M, maxTokens: null },
  keyMonth: { maxMicroUsd: null, maxTokens: null },
  run: { maxMicroUsd: 2 * M, maxTokens: null },
  runMaxSteps: 50,
};

/** What a desk from ADR 0043 counts where neither it nor the account sets a value: no cap on the day, $20 a month, UTC. */
export const DESK_DEFAULTS = { deskDay: { maxMicroUsd: null, maxTokens: null }, deskMonth: { maxMicroUsd: 20 * M, maxTokens: null } } as const;

/**
 * What the account sets, from a page's query, as the Platform's `agentDefaults` would: `accountDay` and `accountMonth` in dollars
 * (`none` for "no limit", set on the account), `accountZone` a zone. Undefined when it names none.
 */
export function accountFromQuery(q: URLSearchParams): Partial<LimitLayer> | undefined {
  const limit = (name: string) => {
    const v = q.get(name);
    if (v == null) return undefined;
    return { maxMicroUsd: v === 'none' ? null : Math.round(Number(v) * M), maxTokens: null };
  };
  const out: Partial<LimitLayer> = {};
  const day = limit('accountDay');
  const month = limit('accountMonth');
  if (day) out.deskDay = day;
  if (month) out.deskMonth = month;
  if (q.get('accountZone')) out.timeZone = q.get('accountZone');
  return Object.keys(out).length ? out : undefined;
}

/** The mock price table's `checked` date. */
export const PRICES_AS_OF = '2026-11-06';

/** Replies reserve against this output cap. */
export const MAX_OUTPUT_TOKENS = 1024;

/** multi-agent.md section 2's built-in defaults, which hold where the Platform sends no tier values. */
export const DEFAULT_CAPS: AgentCaps = {
  agentCap: 24,
  agents: 0,
  workspaceMb: 200,
  workspaceMaxMb: 1024,
  /** 50% of an 8 GB disk, the least a desk has. */
  workspaceBudgetMb: 4096,
  timersPerAgent: 10,
  timerMinMinutes: 5,
  a2aPerHour: 30,
  a2aDeskPerHour: 120,
  a2aDepth: 3,
  a2aSpendPct: 25,
  runsAtOnce: 4,
  rulesMax: 500,
  purposeMax: 4000,
  promptMax: 2000,
  iconMaxBytes: 262144,
  iconMaxPx: 512,
};

/** What a page's query says of the caps: `?agentCap=3`, `?timersPerAgent=2`, `?workspaceMb=1`, and so on. */
export function capsFromQuery(q: URLSearchParams): Partial<AgentCaps> | undefined {
  const out: Partial<AgentCaps> = {};
  for (const k of Object.keys(DEFAULT_CAPS) as (keyof AgentCaps)[]) {
    const v = q.get(k);
    if (v != null && /^\d+$/.test(v)) out[k] = Number(v);
  }
  return Object.keys(out).length ? out : undefined;
}

export interface Seed {
  keys: KeyMeta[];
  agents: Agent[];
  threads: Record<string, Message[]>;
  policies: Record<string, LimitPolicy>;
  ledger: LedgerRow[];
  /** The desk's name, for the window and the key's "created on". */
  deskName: string;
  /** Each agent's workspace: path to text. */
  files: Record<string, Record<string, string>>;
  /** S-14: what each agent remembers, newest first. */
  memories?: Record<string, MemoryLine[]>;
  /** S-14: replies whose run waits on the member, and what it asks. */
  waiting?: { agentId: string; messageId: string; runId: string; ask: AskName; at: number }[];
}

const HOUR = 3_600_000;

const MB = 1024 * 1024;

/** The lead: the desk's first agent, `manager` on the wire (multi-agent.md section 1). Solo, as every new agent is. */
function manager(over: Partial<Agent> = {}, now = Date.now()): Agent {
  return {
    id: 'manager',
    name: 'Lead',
    role: 'manager',
    lead: true,
    status: 'no_key',
    binding: null,
    badgeHidden: false,
    badgeNotice: false,
    unseen: 0,
    purpose: '',
    look: { icon: 'nodes', tone: 'graphite', png: null },
    solo: true,
    links: [],
    workspace: { quotaBytes: DEFAULT_CAPS.workspaceMb * MB, usedBytes: 0, sharedWith: [] },
    timers: 0,
    createdAt: now - 96 * HOUR,
    ...over,
  };
}

/**
 * S-14's `?fixture=tools` (the Product Designer's stills): Lead, Scout and Writer, Scout waiting on a Send outside with the
 * chips of what it read, Writer idle, and what Scout remembers. Demo data only: Alex Demo, example sites, no key.
 */
function toolsSeed(now: number, keys: KeyMeta[], sonnet: Binding, mini: Binding): Seed {
  const deskName = 'Personal';
  const badgeS = { provider: 'anthropic', providerName: 'Anthropic', model: sonnet.model };
  const badgeM = { provider: 'openai', providerName: 'OpenAI', model: mini.model };
  const staff = (id: string, name: string, icon: string, tone: string, binding: Binding, purpose: string): Agent => ({
    id,
    name,
    role: 'staff',
    lead: false,
    status: 'online',
    binding,
    badgeHidden: false,
    badgeNotice: false,
    unseen: 0,
    purpose,
    look: { icon, tone, png: null },
    solo: false,
    links: [],
    workspace: { quotaBytes: 50 * MB, usedBytes: 0, sharedWith: [] },
    timers: 0,
    createdAt: now - 72 * HOUR,
  });
  const agents: Agent[] = [
    manager({ status: 'online', binding: sonnet, look: { icon: 'list', tone: 'graphite', png: null } }, now),
    staff('scout', 'Scout', 'search', 'cyan', sonnet, 'Find things on the web for Alex and check prices.'),
    staff('writer', 'Writer', 'pen', 'plum', mini, 'Keep Alex’s notes tidy.'),
  ];
  const at = now - 4 * 60_000;
  const lead1 = 'What did the team do today?';
  const lead2 = 'Scout checked lamp prices and opened one shop page after you approved it. Writer left your drafts alone, as you asked.';
  const s1 = 'Find me a desk lamp under $80 that’s good for reading. My Home office note has the size.';
  const s2 = 'Your note says the desk is 120 cm wide, so a clamp lamp or a small base fits. Two review sites both like the Lumen Arc. I’d like to check its price today at the shop.';
  const w1 = 'Tidy my Notebook: drafts older than a year can go to the Trash.';
  const w2 = 'I found 3 pages with “draft” in the title that haven’t changed in over a year.';
  const threads: Record<string, Message[]> = {
    manager: [
      { id: 'tl1', role: 'user', text: lead1, at: now - 30 * 60_000 },
      { id: 'tl2', role: 'assistant', text: lead2, at: now - 30 * 60_000 + 3000, badge: badgeS, usage: usageOf(lead2), costMicroUsd: 2_100, stopReason: 'end_turn', state: 'done' },
    ],
    scout: [
      { id: 'ts1', role: 'user', text: s1, at: at - 3 * 60_000 },
      {
        id: 'ts2',
        role: 'assistant',
        text: s2,
        at: at,
        runId: 'run-scout-1',
        badge: badgeS,
        state: 'awaiting_approval',
        untrusted: true,
        pendingApprovals: [],
        tools: [
          { name: 'notebook_read', summary: 'Read your note', ok: true, risk: 'read', target: { kind: 'page', pageId: 'pg-home-office', title: 'Home office' }, durationMs: 1000 },
          { name: 'browser_read', summary: 'Read a web page', ok: true, risk: 'read', path: 'reviews.example.org/lamps', untrusted: true, session: 'agent', durationMs: 4000 },
          { name: 'browser_read', summary: 'Read a web page', ok: true, risk: 'read', path: 'example.com/reviews/desk-lamps', untrusted: true, session: 'agent', durationMs: 3000 },
        ],
      },
    ],
    writer: [
      { id: 'tw1', role: 'user', text: w1, at: now - 50 * 60_000 },
      { id: 'tw2', role: 'assistant', text: w2, at: now - 50 * 60_000 + 4000, badge: badgeM, usage: usageOf(w2), costMicroUsd: 300, stopReason: 'end_turn', state: 'done', tools: [{ name: 'notebook_search', summary: 'Searched your Notebook', ok: true, risk: 'read', path: '“draft”', durationMs: 1000 }] },
    ],
  };
  const day = 86_400_000;
  const memories: Record<string, MemoryLine[]> = {
    scout: [
      { id: 'mem-1', text: 'Alex’s desk is 120 cm wide and faces a window.', createdAt: now - 10 * 60_000, untrusted: false },
      { id: 'mem-2', text: 'Prefers prices in US dollars, with tax shown apart.', createdAt: now - 2 * day, untrusted: false },
      { id: 'mem-3', text: 'The home office budget is $300 in all.', createdAt: now - 3 * day, untrusted: false },
      { id: 'mem-4', text: 'Reads reviews.example.org before shop pages.', createdAt: now - 4 * day, untrusted: true },
      { id: 'mem-5', text: 'Wants a lamp warm enough for evening reading.', createdAt: now - 5 * day, untrusted: false },
      { id: 'mem-6', text: 'Likes short answers, with the price first.', createdAt: now - 6 * day, untrusted: false },
    ],
    writer: [{ id: 'mem-w1', text: 'Drafts go in the General tab.', createdAt: now - 7 * day, untrusted: false }],
    manager: [],
  };
  const policies: Record<string, LimitPolicy> = { manager: { ...DEFAULT_POLICY }, scout: { ...DEFAULT_POLICY }, writer: { ...DEFAULT_POLICY } };
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const ledger: LedgerRow[] = [{ agentId: 'scout', keyId: sonnet.keyId, at: Math.max(midnight, now - HOUR), microUsd: 420_000, tokens: 48_000 }];
  return {
    deskName,
    keys,
    agents,
    threads,
    policies,
    ledger,
    files: { manager: {}, scout: {}, writer: {} },
    memories,
    waiting: [{ agentId: 'scout', messageId: 'ts2', runId: 'run-scout-1', ask: 'shop', at }],
  };
}

function usageOf(text: string): Message['usage'] {
  return { inputTokens: 180 + Math.ceil(text.length / 6), cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: Math.ceil(text.length / 4), reasoningTokens: 0 };
}

export function seed(name: FixtureName, now: number = Date.now()): Seed {
  const deskName = 'Personal';
  if (name === 'fresh') {
    return { deskName, keys: [], agents: [manager({}, now)], threads: { manager: [] }, policies: { manager: { ...DEFAULT_POLICY } }, ledger: [], files: { manager: {} } };
  }
  const sonnet = { keyId: 'k-anthropic-1', provider: 'anthropic', providerName: 'Anthropic', model: 'claude-sonnet-4-5' };
  const mini = { keyId: 'k-openai-1', provider: 'openai', providerName: 'OpenAI', model: 'gpt-5-mini' };
  const keys: KeyMeta[] = [
    { keyId: sonnet.keyId, provider: 'anthropic', providerName: 'Anthropic', label: 'Personal', last4: 'Q7xa', createdAt: now - 72 * HOUR, createdByDesk: deskName },
    { keyId: mini.keyId, provider: 'openai', providerName: 'OpenAI', label: 'Research', last4: 'p2Lm', createdAt: now - 30 * HOUR, createdByDesk: deskName },
  ];
  if (name === 'tools') return toolsSeed(now, keys, sonnet, mini);
  const agents: Agent[] = [
    manager({ status: 'online', binding: sonnet }, now),
    {
      id: 'researcher',
      name: 'Researcher',
      role: 'staff',
      lead: false,
      status: 'online',
      binding: mini,
      badgeHidden: false,
      badgeNotice: false,
      unseen: 1,
      purpose: 'Find sources for the member’s questions and keep notes in the workspace.',
      look: { icon: 'compass', tone: 'teal', png: null },
      solo: true,
      links: [],
      workspace: { quotaBytes: 50 * MB, usedBytes: 0, sharedWith: [] },
      timers: 0,
      createdAt: now - 48 * HOUR,
    },
  ];
  const files: Record<string, Record<string, string>> = {
    manager: {},
    researcher: {
      'sources.md': '# Sources\n\n- The desk design, section 9\n- The provider’s pricing page, checked Nov 6\n',
      'notes/2026-11-07.md': 'Read the two pricing pages. Sonnet is the better fit for long answers; mini for quick ones.\n',
      'notes/ideas.txt': 'Ask the member which sources they trust.\n',
    },
  };
  const badgeS = { provider: 'anthropic', providerName: 'Anthropic', model: sonnet.model };
  const badgeM = { provider: 'openai', providerName: 'OpenAI', model: mini.model };
  const a1 = 'Morning. I’m the lead: I set up this desk’s other agents with you, and see only this desk. Ask me to set up two agents. This is the demo, so nothing here goes to Anthropic.';
  const u1 = 'What can you do for me today?';
  const a2 = 'In the demo, I can show you how replies stream, what each one costs, and how your limits stop me. On a real desk I’ll also read and tidy your notes once tools arrive, always asking before anything leaves the desk.';
  const r1 = 'Hi, I’m Researcher. Send me a question and I’ll keep my answer short. I use your OpenAI key, with my own limits.';
  const threads: Record<string, Message[]> = {
    manager: [
      { id: 'm1', role: 'assistant', text: a1, at: now - 5 * HOUR, badge: badgeS, usage: usageOf(a1), costMicroUsd: 1_900, stopReason: 'end_turn', state: 'done' },
      { id: 'm2', role: 'user', text: u1, at: now - 2 * HOUR },
      { id: 'm3', role: 'assistant', text: a2, at: now - 2 * HOUR + 4000, badge: badgeS, usage: usageOf(a2), costMicroUsd: 3_400, stopReason: 'end_turn', state: 'done' },
    ],
    researcher: [{ id: 'r1', role: 'assistant', text: r1, at: now - 40 * 60_000, badge: badgeM, usage: usageOf(r1), costMicroUsd: 200, stopReason: 'end_turn', state: 'done' }],
  };
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const earlier = Math.max(new Date(today.getFullYear(), today.getMonth(), 1).getTime(), midnight - 4 * 24 * HOUR);
  const ledger: LedgerRow[] = [
    { agentId: 'manager', keyId: sonnet.keyId, at: earlier, microUsd: 2_680_000, tokens: 310_000 },
    { agentId: 'manager', keyId: sonnet.keyId, at: Math.max(midnight, now - 5 * HOUR), microUsd: 420_000, tokens: 48_000 },
    { agentId: 'researcher', keyId: mini.keyId, at: Math.max(midnight, now - 40 * 60_000), microUsd: 80_000, tokens: 61_000 },
  ];
  const policies: Record<string, LimitPolicy> = {
    manager: { ...DEFAULT_POLICY },
    researcher: { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: 1 * M, maxTokens: null } },
  };
  if (name === 'limit') {
    // Today's cap sits just above what's spent, so the next reply's worst case passes it.
    policies['manager'] = { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: 430_000, maxTokens: null } };
  }
  return { deskName, keys, agents, threads, policies, ledger, files };
}
