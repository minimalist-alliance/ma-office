// Each desk's agents as the Desk app needs them for their tiles (task 49 item 6): who they are, their names and their looks,
// from that desk's `agent.state` (liveStore subscribes). Memory only, like the rest of `live`: names are desk content, and a
// member may be on a shared machine. An uploaded icon's mask comes over the desk's own link (`agent.icon.get`, the owner's
// alone) and lives in this page only, as an ImageBitmap for the canvas and a `blob:` URL for the DOM, never a URL that
// leaves the page. Until a desk has said, its agent tiles draw the default mark and read "Agent".
import { create } from 'zustand';
import type { Agent } from '../../agent/src/client/types';
import { agentIdOf, isAgentApp, isDeskApp, type AppId, type CoreAppId } from '../canvas/layout';
import { host } from '../deskapps/door';
import { wearsHat } from '../../agent/src/look/icons';

export interface RosterAgent {
  id: string;
  name: string;
  lead: boolean;
  icon: string;
  /** Its colour (`web/agent/src/look/colors.ts`): the lead's is the Agent app's own; null where its desk hasn't said one. */
  color: string | null;
  tone: string;
  /** The upload's version, or null. */
  png: number | null;
  /** Its finished replies the member hasn't seen, and its requests waiting for the member (S-14): its tile's badge. */
  unseen: number;
  /** Its requests waiting for the member (API.md section 18's `approvalsPending`). */
  waiting: number;
}

interface RosterState {
  /** Absent: this desk hasn't said yet, so its tiles stay as they are. */
  desks: Record<string, RosterAgent[]>;
  /** Masks ready to draw, by `maskKey`. */
  masks: Record<string, { bitmap: ImageBitmap | null; url: string }>;
  /** The look's drawing has loaded (`lookChunk`). */
  lookReady: boolean;
  /** To-do's glyph has loaded (`todoGlyphChunk`). */
  todoReady: boolean;
  /** Documents' glyph has loaded (`docsGlyphChunk`). */
  docsReady: boolean;
}

export const useRosterStore = create<RosterState>(() => ({ desks: {}, masks: {}, lookReady: false, todoReady: false, docsReady: false }));

export type TodoGlyphChunk = typeof import('../apps/todo/glyph3d');
let todoGlyph: TodoGlyphChunk | null = null;
let todoLoading = false;
/** To-do's glyph is a chunk of its own, as an agent's look is: the first To-do tile asks, and `todoReady` says when it's here. */
export function todoGlyphChunk(): TodoGlyphChunk | null {
  if (!todoGlyph && !todoLoading) {
    todoLoading = true;
    import('../apps/todo/glyph3d').then(
      (m) => {
        todoGlyph = m;
        useRosterStore.setState({ todoReady: true });
      },
      () => (todoLoading = false),
    );
  }
  return todoGlyph;
}

export type DocsGlyphChunk = typeof import('../apps/documents/glyph3d');
let docsGlyph: DocsGlyphChunk | null = null;
let docsLoading = false;
/** Documents' glyph, a chunk of its own as To-do's is: the first Documents tile asks, and `docsReady` says when it's here. */
export function docsGlyphChunk(): DocsGlyphChunk | null {
  if (!docsGlyph && !docsLoading) {
    docsLoading = true;
    import('../apps/documents/glyph3d').then(
      (m) => {
        docsGlyph = m;
        useRosterStore.setState({ docsReady: true });
      },
      () => (docsLoading = false),
    );
  }
  return docsGlyph;
}

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

// Until a desk says, an agent wears the hat in grey (no colour), as asleep.
const DEFAULT_LOOK = { icon: 'hat', color: '', tone: 'graphite' } as const;
const isLead = (a: Pick<Agent, 'lead' | 'role'>): boolean => a.lead === true || a.role === 'manager';

export const maskKey = (deskId: string, agentId: string, version: number): string => `${deskId}|${agentId}|${version}`;

const same = (a: readonly RosterAgent[] | undefined, b: readonly RosterAgent[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    return x.id === y.id && x.name === y.name && x.lead === y.lead && x.icon === y.icon && x.color === y.color && x.tone === y.tone && x.png === y.png && x.unseen === y.unseen && x.waiting === y.waiting;
  });

/** What a desk's `agent.state` says. `fetchIcon` reads an upload over that desk's link, once per version. */
export function noteAgents(deskId: string, agents: readonly Agent[], fetchIcon?: (agentId: string) => Promise<{ png: string; version: number }>): void {
  const next: RosterAgent[] = agents.map((a) => ({
    id: a.id,
    name: a.name,
    lead: isLead(a),
    icon: a.look?.icon ?? DEFAULT_LOOK.icon,
    // The lead keeps the Agent app's own accent (the owner, Nov 15); a desk-agent from before says no colour: grey.
    color: isLead(a) ? 'indigo' : (a.look?.color ?? null),
    tone: a.look?.tone ?? DEFAULT_LOOK.tone,
    png: a.look?.icon === 'png' ? (a.look.png ?? null) : null,
    // A request waiting (API.md section 18's `approvalsPending`) counts on the tile with the unseen replies (the S-14 spec, section 6),
    // and so does what a run the member didn't start did without asking, until it's seen (`autoUnseen`, draft ADR section 15).
    unseen: (a.unseen ?? 0) + (a.approvalsPending ?? 0) + (a.autoUnseen ?? 0),
    waiting: a.approvalsPending ?? 0,
  }));
  const cur = useRosterStore.getState();
  // Only a library icon or an upload needs the look's chunk: the hat is the office's own drawing.
  if (next.some((a) => !a.lead && !wearsHat(a.icon))) lookChunk();
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
    // The PNG helpers load beside the icon's own fetch, not in the first load: only an agent with an uploaded mark needs them.
    const [icon, { fromBase64 }] = await Promise.all([fetchIcon(agentId), import('../../agent/src/model/png')]);
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

/** The desk team's requests waiting for the member: the lead's `agent` tile's count (the S-14 spec, section 6). */
export function teamWaiting(deskId: string, state: RosterState = useRosterStore.getState()): number {
  return (state.desks[deskId] ?? []).reduce((n, a) => n + a.waiting, 0);
}

export function useTeamWaiting(deskId: string): number {
  return useRosterStore((s) => teamWaiting(deskId, s));
}

export function useRosterAgent(deskId: string, app: AppId): RosterAgent | null {
  return useRosterStore((s) => (isAgentApp(app) ? rosterAgent(app, deskId, s) : null));
}

/** An agent tile's name: the agent's own, or "Agent" until its desk has said. */
export const agentAppName = (app: AppId, deskId?: string): string => rosterAgent(app, deskId)?.name ?? 'Agent';

/**
 * What a tile's glyph is: a core app's own, or for an agent `look:<icon>:<color>:<tone>:<mask key>`. The sprite caches key on
 * it, so a new icon, colour or upload is a new bitmap and nothing else has to be told.
 */
export type GlyphId = CoreAppId | 'todo:' | 'documents:' | `look:${string}` | `dapp:${string}`;

export function glyphOf(deskId: string, app: AppId, state: RosterState = useRosterStore.getState()): GlyphId {
  // An installed app (ADR 0054): a first-party one's own glyph, or the generic app glyph.
  if (isDeskApp(app)) return `dapp:${host?.glyphFor(app.slice(4)) ?? ''}`;
  // To-do's (a chunk of its own): blank, keyed `todo:`, until it's here, so the tile draws again when it is.
  if (app === 'todo' && !state.todoReady) return todoGlyphChunk() ? 'todo' : 'todo:';
  // Documents' the same way (`documents:` is the blank before).
  if (app === 'documents' && !state.docsReady) return docsGlyphChunk() ? 'documents' : 'documents:';
  if (!isAgentApp(app)) return app;
  const a = rosterAgent(app, deskId, state);
  const look = a ?? { id: agentIdOf(app) ?? '', ...DEFAULT_LOOK, png: null as number | null };
  // The hat (every agent's but a member's other pick) is the office's own 3D drawing: no chunk to wait for.
  if (wearsHat(look.icon)) return `look:hat:${look.color ?? ''}:${look.tone}:`;
  // A library icon or an upload: until its drawing is here the tile is blank, and the key says so, so it draws again once it is.
  if (!state.lookReady) {
    lookChunk();
    return 'look:';
  }
  const key = look.png !== null ? maskKey(deskId, look.id, look.png) : '';
  const ready = key && state.masks[key] ? key : '';
  return `look:${look.icon}:${look.color ?? ''}:${look.tone}:${ready}`;
}

export function useGlyph(deskId: string, app: AppId): GlyphId {
  return useRosterStore((s) => glyphOf(deskId, app, s));
}

/** A `look:` glyph's parts. `color` is '' for none (grey). */
export function parseLook(glyph: string): { icon: string; color: string; tone: string; mask: { bitmap: ImageBitmap | null; url: string } | null } | null {
  if (!glyph.startsWith('look:')) return null;
  if (glyph === 'look:') return { icon: '', color: '', tone: '', mask: null };
  const [, icon = DEFAULT_LOOK.icon, color = '', tone = DEFAULT_LOOK.tone, ...rest] = glyph.split(':');
  const key = rest.join(':');
  return { icon, color, tone, mask: key ? (useRosterStore.getState().masks[key] ?? null) : null };
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

