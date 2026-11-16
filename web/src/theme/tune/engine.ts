// The theme sliders' chunk: the colour math (`xf.ts`), laying it (`apply.ts`), this browser's copy and the save to Platform
// (`PUT /v1/me/appearance`, ma-platform contract appearance.md: one setting for the account, shared with the Forums, no
// desk layer). Loaded when the account menu's panel opens, or when `/v1/me` brings a setting this browser doesn't show.
//
// A slider moves the office live: each change is laid on the next frame (several in one frame lay once). A reset, and a
// setting from Platform that differs from what's shown (moved on another device), ease there over 200 ms, or jump with
// reduced motion. The save waits until the slider rests (500 ms), one at a time; Platform's answer never moves a slider
// the member is still moving. A failed save is tried once more; after that the office keeps what the member chose and
// the next load takes Platform's word.
//
// The glass (release 6.11, `glass.ts`): a live move lays the shown theme's glass every frame (the DOM's is a few custom
// properties), but the canvas's tiles keep their raster until the move rests (`REST_MS` with no new value), when every theme's
// glass is laid and they raster once (`tokensChanged(false)`); an ease's end and a setting that lands without one raster
// them once too. Never per input event, never per frame.
import { api } from '../../platform/api';
import { useSession } from '../../platform/session';
import { isSavingLayout, layoutMirrorWritable } from '../../state/layoutStore';
import { reducedMotion } from '../../lib/util';
import { getTheme, tokensChanged } from '../themeStore';
import { THEME_IDS, type ThemeId } from '../tokens';
import { bootMirror, layFlats, pristine, setTuneTarget, tuneTarget, tuneWho, type TuneValues } from './apply';
import { glassFor } from './glass';
import { MIRROR_KEY, type Flats } from './mirror';
import { changedOnly, clampTune, DEFAULT_TUNE, isDefaultTune, tuneFlat } from './xf';

const EASE_MS = 200;
const SAVE_AFTER_MS = 500;
/** A live move has rested once no new value has come for this long: the canvas's tiles raster then, once. */
export const REST_MS = 250;
const RETRY_MS = 4_000;
const TIMEOUT_MS = 15_000;

/**
 * Every theme's changed tokens and glass for a setting: nothing at the default. `only` works out that theme's glass alone (the
 * one on show, while a slider moves: the rest wait for it to rest).
 */
export function flatsFor(t: TuneValues, only?: ThemeId): Flats {
  const tune = clampTune(t);
  if (isDefaultTune(tune)) return {};
  const out: Flats = {};
  for (const id of THEME_IDS) {
    const base = pristine(id);
    const tuned = tuneFlat(base, tune).out;
    const d = { ...changedOnly(base, tuned), ...(only && only !== id ? {} : glassFor(id, tune, tuned)) };
    if (Object.keys(d).length) out[id] = d;
  }
  return out;
}

let shown: TuneValues = bootMirror ? { blue: bootMirror.blue, contrast: bootMirror.contrast } : { ...DEFAULT_TUNE };
let frame = 0;
/** The next frame lays even an unchanged setting: once per load, since this browser's copy may predate today's tokens. */
let relay = bootMirror !== null;
/** This browser's copy is from before the glass followed the sliders (release 6.10's): its glass is laid as the chunk lands. */
const mirrorLacksGlass = bootMirror !== null && !isDefaultTune(clampTune(bootMirror)) && !Object.values(bootMirror.flats).some((f) => f && Object.keys(f).some((k) => k.startsWith('glass.')));
let ease: { from: TuneValues; to: TuneValues; start: number } | null = null;
/** What the next frame shows comes from the member's own move: live, until it rests. */
let liveNext = false;
/** A live move laid colours the canvas's tiles haven't rastered yet: they do when it rests. */
let behind = false;
let restTimer = 0;

/**
 * Lays a setting. `live` (a slider moving, an ease on its way): the shown theme's glass only, and the canvas keeps its tiles'
 * raster, which a rest then makes once. Otherwise every theme, and the tiles raster once if anything changed since they last did.
 */
function layNow(t: TuneValues, live: boolean): void {
  shown = t;
  relay = false;
  const theme = getTheme().resolved;
  const changed = layFlats(flatsFor(t, live ? theme : undefined), theme);
  window.clearTimeout(restTimer);
  restTimer = 0;
  if (live) {
    behind ||= changed;
    if (changed) tokensChanged(true);
    restTimer = window.setTimeout(() => layNow(shown, false), REST_MS);
    return;
  }
  if (changed || behind) tokensChanged(false);
  behind = false;
}

function tick(now: number): void {
  frame = 0;
  if (ease) {
    const f = Math.min(1, (now - ease.start) / EASE_MS);
    const e = 1 - (1 - f) ** 3;
    const at = (a: number, b: number): number => Math.round(a + (b - a) * e);
    // The ease's frames are live; its last one lands.
    layNow({ blue: at(ease.from.blue, ease.to.blue), contrast: at(ease.from.contrast, ease.to.contrast) }, f < 1);
    if (f < 1) frame = requestAnimationFrame(tick);
    else ease = null;
    return;
  }
  const t = tuneTarget();
  if (relay || t.blue !== shown.blue || t.contrast !== shown.contrast) layNow(t, liveNext);
}

/** Shows the target: on the next frame, or eased there. `live`: the member is moving a slider. */
function show(animate: boolean, live: boolean): void {
  const to = tuneTarget();
  liveNext = live;
  if (animate && !reducedMotion() && !document.hidden && (to.blue !== shown.blue || to.contrast !== shown.contrast)) {
    ease = { from: shown, to, start: performance.now() };
  } else ease = null;
  if (!frame) frame = requestAnimationFrame(tick);
}

const member = (): string | null => useSession.getState().me?.userId ?? null;

/** This browser's copy: the laid colours for every theme, under the member's id. Gone at the default. */
function writeMirror(t: TuneValues, who: string | null): void {
  if (!layoutMirrorWritable()) return;
  try {
    if (isDefaultTune(clampTune(t)) || who === null) window.localStorage.removeItem(MIRROR_KEY);
    else window.localStorage.setItem(MIRROR_KEY, JSON.stringify({ who, blue: t.blue, contrast: t.contrast, flats: flatsFor(t) }));
  } catch {
    /* storage refused: Platform still has it */
  }
}

let saveTimer = 0;
let saving = false;
let dirty = false;
let retried = false;

/** True from the member's first move until Platform has the last of it (or gave up): no setting from `/v1/me` lands meanwhile. */
export const editing = (): boolean => dirty || saving || saveTimer !== 0;

async function save(): Promise<void> {
  saveTimer = 0;
  if (saving || !dirty) return;
  const who = member();
  writeMirror(tuneTarget(), who);
  // The fixtures (dev and the fixture tests) never reach Platform, as with the layout: kept in this tab and browser only.
  if (!isSavingLayout() || who === null) {
    dirty = false;
    return;
  }
  dirty = false;
  saving = true;
  const sent = tuneTarget();
  try {
    await api<unknown>('/v1/me/appearance', {
      method: 'PUT',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blue: sent.blue, contrast: sent.contrast }),
    });
    retried = false;
  } catch {
    // Once more, a little later; then what the member chose stays here and the next load takes Platform's word.
    if (!retried) {
      retried = true;
      dirty = true;
      saveTimer = window.setTimeout(() => void save(), RETRY_MS);
    }
  } finally {
    saving = false;
    if (dirty && !saveTimer) saveTimer = window.setTimeout(() => void save(), SAVE_AFTER_MS);
  }
}

/** The member moved a slider (or pressed Reset: `animate`). Laid at once; saved when it rests. */
export function change(next: Partial<TuneValues>, animate = false): void {
  const t = clampTune({ ...tuneTarget(), ...next });
  setTuneTarget(t, member());
  show(animate, true);
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), SAVE_AFTER_MS);
}

/**
 * Platform's setting for this member (`/v1/me`), or the default once signed out (`who` null). Eased in if it differs from
 * what's shown, unless the member is moving a slider right now.
 */
export function adopt(who: string | null, t: TuneValues): void {
  if (editing() && who !== null && who === tuneWho()) return;
  const tune = clampTune(t);
  const changed = tune.blue !== tuneTarget().blue || tune.contrast !== tuneTarget().contrast;
  setTuneTarget(tune, who);
  if (changed || relay) show(changed, false);
  if (who !== null) writeMirror(tune, who);
}

// This browser's copy painted the first frame. Laid again as the chunk lands, so a copy from before today's tokens, or from
// before the glass followed the sliders, is put right without waiting for `/v1/me` (an unchanged one changes nothing).
if (relay) {
  show(false, false);
  if (mirrorLacksGlass && bootMirror) writeMirror(tuneTarget(), tuneWho() ?? bootMirror.who);
}
