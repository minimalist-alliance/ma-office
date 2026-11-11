// The office background's layer (ADR 0094): a lazy chunk, fetched by `Shell.tsx` after the canvas's first paint, so the
// fast start doesn't move and the initial JS (at its 250 KB budget) holds only `boot.ts`'s paint from the mirror. It reads
// the manifest (`<base>backgrounds/manifest.json`, served as-is from `public/`), works out the scene from the member's
// `prefs.background` and the theme (`backgrounds.ts`), and paints `.ma-backdrop` outside React: the scene's colour and
// placeholder at once, then a `<picture>` of every width in AVIF with WebP behind it, which fades in when it has loaded
// (no fade under reduced motion). The picker (`chrome/BackgroundPicker.tsx`) reads the same store and chooses through here.
import { create } from 'zustand';
import { reducedMotion, writeJson } from '../lib/util';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { setLayoutPref } from '../shell/layoutSync';
import { MIRROR_KEY, paintBackdrop } from './backdropMirror';
import { NONE, parseBackgroundPref, parseManifest, pictureSources, SAVE_DATA_MAX_WIDTH, sceneFor, type EdgeBand, type Scene } from './backgrounds';
import { useThemeStore } from './themeStore';
import type { ThemeId } from './tokens';

export interface BackdropState {
  /** The manifest's scenes, once read; null until then, and if it couldn't be. */
  scenes: Scene[] | null;
  /** The manifest couldn't be read: the picker shows nothing, and the layer keeps what the mirror painted. */
  failed: boolean;
  /** The scene on the layer, "none", or null before the first apply. */
  shown: string | null;
  /** The manifest's edge bands, or null for the tokens' default. */
  edgeBand: EdgeBand | null;
}

export const useBackdrop = create<BackdropState>(() => ({ scenes: null, failed: false, shown: null, edgeBand: null }));

let loading: Promise<void> | null = null;

/** Reads the manifest once. Asked for again after a failure. */
export function loadScenes(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}backgrounds/manifest.json`, { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then((raw: unknown) => {
      const m = parseManifest(raw);
      if (m) useBackdrop.setState({ scenes: m.scenes, edgeBand: m.edgeBand, failed: false });
      else throw new Error('backgrounds manifest unreadable');
    })
    .catch(() => {
      loading = null;
      useBackdrop.setState({ failed: true });
    });
  return loading;
}

/** The member chose: a scene's id, or "none". Saved in the layout document like any other preference, and applied at once. */
export function chooseBackground(id: string): void {
  setLayoutPref({ background: id });
}

/** What the member's preference says, as this build reads it. */
export const backgroundPref = (): string | undefined => parseBackgroundPref(useLayoutPrefs.getState()['background']);

/** A browser asking for less data stops at 1920 wide. */
function saveData(): boolean {
  try {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    return nav.connection?.saveData === true || window.matchMedia('(prefers-reduced-data: reduce)').matches;
  } catch {
    return false;
  }
}

function picture(scene: Scene): HTMLPictureElement {
  const pic = document.createElement('picture');
  const sources = pictureSources(import.meta.env.BASE_URL, scene, saveData() ? SAVE_DATA_MAX_WIDTH : Infinity);
  const last = sources[sources.length - 1]!;
  for (const s of sources.slice(0, -1)) {
    const source = document.createElement('source');
    source.type = s.type;
    source.srcset = s.srcset;
    source.sizes = '100vw';
    pic.append(source);
  }
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.fetchPriority = 'low';
  img.sizes = '100vw';
  img.className = 'ma-backdrop-img';
  // The fade is the stylesheet's 300 ms, and none at all under reduced motion (the stylesheet's rule too).
  if (reducedMotion()) img.style.transition = 'none';
  img.addEventListener('load', () => img.classList.add('on'), { once: true });
  img.srcset = last.srcset;
  pic.append(img);
  return pic;
}

let mounted = false;

/** Takes over `.ma-backdrop` from `boot.ts`'s paint. Called once, after the canvas's first paint. */
export function mountBackdrop(): void {
  if (mounted) return;
  const el = document.querySelector<HTMLElement>('.ma-backdrop');
  if (!el) return;
  mounted = true;
  const root = document.documentElement;

  const apply = (): void => {
    const scenes = useBackdrop.getState().scenes;
    if (!scenes) return; // the mirror's paint stays until the manifest is read
    const theme = useThemeStore.getState().resolved as ThemeId;
    const scene = sceneFor(backgroundPref(), theme, scenes);
    const id = scene?.id ?? NONE;
    const state = useBackdrop.getState();
    if (state.shown === id && root.getAttribute('data-backdrop') === (scene?.id ?? null)) return;
    el.querySelector('picture')?.remove();
    paintBackdrop(root, scene);
    // The edge bands under the scrim (ADR 0094): the manifest's tuning while a scene shows, else the stylesheet's defaults.
    const band = scene ? state.edgeBand : null;
    if (band) {
      root.style.setProperty('--ma-backdrop-band', band.color);
      root.style.setProperty('--ma-backdrop-band-tb', `${band.topBottom * 100}%`);
      root.style.setProperty('--ma-backdrop-band-side', `${band.sides * 100}%`);
    } else {
      for (const k of ['--ma-backdrop-band', '--ma-backdrop-band-tb', '--ma-backdrop-band-side']) root.style.removeProperty(k);
    }
    if (scene) el.append(picture(scene));
    writeJson(MIRROR_KEY, scene ? { id, theme, average: scene.average, placeholder: scene.placeholder } : { id, theme });
    useBackdrop.setState({ shown: id });
  };

  useBackdrop.subscribe(apply);
  useLayoutPrefs.subscribe(apply);
  useThemeStore.subscribe(apply);
  void loadScenes();
}
