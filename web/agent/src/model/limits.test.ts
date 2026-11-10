import { describe, expect, it } from 'vitest';
import type { LimitsView } from '../client/types';
import { DEFAULT_POLICY } from '../mock/fixtures';
import { compactCount, parseUsd, usd, usdField, usdLimit } from './format';
import {
  browserZone,
  canonicalZone,
  draftFromView,
  editDraft,
  followAccount,
  guildHeadline,
  headlineRow,
  levelOf,
  limitRows,
  needsZone,
  parseDraft,
  pricesDate,
  refusalText,
  resetText,
  runRows,
  sourceOf,
} from './limits';

const M = 1_000_000;
const view = (over: Partial<LimitsView> = {}): LimitsView => ({
  agentId: 'manager',
  policy: DEFAULT_POLICY,
  usage: [
    { scope: 'agent_day', spentMicroUsd: 420_000, spentTokens: 48_000, resetsAt: 0 },
    { scope: 'agent_week', spentMicroUsd: 900_000, spentTokens: 0, resetsAt: 0 },
    { scope: 'agent_month', spentMicroUsd: 3_100_000, spentTokens: 0, resetsAt: 0 },
    { scope: 'desk_month', spentMicroUsd: 17_000_000, spentTokens: 0, resetsAt: 0 },
    { scope: 'key_month', spentMicroUsd: 3_100_000, spentTokens: 0, resetsAt: 0 },
  ],
  ...over,
});

describe('money', () => {
  it('formats µ$ as estimates people read', () => {
    expect(usd(420_000)).toBe('$0.42');
    expect(usd(0)).toBe('$0.00');
    expect(usd(4_000)).toBe('<$0.01');
    expect(usd(null)).toBe('unknown');
    expect(usdLimit(5 * M)).toBe('$5');
    expect(usdLimit(2_500_000)).toBe('$2.50');
    expect(compactCount(48_000)).toBe('48k');
    expect(compactCount(1_250_000)).toBe('1.3M');
  });
  it('parses what the member types, two decimals at most', () => {
    expect(parseUsd('5')).toBe(5 * M);
    expect(parseUsd('$2.5')).toBe(2_500_000);
    expect(parseUsd('0.05')).toBe(50_000);
    expect(parseUsd('1,000')).toBe(1000 * M);
    expect(parseUsd('2.555')).toBeNull();
    expect(parseUsd('-1')).toBeNull();
    expect(parseUsd('five')).toBeNull();
    expect(usdField(2_500_000)).toBe('2.5');
    expect(usdField(null)).toBe('');
  });
});

describe('limit rows', () => {
  it('shows each set limit with what is spent, and warns near the top', () => {
    const rows = limitRows(view());
    expect(rows.map((r) => [r.scope, r.text, r.level])).toEqual([
      ['agent_day', '$0.42 of $5', 'ok'],
      ['desk_month', '$17.00 of $20', 'near'],
    ]);
    expect(levelOf(0.79)).toBe('ok');
    expect(levelOf(0.8)).toBe('near');
    expect(levelOf(1)).toBe('reached');
  });
  it('on a Guild Desk the rail measures against the guild’s caps on each member, not the desk’s own limits', () => {
    // $0.42 of the guild's $1 a day is fuller than $3.10 of its $10 a month.
    expect(guildHeadline(view(), { usdPerDay: 1, usdPerMonth: 10 })).toMatchObject({ scope: 'agent_day', text: '$0.42 of $1', level: 'ok' });
    expect(guildHeadline(view(), { usdPerDay: 1, usdPerMonth: 3.5 })).toMatchObject({ scope: 'agent_month', text: '$3.10 of $3.50', level: 'near' });
    // Nothing spent yet: today's, against the guild's cap.
    expect(guildHeadline(view({ usage: [] }), { usdPerDay: 1, usdPerMonth: 10 })?.text).toBe('$0.00 of $1');
    expect(guildHeadline(null, { usdPerDay: null, usdPerMonth: 2.5 })?.text).toBe('$0.00 of $2.50');
    expect(guildHeadline(view(), { usdPerDay: null, usdPerMonth: null })).toBeNull();
  });
  it('the rail shows the fullest', () => {
    expect(headlineRow(view())?.scope).toBe('desk_month');
    expect(headlineRow(view({ policy: { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: null, maxTokens: null }, deskMonth: { maxMicroUsd: null, maxTokens: null } } }))).toBeNull();
  });
  it('a token cap shows in tokens, and a zero cap is reached at once', () => {
    const rows = limitRows(view({ policy: { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: 0, maxTokens: 50_000 } } }));
    expect(rows.filter((r) => r.scope === 'agent_day').map((r) => [r.text, r.level])).toEqual([
      ['$0.42 of $0', 'reached'],
      ['48k of 50k tokens', 'near'],
    ]);
  });
  it('per-run caps read as a line', () => {
    expect(runRows(DEFAULT_POLICY)).toEqual(['$2 a run', '50 steps a run']);
  });
});

describe('the limits form, on an older desk', () => {
  it('round-trips the policy, and nothing changed sends nothing', () => {
    const d = draftFromView(view());
    expect(d).toMatchObject({ agentDay: '5', agentWeek: '', deskMonth: '20', run: '2', runMaxSteps: '50', follow: {} });
    expect(parseDraft(d, view())).toEqual({ ok: true, change: null });
  });
  it('blank means no limit, token caps the desk holds are kept, and `deskMonth` goes with every policy, as it always did', () => {
    const base = { ...DEFAULT_POLICY, agentDay: { maxMicroUsd: 5 * M, maxTokens: 90_000 } };
    const r = parseDraft({ ...draftFromView(view({ policy: base })), agentDay: '', agentWeek: '12.50' }, view({ policy: base }));
    const p = r.ok ? r.change?.policy : undefined;
    expect(p?.agentDay).toEqual({ maxMicroUsd: null, maxTokens: 90_000 });
    expect(p?.agentWeek).toEqual({ maxMicroUsd: 12_500_000, maxTokens: null });
    expect(p?.deskMonth).toEqual({ maxMicroUsd: 20 * M, maxTokens: null });
    expect(p && 'deskDay' in p).toBe(false);
    expect(r.ok && r.change && 'timeZone' in r.change).toBe(false);
  });
  it('names every bad field', () => {
    const r = parseDraft({ ...draftFromView(view()), agentDay: 'lots', run: '20000', runMaxSteps: '0' }, view());
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['agentDay', 'run', 'runMaxSteps']);
    expect(parseDraft({ ...draftFromView(view()), runMaxSteps: '2.5' }, view()).ok).toBe(false);
    expect(parseDraft({ ...draftFromView(view()), runMaxSteps: '501' }, view()).ok).toBe(false);
  });
  it('a refusal says which limit and that nothing was sent', () => {
    expect(refusalText('agent_day', view())).toBe('Today’s limit is reached ($5). Nothing was sent. Raise the limit, or wait for it to reset.');
    expect(refusalText(null, null)).toMatch(/^A usage limit is reached\. Nothing was sent/);
  });
  it('the whole desk\'s day (ADR 0043): shown where a desk sets it, refused in its own words, and absent on older desks', () => {
    const deskDay = { maxMicroUsd: 10 * M, maxTokens: null };
    const withDay = view({ policy: { ...DEFAULT_POLICY, deskDay }, usage: [...view().usage, { scope: 'desk_day', spentMicroUsd: 9 * M, spentTokens: 0, resetsAt: 0 }] });
    expect(limitRows(withDay).map((r) => [r.scope, r.label, r.text, r.level])).toContainEqual(['desk_day', 'Whole desk, today', '$9.00 of $10', 'near']);
    expect(refusalText('desk_day', withDay)).toBe('The desk’s limit for today is reached ($10). Nothing was sent. Raise the limit, or wait for it to reset.');
    expect(limitRows(view()).some((r) => r.scope === 'desk_day')).toBe(false);
    expect(refusalText('desk_day', view())).toBe('The desk’s limit for today is reached. Nothing was sent. Raise the limit, or wait for it to reset.');
    expect(refusalText('desk_hour' as never, view())).toMatch(/^A usage limit is reached\. Nothing was sent/);
  });
});

describe('the limits form, on a layered desk (ADR 0043)', () => {
  const none = { maxMicroUsd: null, maxTokens: null };
  const usdL = (n: number) => ({ maxMicroUsd: n * M, maxTokens: null });
  const empty = { deskDay: null, deskMonth: null, timeZone: null };
  /** A desk that follows its account for everything, or as `over` says. */
  const layered = (over: Partial<LimitsView> = {}): LimitsView =>
    view({
      policy: { ...DEFAULT_POLICY, deskDay: none },
      timeZone: 'America/Denver',
      pricesAsOf: '2026-11-06',
      desk: { ...empty, timeZone: 'America/Denver' },
      account: empty,
      ...over,
    });

  it('a field the member didn\'t touch isn\'t sent: the agent\'s own fields go, and the desk keeps following', () => {
    const v = layered();
    const r = parseDraft({ ...draftFromView(v), agentDay: '7' }, v);
    expect(r.ok && r.change).toEqual({ policy: { ...DEFAULT_POLICY, deskMonth: undefined, agentDay: usdL(7) } });
    const p = r.ok ? r.change?.policy : undefined;
    expect(p && 'deskMonth' in p && p.deskMonth !== undefined).toBe(false);
    expect(p && 'deskDay' in p).toBe(false);
    expect(r.ok && r.change && 'timeZone' in r.change).toBe(false);
    expect(JSON.stringify(r.ok && r.change)).not.toMatch(/desk|timeZone/);
  });
  it('typing the same amount back, or `20.00` for 20, is no change', () => {
    const v = layered();
    let d = editDraft(draftFromView(v), 'deskMonth', '25');
    d = editDraft(d, 'deskMonth', '20.00');
    expect(parseDraft(d, v)).toEqual({ ok: true, change: null });
  });
  it('a changed whole-desk field is sent, and only it; blank is no limit, set on this desk', () => {
    const v = layered();
    const r = parseDraft(editDraft(draftFromView(v), 'deskMonth', '30'), v);
    expect(r.ok && r.change?.policy).toMatchObject({ deskMonth: usdL(30) });
    expect(r.ok && r.change?.policy && 'deskDay' in r.change.policy).toBe(false);
    const blank = parseDraft(editDraft(draftFromView(v), 'deskMonth', ''), v);
    expect(blank.ok && blank.change?.policy?.deskMonth).toEqual(none);
    const day = parseDraft(editDraft(draftFromView(v), 'deskDay', '4.50'), v);
    expect(day.ok && day.change?.policy).toMatchObject({ deskDay: usdL(4.5) });
    expect(day.ok && day.change?.policy && 'deskMonth' in day.change.policy).toBe(false);
  });
  it('"Use my account’s" sends null where this desk had its own, and shows the account\'s, or the default', () => {
    const own = layered({ policy: { ...DEFAULT_POLICY, deskDay: none, deskMonth: usdL(30) }, desk: { ...empty, deskMonth: usdL(30), timeZone: 'America/Denver' }, account: { ...empty, deskMonth: usdL(50) } });
    expect(sourceOf(draftFromView(own), own, 'deskMonth')).toBe('own');
    const d = followAccount(draftFromView(own), own, 'deskMonth');
    expect(d.deskMonth).toBe('50');
    expect(sourceOf(d, own, 'deskMonth')).toBe('account');
    const r = parseDraft(d, own);
    expect(r.ok && r.change?.policy?.deskMonth).toBeNull();
    expect(r.ok && r.change?.policy && 'deskDay' in r.change.policy).toBe(false);
    // With nothing on the account, it's the default: $20.
    const noAccount = layered({ ...own, account: empty });
    const back = followAccount(draftFromView(noAccount), noAccount, 'deskMonth');
    expect(back.deskMonth).toBe('20');
    expect(sourceOf(back, noAccount, 'deskMonth')).toBe('default');
    // Typing again takes it back: it's this desk's own once more.
    expect(sourceOf(editDraft(back, 'deskMonth', '35'), noAccount, 'deskMonth')).toBe('own');
  });
  it('says where each value comes from: the account, the default, or this desk', () => {
    const v = layered({ policy: { ...DEFAULT_POLICY, deskDay: usdL(3) }, account: { ...empty, deskDay: usdL(3) } });
    const d = draftFromView(v);
    expect(sourceOf(d, v, 'deskDay')).toBe('account');
    expect(sourceOf(d, v, 'deskMonth')).toBe('default');
    expect(sourceOf(d, v, 'timeZone')).toBe('own');
    expect(sourceOf(editDraft(d, 'deskDay', '9'), v, 'deskDay')).toBe('own');
    expect(sourceOf(draftFromView(view()), view(), 'deskMonth')).toBeNull(); // an older desk says nothing
  });
  it('the zone: sent only when changed, in its own spelling, null to follow, and a bad one named before it goes', () => {
    const v = layered();
    expect(parseDraft(editDraft(draftFromView(v), 'timeZone', 'europe/paris'), v)).toEqual({ ok: true, change: { timeZone: 'Europe/Paris' } });
    expect(parseDraft(editDraft(draftFromView(v), 'timeZone', 'Etc/UTC'), v)).toEqual({ ok: true, change: { timeZone: 'UTC' } });
    for (const bad of ['', 'Mars/Olympus', 'Etc/GMT+5', '+05:00']) {
      const r = parseDraft(editDraft(draftFromView(v), 'timeZone', bad), v);
      expect(r.ok).toBe(false);
      expect(!r.ok && Object.keys(r.errors)).toEqual(['timeZone']);
    }
    const withAccount = layered({ account: { ...empty, timeZone: 'Asia/Tokyo' } });
    const d = followAccount(draftFromView(withAccount), withAccount, 'timeZone');
    expect(d.timeZone).toBe('Asia/Tokyo');
    expect(parseDraft(d, withAccount)).toEqual({ ok: true, change: { timeZone: null } });
  });
  it('the zone is set once from this browser, only where nothing sets one', () => {
    const unset = layered({ timeZone: null, desk: empty, account: empty });
    expect(needsZone(unset)).toBe(true);
    expect(needsZone(layered())).toBe(false);
    expect(needsZone(layered({ timeZone: 'Asia/Tokyo', desk: empty, account: { ...empty, timeZone: 'Asia/Tokyo' } }))).toBe(false);
    expect(needsZone(view({ timeZone: null }))).toBe(false); // a desk without layers isn't asked
    expect(canonicalZone('Etc/UTC')).toBe('UTC');
    expect(canonicalZone('america/new_york')).toBe('America/New_York');
    expect(browserZone()).toBe(canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  });
  it('resets read in the desk\'s zone, naming it where it isn\'t this browser\'s', () => {
    const v = layered({ timeZone: 'America/Denver' });
    const dec1 = Date.UTC(2026, 11, 1, 7); // midnight on 1 Dec in Denver
    expect(resetText('agent_day', dec1, v, 'America/Denver')).toBe('Resets at midnight');
    expect(resetText('agent_week', dec1, v, 'America/Denver')).toBe('Resets Monday');
    expect(resetText('desk_month', dec1, v, 'America/Denver')).toBe('Resets Dec 1');
    expect(resetText('desk_day', dec1, v, 'Europe/Paris')).toBe('Resets at midnight (America/Denver)');
    expect(resetText('desk_day', dec1, layered({ timeZone: null }), 'UTC')).toBe('Resets at midnight');
    expect(resetText('run', null, v)).toBeNull();
  });
  it('prices: the table\'s date as words', () => {
    expect(pricesDate('2026-11-06')).toBe('Nov 6, 2026');
    expect(pricesDate('soon')).toBe('soon');
  });
});
