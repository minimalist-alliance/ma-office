// Each desk's agents as the Desk app needs them for their tiles (task 49 item 6): who they are, their names and their looks,
// from that desk's `agent.state` (liveStore subscribes). Memory only, like the rest of `live`: names are desk content, and a
// member may be on a shared machine. An uploaded icon's mask comes over the desk's own link (`agent.icon.get`, the owner's
// alone) and lives in this page only, as an ImageBitmap for the canvas and a `blob:` URL for the DOM, never a URL that
// leaves the page. Until a desk has said, its agent tiles draw the default mark and read "Agent".
import { create } from 'zustand';
import type { Agent } from '../../agent/src/client/types';
import { fromBase64 } from '../../agent/src/model/png';
import { agentIdOf, isAgentApp, type AppId, type CoreAppId } from '../canvas/layout';

export interface RosterAgent {
  id: string;
  name: string;
  lead: boolean;
  icon: string;
  tone: string;
  /** The upload's version, or null. */
  png: number | null;
  /** Its finished replies the member hasn't seen: its tile's badge. */
  unseen: number;
}

interface RosterState {
  /** Absent: this desk hasn't said yet, so its tiles stay as they are. */
  desks: Record<string, RosterAgent[]>;
  /** Masks ready to draw, by `maskKey`. */
  masks: Record<string, { bitmap: ImageBitmap | null; url: string }>;
  /** The look's drawing has loaded (`lookChunk`). */
  lookReady: boolean;
}

export const useRosterStore = create<RosterState>(() => ({ desks: {}, masks: {}, lookReady: false }));

export type LookChunk = typeof import('./lookChunk');
let chunk: LookChunk | null = null;
let asked = false;

/**
 * The look's drawing, or null while it loads: it's a chunk of its own, so a member with no agent tiles never pays for it (the
 * initial chunk's budget, design 2.2). The first ask loads it, and `lookReady` says when it's here.
 */
export function lookChunk(): LookChunk | null {
  if (!chunk && !asked) {
    asked = true;
    import('./lookChunk').then(
      (m) => {
        chunk = m;
        useRosterStore.setState({ lookReady: true });
      },
      () => {
        asked = false; // the next tile asks again
      },
    );
  }
  return chunk;
}

const DEFAULT_LOOK = { icon: 'spark', tone: 'graphite' } as const;
const isLead = (a: Pick<Agent, 'lead' | 'role'>): boolean => a.lead === true || a.role === 'manager';

export const maskKey = (deskId: string, agentId: string, version: number): string => `${deskId}|${agentId}|${version}`;

const same = (a: readonly RosterAgent[] | undefined, b: readonly RosterAgent[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    return x.id === y.id && x.name === y.name && x.lead === y.lead && x.icon === y.icon && x.tone === y.tone && x.png === y.png && x.unseen === y.unseen;
  });

/** What a desk's `agent.state` says. `fetchIcon` reads an upload over that desk's link, once per version. */
export function noteAgents(deskId: string, agents: readonly Agent[], fetchIcon?: (agentId: string) => Promise<{ png: string; version: number }>): void {
  const next: RosterAgent[] = agents.map((a) => ({
    id: a.id,
    name: a.name,
    lead: isLead(a),
    icon: a.look?.icon ?? DEFAULT_LOOK.icon,
    tone: a.look?.tone ?? DEFAULT_LOOK.tone,
    png: a.look?.icon === 'png' ? (a.look.png ?? null) : null,
    unseen: a.unseen ?? 0,
  }));
  const cur = useRosterStore.getState();
  if (next.some((a) => !a.lead)) lookChunk();
  if (!same(cur.desks[deskId], next)) useRosterStore.setState({ desks: { ...cur.desks, [deskId]: next } });
  if (!fetchIcon) return;
  for (const a of next) if (a.png !== null) void loadMask(deskId, a.id, a.png, fetchIcon);
}

const loading = new Set<string>();

async function loadMask(deskId: string, agentId: string, version: number, fetchIcon: (agentId: string) => Promise<{ png: string; version: number }>): Promise<void> {
  const key = maskKey(deskId, agentId, version);
  if (loading.has(key) || useRosterStore.getState().masks[key]) return;
  loading.add(key);
  try {
    const icon = await fetchIcon(agentId);
    const blob = new Blob([fromBase64(icon.png).slice()], { type: 'image/png' });
    const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(blob).catch(() => null) : null;
    const url = URL.createObjectURL(blob);
    // The older versions of this agent's mask go, and their URLs with them.
    const masks = { ...useRosterStore.getState().masks };
    for (const k of Object.keys(masks)) {
      if (k.startsWith(`${deskId}|${agentId}|`) && k !== key) {
        URL.revokeObjectURL(masks[k]!.url);
        masks[k]!.bitmap?.close();
        delete masks[k];
      }
    }
    masks[key] = { bitmap, url };
    useRosterStore.setState({ masks });
  } catch {
    // Not served (an older desk, or the link dropped): the tile keeps the tone alone, and the next `agent.state` asks again.
  } finally {
    loading.delete(key);
  }
}

/** A teen's desks say nothing of agents (`dropAdultOnlySummaries`), and a desk that's gone takes its agents. */
export function dropRoster(deskId?: string): void {
  const cur = useRosterStore.getState();
  const masks = { ...cur.masks };
  for (const [k, m] of Object.entries(masks)) {
    if (deskId && !k.startsWith(`${deskId}|`)) continue;
    URL.revokeObjectURL(m.url);
    m.bitmap?.close();
    delete masks[k];
  }
  const desks = { ...cur.desks };
  if (deskId) delete desks[deskId];
  useRosterStore.setState({ desks: deskId ? desks : {}, masks });
}

/** This app's agent on this desk, or, without a desk, the first desk that has it. Null for the core apps and unknown agents. */
export function rosterAgent(app: AppId, deskId?: string, state: RosterState = useRosterStore.getState()): RosterAgent | null {
  const id = agentIdOf(app);
  if (!id) return null;
  const lists = deskId ? [state.desks[deskId] ?? []] : Object.values(state.desks);
  for (const list of lists) {
    const a = list.find((x) => x.id === id);
    if (a) return a;
  }
  return null;
}

export function useRosterAgent(deskId: string, app: AppId): RosterAgent | null {
  return useRosterStore((s) => (isAgentApp(app) ? rosterAgent(app, deskId, s) : null));
}

/** An agent tile's name: the agent's own, or "Agent" until its desk has said. */
export const agentAppName = (app: AppId, deskId?: string): string => rosterAgent(app, deskId)?.name ?? 'Agent';

/**
 * What a tile's glyph is: a core app's own, or for an agent `look:<icon>:<tone>:<mask key>`. The sprite caches key on it, so a
 * new icon, tone or upload is a new bitmap and nothing else has to be told.
 */
export type GlyphId = CoreAppId | `look:${string}`;

export function glyphOf(deskId: string, app: AppId, state: RosterState = useRosterStore.getState()): GlyphId {
  if (!isAgentApp(app)) return app;
  // Until the drawing is here the tile is blank, and the key says so, so it draws again once it is.
  if (!state.lookReady) {
    lookChunk();
    return 'look:';
  }
  const a = rosterAgent(app, deskId, state);
  const look = a ?? { id: agentIdOf(app) ?? '', ...DEFAULT_LOOK, png: null as number | null };
  const key = look.png !== null ? maskKey(deskId, look.id, look.png) : '';
  const ready = key && state.masks[key] ? key : '';
  return `look:${look.icon}:${look.tone}:${ready}`;
}

export function useGlyph(deskId: string, app: AppId): GlyphId {
  return useRosterStore((s) => glyphOf(deskId, app, s));
}

/** A `look:` glyph's parts. */
export function parseLook(glyph: string): { icon: string; tone: string; mask: { bitmap: ImageBitmap | null; url: string } | null } | null {
  if (!glyph.startsWith('look:')) return null;
  if (glyph === 'look:') return { icon: '', tone: '', mask: null };
  const [, icon = DEFAULT_LOOK.icon, tone = DEFAULT_LOOK.tone, ...rest] = glyph.split(':');
  const key = rest.join(':');
  return { icon, tone, mask: key ? (useRosterStore.getState().masks[key] ?? null) : null };
}

/**
 * Keeps agent tiles level with each desk's agents (`tileSync.ts`), loaded the first time a desk says who's there: an office whose
 * desks have said nothing has no agent tiles to keep, and pays nothing in the initial chunk for it. Returns a stop.
 */
export function watchAgentTiles(): () => void {
  let stop: (() => void) | null = null;
  let gone = false;
  const start = (): void => {
    off();
    void import('./tileSync').then((m) => {
      if (!gone) stop = m.startAgentTiles();
    });
  };
  const off = useRosterStore.subscribe((s) => {
    if (Object.keys(s.desks).length) start();
  });
  if (Object.keys(useRosterStore.getState().desks).length) start();
  return () => {
    gone = true;
    off();
    stop?.();
  };
}

