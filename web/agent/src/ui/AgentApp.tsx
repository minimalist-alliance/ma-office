// The Agent app: what goes inside the Desk's Agent window (design 9.1). Left, the desk's agents with their
// badges, status and usage; middle, the thread and composer, or the key screen for an agent with no key; right,
// a drawer with Usage, Keys and Activity. It talks to the desk only through `client`.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentAccess, AgentCaps, KeyMeta, LimitScope, Provider } from '../client/types';
import { AgentMark } from '../look/AgentMark';
import { colorFor } from '../look/hat';
import type { LookTheme } from '../look/tones';
import { attachErrorText, BUSY_WITH_FILES, desksKeepsFiles } from '../model/attachments';
import { onFreeModels } from '../connect/openrouter';
import { badgeDismissable, badgeShown, defaultModel, errorText, isFreeLimit, keysLast, limitBannerText, pausedText, statusWord } from '../model/agents';
import { approvalOpen, arrivedText, cardOf, countLabel, withApprovals } from '../model/approvals';
import { autoRowsOf, isAuto, mayOfferDontAsk, type NotebookTab } from '../model/auto';
import { streaming } from '../model/conversation';
import { when } from '../model/format';
import { browserZone, guildHeadline, headlineRow, needsZone, refusalText, type GuildCaps } from '../model/limits';
import { ActivityPanel, noteZoneSet } from './Activity';
import { AgentMessagesPanel } from './AgentMessages';
import type { ApprovalContext } from './Approvals';
import { Meter, ProviderBadge, StatusWord, Switch } from './bits';
import { UnsavedContext, useAgents, useCalmRetry, useKeys, useLimits, useLookTheme, useMaskUrl, useRead, useThread, useUnsaved } from './hooks';
import { Icon } from './icons';
import { GuildKeyPanel, KeySetup, KeysPanel, type KeyWords } from './Keys';
import { LimitsPanel } from './Limits';
import { MemoryPanel } from './Memory';
import type { ProposalContext } from './Proposals';
import { RunningStrip, useRunningTools } from './Running';
import { isLeadAgent, SettingsPanel } from './Settings';
import { SetupScreen, type AccessPlaces } from './Setup';
import { waitingLine, type OtherDesk } from '../model/access';
import { isWaitingDesk, WAITING_DESK } from '../model/deskMessages';
import { DeskOfferCards } from './DeskOffers';
import { Composer, ThreadView, type SendResult } from './Thread';

export interface AgentAppProps {
  client: AgentClient;
  /** For "on the Personal desk only". */
  deskName: string;
  /** The global badge preference, which the Desk app keeps in the layout doc (design 9.4). */
  showBadges: boolean;
  onShowBadgesChange: (show: boolean) => void;
  /** The desk can't be reached just now. What's typed stays and nothing goes, until it can. */
  offline?: boolean;
  /** The window can't be seen. Nothing counts as seen, and what arrives waits. */
  parked?: boolean;
  /** Suggestion chips over the composer. A desk shows none until tools make them real. */
  suggestions?: readonly string[];
  /** Whether "New agent" shows. The desk's cap says when it's full (task 49). */
  canAddAgents?: boolean;
  /**
   * This window is one agent's own app (task 49 item 6): its thread and its settings, with no rail. The lead's window, the
   * Desk's `agent` tile, passes nothing and has the whole team.
   */
  focusAgentId?: string | null;
  /** The theme marks are drawn for. Unset: `<html data-theme>`. */
  theme?: LookTheme;
  /** Opens an agent's own window, where the host has one per agent (the Desk), and says whether it did. Otherwise it's shown here. */
  onOpenAgent?: (agentId: string) => boolean;
  /**
   * Whether anything here would be lost if the page went now: a draft with text, a settings form with changes. Told only when
   * it changes, and `false` as the app goes. The Desk holds its close guard on it (`shell/closeGuard.ts`).
   */
  onUnsaved?: (unsaved: boolean) => void;
  /**
   * A Guild Desk (the Desk app's task 48): the member's own agent seat on the guild's shared desk. Nobody gets the Keys tab or
   * this desk's limits form there; the Founder and an Officer with `manage_agents` get "Guild limits" (the guild's key and the
   * guild's limits) with Activity, everyone else neither. See `GuildMode`.
   */
  guild?: GuildMode | null;
  /** This desk's id, so a free-models Connect resumes only on the desk it started on. Unset: `deskName`. */
  deskId?: string;
  /**
   * Whether this member may be offered free models through OpenRouter (agent-free-key spec §8): never a teen. A teen never has
   * the Agent at all, so this is the second lock. Never offered on a Guild Desk either, whatever this says.
   */
  offerFree?: boolean;
  /**
   * The member's other desks an agent here may be let message (draft ADR section 14): never this one or a Guild Desk. The setup
   * screen and the settings show the "Other desks" section only when there's one. Unset: none.
   */
  otherDesks?: readonly OtherDesk[];
  /** Where a "without asking" switch's additions go: the office's Notebook tabs and Files. Unset: those two switches stay off. */
  places?: AccessPlaces | null;
  /**
   * A question handed over from elsewhere in the host (the office's Documents: "Ask Lead about this"): words and files that wait
   * in that agent's composer for the member to finish and send, never sent by themselves. A new `seq` is a new one.
   */
  handoff?: { agentId: string; text: string; files: readonly File[]; seq: number } | null;
  /** The handoff with this `seq` is in its composer now. */
  onHandoff?: (seq: number) => void;
}

/** What the Agent app says and shows on a Guild Desk. */
export interface GuildMode {
  /** The guild's limits panel, given only to the Founder and an Officer with `manage_agents`; null for everyone else. */
  limits: ReactNode | null;
  /** A member's agent waiting on a guild that hasn't added its key: whose key, and who can add it. */
  noKey: string;
  /** The same, where the guild's key was here and went (the Guild Desk slept or restarted). */
  keyLost: string;
  /** The key screen, for those who add the guild's key: the first time, and again after the desk lost it. */
  addKey?: KeyWords;
  addKeyAgain?: KeyWords;
  /** The key screen's line on how long the guild's key stays, shown whatever the desk says of keys. */
  restartLine?: string;
  /** The guild's caps on this member's agent, for the sidebar's meter. Undefined until the Guild Desk says. */
  caps?: GuildCaps | null;
  /** Goes up each time the member asks for the guild's limits from outside this app (the window's line): opens the drawer. */
  openLimits?: number;
}

/** The first reads failed, and what that means. Anything but a final no is worth asking again, calmly. */
type Reach = 'ok' | 'down' | 'absent' | 'forbidden';
function reachOf(err: unknown): Reach {
  const { code, name } = (err ?? {}) as { code?: unknown; name?: unknown };
  if (name === 'DeskNotConnected') return 'ok'; // the link's to say, and a new session reads again
  if (code === 'not_found') return 'absent';
  return code === 'forbidden' ? 'forbidden' : 'down';
}

function TeamState({ reach }: { reach: Exclude<Reach, 'ok'> }) {
  return (
    <div className="ag-app ag-state" role="status" data-testid="agent-state" data-state={reach}>
      {reach === 'down' && (
        <>
          <h3>Your desk team isn’t running right now</h3>
          <p className="ag-muted">It comes back on its own.</p>
        </>
      )}
      {reach === 'absent' && (
        <>
          <h3>This desk’s Agent isn’t ready yet</h3>
          <p className="ag-muted">It arrives with an update to the desk.</p>
        </>
      )}
      {reach === 'forbidden' && <h3>This session can’t view the desk’s Agent</h3>}
    </div>
  );
}

/** A send whose answer never came may have gone through, so a second press of the same words keeps its `idem`. */
function mayHaveGone(err: unknown): boolean {
  return err instanceof AgentError ? err.mayHaveApplied : (err as { inFlight?: unknown } | null)?.inFlight === true;
}

type Tab = 'settings' | 'memory' | 'usage' | 'keys' | 'activity' | 'messages';
const TABS: { id: Tab; label: string; title: string; icon: 'gear' | 'bookmark' | 'meter' | 'key' | 'list' | 'messages' }[] = [
  { id: 'settings', label: 'Settings', title: 'Settings', icon: 'gear' },
  // S-14: what the agent remembers, its own tab (spec 3.1). The title names the agent where it's shown (`tabTitle`).
  { id: 'memory', label: 'Memory', title: 'What {name} remembers', icon: 'bookmark' },
  { id: 'usage', label: 'Usage', title: 'Usage', icon: 'meter' },
  { id: 'keys', label: 'Keys', title: 'Keys', icon: 'key' },
  { id: 'activity', label: 'Activity', title: 'Activity', icon: 'list' },
  { id: 'messages', label: 'Messages', title: 'Agent messages', icon: 'messages' },
];

const tabTitle = (t: { title: string }, name: string): string => t.title.replace('{name}', name);
/** A tab's name holds the word it shows (WCAG 2.5.3, label in name): its title where that does, else its label. */
const tabName = (t: { title: string; label: string }, name: string): string => {
  const title = tabTitle(t, name);
  return title.toLowerCase().includes(t.label.toLowerCase()) ? title : t.label;
};

/** An agent's mark, its uploaded picture included. Decorative beside its name. */
function Mark({ client, agent, theme, size }: { client: AgentClient; agent: Agent; theme: LookTheme; size: number }) {
  const pngUrl = useMaskUrl(client, agent);
  const look = agent.look ?? { icon: 'hat', tone: 'graphite', png: null };
  // The lead wears the Agent app's own icon and accent, whatever is stored (its look isn't the member's to change, ADR 0047).
  const lead = isLeadAgent(agent);
  return <AgentMark icon={lead ? 'hat' : look.icon} color={colorFor(agent)} tone={look.tone} theme={theme} pngUrl={lead ? null : pngUrl} size={size} />;
}

type Notice = { kind: 'limit'; scope: LimitScope | null } | { kind: 'error'; text: string } | null;

const NO_DESKS: readonly OtherDesk[] = [];
const without = (record: Record<string, string>, key: string): Record<string, string> => {
  const out = { ...record };
  delete out[key];
  return out;
};

function AddAgent({ client, keys, onAdded, onCancel }: { client: AgentClient; keys: KeyMeta[]; onAdded: (a: Agent) => void; onCancel: () => void }) {
  // `caps` decides whether this shows at all; a desk that's full by the time it answers says so here.
  const [name, setName] = useState('');
  const [keyId, setKeyId] = useState(keys[0]?.keyId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsaved(name.trim() !== '');
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A key goes with a model, as the desk takes them: `agent.key.models`'s good default, listed first (API.md section 11;
      // `defaultModel` passes over an unpriced one). Settings change it later. With none listed, the agent is made with no
      // key, and its key screen asks.
      const model = keyId ? defaultModel(await client.listModels(keyId))?.id : undefined;
      const a = await client.createAgent({ name: name.trim() || 'Assistant', ...(keyId && model ? { keyId, model } : {}) }, { idem: newIdem() });
      onAdded(a);
    } catch (err) {
      setError(err instanceof AgentError && err.detail === 'name' && !err.reason ? 'A name is 1 to 24 characters.' : err instanceof AgentError ? errorText(err.reason, err.detail) : errorText(null));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ag-add" onSubmit={(e) => void submit(e)} data-testid="add-agent-form">
      <label className="ag-field" htmlFor="ag-new-name">
        <span>Name</span>
        <input id="ag-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Researcher" maxLength={24} autoComplete="off" autoFocus disabled={busy} data-testid="new-agent-name" />
      </label>
      <label className="ag-field" htmlFor="ag-new-key">
        <span>Key</span>
        <select id="ag-new-key" value={keyId} onChange={(e) => setKeyId(e.target.value)} disabled={busy}>
          {keys.map((k) => (
            <option key={k.keyId} value={k.keyId}>
              {k.label} · {k.providerName}
            </option>
          ))}
          <option value="">No key yet</option>
        </select>
      </label>
      {error && <p className="ag-error" role="alert">{error}</p>}
      <div className="ag-row-end">
        <button type="button" className="ag-text-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="ag-btn primary sm" disabled={busy} data-testid="new-agent-submit">
          Add agent
        </button>
      </div>
      <p className="ag-muted ag-small">It starts solo, with a look of its own. What it can use comes next. Or ask the lead to set one up.</p>
    </form>
  );
}

/** "New agent", and why not when the desk is full. */
function NewAgent({ caps, count, adding, onToggle }: { caps: AgentCaps | null; count: number; adding: boolean; onToggle: () => void }) {
  const ids = useId();
  const full = caps !== null && count >= caps.agentCap;
  return (
    <>
      <button
        type="button"
        className="ag-btn sm ag-new-agent"
        onClick={onToggle}
        aria-expanded={adding}
        disabled={full}
        aria-describedby={full ? `${ids}-full` : undefined}
        data-testid="new-agent"
      >
        <Icon name="plus" size={14} /> New agent
      </button>
      {full && (
        <p id={`${ids}-full`} className="ag-muted ag-small ag-cap-note" data-testid="agent-cap-note">
          This desk has {caps.agentCap} agents, the most it can hold. Delete one to add another.
        </p>
      )}
    </>
  );
}

export function AgentApp({ client, deskName, showBadges, onShowBadgesChange, offline = false, parked = false, suggestions = [], canAddAgents = true, focusAgentId = null, theme: themeProp, onOpenAgent, onUnsaved, guild = null, deskId, offerFree = true, otherDesks = NO_DESKS, places = null, handoff = null, onHandoff }: AgentAppProps) {
  // On a Guild Desk: no Keys tab and no desk limits form for anyone; the guild's limits, and Activity, for those who set them.
  // Task 49's settings and agent messages are a member's own desk's: a Guild Desk's agent is one seat on the guild's key.
  // Memory is every member's own, on a Guild Desk too: their agent's lines are their data (spec 3.1).
  const tabs = guild
    ? guild.limits !== null
      ? TABS.filter((t) => t.id !== 'keys' && t.id !== 'settings' && t.id !== 'messages').map((t) => (t.id === 'usage' ? { ...t, label: 'Guild limits', title: 'Guild limits' } : t))
      : TABS.filter((t) => t.id === 'memory')
    : TABS;
  const mayChangeLimits = !guild || guild.limits !== null;
  const team = useAgents(client);
  // A desk's `approvalsPending` is the app's "needs you" (API.md section 18), wherever an agent's status shows.
  const agents = useMemo(() => team.value?.map(withApprovals) ?? null, [team.value]);
  const htmlTheme = useLookTheme();
  // Ids of this window's own: a desk can show several Agent windows at once (task 49).
  const uid = useId();
  const theme = themeProp ?? htmlTheme;
  const providers = useRead<Provider[]>(() => client.providers(), [client]);
  const keys = useKeys(client);
  // What isn't here yet, and why. desk-agent not running answers `unavailable`, and a calm retry and its own next event bring it back.
  const firstFailure = (agents === null && team.error) || (providers.value === null && providers.error) || (keys.value === null && keys.error) || null;
  const reach: Reach = firstFailure ? reachOf(firstFailure) : 'ok';
  const readAgain = (): void => {
    if (agents === null) team.reload();
    if (providers.value === null) providers.reload();
    if (keys.value === null) keys.reload();
  };
  useCalmRetry(reach === 'down' && !offline && !parked, readAgain);
  // desk-agent is back: every subscription gets a fresh snapshot, which is the news the reads were waiting for.
  useEffect(() => {
    if (agents !== null && reach !== 'ok') readAgain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  // Whether a key still works shows first in an agent's status, and only `agent.key.list` says more.
  const keysWord = agents?.map((a) => `${a.id}:${a.status}:${a.binding?.keyId}`).join() ?? null;
  const keysWordWas = useRef(keysWord);
  useEffect(() => {
    if (keysWordWas.current !== null && keysWord !== keysWordWas.current) keys.reload();
    keysWordWas.current = keysWord;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysWord]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  // "Guild limits" on the window's line opens the drawer here, for those who have it.
  const limitsAsked = guild?.openLimits ?? 0;
  const limitsAskedWas = useRef(limitsAsked);
  const mayOpenLimits = guild?.limits != null;
  useEffect(() => {
    if (limitsAsked === limitsAskedWas.current) return;
    limitsAskedWas.current = limitsAsked;
    if (mayOpenLimits) setTab('usage');
  }, [limitsAsked, mayOpenLimits]);
  const [railOpen, setRailOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [sending, setSending] = useState(false);
  const [announce, setAnnounce] = useState('');
  // The same words twice are still news: the status changes by a space so a screen reader says them again.
  const say = useCallback((text: string) => setAnnounce((cur) => (cur === text ? `${text}\u00a0` : text)), []);
  const running = useRunningTools(client);
  // The free limit's "Add a key": the Keys tab, opened afresh with its form open.
  const [keysAdd, setKeysAdd] = useState(0);
  const [addFresh, setAddFresh] = useState(false);
  useEffect(() => {
    if (addFresh) setAddFresh(false);
  }, [addFresh]);
  const openKeys = useCallback(() => setTab('keys'), []);
  const drafts = useRef(new Map<string, string>());
  // What's unsaved, by who holds it: the host hears only when the answer changes.
  const unsaved = useRef(new Set<string>());
  const tellHost = useRef(onUnsaved);
  useEffect(() => {
    tellHost.current = onUnsaved;
  }, [onUnsaved]);
  const reportUnsaved = useCallback((key: string, on: boolean): void => {
    const held = unsaved.current;
    const was = held.size > 0;
    if (on) held.add(key);
    else held.delete(key);
    if (was !== held.size > 0) tellHost.current?.(!was);
  }, []);
  useEffect(() => {
    const held = unsaved.current;
    const host = tellHost;
    return () => {
      if (held.size) host.current?.(false);
      held.clear();
    };
  }, []);
  const unsure = useRef<{ agentId: string; text: string; idem: string } | null>(null);
  // The setup screen (draft ADR section 16): its Back shows the thread with no composer, and a Save here closes it at once,
  // before the desk's own word (`setup: null`) comes on `agent.state`. Each by the reason it showed for, so a later one shows.
  const [setupBack, setSetupBack] = useState<Record<string, string>>({});
  const [setupDone, setSetupDone] = useState<Record<string, string>>({});

  const focused = focusAgentId !== null;
  const agent = useMemo(
    () => (focused ? (agents?.find((a) => a.id === focusAgentId) ?? null) : (agents?.find((a) => a.id === selectedId) ?? agents?.find((a) => isLeadAgent(a)) ?? agents?.[0] ?? null)),
    [agents, selectedId, focused, focusAgentId],
  );
  const agentId = agent?.id ?? null;
  const thread = useThread(client, agentId, parked);
  const live = streaming(thread);
  const waitingRun = live?.state === 'awaiting_approval';
  // "Don't ask again" (API.md section 18) needs the agent's switches, read only while one of its waiting cards could offer it,
  // and again when the drawer closes (its settings may have changed them). Never on a Guild Desk: nothing runs unasked there.
  const offerIds = guild ? '' : thread.approvals.filter((a) => mayOfferDontAsk(a)).map((a) => a.id).join();
  const [accessTick, setAccessTick] = useState(0);
  const access = useRead<{ agentId: string; access: AgentAccess } | null>(
    () => (agentId && offerIds ? client.getAccess(agentId).then((x) => ({ agentId, access: x })) : Promise.resolve(null)),
    [client, agentId, offerIds, accessTick],
  );
  // A drawer that closes may have changed the switches (Settings): read them again.
  const drawerOpen = tab !== null;
  const drawerWas = useRef(drawerOpen);
  useEffect(() => {
    if (drawerWas.current && !drawerOpen) setAccessTick((t) => t + 1);
    drawerWas.current = drawerOpen;
  }, [drawerOpen]);
  const setAccessValue = access.set;
  const onAccess = useCallback((id: string, next: AgentAccess) => setAccessValue({ agentId: id, access: next }), [setAccessValue]);
  // The Notebook's tabs by name, for a card's tab and the line under a reply, read once something here could name one.
  const wantsTabs =
    !!places &&
    (thread.approvals.some((a) => mayOfferDontAsk(a) === 'notebook') || thread.messages.some((m) => autoRowsOf(m).some((r) => r.group === 'notebook')));
  const [tabsAsked, setTabsAsked] = useState(false);
  useEffect(() => {
    if (wantsTabs) setTabsAsked(true);
  }, [wantsTabs]);
  const notebookTabs = useRead<NotebookTab[] | null>(() => (places && tabsAsked ? places.notebookTabs() : Promise.resolve(null)), [places, tabsAsked, accessTick]);
  const approvalCtx = useMemo<ApprovalContext | null>(
    () => (agents ? { client, agents, offline, announce: say, access: access.value, tabs: notebookTabs.value, onAccess, desks: otherDesks } : null),
    [client, agents, offline, say, access.value, notebookTabs.value, onAccess, otherDesks],
  );
  // A card that arrives while the thread is open is announced, never focused (spec 1.8). Those already there when it opened aren't news.
  const knownCards = useRef<{ agentId: string | null; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!thread.loaded || !agent) return;
    const pending = thread.approvals.filter((a) => approvalOpen(a, Date.now()) && !isAuto(a));
    const known = knownCards.current;
    if (!known || known.agentId !== agent.id) {
      knownCards.current = { agentId: agent.id, ids: new Set(thread.approvals.map((a) => a.id)) };
      return;
    }
    for (const a of pending) {
      if (known.ids.has(a.id)) continue;
      known.ids.add(a.id);
      say(arrivedText(agent.name, cardOf(a, agents ?? [], otherDesks).asked));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.approvals, thread.loaded, agent?.id]);
  // Limits change when a reply settles or a limit refuses: re-read on the agent's status and message count.
  const limits = useLimits(client, agentId, `${agent?.status}:${thread.messages.length}:${live ? 'live' : 'idle'}`);
  // Whether keys last here (ADR 0042): `agent.key.list`, or `agent.limits.get`'s `timeZone` while there are no keys yet.
  const keysStay = keysLast(keys.value, limits.value ?? (limits.error ? null : undefined));
  const [zoneNoted, setZoneNoted] = useState(0);
  // Today's free requests used (spec §4): the warn banner, from the newest reply's failure, until a reply works or a key is added.
  const lastReply = [...thread.messages].reverse().find((m) => m.role === 'assistant');
  const freeLimitId = lastReply && isFreeLimit(lastReply) ? lastReply.id : null;
  const keyCount = keys.value?.length ?? 0;
  const [limitKeys, setLimitKeys] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (freeLimitId && limitKeys?.id !== freeLimitId) setLimitKeys({ id: freeLimitId, n: keyCount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeLimitId]);
  const freeLimitShown = freeLimitId !== null && limitKeys?.id === freeLimitId && keyCount <= limitKeys.n && onFreeModels(agent?.binding);
  const activityVersion = `${thread.seq}:${agent?.status}:${keys.value?.length ?? 0}:${limits.value?.policy.runMaxSteps}:${zoneNoted}`;

  // Where neither the desk nor the account has a zone, days would run in UTC: set this browser's, once a client, with no question
  // (ADR 0043). A refusal or a failure leaves it as it was, and the next session asks again.
  const zoneAsked = useRef<AgentClient | null>(null);
  const shownAgent = useRef(agentId);
  useEffect(() => {
    shownAgent.current = agentId;
  }, [agentId]);
  useEffect(() => {
    const view = limits.value;
    if (!view || offline || zoneAsked.current === client || !needsZone(view)) return;
    zoneAsked.current = client;
    const zone = browserZone();
    if (!zone) return;
    client.setLimits(view.agentId, { timeZone: zone }, { idem: newIdem() }).then(
      (next) => {
        if (next.agentId === shownAgent.current) limits.set(next);
        // An older desk audits this as any change of limits (`limits.set`), so Activity would say "Changed limits", which the
        // member didn't do; a current one writes `limits.timezone`. Its row is the newest, written before the answer: Activity
        // names the zone on this page either way.
        client.listAudit({ limit: 5 }).then((page) => {
          const row = page.entries.find((e) => (e.action === 'limits.set' || e.action === 'limits.timezone') && e.actor === 'user' && e.target === `agent:${view.agentId}`);
          if (!row) return;
          noteZoneSet(row.hash, zone);
          setZoneNoted((n) => n + 1);
        }, () => undefined);
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, limits.value, offline]);

  // Seen while it's open.
  useEffect(() => {
    if (agent && agent.unseen > 0 && !parked && !offline) client.markSeen(agent.id).catch(() => undefined); // it asks again with the next change
  }, [client, agent, parked, offline]);

  // A refusal says which limit; once the status clears, so does the notice.
  useEffect(() => {
    if (notice?.kind === 'limit' && agent && agent.status !== 'limit_reached') setNotice(null);
  }, [agent, notice]);

  const lastLive = useRef<string | null>(null);
  useEffect(() => {
    if (live) lastLive.current = live.id;
    else if (lastLive.current && agent) {
      lastLive.current = null;
      setAnnounce(`${agent.name} replied.`);
    }
  }, [live, agent]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setNotice(null);
    setRailOpen(false);
  }, []);
  // A handoff (Documents' "Ask Lead"): that agent's thread, its words in the composer after anything already typed there, and its
  // files staged beside them. Taken once its agent is known here; the composer starts afresh to take the files.
  const [seed, setSeed] = useState<{ agentId: string; files: readonly File[]; seq: number } | null>(null);
  const tookHandoff = useRef(0);
  useEffect(() => {
    if (!handoff || handoff.seq === tookHandoff.current || !agents) return;
    const target = agents.find((a) => a.id === handoff.agentId);
    if (!target || (focused && target.id !== focusAgentId)) return;
    tookHandoff.current = handoff.seq;
    if (!focused) select(target.id);
    const had = (drafts.current.get(target.id) ?? '').trim();
    const text = had ? `${had}\n\n${handoff.text}` : handoff.text;
    drafts.current.set(target.id, text);
    reportUnsaved(`draft:${target.id}`, text.trim() !== '');
    setSeed({ agentId: target.id, files: handoff.files, seq: handoff.seq });
    onHandoff?.(handoff.seq);
  }, [handoff, agents, focused, focusAgentId, select, reportUnsaved, onHandoff]);
  // Where an agent opens: its own window where the host has one, else here.
  const openAgent = useCallback(
    (id: string) => {
      if (!onOpenAgent?.(id)) select(id);
    },
    [onOpenAgent, select],
  );
  const proposalCtx = useMemo<ProposalContext | null>(
    () => (agents && keys.value ? { client, agents, keys: keys.value, zone: limits.value?.timeZone ?? null, theme, onOpenAgent: openAgent } : null),
    [client, agents, keys.value, limits.value?.timeZone, theme, openAgent],
  );

  const send = async (text: string, attachments: string[]): Promise<SendResult> => {
    if (!agent) return { sent: false };
    setSending(true);
    setNotice(null);
    // The same words with the same files are the same action, so a retry after a lost answer keeps its key.
    const key = `${text}\u0000${attachments.join(',')}`;
    const idem = unsure.current?.agentId === agent.id && unsure.current.text === key ? unsure.current.idem : newIdem();
    try {
      await client.sendMessage(agent.id, text, { idem }, attachments);
      unsure.current = null;
      return { sent: true };
    } catch (err) {
      unsure.current = mayHaveGone(err) ? { agentId: agent.id, text: key, idem } : null;
      const files = err instanceof AgentError ? attachErrorText(err) : null;
      if (err instanceof AgentError && err.reason === 'limit_reached') setNotice({ kind: 'limit', scope: err.scope });
      else if (err instanceof AgentError && err.reason === 'agent_cap') setNotice({ kind: 'error', text: pausedText('agent_cap') });
      else if (files) setNotice({ kind: 'error', text: files });
      else if (err instanceof AgentError && err.reason === 'busy' && attachments.length) setNotice({ kind: 'error', text: BUSY_WITH_FILES });
      else setNotice({ kind: 'error', text: err instanceof AgentError ? errorText(err.reason, err.detail) : errorText(null) });
      // A busy desk or a missing key keeps the files staged for the next try. A refusal after the desk read them (an unreadable
      // file, a limit) has already deleted them, so they go from here too.
      return attachments.length && !desksKeepsFiles(err) ? { sent: false, lost: true } : { sent: false };
    } finally {
      setSending(false);
    }
  };

  const stop = (): void => {
    if (live?.runId) client.stopRun(live.runId, { idem: newIdem() }).catch(() => setNotice({ kind: 'error', text: errorText(null) }));
  };

  // Esc leaves the window, which would take with it whatever's typed in a field. With words there, it leaves them be.
  const keepTyped = (e: KeyboardEvent): void => {
    const field = e.target;
    if (e.key === 'Escape' && !e.shiftKey && (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && field.value) e.preventDefault();
  };

  const onDrawerKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setTab(null);
    }
  };

  if (reach !== 'ok') return <TeamState reach={reach} />;
  if (focused && agents && !agent) {
    return (
      <div className="ag-app ag-state" role="status" data-testid="agent-state" data-state="removed">
        <h3>This agent isn’t on the desk any more</h3>
        <p className="ag-muted">Its thread, workspace and timers went with it.</p>
      </div>
    );
  }
  if (!agents || !providers.value || !keys.value || !agent) {
    return (
      <div className="ag-app ag-loading" data-testid="agent-app">
        <p className="ag-muted">{guild ? 'Opening your agent…' : 'Opening the desk team…'}</p>
      </div>
    );
  }

  const show = badgeShown(agent, showBadges);
  // On a Guild Desk the meter is against the guild's caps on each member, not this desk's own agent limits.
  const head = guild?.caps ? guildHeadline(limits.value, guild.caps) : guild ? null : limits.value ? headlineRow(limits.value) : null;
  const teamName = guild ? 'Your agent' : 'Desk team';
  const isLead = isLeadAgent(agent);
  // Why its setup screen shows (section 16), or null: a Save here counts until the desk says otherwise.
  const setupReason = agent.setup && setupDone[agent.id] !== agent.setup ? agent.setup : null;
  const caps = team.caps;
  const free = onFreeModels(agent.binding);
  const freeKey = free ? (keys.value.find((k) => k.keyId === agent.binding?.keyId)?.free ?? null) : null;
  const offered = offerFree && !guild;
  const desk = deskId ?? deskName;

  return (
    <UnsavedContext.Provider value={reportUnsaved}>
    <div className="ag-app" data-testid="agent-app" data-focus={focused ? agent.id : undefined} onKeyDown={keepTyped}>
      <div className={`ag-shell${tab ? ' drawer-open' : ''}${railOpen ? ' rail-open' : ''}${focused ? ' focused' : ''}`}>
      {!focused && (
      <aside className="ag-rail" aria-label={teamName}>
        <div className="ag-side-head">
          <h3>{teamName}</h3>
          {canAddAgents && <NewAgent caps={caps} count={agents.length} adding={adding} onToggle={() => setAdding((v) => !v)} />}
        </div>
        {adding && (
          <AddAgent
            client={client}
            keys={keys.value}
            onCancel={() => setAdding(false)}
            onAdded={(a) => {
              setAdding(false);
              select(a.id);
              // With a key, its setup screen comes next, where the thread will be; with none, the key screen first.
              if (!a.binding) setTab('settings');
            }}
          />
        )}
        <ul className="ag-list" role="tablist" aria-label="Switch agent" aria-orientation="vertical">
          {agents.map((a) => (
            // The tabs are the tablist's own children to assistive tech; the list items only lay them out.
            <li key={a.id} role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={a.id === agent.id}
                aria-controls={`${uid}main`}
                className={`ag-agent-btn${a.id === agent.id ? ' on' : ''}`}
                onClick={() => select(a.id)}
                data-testid={`agent-${a.id}`}
              >
                <Mark client={client} agent={a} theme={theme} size={34} />
                <span className="ag-agent-text">
                  <span className="ag-agent-name">{a.name}</span>
                  <StatusWord agent={a} />
                </span>
                {badgeShown(a, showBadges) && a.binding && <ProviderBadge badge={a.binding} compact />}
                {(() => {
                  // Waiting cards count even on the agent being read; its unseen replies don't (spec 1.5), nor what a run the
                  // member didn't start did without asking (`autoUnseen`, draft ADR section 15), which counts until it's seen.
                  const waiting = a.approvalsPending ?? 0;
                  const unseen = a.id !== agent.id ? a.unseen : 0;
                  const unasked = a.id !== agent.id ? (a.autoUnseen ?? 0) : 0;
                  return waiting + unseen + unasked > 0 ? (
                    <span className="ag-count" aria-label={waiting || unasked ? countLabel(waiting, unseen, unasked) : `${unseen} new`} data-testid="agent-count">
                      {waiting + unseen + unasked}
                    </span>
                  ) : null;
                })()}
              </button>
            </li>
          ))}
        </ul>
        <div className="ag-usage-card" data-testid="usage-card">
          {head ? (
            <>
              <div className="ag-usage-head">
                <span>{head.label}</span>
                <b>{head.text}</b>
              </div>
              <Meter fraction={head.fraction ?? 0} level={head.level} label={`${agent.name}, ${head.label.toLowerCase()}: ${head.text}`} />
              <p className="ag-muted ag-small" data-testid="usage-line">
                {head.level === 'reached'
                  ? `${agent.name} is paused at this limit.`
                  : free
                    ? freeKey
                      ? `${freeKey.leftToday} of ${freeKey.perDay} free requests left today`
                      : 'Free models cost nothing here. OpenRouter limits how many requests a day.'
                    : guild
                      ? `${agent.name} stops at the guild's limit.`
                      : `${agent.name} stops at the limit you set.`}
              </p>
            </>
          ) : (
            <p className="ag-muted ag-small">{(guild ? guild.caps : limits.value) ? 'No spending limit set.' : ' '}</p>
          )}
          {mayChangeLimits && (
            <button type="button" className="ag-text-btn" onClick={() => setTab('usage')}>
              {guild ? 'Guild limits' : 'Usage and limits'}
            </button>
          )}
        </div>
        <Switch id={`${uid}badges`} label="Show provider badges" checked={showBadges} onChange={onShowBadgesChange} />
      </aside>
      )}

      {railOpen && !focused && <button type="button" className="ag-scrim" aria-label="Close the agent list" tabIndex={-1} onClick={() => setRailOpen(false)} />}
      <section className="ag-main" id={`${uid}main`} aria-label={`Chat with ${agent.name}`}>
        <div className="ag-head">
          {!focused && (
            <button type="button" className="ag-icon-btn ag-rail-toggle" onClick={() => setRailOpen((v) => !v)} aria-label="Agents" aria-expanded={railOpen}>
              <Icon name="agents" />
            </button>
          )}
          <span className="ag-head-mark">
            <Mark client={client} agent={agent} theme={theme} size={40} />
          </span>
          <div className="ag-head-text">
            <h3>
              <span className="ag-head-name">{agent.name}</span>
              {show && agent.binding && <ProviderBadge badge={agent.binding} />}
              {badgeDismissable(agent, showBadges) && (
                <button type="button" className="ag-text-btn sm" onClick={() => void client.updateAgent(agent.id, { dismissBadgeNotice: true }, { idem: newIdem() }).catch(() => setNotice({ kind: 'error', text: errorText(null) }))} data-testid="badge-dismiss">
                  New provider · OK
                </button>
              )}
            </h3>
            <p className="ag-muted">
              {guild ? 'Your agent' : isLead ? 'Lead' : agent.solo === false ? 'Linked' : 'Solo'} · {statusWord(agent)}
              {agent.binding ? ` · ${agent.binding.model}` : ''}
              {guild ? ' · on this Guild Desk only' : ''}
            </p>
          </div>
          {tabs.length > 0 && (
            <div className="ag-seg ag-tabs" role="group" aria-label="Agent details">
              {tabs.map((t) => (
                <button key={t.id} type="button" aria-pressed={tab === t.id} aria-label={tabName(t, agent.name)} title={tabTitle(t, agent.name)} className={tab === t.id ? 'on' : ''} onClick={() => setTab(tab === t.id ? null : t.id)} data-testid={`tab-${t.id}`}>
                  <Icon name={t.icon} size={14} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Offers from the member's other desks (W6), in the desk team's window: never on a Guild Desk, nor beside a setup screen,
            which lists them itself. Read once as the window opens (a window that subscribes late hears no `agent.state` until the
            next change, so its count is unknown, null), and again whenever the count changes; a count of none reads nothing. */}
        {!focused && !guild && otherDesks.length > 0 && team.deskOffers !== 0 && !(agent.binding && agent.status !== 'no_key' && setupReason && setupBack[agent.id] !== setupReason) && (
          <DeskOfferCards client={client} agents={agents} otherDesks={otherDesks} version={team.deskOffers} announce={say} />
        )}
        {(agent.status === 'no_key' || !agent.binding) && guild && !guild.limits ? (
          <div className="ag-setup" data-testid="guild-no-key">
            <div className="ag-setup-card">
              <h3>{agent.name} is waiting for the guild’s key</h3>
              <p className="ag-muted">{agent.binding ? guild.keyLost : guild.noKey}</p>
            </div>
          </div>
        ) : agent.status === 'no_key' || !agent.binding ? (
          <KeySetup
            client={client}
            agent={agent}
            agents={agents}
            providers={providers.value}
            keys={keys.value}
            keysLast={keysStay}
            onKeysChanged={keys.reload}
            intro={guild?.addKey ?? null}
            introAgain={guild?.addKeyAgain ?? null}
            restartLine={guild?.restartLine ?? null}
            deskId={desk}
            deskName={deskName}
            offerFree={offered}
            announce={say}
          />
        ) : setupReason && setupBack[agent.id] !== setupReason ? (
          <SetupScreen
            key={`${agent.id}:${setupReason}`}
            client={client}
            agent={agent}
            otherDesks={otherDesks}
            places={places}
            guild={guild !== null}
            onBack={() => setSetupBack((b) => ({ ...b, [agent.id]: setupReason }))}
            onSaved={() => setSetupDone((d) => ({ ...d, [agent.id]: setupReason }))}
            announce={say}
            version={team.deskOffers}
          />
        ) : (
          <>
            <ThreadView
              agent={agent}
              agents={agents}
              messages={thread.messages}
              loaded={thread.loaded}
              showBadge={show}
              deskName={deskName}
              proposals={isLead ? proposalCtx : null}
              approvals={thread.approvals}
              approvalCtx={approvalCtx}
              free={free}
              onPickModel={tabs.some((t) => t.id === 'keys') ? openKeys : null}
              desks={otherDesks}
            />
            <RunningStrip
              client={client}
              calls={running.calls}
              offset={running.offset}
              agent={agent}
              agents={agents}
              onOpenAgent={openAgent}
              announce={say}
              onStopFailed={() => setNotice({ kind: 'error', text: 'Couldn’t stop it just now. Try again.' })}
            />
            {notice?.kind === 'limit' && (
              <div className="ag-banner warn" role="alert" data-testid="limit-banner">
                <span>{refusalText(notice.scope, limits.value)}</span>
                {mayChangeLimits && (
                  <button type="button" className="ag-btn sm" onClick={() => setTab('usage')} data-testid="limit-change">
                    Change limits
                  </button>
                )}
              </div>
            )}
            {freeLimitShown && (
              <div className="ag-banner warn" role="alert" data-testid="free-limit-banner">
                <span>{limitBannerText(lastReply?.errorResetAt, when)}</span>
                {tabs.some((t) => t.id === 'keys') && (
                  <button
                    type="button"
                    className="ag-btn sm"
                    onClick={() => {
                      setKeysAdd((n) => n + 1);
                      setAddFresh(true);
                      setTab('keys');
                    }}
                    data-testid="free-limit-add"
                  >
                    Add a key
                  </button>
                )}
              </div>
            )}
            {isWaitingDesk(agent) && (
              <div className="ag-banner calm" role="status" data-testid="waiting-desk">
                <span>{WAITING_DESK}</span>
              </div>
            )}
            {agent.status === 'paused' && (
              <div className="ag-banner warn" role="status" data-testid="paused-banner">
                <span>{pausedText(agent.statusDetail)}</span>
              </div>
            )}
            {notice?.kind === 'error' && (
              <div className="ag-banner error" role="alert">
                <span>{notice.text}</span>
              </div>
            )}
            {setupReason ? (
              <div className="ag-banner calm" role="status" data-testid="setup-waiting">
                <span>{waitingLine(agent.name)}</span>
                <button type="button" className="ag-btn sm" onClick={() => setSetupBack((b) => without(b, agent.id))} data-testid="setup-open">
                  Set up {agent.name}
                </button>
              </div>
            ) : (
            <Composer
              key={seed?.agentId === agent.id ? `${agent.id}:${seed.seq}` : agent.id}
              client={client}
              agent={agent}
              busy={sending}
              streamingRunId={live?.runId ?? null}
              waiting={waitingRun}
              onSend={send}
              onStop={stop}
              disabled={offline}
              suggestions={suggestions}
              initialDraft={drafts.current.get(agent.id) ?? ''}
              initialFiles={seed?.agentId === agent.id ? seed.files : undefined}
              onDraftChange={(t) => {
                drafts.current.set(agent.id, t);
                reportUnsaved(`draft:${agent.id}`, t.trim() !== '');
              }}
            />
            )}
          </>
        )}
      </section>

      {tab && tabs.some((t) => t.id === tab) && (
        <aside className="ag-drawer" aria-label={tabTitle(tabs.find((t) => t.id === tab) ?? { title: '' }, agent.name)} onKeyDown={onDrawerKey} data-testid="drawer">
          <div className="ag-side-head">
            <h3>{tab === 'settings' ? `${agent.name}’s settings` : tabTitle(tabs.find((t) => t.id === tab) ?? { title: '' }, agent.name)}</h3>
            <button type="button" className="ag-icon-btn" onClick={() => setTab(null)} aria-label="Close panel">
              <Icon name="close" />
            </button>
          </div>
          <div className="ag-drawer-body">
            {tab === 'settings' && (
              <SettingsPanel
                key={agent.id}
                client={client}
                agent={agent}
                agents={agents}
                keys={keys.value}
                caps={caps}
                theme={theme}
                otherDesks={otherDesks}
                places={places}
                announce={say}
                stateVersion={team.events}
                onOpenUsage={() => setTab('usage')}
                onDeleted={() => {
                  setTab(null);
                  setSelectedId(null);
                }}
              />
            )}
            {tab === 'memory' && <MemoryPanel key={agent.id} client={client} agent={agent} agents={agents} version={`${thread.messages.length}:${live ? live.state : 'idle'}`} announce={say} />}
            {tab === 'messages' && <AgentMessagesPanel client={client} agent={agent} agents={agents} version={`${thread.seq}:${agents.map((a) => a.status).join()}`} />}
            {tab === 'usage' && guild && (
              <>
                <GuildKeyPanel client={client} agent={agent} agents={agents} providers={providers.value} keys={keys.value} onKeysChanged={keys.reload} restartLine={guild.restartLine ?? null} />
                {guild.limits}
              </>
            )}
            {tab === 'usage' && (guild ? null : <LimitsPanel key={agent.id} client={client} agent={agent} view={limits.value} onSaved={(v) => limits.set(v)} />)}
            {tab === 'keys' && (
              <KeysPanel
                key={keysAdd}
                client={client}
                agent={agent}
                agents={agents}
                providers={providers.value}
                keys={keys.value}
                keysLast={keysStay}
                onKeysChanged={keys.reload}
                deskName={deskName}
                deskId={desk}
                offerFree={offered}
                openAdd={addFresh}
                announce={say}
              />
            )}
            {tab === 'activity' && <ActivityPanel client={client} agents={agents} keys={keys.value} providers={providers.value} version={activityVersion} keysLast={keysStay} />}
          </div>
        </aside>
      )}
      </div>
      <div className="ag-sr" role="status" aria-live="polite">
        {announce}
      </div>
    </div>
    </UnsavedContext.Provider>
  );
}
