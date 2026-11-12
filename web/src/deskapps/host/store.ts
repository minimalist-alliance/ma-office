// Desk apps (S-97, ADR 0054), the host's store: what each desk's `apps` topic says (deskd API.md section 19, handed on by the
// first load's `../door.ts`), read leniently; an installed app's name, glyph and tile; whether its window can show (the kill
// switch's value, from client-config, is set by `index.ts`); and the Apps sheet's place. Memory only, like `live`.
import { create } from 'zustand';
import type { AppId } from '../../canvas/layout';
import { deskAppIdOf, hidesSamples, isSampleApp } from './ids';
import type { AppSummary } from '../../desk/deskLink';

export interface WindowSpec {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/** One installed app as `apps.list` and the `apps` topic say it, read leniently and cut to sane lengths: it's untrusted text. */
export interface AppRecord {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  /** `stopped`, `starting`, `running`, `failed` or `disabled`. */
  state: string;
  /** `no_hello`, `crashed`, `memory`, `needs_update`, `host`, `revoked`, or null. */
  problem: string | null;
  /** The widget's last `app.summary`, as it came: the host's chunk reads it (`host/widget.ts`). */
  summary: unknown;
  window: WindowSpec | null;
  permissions: string[];
}

/** What an installed app's tile draws and says, worked out by the host's chunk (`host/tiles.ts`) from its record. */
export interface TileInfo {
  summary: TileSummary;
}

/** A tile's widget, with the contract's words for an app that's stopped by a problem, for its name (`a11y/ProxyLayer.tsx`). */
export type TileSummary = AppSummary & { problem?: string };

export interface DeskApps {
  /** deskd can install and run apps here. False with `reason`: `switched_off`, `no_storage`, `no_sandbox`, or `not_served` (an older deskd). */
  available: boolean;
  reason: string | null;
  apps: AppRecord[];
}

export interface DeskAppsState {
  /** Absent: this desk hasn't said yet. */
  desks: Record<string, DeskApps>;
  /** The Apps sheet, on one desk, with one app's detail open or none. */
  sheet: { deskId: string; appId: string | null } | null;
  /** Client-config's kill switch (`deskApps`), as `door.ts` last read it: absent is on, as it ships. */
  switchOn: boolean;
  /** Each desk's tiles, by app id: until the host's chunk is here, a tile is its glyph and name. */
  tiles: Record<string, Record<string, TileInfo>>;
}

export const useDeskAppsStore = create<DeskAppsState>(() => ({ desks: {}, sheet: null, switchOn: true, tiles: {} }));

/** A shortcut as the office's list shows it: its keys, and what they do. */
export type Shortcut = readonly [keys: string, what: string];

/**
 * The first-party apps' glyphs, until a package carries its own icon (ADR 0054): the Bible's is the Designer's option 1. And
 * their keys, for the office's list of shortcuts (the view's own, `apps/bible/view/`), until a package can say its own.
 */
const FIRST_PARTY: Record<string, { name: string; glyph: DeskGlyph; keys?: readonly Shortcut[] }> = {
  'com.minimalistalliance.bible': {
    name: 'Bible',
    glyph: 'bible',
    keys: [
      ['← →', 'Previous or next chapter'],
      ['/', 'Search'],
      ['g', 'Go to'],
      ['Esc', 'Close the top panel, or clear the selection'],
    ],
  },
};
export type DeskGlyph = 'bible' | 'generic';
export const glyphFor = (id: string): DeskGlyph => FIRST_PARTY[id]?.glyph ?? 'generic';

/**
 * The shortcuts list's groups for installed apps (`chrome/AccountPanel.tsx`): each first-party app with keys that's installed
 * on `deskId`, or on any desk while none is in front. Its name heads its group.
 */
export function shortcutGroups(deskId: string | null, state: DeskAppsState = useDeskAppsStore.getState()): [name: string, keys: readonly Shortcut[]][] {
  const lists = deskId ? [state.desks[deskId]?.apps ?? []] : Object.values(state.desks).map((d) => d.apps);
  return Object.entries(FIRST_PARTY).flatMap(([id, app]) => (app.keys && lists.some((l) => l.some((a) => a.id === id)) ? [[app.name, app.keys] as [string, readonly Shortcut[]]] : []));
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** deskd's `AppManifest.ID`: reverse DNS, lower case. */
const MANIFEST_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function windowOf(v: unknown): WindowSpec | null {
  if (!isObj(v)) return null;
  const width = num(v['width'], 480);
  const height = num(v['height'], 400);
  return { width, height, minWidth: num(v['minWidth'], 280), minHeight: num(v['minHeight'], 200) };
}

/** One `App` from the wire, or null if it isn't one. */
export function appRecord(v: unknown): AppRecord | null {
  if (!isObj(v) || typeof v['id'] !== 'string' || v['id'].length > 64 || !MANIFEST_ID.test(v['id']) || (hidesSamples() && isSampleApp(v['id']))) return null;
  const views = isObj(v['views']) ? v['views'] : {};
  return {
    id: v['id'],
    name: str(v['name'], 32) || (FIRST_PARTY[v['id']]?.name ?? 'App'),
    version: str(v['version'], 32),
    publisher: str(v['publisher'], 64),
    description: str(v['description'], 140),
    state: str(v['state'], 16) || 'stopped',
    problem: strOrNull(v['problem'], 32),
    summary: v['summary'] ?? null,
    window: windowOf(views['window']),
    permissions: (Array.isArray(v['permissions']) ? v['permissions'] : []).filter((t): t is string => typeof t === 'string'),
  };
}

/** What a desk's `apps` topic or `apps.list` says. */
export function noteApps(deskId: string, msg: unknown): void {
  if (!isObj(msg)) return;
  const apps = (Array.isArray(msg['apps']) ? msg['apps'] : []).flatMap((a: unknown) => {
    const r = appRecord(a);
    return r ? [r] : [];
  });
  const next: DeskApps = { available: msg['available'] === true, reason: strOrNull(msg['reason'], 32), apps };
  useDeskAppsStore.setState((s) => ({ desks: { ...s.desks, [deskId]: next } }));
}

/** A desk whose deskd doesn't serve the topic: as if it said it can't, with nothing installed. */
export function noteAppsRefused(deskId: string): void {
  useDeskAppsStore.setState((s) => ({ desks: { ...s.desks, [deskId]: { available: false, reason: 'not_served', apps: s.desks[deskId]?.apps ?? [] } } }));
}

export function dropApps(deskId: string): void {
  useDeskAppsStore.setState((s) => {
    if (!(deskId in s.desks)) return s;
    const desks = { ...s.desks };
    delete desks[deskId];
    return { desks, sheet: s.sheet?.deskId === deskId ? null : s.sheet };
  });
}

/** An installed app's window can show: the switch on, and the desk hasn't said apps are off or can't run there. */
export function appOpenable(deskId: string, state: DeskAppsState = useDeskAppsStore.getState()): boolean {
  return state.switchOn && state.desks[deskId]?.available !== false;
}

export function installedApp(deskId: string | undefined, app: AppId, state: DeskAppsState = useDeskAppsStore.getState()): AppRecord | null {
  const id = deskAppIdOf(app);
  if (!id) return null;
  const lists = deskId ? [state.desks[deskId]?.apps ?? []] : Object.values(state.desks).map((d) => d.apps);
  for (const list of lists) {
    const a = list.find((x) => x.id === id);
    if (a) return a;
  }
  return null;
}

/** An installed app's name: its own, or a first-party one's, or "App" until its desk has said. */
export const deskAppName = (app: AppId, deskId?: string): string => installedApp(deskId, app)?.name ?? FIRST_PARTY[deskAppIdOf(app) ?? '']?.name ?? 'App';

/** An installed app's tile: its widget, from the host's chunk once it's here. */
export const deskAppSummary = (deskId: string, app: AppId, state: DeskAppsState = useDeskAppsStore.getState()): TileSummary | undefined => state.tiles[deskId]?.[deskAppIdOf(app) ?? '']?.summary;


export function openAppsSheet(deskId: string, appId: string | null = null): void {
  useDeskAppsStore.setState({ sheet: { deskId, appId } });
}

export function closeAppsSheet(): void {
  useDeskAppsStore.setState({ sheet: null });
}

