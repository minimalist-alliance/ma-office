// The mock behaves like the desk in the ways the UI depends on: the key flow keeps no key, limits refuse before
// a call, a refused call spends nothing and adds nothing, and the audit log is a hash chain.
import { describe, expect, it, vi } from 'vitest';
import { AgentError, newIdem } from '../client/agentClient';
import { KeySecret } from '../client/keySecret';
import type { ConversationEvent } from '../client/types';
import { TONES } from '../look/tones';
import { DEFAULT_POLICY } from './fixtures';
import { check, cost, estimate, periodStart, usageIn } from './ledger';
import { MockAgentClient } from './mockAgentClient';

const KEY = 'sk-ant-TEST-not-a-real-key-0000-MOCK';
const m = () => ({ idem: newIdem() });
const fast = (fixture: 'fresh' | 'ready' | 'limit') => new MockAgentClient({ fixture, latencyMs: 0, streamMs: 0 });

async function settle(c: MockAgentClient, agentId: string): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = [];
  await new Promise<void>((resolve) => {
    const off = c.watchConversation(agentId, (e) => {
      events.push(e);
      if (e.type === 'message' && e.message.role === 'assistant' && e.message.state && e.message.state !== 'streaming') {
        off();
        resolve();
      }
    });
  });
  return events;
}

describe('mock: the key flow', () => {
  it('keeps the last 4 and nothing else of the key', async () => {
    const c = fast('fresh');
    const key = await c.addKey({ provider: 'anthropic', label: 'Mine', secret: KeySecret.fromText(KEY) }, m());
    expect(key).toMatchObject({ provider: 'anthropic', label: 'Mine', last4: 'MOCK' });
    expect(c.dump()).not.toContain(KEY);
    expect(c.dump()).not.toContain(KEY.slice(0, -4));
    expect(c.calls.find((x) => x.method === 'agent.key.add')?.params).toMatchObject({ secret: '[redacted]' });
  });

  it('refuses a malformed key and a refused key, and keeps neither', async () => {
    const c = fast('fresh');
    const bad = await c.addKey({ provider: 'anthropic', label: '', secret: KeySecret.fromText('sk-proj-0000000000') }, m()).catch((e: unknown) => e);
    // Another provider's prefix, as desk-agent says it (deskd API.md §11), and the longest prefix decides.
    expect(bad).toMatchObject({ code: 'bad_request', reason: 'key_malformed', detail: 'provider_mismatch' });
    const anthropicUnderOpenAi = await c.addKey({ provider: 'openai', label: '', secret: KeySecret.fromText('sk-ant-TEST-0000000000') }, m()).catch((e: unknown) => e);
    expect(anthropicUnderOpenAi).toMatchObject({ code: 'bad_request', reason: 'key_malformed', detail: 'provider_mismatch' });
    const nobodys = await c.addKey({ provider: 'anthropic', label: '', secret: KeySecret.fromText('gsk_0000000000') }, m()).catch((e: unknown) => e);
    expect(nobodys).toMatchObject({ code: 'bad_request', reason: 'key_malformed', detail: 'prefix' });
    const revoked = 'sk-ant-TEST-revoked-0000';
    const refused = await c.addKey({ provider: 'anthropic', label: '', secret: KeySecret.fromText(revoked) }, m()).catch((e: unknown) => e);
    expect(refused).toMatchObject({ reason: 'key_refused' });
    expect(await c.listKeys()).toEqual([]);
    expect(c.dump()).not.toContain(revoked);
  });

  it('a bound key wakes the manager, and deleting it puts it back to sleep', async () => {
    const c = fast('fresh');
    const key = await c.addKey({ provider: 'anthropic', label: '', secret: KeySecret.fromText(KEY) }, m());
    expect(key.label).toBe('Anthropic key');
    const [model] = await c.listModels(key.keyId);
    const a = await c.bindAgent('manager', { keyId: key.keyId, model: model?.id ?? '' }, m());
    expect(a).toMatchObject({ status: 'online', binding: { provider: 'anthropic' } });
    await c.deleteKey(key.keyId, m());
    expect((await c.listAgents())[0]).toMatchObject({ status: 'no_key', binding: null });
    const actions = (await c.listAudit()).entries.map((e) => e.action);
    expect(actions).toEqual(['key.delete', 'agent.bind', 'key.add']);
  });

  it('a provider change brings the badge back', async () => {
    const c = fast('ready');
    await c.updateAgent('manager', { badgeHidden: true }, m());
    const a = await c.bindAgent('manager', { keyId: 'k-openai-1', model: 'gpt-5' }, m());
    expect(a).toMatchObject({ badgeHidden: true, badgeNotice: true });
    expect(await c.updateAgent('manager', { dismissBadgeNotice: true }, m())).toMatchObject({ badgeNotice: false });
  });
});

describe('mock: limits', () => {
  it('refuses before the call, spending nothing and adding nothing to the thread', async () => {
    const c = fast('limit');
    const before = await c.getLimits('manager');
    const thread = await c.getThread('manager');
    const err = await c.sendMessage('manager', 'hello', m()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'precondition_failed', reason: 'limit_reached', scope: 'agent_day' });
    expect((await c.getThread('manager')).messages).toHaveLength(thread.messages.length);
    expect((await c.getLimits('manager')).usage).toEqual(before.usage);
    expect((await c.listAgents()).find((a) => a.id === 'manager')).toMatchObject({ status: 'limit_reached', statusDetail: 'agent_day' });
    expect((await c.listAudit()).entries[0]).toMatchObject({ action: 'limit.hit', decision: 'refused:usd', actor: 'agent:manager' });
  });

  it('raising the limit clears the state, and the next message streams and is charged', async () => {
    const c = fast('limit');
    await c.sendMessage('manager', 'hello', m()).catch(() => undefined);
    await c.setLimits('manager', { policy: { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: 5_000_000, maxTokens: null } } }, m());
    expect((await c.listAgents())[0]?.status).toBe('online');
    const spent = (await c.getLimits('manager')).usage.find((u) => u.scope === 'agent_day')?.spentMicroUsd ?? 0;
    const done = settle(c, 'manager');
    await c.sendMessage('manager', 'hello', m());
    const events = await done;
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    const last = events[events.length - 1];
    expect(last?.type === 'message' && last.message).toMatchObject({ state: 'done', badge: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
    const after = (await c.getLimits('manager')).usage.find((u) => u.scope === 'agent_day')?.spentMicroUsd ?? 0;
    expect(after).toBeGreaterThan(spent);
    expect(last?.type === 'message' && last.message.costMicroUsd).toBe(after - spent);
  });

  it('one run at a time per agent, and stop keeps what was said', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 5 });
    const done = settle(c, 'manager');
    const { runId } = await c.sendMessage('manager', 'Show me a long reply', m());
    await expect(c.sendMessage('manager', 'again', m())).rejects.toMatchObject({ code: 'conflict', reason: 'busy' });
    await new Promise((r) => setTimeout(r, 40));
    await c.stopRun(runId, m());
    const events = await done;
    const last = events[events.length - 1];
    expect(last?.type === 'message' && last.message.state).toBe('stopped');
    expect(last?.type === 'message' && last.message.text.length).toBeGreaterThan(0);
  });

  it('only the member sets limits, and a bad policy is refused', async () => {
    const c = fast('ready');
    await expect(c.setLimits('manager', { policy: { ...DEFAULT_POLICY, runMaxSteps: 0 } }, m())).rejects.toMatchObject({ code: 'bad_request' });
    await expect(c.setLimits('manager', { policy: { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: -1, maxTokens: null } } }, m())).rejects.toMatchObject({ code: 'bad_request' });
    // An older desk needs `deskMonth` with every policy.
    const noMonth: Partial<typeof DEFAULT_POLICY> = { ...DEFAULT_POLICY };
    delete noMonth.deskMonth;
    await expect(c.setLimits('manager', { policy: noMonth as never }, m())).rejects.toMatchObject({ code: 'bad_request', detail: 'deskMonth' });
  });
});

describe('mock: ADR 0043, the layered desk', () => {
  const layered = (account = {}) => new MockAgentClient({ fixture: 'ready', keysLast: true, latencyMs: 0, streamMs: 0, account });
  const usd = (n: number) => ({ maxMicroUsd: n * 1_000_000, maxTokens: null });
  /** The agent's own fields, without the desk's. */
  const agentOnly = () => {
    const rest: Omit<typeof DEFAULT_POLICY, 'deskMonth'> & { deskMonth?: unknown } = { ...DEFAULT_POLICY };
    delete rest.deskMonth;
    return rest as Omit<typeof DEFAULT_POLICY, 'deskMonth'>;
  };

  it('with nothing set anywhere: no day cap, $20 a month, UTC, and the layers say nothing', async () => {
    const v = await layered().getLimits('manager');
    expect(v).toMatchObject({ timeZone: null, pricesAsOf: '2026-11-06', desk: { deskDay: null, deskMonth: null, timeZone: null }, account: { deskDay: null, deskMonth: null, timeZone: null } });
    expect(v.policy.deskDay).toEqual({ maxMicroUsd: null, maxTokens: null });
    expect(v.policy.deskMonth).toEqual(usd(20));
    expect(v.usage.map((u) => u.scope)).toContain('desk_day');
  });

  it('follows the account, a desk value wins over it, and null takes the desk back to the account', async () => {
    const c = layered({ deskMonth: usd(50), timeZone: 'Europe/Paris' });
    expect((await c.getLimits('manager')).policy.deskMonth).toEqual(usd(50));
    expect((await c.getLimits('manager')).timeZone).toBe('Europe/Paris');
    // Only the agent's own fields: the desk's stay as they were, following the account.
    let v = await c.setLimits('manager', { policy: { ...agentOnly(), agentDay: usd(7) } }, m());
    expect(v.desk).toEqual({ deskDay: null, deskMonth: null, timeZone: null });
    expect(v.policy).toMatchObject({ agentDay: usd(7), deskMonth: usd(50) });
    v = await c.setLimits('manager', { policy: { ...agentOnly(), deskMonth: usd(30), deskDay: { maxMicroUsd: null, maxTokens: null } } }, m());
    expect(v.desk).toMatchObject({ deskMonth: usd(30), deskDay: { maxMicroUsd: null, maxTokens: null } });
    expect(v.policy.deskMonth).toEqual(usd(30));
    v = await c.setLimits('manager', { policy: { ...agentOnly(), deskMonth: null } }, m());
    expect(v.desk?.deskMonth).toBeNull();
    expect(v.policy.deskMonth).toEqual(usd(50));
  });

  it('a zone: set, refused in its own words, and cleared to follow; with neither, nothing changes and nothing is audited', async () => {
    const c = layered();
    expect((await c.setLimits('manager', { timeZone: 'America/Denver' }, m())).timeZone).toBe('America/Denver');
    for (const bad of ['Etc/GMT+5', '+05:00', 'Mars/Olympus', 'GMT']) {
      await expect(c.setLimits('manager', { timeZone: bad }, m())).rejects.toMatchObject({ code: 'bad_request', reason: 'time_zone' });
    }
    expect((await c.getLimits('manager')).timeZone).toBe('America/Denver');
    expect((await c.setLimits('manager', { timeZone: null }, m())).timeZone).toBeNull();
    const before = (await c.listAudit()).entries.length;
    await c.setLimits('manager', {}, m());
    expect((await c.listAudit()).entries.length).toBe(before);
  });

  it('the whole desk\'s day refuses in its own scope', async () => {
    const c = layered();
    await c.setLimits('manager', { policy: { ...agentOnly(), deskDay: { maxMicroUsd: 1, maxTokens: null } } }, m());
    await expect(c.sendMessage('manager', 'hello', m())).rejects.toMatchObject({ reason: 'limit_reached', scope: 'desk_day' });
  });

  it('a model with no listed price still counts, at its provider\'s highest', async () => {
    const c = layered();
    const models = await c.listModels('k-anthropic-1');
    expect(models.find((x) => x.id === 'claude-preview')).toMatchObject({ inputMicroUsdPerMTok: null, outputMicroUsdPerMTok: null });
    await c.bindAgent('manager', { keyId: 'k-anthropic-1', model: 'claude-preview' }, m());
    await c.setLimits('manager', { policy: { ...agentOnly(), run: { maxMicroUsd: 1, maxTokens: null } } }, m());
    await expect(c.sendMessage('manager', 'hello', m())).rejects.toMatchObject({ reason: 'limit_reached', scope: 'run' });
  });
});

describe('ledger', () => {
  const price = { inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 };
  it('reserves the worst case: input bytes / 3 and the whole output cap', () => {
    expect(estimate(price, 3000, 1024)).toEqual({ tokens: 2024, microUsd: Math.ceil(1000 * 3 + 1024 * 15) });
    expect(estimate(null, 3000, 1024)).toEqual({ tokens: 2024, microUsd: null });
  });
  it('settles from reported usage, cache reads cheaper', () => {
    expect(cost(price, { inputTokens: 1000, cachedInputTokens: 1000, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 })).toBe(Math.ceil(3000 + 300 + 1500));
  });
  it('a dollar cap cannot bind a model with no price, but a token cap can', () => {
    const now = Date.now();
    const rows = [{ agentId: 'a', keyId: 'k', at: now, microUsd: null, tokens: 900 }];
    const policy = { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: 1, maxTokens: 1000 } };
    expect(check(policy, rows, { agentId: 'a', keyId: 'k' }, { tokens: 50, microUsd: null }, now)).toBeNull();
    expect(check(policy, rows, { agentId: 'a', keyId: 'k' }, { tokens: 200, microUsd: null }, now)).toMatchObject({ scope: 'agent_day', unit: 'tokens' });
  });
  it('periods: day from midnight, week from Monday, month from the 1st', () => {
    const wed = new Date(2026, 10, 4, 15, 30).getTime(); // Wednesday 4 Nov 2026
    expect(new Date(periodStart('agent_day', wed) ?? 0)).toEqual(new Date(2026, 10, 4));
    expect(new Date(periodStart('agent_week', wed) ?? 0)).toEqual(new Date(2026, 10, 2));
    expect(new Date(periodStart('desk_month', wed) ?? 0)).toEqual(new Date(2026, 10, 1));
    expect(periodStart('run', wed)).toBeNull();
  });
  it('periods in a zone, as a desk from ADR 0043 counts them: midnight there, through a change of clocks', () => {
    const at = Date.UTC(2026, 10, 4, 3, 0); // 4 Nov 03:00 UTC, which is still 3 Nov in Denver
    expect(new Date(periodStart('agent_day', at, 'UTC') ?? 0).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(new Date(periodStart('desk_day', at, 'America/Denver') ?? 0).toISOString()).toBe('2026-11-03T07:00:00.000Z');
    // Denver's clocks went back on 1 Nov: the month began at 06:00 UTC, in daylight time.
    expect(new Date(periodStart('desk_month', at, 'America/Denver') ?? 0).toISOString()).toBe('2026-11-01T06:00:00.000Z');
    expect(new Date(periodStart('agent_week', at, 'Asia/Tokyo') ?? 0).toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });
  it('desk scope counts every agent, agent scope only its own, key scope only its key', () => {
    const now = Date.now();
    const rows = [
      { agentId: 'a', keyId: 'k1', at: now, microUsd: 10, tokens: 1 },
      { agentId: 'b', keyId: 'k2', at: now, microUsd: 20, tokens: 1 },
    ];
    expect(usageIn(rows, 'agent_day', { agentId: 'a', keyId: 'k1' }, now).spentMicroUsd).toBe(10);
    expect(usageIn(rows, 'desk_month', { agentId: 'a', keyId: 'k1' }, now).spentMicroUsd).toBe(30);
    expect(usageIn(rows, 'key_month', { agentId: 'a', keyId: 'k2' }, now).spentMicroUsd).toBe(20);
  });
});

describe('audit log', () => {
  it('is a hash chain, newest first', async () => {
    const c = fast('ready');
    await c.updateAgent('manager', { name: 'Boss' }, m());
    await c.setLimits('manager', { policy: DEFAULT_POLICY }, m());
    const page = await c.listAudit();
    expect(page.entries[0]?.hash).toBe(page.headHash);
    expect(page.entries.map((e) => e.seq)).toEqual([...page.entries.map((e) => e.seq)].sort((a, b) => b - a));
    expect(page.entries.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true);
  });
  it('never holds a prompt or a reply', async () => {
    const c = fast('ready');
    const secretText = 'my private grocery list';
    const done = settle(c, 'manager');
    await c.sendMessage('manager', secretText, m());
    await done;
    expect(JSON.stringify((await c.listAudit()).entries)).not.toContain('grocery');
  });
});

describe('mock: no network', () => {
  it('never calls fetch, XHR, WebSocket or sendBeacon', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', vi.fn());
    vi.stubGlobal('WebSocket', vi.fn());
    try {
      const c = fast('fresh');
      const key = await c.addKey({ provider: 'anthropic', label: '', secret: KeySecret.fromText(KEY) }, m());
      await c.bindAgent('manager', { keyId: key.keyId, model: 'claude-haiku-4-5' }, m());
      const done = settle(c, 'manager');
      await c.sendMessage('manager', 'hi', m());
      await done;
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(XMLHttpRequest).not.toHaveBeenCalled();
      expect(WebSocket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('MockAgentClient: a restart', () => {
  const fast = { latencyMs: 0, streamMs: 1 };

  it('on a desk whose keys do not last, every key goes but its row, and agents keep their binding', async () => {
    const c = new MockAgentClient({ fixture: 'ready', ...fast });
    c.restart();
    const [manager] = await c.listAgents();
    expect(manager).toMatchObject({ status: 'no_key', binding: { keyId: 'k-anthropic-1' } });
    expect((await c.listKeys()).map((k) => k.keyId)).toContain('k-anthropic-1');
    expect((await c.listKeys())[0]).not.toHaveProperty('available');
    await expect(c.listModels('k-anthropic-1')).rejects.toMatchObject({ reason: 'no_key' });
    await expect(c.sendMessage('manager', 'hello', { idem: 'x' })).rejects.toMatchObject({ reason: 'no_key' });
  });

  it('on a desk whose keys last, nothing goes, and each key says so', async () => {
    const c = new MockAgentClient({ fixture: 'ready', keysLast: true, ...fast });
    c.restart();
    expect((await c.listAgents())[0]).toMatchObject({ status: 'online' });
    expect((await c.listKeys())[0]).toMatchObject({ available: true });
    // ADR 0043's `timeZone` came with the store, so the limits say it too, as the real desk does.
    expect(await c.getLimits('manager')).toHaveProperty('timeZone', null);
    expect(await new MockAgentClient({ fixture: 'ready', ...fast }).getLimits('manager')).not.toHaveProperty('timeZone');
    c.loseKey('k-anthropic-1');
    expect((await c.listKeys())[0]).toMatchObject({ available: false });
    expect((await c.listAgents())[0]).toMatchObject({ status: 'no_key' });
  });

  it('audits a restart as desk-agent does: the keys cleared at the stop, read back at the start', async () => {
    const kept = new MockAgentClient({ fixture: 'ready', keysLast: true, ...fast });
    const rows = async (): Promise<string[]> => (await kept.listAudit({ limit: 2 })).entries.map((e) => `${e.action} ${e.target} ${e.decision}`);
    kept.restart();
    expect(await rows()).toEqual(['key.restore keys:all restored:2:unreadable:0', 'key.drop keys:all zeroed:2']);
    kept.loseKey('k-anthropic-1');
    kept.restart();
    expect((await rows())[0]).toBe('key.restore keys:all restored:1:unreadable:1');
  });

  it('a reply streaming through it ends failed, with what it had', async () => {
    const c = new MockAgentClient({ fixture: 'ready', ...fast });
    const { runId } = await c.sendMessage('manager', 'Show me a long reply', { idem: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    c.restart();
    const { messages } = await c.getThread('manager');
    expect(messages[messages.length - 1]).toMatchObject({ runId, state: 'failed', error: 'unavailable' });
  });
});

describe('mock: many agents (task 49)', () => {
  const capped = (caps: Record<string, number>) => new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, caps });

  it('creates agents up to the cap, counting the lead, and refuses the next with agent_cap', async () => {
    const c = capped({ agentCap: 3 });
    const a = await c.createAgent({ name: 'Scout', icon: 'compass', tone: 'teal', purpose: 'Brief me.', workspaceMb: 10 }, m());
    expect(a).toMatchObject({ name: 'Scout', role: 'staff', lead: false, solo: true, links: [], look: { icon: 'compass', tone: 'teal', png: null }, workspace: { quotaBytes: 10 * 1024 * 1024, usedBytes: 0 } });
    expect(a.id).toMatch(/^ag-[a-z2-7]{12}$/);
    await expect(c.createAgent({ name: 'Fourth' }, m())).rejects.toMatchObject({ code: 'precondition_failed', reason: 'agent_cap' });
    expect((await c.caps()).agents).toBe(3);
  });

  it('names are unique per desk, compared as the desk does, at create and at rename', async () => {
    const c = fast('ready');
    await c.createAgent({ name: 'Scout' }, m());
    for (const dup of ['scout', ' SCOUT ', 'Sсout', 'Sc\u200Bout']) {
      await expect(c.createAgent({ name: dup }, m())).rejects.toMatchObject({ code: 'bad_request', detail: 'name', reason: dup.includes('\u200B') ? 'hidden_chars' : 'name_taken' });
    }
    const other = await c.createAgent({ name: 'Writer' }, m());
    await expect(c.updateAgent(other.id, { name: 'scout' }, m())).rejects.toMatchObject({ detail: 'name', reason: 'name_taken' });
    // Its own name, in other case, is a change it may make.
    expect((await c.updateAgent(other.id, { name: 'WRITER' }, m())).name).toBe('WRITER');
  });

  it('an agent made with no tone gets the first tone no agent has, graphite skipped; the member\'s pick stands', async () => {
    const c = new MockAgentClient({ fixture: 'fresh', latencyMs: 0, streamMs: 0 });
    const made: string[] = [];
    for (const name of ['A', 'B', 'C']) made.push((await c.createAgent({ name }, m())).look?.tone ?? '');
    expect(new Set(made).size).toBe(3);
    expect(made).not.toContain('graphite');
    expect(made).toEqual(TONES.map((t) => t.id).filter((id) => id !== 'graphite').slice(0, 3));
    expect((await c.createAgent({ name: 'D', tone: 'graphite' }, m())).look?.tone).toBe('graphite');
  });

  it('workspaces share the desk\'s budget: the total is in the caps, a raise or a create past it is disk_budget, a create with no size takes what is left', async () => {
    const probe = new MockAgentClient({ fixture: 'fresh', latencyMs: 0, streamMs: 0 });
    const first = (await probe.caps()).workspaceTotalMb as number;
    const c = new MockAgentClient({ fixture: 'fresh', latencyMs: 0, streamMs: 0, caps: { workspaceMb: 50, workspaceBudgetMb: first + 75 } });
    expect((await c.caps()).workspaceBudgetMb).toBe(first + 75);
    const a = await c.createAgent({ name: 'A' }, m());
    expect(a.workspace?.quotaBytes).toBe(50 * 1024 * 1024);
    expect((await c.caps()).workspaceTotalMb).toBe(first + 50);
    await expect(c.updateAgent(a.id, { workspaceMb: 500 }, m())).rejects.toMatchObject({ code: 'precondition_failed', reason: 'disk_budget' });
    const b = await c.createAgent({ name: 'B' }, m());
    expect(b.workspace?.quotaBytes).toBe(25 * 1024 * 1024);
    await expect(c.createAgent({ name: 'C' }, m())).rejects.toMatchObject({ reason: 'disk_budget' });
    await expect(c.createAgent({ name: 'D', workspaceMb: 1 }, m())).rejects.toMatchObject({ reason: 'disk_budget' });
  });

  it('checks every field: name, purpose, icon, tone and workspace size', async () => {
    const c = fast('ready');
    await expect(c.createAgent({ name: ' ' }, m())).rejects.toMatchObject({ detail: 'name' });
    await expect(c.createAgent({ name: 'X', purpose: 'p'.repeat(4001) }, m())).rejects.toMatchObject({ detail: 'purpose' });
    await expect(c.createAgent({ name: 'X', icon: 'nope' }, m())).rejects.toMatchObject({ detail: 'icon' });
    await expect(c.createAgent({ name: 'X', tone: 'sage' }, m())).rejects.toMatchObject({ detail: 'tone' });
    await expect(c.createAgent({ name: 'X', workspaceMb: 1025 }, m())).rejects.toMatchObject({ detail: 'workspaceMb' });
    await expect(c.updateAgent('researcher', { icon: 'png' }, m())).rejects.toMatchObject({ detail: 'icon' });
  });

  it('agent.state is the smaller snapshot, with the caps', async () => {
    const c = fast('ready');
    await c.setLinks('researcher', { solo: false, links: [{ to: 'manager', rules: 'Only ask for summaries.' }] }, m());
    const [agents, caps] = await new Promise<[unknown[], unknown]>((resolve) => {
      const off = c.watchAgents((a, k) => {
        off();
        resolve([a, k]);
      });
    });
    const r = (agents as { id: string }[]).find((a) => a.id === 'researcher') as Record<string, unknown>;
    expect(r['purpose']).toBeUndefined();
    expect(r['workspace']).toBeUndefined();
    expect(r['links']).toEqual([{ to: 'manager' }]);
    expect(caps).toMatchObject({ agentCap: 24, agents: 2, rulesMax: 500 });
    expect((await c.getAgent('researcher')).links).toEqual([{ to: 'manager', rules: 'Only ask for summaries.' }]);
  });

  it('never deletes the lead; a deleted agent takes its links both ways, timers and workspace, and the logs keep their rows', async () => {
    const c = fast('ready');
    await expect(c.deleteAgent('manager', m())).rejects.toMatchObject({ code: 'bad_request', detail: 'lead' });
    await c.setLinks('manager', { solo: false, links: [{ to: 'researcher', rules: 'Be brief.' }] }, m());
    await c.setTimer('researcher', { label: 'Brief', kind: 'repeat', everyMinutes: 60, prompt: 'Go' }, m());
    await c.deleteAgent('researcher', m());
    expect((await c.listAgents()).map((a) => a.id)).toEqual(['manager']);
    expect((await c.getAgent('manager')).links).toEqual([]);
    await expect(c.listTimers('researcher')).rejects.toMatchObject({ code: 'not_found' });
    expect((await c.listAudit()).entries.map((e) => e.action)).toContain('agent.delete');
  });

  it('links: rules 1 to 500 characters, no self, no stranger, no repeat; solo stays the default', async () => {
    const c = fast('ready');
    const bad = (links: { to: string; rules: string }[]) => expect(c.setLinks('researcher', { solo: false, links }, m())).rejects.toMatchObject({ code: 'bad_request', detail: 'links' });
    await bad([{ to: 'manager', rules: '' }]);
    await bad([{ to: 'manager', rules: 'x'.repeat(501) }]);
    await bad([{ to: 'researcher', rules: 'x' }]);
    await bad([{ to: 'ghost', rules: 'x' }]);
    await bad([{ to: 'manager', rules: 'x' }, { to: 'manager', rules: 'y' }]);
    expect((await c.setLinks('researcher', { solo: false, links: [{ to: 'manager', rules: ' x'.repeat(250) }] }, m())).links?.[0]?.rules).toHaveLength(499);
    expect((await c.getAgent('manager')).solo).toBe(true);
  });
});

describe('mock: the lead\'s proposals', () => {
  async function ask(c: MockAgentClient, text: string) {
    await c.sendMessage('manager', text, m());
    const events = await settle(c, 'manager');
    const reply = [...events].reverse().find((e) => e.type === 'message' && e.message.role === 'assistant' && e.message.state === 'done');
    return (reply as Extract<ConversationEvent, { type: 'message' }>).message;
  }

  it('"set up two agents" proposes two, each with the sha256 of its payload, and nothing changes yet', async () => {
    const c = fast('ready');
    const reply = await ask(c, 'Please set up two agents for me');
    expect(reply.proposals?.map((p) => [p.action, p.state, p.payload['name']])).toEqual([
      ['agent.create', 'pending', 'Scout'],
      ['agent.create', 'pending', 'Writer'],
    ]);
    const { canonicalJson, sha256Hex } = await import('../model/proposals');
    for (const p of reply.proposals ?? []) expect(p.sha256).toBe(await sha256Hex(canonicalJson(p.payload)));
    expect((await c.listAgents()).length).toBe(2);
  });

  it('a yes applies exactly the card (agent, timer), a no declines, and each answers once', async () => {
    const c = fast('ready');
    const [scout, writer] = (await ask(c, 'set up two agents')).proposals ?? [];
    await expect(c.answerProposal(scout!.id, true, 'f'.repeat(64), m())).rejects.toMatchObject({ code: 'bad_request', detail: 'sha256' });
    const yes = await c.answerProposal(scout!.id, true, scout!.sha256, m());
    expect(yes).toMatchObject({ state: 'applied', detail: null });
    const made = await c.getAgent(yes.result!.agentId!);
    expect(made).toMatchObject({ name: 'Scout', solo: true, look: { icon: 'compass', tone: 'teal' }, timers: 1 });
    expect((await c.listTimers(made.id)).timers[0]).toMatchObject({ label: 'Morning brief', days: [1, 2, 3, 4, 5], time: '08:00' });
    expect(await c.answerProposal(writer!.id, false, writer!.sha256, m())).toMatchObject({ state: 'declined' });
    await expect(c.answerProposal(writer!.id, true, writer!.sha256, m())).rejects.toMatchObject({ code: 'conflict', reason: 'answered' });
    // The thread's copy says so too.
    const thread = await c.getThread('manager');
    expect(thread.messages.flatMap((x) => x.proposals ?? []).map((p) => p.state)).toEqual(['applied', 'declined']);
    expect((await c.listAudit()).entries.filter((e) => e.action.startsWith('proposal.')).map((e) => `${e.action} ${e.decision}`)).toEqual([
      'proposal.answer declined',
      'proposal.answer applied',
      'proposal.make agent.create',
      'proposal.make agent.create',
    ]);
  });

  it('a yes the desk can no longer do ends failed, with why; one past 24 hours ends expired', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, caps: { agentCap: 2 } });
    const [scout, writer] = (await ask(c, 'set up two agents')).proposals ?? [];
    expect(await c.answerProposal(scout!.id, true, scout!.sha256, m())).toMatchObject({ state: 'failed', detail: 'agent_cap' });
    c.expireProposals();
    expect(await c.answerProposal(writer!.id, true, writer!.sha256, m())).toMatchObject({ state: 'expired' });
  });

  it('links between two agents, with the rule on the card', async () => {
    const c = fast('ready');
    const [scout, writer] = (await ask(c, 'set up two agents')).proposals ?? [];
    await c.answerProposal(scout!.id, true, scout!.sha256, m());
    await c.answerProposal(writer!.id, true, writer!.sha256, m());
    const [link] = (await ask(c, 'let Writer message Scout')).proposals ?? [];
    expect(link?.action).toBe('agent.links');
    const applied = await c.answerProposal(link!.id, true, link!.sha256, m());
    const w = await c.getAgent(applied.result!.agentId!);
    expect(w.name).toBe('Writer');
    expect(w.links?.[0]?.rules).toMatch(/^Ask Scout only/);
  });
});

describe('mock: messages between agents', () => {
  it('a solo agent sends none; a linked one sends with its rules, the receiver\'s thread marks it, and the log keeps it', async () => {
    const c = fast('ready');
    await c.sendMessage('researcher', 'ask the lead for a summary', m());
    await settle(c, 'researcher');
    expect((await c.listA2a()).messages).toEqual([]);

    await c.setLinks('researcher', { solo: false, links: [{ to: 'manager', rules: 'Only ask for summaries.' }] }, m());
    // The receiver stays solo: a solo agent sends none but still gets what a link allows.
    expect((await c.getAgent('manager')).solo).toBe(true);
    expect((await c.getAgent('manager')).incoming).toEqual([{ from: 'researcher', rules: 'Only ask for summaries.' }]);
    await c.sendMessage('researcher', 'ask the lead for a summary', m());
    await settle(c, 'researcher');
    await settle(c, 'manager');
    const log = (await c.listA2a({ agentId: 'researcher' })).messages;
    expect(log[0]).toMatchObject({ from: 'researcher', to: 'manager', rules: 'Only ask for summaries.', depth: 1, state: 'replied' });
    expect(log[0]?.costMicroUsd).toBeGreaterThan(0);
    const into = (await c.getThread('manager')).messages.find((x) => x.origin);
    expect(into?.origin).toMatchObject({ kind: 'agent', agentId: 'researcher', rules: 'Only ask for summaries.' });
  });

  it('refuses past the hourly rate per pair, and logs the refusal', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, caps: { a2aPerHour: 1 } });
    await c.setLinks('researcher', { solo: false, links: [{ to: 'manager', rules: 'Be brief.' }] }, m());
    for (let i = 0; i < 2; i += 1) {
      await c.sendMessage('researcher', 'ask the lead', m());
      await settle(c, 'researcher');
      if (i === 0) await settle(c, 'manager');
    }
    expect((await c.listA2a()).messages.map((x) => `${x.state}:${x.reason}`)).toEqual(['refused:rate', 'replied:null']);
  });
});

describe('mock: desk-wide message limits', () => {
  it('stops past the desk\'s messages an hour with desk_rate, and logs it', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, caps: { a2aDeskPerHour: 1 } });
    await c.setLinks('researcher', { solo: false, links: [{ to: 'manager', rules: 'Be brief.' }] }, m());
    for (let i = 0; i < 2; i += 1) {
      await c.sendMessage('researcher', 'ask the lead', m());
      await settle(c, 'researcher');
      if (i === 0) await settle(c, 'manager');
    }
    expect((await c.listA2a()).messages.map((x) => `${x.state}:${x.reason}`)).toEqual(['refused:desk_rate', 'replied:null']);
  });
});

describe('mock: hidden characters are refused with hidden_chars (task 49 fix)', () => {
  it('in names, purposes, rules, timer labels and prompts', async () => {
    const c = fast('ready');
    const bad = 'a\u202Eb';
    await expect(c.createAgent({ name: bad }, m())).rejects.toMatchObject({ detail: 'name', reason: 'hidden_chars' });
    await expect(c.updateAgent('researcher', { purpose: bad }, m())).rejects.toMatchObject({ detail: 'purpose', reason: 'hidden_chars' });
    await expect(c.setLinks('researcher', { solo: false, links: [{ to: 'manager', rules: bad }] }, m())).rejects.toMatchObject({ reason: 'hidden_chars' });
    const t = { label: 'L', kind: 'once' as const, inMinutes: 5, prompt: 'p' };
    await expect(c.setTimer('researcher', { ...t, label: bad }, m())).rejects.toMatchObject({ detail: 'label', reason: 'hidden_chars' });
    await expect(c.setTimer('researcher', { ...t, prompt: bad }, m())).rejects.toMatchObject({ detail: 'prompt', reason: 'hidden_chars' });
  });
});

describe('mock: pages, refused saves, run ends and the plan cap (task 49 fix)', () => {
  it('reads a long file a page at a time, 128 Ki characters, and says how many are left', async () => {
    const c = fast('ready');
    c.writeFile('researcher', 'long.txt', 'p'.repeat(300_000));
    const one = await c.readWorkspace('researcher', 'long.txt');
    expect(one).toMatchObject({ offset: 0, remaining: 300_000 - 131_072, truncated: true });
    expect(one.text).toHaveLength(131_072);
    const two = await c.readWorkspace('researcher', 'long.txt', { offset: 131_072 });
    expect(two).toMatchObject({ offset: 131_072, remaining: 37_856, truncated: true });
    const three = await c.readWorkspace('researcher', 'long.txt', { offset: 262_144, length: 1_000_000 });
    expect(three).toMatchObject({ remaining: 0, truncated: false });
    expect(three.text).toHaveLength(37_856);
  });

  it('every file counts at least 4 KiB, and a folder over 500 entries says there is more', async () => {
    const c = fast('ready');
    const before = (await c.getWorkspace('researcher')).usedBytes;
    c.writeFile('researcher', 'tiny.txt', 'x');
    expect((await c.getWorkspace('researcher')).usedBytes).toBe(before + 4096);
    for (let i = 0; i < 500; i += 1) c.writeFile('researcher', `many/f${i}.txt`, 'x');
    for (let i = 0; i < 2; i += 1) c.writeFile('researcher', `f${i}.txt`, 'x');
    const view = await c.getWorkspace('researcher', 'many');
    expect(view.entries).toHaveLength(500);
    expect(view.more).toBeUndefined();
    c.writeFile('researcher', 'many/last.txt', 'x');
    expect((await c.getWorkspace('researcher', 'many')).more).toBe(true);
  });

  it('a save over the quota leaves the file out and the reply says which', async () => {
    const c = fast('ready');
    await c.updateAgent('researcher', { workspaceMb: 1 }, m());
    const left = (await c.getWorkspace('researcher')).quotaBytes - (await c.getWorkspace('researcher')).usedBytes;
    c.writeFile('researcher', 'fill.txt', 'z'.repeat(left));
    await c.sendMessage('researcher', 'save notes.txt', m());
    await settle(c, 'researcher');
    const reply = (await c.getThread('researcher')).messages.filter((x) => x.role === 'assistant').pop();
    expect(reply?.workspaceRefused).toEqual([{ path: 'notes.txt', reason: 'workspace_full' }]);
    await expect(c.readWorkspace('researcher', 'notes.txt')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a run that hits the output cap, or a refusal, fails with that word and keeps what was said', async () => {
    const c = fast('ready');
    await c.sendMessage('researcher', 'demo:cut_off', m());
    await settle(c, 'researcher');
    await c.sendMessage('researcher', 'demo:refused', m());
    await settle(c, 'researcher');
    const replies = (await c.getThread('researcher')).messages.filter((x) => x.role === 'assistant').slice(-2);
    expect(replies.map((x) => `${x.state}:${x.error}`)).toEqual(['failed:cut_off', 'failed:refused']);
    expect(replies[0]?.text).toMatch(/^Here is the start/);
  });

  it('agents past the plan cap are paused, never deleted, and refuse a run with agent_cap', async () => {
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, caps: { agentCap: 1 } });
    const list = await c.listAgents();
    expect(list).toHaveLength(2);
    expect(list.find((a) => a.id === 'researcher')).toMatchObject({ status: 'paused', statusDetail: 'agent_cap' });
    expect(list.find((a) => a.id === 'manager')?.status).not.toBe('paused');
    await expect(c.sendMessage('researcher', 'hello', m())).rejects.toMatchObject({ code: 'precondition_failed', reason: 'agent_cap' });
  });
});

describe('mock: workspaces', () => {
  it('lists folders and files, reads text, deletes, and keeps the use', async () => {
    const c = fast('ready');
    const top = await c.getWorkspace('researcher');
    expect(top.entries.map((e) => `${e.dir ? 'd' : 'f'} ${e.path}`)).toEqual(['d notes', 'f sources.md']);
    expect(top.usedBytes).toBeGreaterThan(0);
    expect((await c.getWorkspace('researcher', 'notes')).entries.map((e) => e.path)).toEqual(['notes/2026-11-07.md', 'notes/ideas.txt']);
    expect((await c.readWorkspace('researcher', 'notes/ideas.txt')).text).toMatch(/sources they trust/);
    await expect(c.readWorkspace('researcher', '../manager/x')).rejects.toMatchObject({ code: 'bad_request', detail: 'path' });
    await expect(c.readWorkspace('researcher', 'nope.md')).rejects.toMatchObject({ code: 'not_found', detail: 'path' });
    const { usedBytes } = await c.deleteWorkspaceEntry('researcher', 'notes', m());
    expect(usedBytes).toBeLessThan(top.usedBytes);
    expect((await c.getAgent('researcher')).workspace?.usedBytes).toBe(usedBytes);
  });

  it('a quota under its use is refused, a write past the quota is too, and sharing names real agents only', async () => {
    const c = fast('ready');
    c.writeFile('researcher', 'big.txt', 'x'.repeat(2 * 1024 * 1024));
    await expect(c.updateAgent('researcher', { workspaceMb: 1 }, m())).rejects.toMatchObject({ reason: 'workspace_full' });
    await c.updateAgent('manager', { workspaceMb: 1 }, m());
    expect(() => c.writeFile('manager', 'big.txt', 'x'.repeat(2 * 1024 * 1024))).toThrow(/workspace_full/);
    await expect(c.shareWorkspace('researcher', ['researcher'], m())).rejects.toMatchObject({ detail: 'with' });
    expect((await c.shareWorkspace('researcher', ['manager'], m())).workspace?.sharedWith).toEqual(['manager']);
  });
});

describe('mock: timers', () => {
  it('validates each shape, holds the per-agent cap, and says the next run in the member\'s zone', async () => {
    const now = Date.UTC(2026, 10, 8, 10, 15);
    const c = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, keysLast: true, account: { timeZone: 'America/Denver' }, caps: { timersPerAgent: 2 }, now: () => now });
    await expect(c.setTimer('researcher', { label: 'X', kind: 'repeat', everyMinutes: 1, prompt: 'p' }, m())).rejects.toMatchObject({ detail: 'everyMinutes' });
    await expect(c.setTimer('researcher', { label: 'X', kind: 'once', at: now - 1, prompt: 'p' }, m())).rejects.toMatchObject({ detail: 'at' });
    const brief = await c.setTimer('researcher', { label: 'Brief', kind: 'repeat', days: [1, 2, 3, 4, 5], time: '08:00', prompt: 'Brief me.' }, m());
    expect(brief).toMatchObject({ zone: 'America/Denver', nextAt: Date.UTC(2026, 10, 9, 15, 0), enabled: true });
    const once = await c.setTimer('researcher', { label: 'Later', kind: 'once', inMinutes: 120, prompt: 'Check.' }, m());
    expect(once.at).toBe(now + 120 * 60_000);
    await expect(c.setTimer('researcher', { label: 'Third', kind: 'once', inMinutes: 5, prompt: 'p' }, m())).rejects.toMatchObject({ reason: 'timer_cap' });
    const off = await c.setTimer('researcher', { id: brief.id, label: 'Brief', kind: 'repeat', days: [1], time: '09:30', prompt: 'Brief me.', enabled: false }, m());
    expect(off).toMatchObject({ id: brief.id, days: [1], nextAt: null });
    await c.deleteTimer('researcher', once.id, m());
    expect((await c.listTimers('researcher')).timers.map((t) => t.id)).toEqual([brief.id]);
    expect((await c.getAgent('researcher')).timers).toBe(1);
  });

  it('when one fires, its prompt shows in the thread marked from the timer, then the reply; its spend counts', async () => {
    const c = fast('ready');
    const t = await c.setTimer('researcher', { label: 'Brief', kind: 'repeat', everyMinutes: 60, prompt: 'What changed?' }, m());
    c.fireTimer('researcher', t.id);
    await settle(c, 'researcher');
    const msgs = (await c.getThread('researcher')).messages;
    expect(msgs.find((x) => x.origin)).toMatchObject({ role: 'user', text: 'What changed?', origin: { kind: 'timer', timerId: t.id, label: 'Brief' } });
    const after = (await c.listTimers('researcher')).timers[0]!;
    expect(after.lastState).toBe('ok');
    expect(after.spentMicroUsd).toBeGreaterThan(0);
  });
});

describe('mock: icons', () => {
  const ONE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  it('takes a PNG, bumps the version, and serves it back; refuses what isn\'t one, in the desk\'s words', async () => {
    const c = fast('ready');
    const a = await c.uploadIcon('researcher', ONE, m());
    expect(a?.look).toMatchObject({ icon: 'png', png: 1 });
    expect(await c.getIcon('researcher')).toMatchObject({ version: 1 });
    expect((await c.uploadIcon('researcher', ONE, m()))?.look?.png).toBe(2);
    await expect(c.uploadIcon('researcher', btoa('GIF89a'), m())).rejects.toMatchObject({ code: 'bad_request', detail: 'png', reason: 'not_png' });
    const tiny = new MockAgentClient({ fixture: 'ready', latencyMs: 0, streamMs: 0, caps: { iconMaxBytes: 20 } });
    await expect(tiny.uploadIcon('researcher', ONE, m())).rejects.toMatchObject({ reason: 'too_large' });
    await expect(c.getIcon('manager')).rejects.toMatchObject({ code: 'not_found' });
    // The upload goes nowhere near the log of calls.
    expect(JSON.stringify(c.calls)).not.toContain(ONE);
  });
});


describe('mock: files on a message (ADR 0049)', () => {
  const doc = (name: string, n = 1000) => new File([new Uint8Array(n).fill(66) as BlobPart], name);
  const withKey = async () => {
    const c = fast('ready');
    return { c, id: (await c.listAgents())[0]!.id };
  };

  it('stages a file, sends it with the message, and holds nothing afterwards', async () => {
    const { c, id } = await withKey();
    await c.attachFile(id, 'upload-1', doc('plan.pdf', 600 * 1024));
    expect(c.calls.filter((x) => x.method === 'agent.attach.put').map((x) => (x.params as { index: number }).index)).toEqual([0, 1]);
    const sent = await c.sendMessage(id, '', m(), ['upload-1']);
    const user = (await c.getThread(id)).messages.find((x) => x.id === sent.messageId)!;
    expect(user.attachments).toEqual([{ name: 'plan.pdf', type: 'pdf', size: 600 * 1024 }]);
    expect(JSON.parse(c.dump()).staged).toEqual([]);
    // The file's bytes were never in the mock: only a count.
    expect(c.dump()).not.toContain('BBBB');
    await expect(c.sendMessage(id, 'again', m(), ['upload-1'])).rejects.toMatchObject({ reason: 'missing' });
  });

  it('text may be empty with files, and not without', async () => {
    const { c, id } = await withKey();
    await expect(c.sendMessage(id, '  ', m())).rejects.toMatchObject({ code: 'bad_request' });
    await c.attachFile(id, 'upload-2', doc('a.txt'));
    await expect(c.sendMessage(id, '  ', m(), ['upload-2'])).resolves.toBeTruthy();
  });

  it('a busy agent leaves the files staged for the next try; a limit takes them', async () => {
    const { c, id } = await withKey();
    await c.attachFile(id, 'upload-3', doc('a.txt'));
    await c.sendMessage(id, 'first', m());
    await expect(c.sendMessage(id, 'second', m(), ['upload-3'])).rejects.toMatchObject({ code: 'conflict', reason: 'busy' });
    await settle(c, id);
    await expect(c.sendMessage(id, 'third', m(), ['upload-3'])).resolves.toBeTruthy();
  });

  it('refuses chunks out of order, and a file the desk dropped', async () => {
    const { c, id } = await withKey();
    await expect(c.attachPut({ agentId: id, uploadId: 'upload-4', name: 'a', size: 10, index: 1, bytes: 10 })).rejects.toMatchObject({ reason: 'bad_upload' });
    await c.attachFile(id, 'upload-5', doc('a.txt'));
    c.expireStaged();
    await expect(c.sendMessage(id, 'x', m(), ['upload-5'])).rejects.toMatchObject({ reason: 'missing' });
  });

  it('removes a staged file, and says an unreadable one by name, taking the files', async () => {
    const { c, id } = await withKey();
    await c.attachFile(id, 'upload-6', doc('a.txt'));
    await c.removeAttachment(id, 'upload-6', m());
    await expect(c.sendMessage(id, 'x', m(), ['upload-6'])).rejects.toMatchObject({ reason: 'missing' });
    await c.attachFile(id, 'upload-7', doc('encrypted.pdf'));
    await expect(c.sendMessage(id, 'x', m(), ['upload-7'])).rejects.toMatchObject({ reason: 'encrypted', file: 'encrypted.pdf' });
    await expect(c.sendMessage(id, 'x', m(), ['upload-7'])).rejects.toMatchObject({ reason: 'missing' });
  });

  it('caps: the owner changes them within the ceiling', async () => {
    const { c, id } = await withKey();
    expect((await c.attachCaps(id)).caps.maxFiles).toBe(5);
    expect((await c.setAttachCaps({ maxFiles: 3 }, m())).caps.maxFiles).toBe(3);
    await expect(c.setAttachCaps({ maxFiles: 99 }, m())).rejects.toMatchObject({ code: 'bad_request' });
  });
});
