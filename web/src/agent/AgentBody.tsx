// The Agent app itself: its own lazy chunk, so none of it costs a member who hasn't opened the window. `web/agent` is a package
// of its own, imported here as source. The one client over this desk's link is made here, and it talks to that desk alone.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo } from 'react';
import { AgentApp, RpcAgentClient, type DeskTransport, type GuildMode } from '../../agent/src/index';
import { agentApp, agentIdOf, type AppId } from '../canvas/layout';
import type { DeskLink } from '../desk/deskLink';
import { setGuildCaps, useGuildStore } from '../guild/guildStore';
import { guildIdOfPanel, limitsOf, mayManageAgents } from '../guild/panel';
import { useTierNames } from '../platform/useTiers';
import { useDeskStore } from '../state/deskStore';
import { setLayoutPref } from '../shell/layoutSync';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { useLayoutStore } from '../state/layoutStore';
import { openWindow } from '../state/windowStore';
import { useRosterStore } from './roster';

/** The link, untyped: `DeskRpc` and `LinkTopics` list what it's called with. */
export function transportOf(link: DeskLink): DeskTransport {
  return {
    call: (method, params, options) => link.call(method as never, params, options),
    subscribe: (topic, onEvent, onRefused) => link.subscribe(topic as never, onEvent as never, onRefused),
  };
}

const onShowBadgesChange = (showProviderBadges: boolean): void => setLayoutPref({ showProviderBadges });

/**
 * An agent's own window on this desk (task 49): its tile's, or the `agent` tile's for the lead. False where it has none yet,
 * as just after it was made, and the app shows it where it is.
 */
export function openAgentWindow(deskId: string, agentId: string): boolean {
  const items = useLayoutStore.getState().desks[deskId]?.items ?? [];
  const lead = useRosterStore.getState().desks[deskId]?.find((a) => a.id === agentId)?.lead === true;
  const item = items.find((i) => i.app === (lead ? 'agent' : agentApp(agentId)));
  if (!item) return false;
  openWindow(deskId, item.app, item.id);
  return true;
}

// The guild's limits panel is the guild sheet's own chunk, loaded only where a Founder or `manage_agents` opens it.
const GuildLimitsPanel = lazy(() => import('../guild/GuildSheet').then((m) => ({ default: m.GuildLimitsPanel })));

const an = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/**
 * What the Agent says on a Guild Desk about the guild's key: a member's agent runs on it, and only the Founder or an Officer with
 * `manage_agents` can add it, named with the tiers' names from the owner's setting. Until desk-agent keeps it (STATUS.md, finding 9),
 * the key goes with every sleep or restart of the Guild Desk: the key screen's line says so, and nothing says why it went, as a
 * Founder's Remove looks the same.
 */
export function guildKeyWords(lead: string, officer: string): Pick<GuildMode, 'noKey' | 'keyLost' | 'addKey' | 'addKeyAgain' | 'restartLine'> {
  const who = `the ${lead}, or ${an(officer)} who manages agents,`;
  return {
    noKey: `Your agent here runs on the guild's key. It starts once ${who} adds it.`,
    keyLost: `The guild's key isn't on the Guild Desk right now. Your agent starts again once ${who} adds it back.`,
    addKey: {
      title: "Add the guild's key",
      line: "Every member's agent here runs on this key, within the guild's limits. You pay the provider directly, and members never see the key.",
    },
    addKeyAgain: {
      title: "Add the guild's key again",
      line: "Every member's agent waits until it's back. Their threads and the guild's limits are all still here.",
    },
    restartLine: 'For now, the guild’s key stays only until the Guild Desk sleeps or restarts. You’d add it again after that.',
  };
}

/** A Guild Desk's mode of the Agent app (task 48), or null on any other desk. */
function useGuildMode(deskId: string, link: DeskLink, session: number): GuildMode | null {
  const guildId = guildIdOfPanel(deskId);
  const hello = useGuildStore((s) => (guildId ? s.hello[guildId] : undefined));
  const info = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.guild);
  const caps = useGuildStore((s) => (guildId ? s.caps[guildId] : undefined));
  const openLimits = useGuildStore((s) => s.limitsAsk[deskId] ?? 0);
  const names = useTierNames();
  // The guild's caps on each member are any member's to read (`guild.settings.get`); the sheet's saves update them too.
  useEffect(() => {
    if (!guildId) return;
    link.call('guild.settings.get').then((s) => setGuildCaps(guildId, limitsOf(s).perMember), () => undefined);
  }, [guildId, link, session]);
  return useMemo(() => {
    if (!guildId) return null;
    const manages = mayManageAgents(hello?.role ?? info?.role, hello?.grants ?? info?.grants);
    const words = guildKeyWords(names.lead, names.officer);
    return {
      limits: manages ? (
        <Suspense fallback={null}>
          <GuildLimitsPanel guildId={guildId} />
        </Suspense>
      ) : null,
      noKey: words.noKey,
      keyLost: words.keyLost,
      restartLine: words.restartLine,
      caps: caps ? { usdPerDay: caps.usdPerDay, usdPerMonth: caps.usdPerMonth } : null,
      openLimits,
      ...(manages ? { addKey: words.addKey, addKeyAgain: words.addKeyAgain } : {}),
    };
  }, [guildId, hello?.role, hello?.grants, info?.role, info?.grants, names.lead, names.officer, caps, openLimits]);
}

export default memo(function AgentBody({ link, session, deskId, deskName, offline, parked, app = 'agent' }: {
  link: DeskLink;
  /** Goes up with each session that opens: a new client, so every read runs again and nothing shown is stale. */
  session: number;
  deskId: string;
  deskName: string;
  offline: boolean;
  parked: boolean;
  /** `agent` is the lead's window, with the whole team; `agent:<agentId>` is that agent's own (task 49). */
  app?: AppId;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const client = useMemo(() => new RpcAgentClient(transportOf(link)), [link, session]);
  const showBadges = useLayoutPrefs((s) => s.showProviderBadges);
  const guild = useGuildMode(deskId, link, session);
  const onOpenAgent = useCallback((agentId: string) => openAgentWindow(deskId, agentId), [deskId]);
  // A Guild Desk's Agent is each member's own, on the guild's key (task 48): one agent, and no team to add to there.
  return (
    <AgentApp
      client={client}
      deskName={deskName}
      showBadges={showBadges}
      onShowBadgesChange={onShowBadgesChange}
      offline={offline}
      parked={parked}
      canAddAgents={!guild}
      guild={guild}
      focusAgentId={agentIdOf(app)}
      onOpenAgent={onOpenAgent}
    />
  );
});
