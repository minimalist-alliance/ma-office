// The guild settings sheet (task 48), its own lazy chunk: members' agent limits on the Guild Desk, for the Founder and an Officer
// with `manage_agents`, and agent usage per member, for the Founder and Officers. Both come from the Guild Desk itself over its
// link (`guild.settings.*`, `guild.usage.get`, contract 3.3): Platform never sees either. Usage is runs and dollars by name,
// never what anyone asked. deskd checks every call; this only hides what it would refuse.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { mutate } from '../browser/mutate';
import { Icon } from '../chrome/icons';
import { linkOf, useLive, wakeDesk } from '../desk/liveStore';
import { useDeskStore } from '../state/deskStore';
import { getGuildPeople, type GuildAgentLimits, type GuildUsage } from './api';
import { closeGuildSheet, openGuildSheet, setGuildCaps, useGuildStore, type GuildSheetView } from './guildStore';
import { useEscape } from './useEscape';
import { AGENT_TOOLS_LIVE, DEFAULT_LIMITS, guildPanelId, limitProblem, limitsOf, limitsPatch, mayManageAgents, maySeeUsage, MEMBER_KEYS_LIVE, runs, share, TOOL_LABELS, usd, zoneName } from './panel';

const DIDNT_SAVE = "That didn't save. Try again in a moment.";
const DIDNT_LOAD = "That didn't load. Try again in a moment.";

/** deskd's ranges (API.md section 14): dollars to 100,000, runs a day to 10,000, runs at once 1 to 8. Empty is no cap, but for runs at once. */
type Field = { group: 'perMember' | 'perGuild'; key: string; label: string; kind: 'usd' | 'count'; max: number; nullable: boolean; hint?: string };
const FIELDS: Field[] = [
  { group: 'perMember', key: 'runsPerDay', label: 'Runs a day', kind: 'count', max: 10_000, nullable: true },
  { group: 'perMember', key: 'usdPerDay', label: 'Dollars a day', kind: 'usd', max: 100_000, nullable: true },
  { group: 'perMember', key: 'usdPerMonth', label: 'Dollars a month', kind: 'usd', max: 100_000, nullable: true },
  { group: 'perGuild', key: 'usdPerMonth', label: 'Dollars a month, the whole guild', kind: 'usd', max: 100_000, nullable: true },
  { group: 'perGuild', key: 'runsAtOnce', label: 'Runs at once', kind: 'count', max: 8, nullable: false, hint: 'Others wait their turn, fairly by member.' },
];

const fieldId = (f: Field): string => `gs-${f.group}-${f.key}`;
const asText = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '');

function useGuildRole(guildId: string): { role: ReturnType<typeof roleOf>['role']; grants: string[] } {
  const info = useDeskStore((s) => s.desks.find((d) => d.id === guildPanelId(guildId))?.guild);
  const hello = useGuildStore((s) => s.hello[guildId]);
  return roleOf(hello ?? info);
}
function roleOf(r: { role?: 'lead' | 'officer' | 'member'; grants?: string[] } | undefined) {
  return { role: r?.role ?? null, grants: r?.grants ?? [] };
}

/** Needs the Guild Desk awake and connected: it holds the limits and the counts. Waking it is the member's press. */
function NeedsDesk({ guildId }: { guildId: string }) {
  const vm = useDeskStore((s) => s.desks.find((d) => d.id === guildPanelId(guildId))?.vm);
  const asleep = vm === 'stopped';
  return (
    <div className="guild-sheet-empty" role="status" data-testid="guild-sheet-waiting">
      <p>{asleep ? 'The Guild Desk is asleep. It keeps these, so they show once it wakes.' : 'Connecting to the Guild Desk…'}</p>
      {asleep && (
        <button type="button" className="btn" onClick={() => wakeDesk(guildPanelId(guildId))}>
          Wake
        </button>
      )}
    </div>
  );
}

/** The guild's agent limits, also the Agent window's "Guild limits" on a Guild Desk (`agent/AgentBody.tsx`). */
export function GuildLimitsPanel({ guildId }: { guildId: string }) {
  return <LimitsView guildId={guildId} />;
}

function LimitsView({ guildId }: { guildId: string }) {
  const [saved, setSaved] = useState<GuildAgentLimits | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tools, setTools] = useState<GuildAgentLimits['tools']>(DEFAULT_LIMITS.tools);
  const [ownKeys, setOwnKeys] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'saving'>('loading');
  const [line, setLine] = useState<string | null>(null);
  const live = useLive(guildPanelId(guildId));
  const open = live.link === 'open';

  const take = useCallback((agents: GuildAgentLimits) => {
    setSaved(agents);
    setGuildCaps(guildId, agents.perMember);
    setDraft(Object.fromEntries(FIELDS.map((f) => [fieldId(f), asText((agents[f.group] as Record<string, number>)[f.key])])));
    setTools({ ...DEFAULT_LIMITS.tools, ...agents.tools });
    setOwnKeys(agents.ownKeys === true);
  }, [guildId]);

  const load = useCallback(() => {
    const link = linkOf(guildPanelId(guildId));
    if (!link) return;
    setState('loading');
    link.call('guild.settings.get').then(
      (s) => {
        take(limitsOf(s));
        setState('ready');
      },
      () => setState('failed'),
    );
  }, [guildId, take]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return <NeedsDesk guildId={guildId} />;
  if (state === 'loading' && !saved) return <div className="guild-sheet-empty" role="status"><p>Loading…</p></div>;
  if (state === 'failed' && !saved) {
    return (
      <div className="guild-sheet-empty" role="status">
        <p>{DIDNT_LOAD}</p>
        <button type="button" className="btn" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!saved) return null;

  const problems = Object.fromEntries(FIELDS.map((f) => [fieldId(f), limitProblem(draft[fieldId(f)] ?? '', f.kind, f.max, f.nullable)]));
  const valid = Object.values(problems).every((p) => p === null);
  const next: GuildAgentLimits = valid
    ? {
        perMember: { ...saved.perMember, ...numbers('perMember', draft) },
        perGuild: { ...saved.perGuild, ...numbers('perGuild', draft) },
        tools,
        ownKeys,
      }
    : saved;
  const patch = valid ? limitsPatch(saved, next) : null;

  const save = (): void => {
    const link = linkOf(guildPanelId(guildId));
    if (!link || !patch) return;
    setState('saving');
    setLine(null);
    // The whole object, as deskd takes it: every field, with what the member changed.
    mutate((idem) => link.call('guild.settings.set', { agents: next }, { idem })).then(
      (s) => {
        take(limitsOf(s));
        setState('ready');
        setLine('Saved.');
        // Save goes quiet once there's nothing left to save, and a disabled button lets go of focus: keep it in the sheet.
        window.setTimeout(() => {
          if (document.activeElement === document.body) document.querySelector<HTMLElement>('.guild-modal.guild-sheet')?.focus({ preventScroll: true });
        }, 0);
      },
      (err: unknown) => {
        setState('ready');
        setLine((err as { code?: string } | null)?.code === 'forbidden' ? "You can't change these any more." : DIDNT_SAVE);
      },
    );
  };

  const group = (g: 'perMember' | 'perGuild', title: string, note: string): ReactNode => (
    <fieldset className="guild-fields">
      <legend>{title}</legend>
      <p className="guild-quiet-note">{note}</p>
      {FIELDS.filter((f) => f.group === g).map((f) => {
        const id = fieldId(f);
        const problem = draft[id] !== asText((saved[f.group] as Record<string, number>)[f.key]) ? problems[id] : null;
        return (
          <label key={id} className="guild-field" htmlFor={id}>
            <span className="guild-field-label">{f.label}</span>
            <span className="guild-field-input">
              {f.kind === 'usd' && <span aria-hidden="true">$</span>}
              <input
                id={id}
                inputMode={f.kind === 'usd' ? 'decimal' : 'numeric'}
                value={draft[id] ?? ''}
                placeholder={f.nullable ? 'No limit' : undefined}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${id}-problem` : undefined}
                onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
                data-testid={id}
              />
            </span>
            {problem ? (
              <span id={`${id}-problem`} className="guild-field-problem">{problem}</span>
            ) : (
              f.hint && <span className="guild-field-hint">{f.hint}</span>
            )}
          </label>
        );
      })}
    </fieldset>
  );

  return (
    <form
      className="guild-limits"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {group('perMember', 'Each member', "A member's agent pauses at whichever comes first, and starts again the next day or month.")}
      {group('perGuild', 'The whole guild', "On the guild's key, shared by everyone.")}
      {(AGENT_TOOLS_LIVE || MEMBER_KEYS_LIVE) && (
        <fieldset className="guild-fields">
          <legend>What agents may do</legend>
          {AGENT_TOOLS_LIVE &&
            (Object.keys(TOOL_LABELS) as (keyof GuildAgentLimits['tools'])[]).map((k) => (
              <label key={k} className="switch-row" htmlFor={`gs-tool-${k}`}>
                <span className="switch-text">{TOOL_LABELS[k]}</span>
                <input id={`gs-tool-${k}`} type="checkbox" role="switch" checked={tools[k]} onChange={(e) => setTools({ ...tools, [k]: e.target.checked })} data-testid={`gs-tool-${k}`} />
                <span className="switch" aria-hidden="true" />
              </label>
            ))}
          {MEMBER_KEYS_LIVE && (
            <label className="switch-row" htmlFor="gs-own-keys">
              <span className="switch-text">
                Members may use their own key
                <small>Their key stays on the Guild Desk, in memory only. Nobody else sees it.</small>
              </span>
              <input id="gs-own-keys" type="checkbox" role="switch" checked={ownKeys} onChange={(e) => setOwnKeys(e.target.checked)} data-testid="gs-own-keys" />
              <span className="switch" aria-hidden="true" />
            </label>
          )}
        </fieldset>
      )}
      <div className="guild-sheet-foot">
        {line && <span className="guild-sheet-line" role="status" data-testid="guild-limits-line">{line}</span>}
        <button type="submit" className="btn primary" disabled={!patch || state === 'saving'} data-testid="guild-limits-save">
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function numbers(group: 'perMember' | 'perGuild', draft: Record<string, string>): Record<string, number | null> {
  return Object.fromEntries(FIELDS.filter((f) => f.group === group).map((f) => {
    const t = (draft[fieldId(f)] ?? '').trim();
    return [f.key, t === '' && f.nullable ? null : Number(t)];
  }));
}

function UsageView({ guildId, canReadLimits }: { guildId: string; canReadLimits: boolean }) {
  const [usage, setUsage] = useState<GuildUsage | null>(null);
  // deskd counts by `memberId` only; names come from identity's roster of the guild.
  const [names, setNames] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useLive(guildPanelId(guildId));
  const open = live.link === 'open';

  const load = useCallback(() => {
    const link = linkOf(guildPanelId(guildId));
    if (!link) return;
    setFailed(false);
    link.call('guild.usage.get').then(setUsage, () => setFailed(true));
    getGuildPeople(guildId).then(
      (r) => setNames(Object.fromEntries((r.data?.people ?? []).filter((p) => p && typeof p.name === 'string').map((p) => [p.memberId, p.name]))),
      () => setNames({}),
    );
    // The bar beside each member's month needs the limit, which only those who can read the limits get.
    if (canReadLimits) link.call('guild.settings.get').then((s) => setLimit(limitsOf(s).perMember.usdPerMonth ?? null), () => setLimit(null));
  }, [guildId, canReadLimits]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return <NeedsDesk guildId={guildId} />;
  if (failed && !usage) {
    return (
      <div className="guild-sheet-empty" role="status">
        <p>{DIDNT_LOAD}</p>
        <button type="button" className="btn" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!usage) return <div className="guild-sheet-empty" role="status"><p>Loading…</p></div>;
  const nameOf = (r: GuildUsage['members'][number]): string => r.name ?? names[r.memberId] ?? 'A member';
  const rows = [...(Array.isArray(usage.members) ? usage.members : [])].sort((a, b) => (b.month?.usd ?? 0) - (a.month?.usd ?? 0) || nameOf(a).localeCompare(nameOf(b)));
  const total = usage.guild?.month ?? { runs: rows.reduce((n, r) => n + (r.month?.runs ?? 0), 0), usd: rows.reduce((n, r) => n + (r.month?.usd ?? 0), 0) };
  const today = usage.guild?.today ?? { runs: rows.reduce((n, r) => n + (r.today?.runs ?? 0), 0), usd: rows.reduce((n, r) => n + (r.today?.usd ?? 0), 0) };
  return (
    <div className="guild-usage">
      <div className="guild-usage-totals">
        <div>
          <span className="guild-usage-k">Today</span>
          <span className="guild-usage-v">{usd(today.usd)}</span>
          <span className="guild-usage-s">{runs(today.runs)}</span>
        </div>
        <div>
          <span className="guild-usage-k">This month</span>
          <span className="guild-usage-v">{usd(total.usd)}</span>
          <span className="guild-usage-s">{runs(total.runs)}</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="guild-quiet-note">Nobody's agent has run here yet.</p>
      ) : (
        <table className="guild-usage-table" data-testid="guild-usage-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Today</th>
              <th scope="col">This month</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const part = limit ? share(r.month?.usd ?? 0, limit) : 0;
              return (
                <tr key={r.memberId}>
                  <th scope="row">{nameOf(r)}</th>
                  <td>
                    {usd(r.today?.usd ?? 0)} <span className="guild-usage-s">· {runs(r.today?.runs ?? 0)}</span>
                  </td>
                  <td>
                    <span className="guild-usage-month">
                      {usd(r.month?.usd ?? 0)} <span className="guild-usage-s">· {runs(r.month?.runs ?? 0)}</span>
                    </span>
                    {limit !== null && (
                      <span className="guild-usage-bar" aria-hidden="true">
                        <span style={{ width: `${Math.round(part * 100)}%` }} className={part >= 1 ? 'full' : undefined} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="guild-quiet-note">Counts only. Nobody sees what a member asked their agent.{usage.timeZone ? ` Days start at midnight, ${zoneName(usage.timeZone)}.` : ''}</p>
    </div>
  );
}

export default function GuildSheet({ guildId, view }: { guildId: string; view: GuildSheetView }) {
  const name = useDeskStore((s) => s.desks.find((d) => d.id === guildPanelId(guildId))?.name) ?? 'Guild';
  const { role, grants } = useGuildRole(guildId);
  const canLimits = mayManageAgents(role, grants);
  const canUsage = maySeeUsage(role);
  const shown: GuildSheetView | null = view === 'limits' && canLimits ? 'limits' : view === 'usage' && canUsage ? 'usage' : canLimits ? 'limits' : canUsage ? 'usage' : null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  useEscape(closeGuildSheet);
  useEffect(() => {
    if (!shown) closeGuildSheet(); // a role that changed while it was open
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="guild-modal-away" onClick={closeGuildSheet}>
      <div
        ref={ref}
        tabIndex={-1}
        className="guild-modal guild-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guild-sheet-title"
        data-testid="guild-sheet"
        data-view={shown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="guild-sheet-head">
          <h2 id="guild-sheet-title">
            <span className="guild-sheet-guild">{name}</span>
            <span>{shown === 'limits' ? 'Guild limits' : 'Agent usage'}</span>
          </h2>
          <button type="button" className="icon-btn sm" aria-label="Close" title="Close" onClick={closeGuildSheet}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {canLimits && canUsage && (
          <div className="guild-tabs" role="tablist" aria-label="Agents">
            {(['limits', 'usage'] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={shown === v} className={`guild-tab${shown === v ? ' on' : ''}`} onClick={() => openGuildSheet(guildId, v)} data-testid={`guild-tab-${v}`}>
                {v === 'limits' ? 'Guild limits' : 'Agent usage'}
              </button>
            ))}
          </div>
        )}
        <div className="guild-sheet-body">{shown === 'limits' ? <LimitsView guildId={guildId} /> : <UsageView guildId={guildId} canReadLimits={canLimits} />}</div>
      </div>
    </div>
  );
}
