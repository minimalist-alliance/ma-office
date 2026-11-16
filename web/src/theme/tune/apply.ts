// The theme sliders' colours laid over the office (the owner's pick, Nov 14: blue range A and the sheet's contrast range;
// ma-platform contract appearance.md). Main chunk and small: no colour math here. The math is `xf.ts`, in the sliders'
// chunk (`engine.ts`), which hands this file each theme's changed tokens.
//
// Two places, the same values: the token objects in `tokens.ts`, written in place so every reader follows (the canvas's
// desks and tiles, a Plain desk's etch, the desk apps' tokens), each theme's top-level object then replaced so the
// components that select `t` draw again and `THEMES[id] === t` still holds; and the same values as custom properties on
// <html>, which win over themes.css's `:root[data-theme]` blocks. An app's own inks (`.ma-window[data-app]`) re-declare
// theirs on the window and stay as they are, as the sheet says.
//
// At the default (blue 100, contrast 50) nothing is laid: today's office, exactly. This browser keeps the member's laid
// colours under their id (`ma.appearance.v1`, part of the layout's mirror, wiped on every signed-out state), so the next
// load paints them with the first frame (`layBootProps`, from `theme/boot.ts`) and before the canvas's first draw.
//
// The glass (release 6.11, the owner, Nov 16: "Yes, do it"): the sliders' chunk works out the office's glass for a setting
// (`glass.ts`) and hands it over in the same flats: `glass.*`, the DOM recipe's `--ma-glass-*` properties, laid on <html> like
// any token; and `tile*`, the canvas's glass, written in place into `GLASS_FACE` (its dials, `tileGlass.*`, and its lift's two
// colours, `tileLiftContact.color` and `tileLiftSoft.color`) and `TILE_TINT` (its body's lightness, `tileTint.*`), never set as
// properties. Each changed theme's `GLASS_FACE` object is replaced too, so the canvas's light (cached per face) draws again.
import { followThemeTokens } from '../deskStyles';
import { GLASS_FACE, THEME_IDS, THEMES, TILE_TINT, type ThemeId } from '../tokens';
import { MIRROR_KEY, parseMirror, propOf, type Flats, type Mirror } from './mirror';

type Flat = Record<string, string>;
type Groups = Record<string, Record<string, unknown>>;

/** What a theme's keys write into: its token groups, and the canvas's glass. */
const groupsOf = (id: ThemeId): Groups => {
  const g = GLASS_FACE[id] as unknown as Groups[string] & { lift: Groups[string][] };
  return { ...(THEMES[id] as unknown as Groups), tileGlass: g, tileLiftContact: g.lift[0]!, tileLiftSoft: g.lift[1]!, tileTint: TILE_TINT[id] as unknown as Groups[string] };
};

/** Every theme's string tokens as tokens.ts spells them, and the canvas glass's dials, before anything is laid. */
const PRISTINE: Record<ThemeId, Flat> = Object.fromEntries(THEME_IDS.map((id) => [id, flatten(groupsOf(id))])) as Record<ThemeId, Flat>;

function flatten(groups: Groups): Flat {
  const flat: Flat = {};
  for (const [group, values] of Object.entries(groups)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [key, v] of Object.entries(values)) if (typeof v === 'string' || typeof v === 'number') flat[`${group}.${key}`] = String(v);
  }
  return flat;
}

export const pristine = (id: ThemeId): Flat => PRISTINE[id];

let laid: Flats = {};
let propsOn = new Set<string>();

/** What's laid now, each theme's changed tokens only (empty at the default). */
export const laidFlats = (): Flats => laid;

/** Writes `next` into the token objects (and puts back today's value for any key no longer laid). Returns whether any changed. */
function layTokens(next: Flats): boolean {
  let any = false;
  for (const id of THEME_IDS) {
    const before = laid[id] ?? {};
    const after = next[id] ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let changed = false;
    const groups = groupsOf(id);
    for (const k of keys) {
      const [group, key] = k.split('.') as [string, string];
      const value = after[k] ?? PRISTINE[id][k];
      const groupObj = Object.hasOwn(groups, group) ? groups[group] : undefined;
      const now = groupObj?.[key];
      if (value === undefined || !groupObj || !(typeof now === 'string' || typeof now === 'number') || String(now) === value) continue;
      groupObj[key] = typeof now === 'number' ? Number(value) : value;
      changed = true;
    }
    // A new top-level object over the same (rewritten) groups: selectors of `t` see a change, identity checks still pass.
    if (changed) {
      THEMES[id] = { ...THEMES[id] };
      GLASS_FACE[id] = { ...GLASS_FACE[id] };
    }
    any ||= changed;
  }
  laid = next;
  // A Plain desk (and the flat look) is the theme's own surface: it takes the new values too.
  if (any) followThemeTokens();
  return any;
}

/** The custom properties for `theme` on <html>: the laid ones set, any left from before removed. */
export function layProps(theme: ThemeId): void {
  const style = document.documentElement.style;
  const want = new Map(Object.entries(laid[theme] ?? {}).filter(([k]) => !k.startsWith('tile')).map(([k, v]) => [propOf(k), v] as const));
  for (const p of propsOn) if (!want.has(p)) style.removeProperty(p);
  for (const [p, v] of want) if (style.getPropertyValue(p) !== v) style.setProperty(p, v);
  propsOn = new Set(want.keys());
}

/** Lays `next` everywhere. The caller redraws (`themeStore.tokensChanged`). Returns whether the tokens changed. */
export function layFlats(next: Flats, theme: ThemeId): boolean {
  const changed = layTokens(next);
  layProps(theme);
  return changed;
}

/** This browser's copy, read once at load: its colours go into the tokens before the store or the canvas reads them. */
function layFromMirror(): Mirror | null {
  let m: Mirror | null = null;
  try {
    m = parseMirror(window.localStorage.getItem(MIRROR_KEY));
  } catch {
    /* storage unavailable: today's colours until Platform's answer */
  }
  if (m) layTokens(m.flats);
  return m;
}

export const bootMirror: Mirror | null = layFromMirror();

// ---------------------------------------------------------------- the member's choice, for the sliders and the watcher

export interface TuneValues {
  blue: number;
  contrast: number;
}

/** What the member chose (the sliders show it) and whose it is; what's laid may still be easing toward it (`engine.ts`). */
let target: TuneValues = bootMirror ? { blue: bootMirror.blue, contrast: bootMirror.contrast } : { blue: 100, contrast: 50 };
let targetWho: string | null = bootMirror?.who ?? null;
const listeners = new Set<() => void>();

export const tuneTarget = (): TuneValues => target;
export const tuneWho = (): string | null => targetWho;

export function setTuneTarget(next: TuneValues, who: string | null): void {
  targetWho = who;
  if (next.blue === target.blue && next.contrast === target.contrast) return;
  target = next;
  listeners.forEach((fn) => fn());
}

export function onTuneTarget(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
