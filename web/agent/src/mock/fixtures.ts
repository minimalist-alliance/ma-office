// The mock's desks. Prices are illustrative, not anyone's real price list, and no key here is real: a mock key
// is metadata only (label and last 4), because the mock never keeps a key.
import type { Agent, AgentCaps, KeyMeta, LimitLayer, LimitPolicy, Message, ModelInfo, Provider } from '../client/types';
import type { LedgerRow } from './ledger';

export type FixtureName = 'fresh' | 'ready' | 'limit';
export const FIXTURES: readonly FixtureName[] = ['fresh', 'ready', 'limit'];

export const PROVIDERS: Provider[] = [
  { id: 'anthropic', name: 'Anthropic', console: 'console.anthropic.com', keyPrefix: 'sk-ant-' },
  { id: 'openai', name: 'OpenAI', console: 'platform.openai.com', keyPrefix: 'sk-' },
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
    look: { icon: 'spark', tone: 'graphite', png: null },
    solo: true,
    links: [],
    workspace: { quotaBytes: DEFAULT_CAPS.workspaceMb * MB, usedBytes: 0, sharedWith: [] },
    timers: 0,
    createdAt: now - 96 * HOUR,
    ...over,
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
