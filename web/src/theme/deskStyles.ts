// Desk styles (the owner's desk textures): how a desk's surface looks, chosen per desk from its menu, with one the
// default. A style has a member-facing name, a texture per theme (or none, for a flat surface), and its colors in
// `tokens.ts` (`DESK_STYLE_INKS`): the base under the texture, and the etch its name and icons are cut in.
//
// The choice is kept per desk in the layout document (`LayoutDesk.style`), which follows the member to every browser
// (`shell/layoutSync.ts`). No style stored means the default. An id this build doesn't know, from a newer one, is kept
// as it is and drawn as the default.
//
// Adding a style: its three images in `src/assets/desk-styles/` as `<id>-light.webp`, `<id>-dusk.webp` and
// `<id>-dark.webp` (seamless tiles; `DeskTexture` says how big), its colors in `DESK_STYLE_INKS`, and an entry in
// `BUILT_IN` below, in the order members see them. An image is a key into `deskStyleFiles.ts`, where Vite emits each file
// (`assetsInlineLimit: 0`), and the canvas fetches it only when a desk in view wears it (`canvas/deskTexture.ts`), so
// none of it is in the JS. The chooser shows only when there are two styles or more.
import { DESK_STYLE_INKS, THEME_IDS, THEMES, type DeskStyleInk, type ThemeId } from './tokens';

/** A seamless tile, repeated across a desk from its top-left corner, in desk units, so it zooms with the desk. */
export interface DeskTexture {
  src: string;
  /** In pixels, each a power of two, so the smaller copies a zoomed-out view uses are exact halves. */
  width: number;
  height: number;
  /** Image pixels per desk unit. The built-in tiles are 2: one covers 512 units. */
  density: number;
}

export interface DeskStyleLook extends DeskStyleInk {
  /** `<style>.<theme>`: names this look in the keys of the bitmaps it's drawn into. */
  key: string;
  texture: DeskTexture | null;
}

export interface DeskStyle {
  id: string;
  /** What a member reads: a swatch's tooltip and accessible name. */
  name: string;
  looks: Record<ThemeId, DeskStyleLook>;
}

/** What's stored when a member picks one. Lower case, digits and hyphens, so it's never anything but an id. */
export const DESK_STYLE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const isDeskStyleId = (v: unknown): v is string => typeof v === 'string' && DESK_STYLE_ID.test(v);

type Textures = Record<ThemeId, DeskTexture | null>;
const NO_TEXTURE: Textures = { light: null, dusk: null, dark: null };

function looksOf(id: string, inks: Record<ThemeId, DeskStyleInk>, textures: Textures): Record<ThemeId, DeskStyleLook> {
  return Object.fromEntries(THEME_IDS.map((theme) => [theme, { key: `${id}.${theme}`, base: inks[theme].base, etch: inks[theme].etch, deskText: inks[theme].deskText, texture: textures[theme] }])) as Record<ThemeId, DeskStyleLook>;
}

function style(id: string, name: string, textures: Textures = NO_TEXTURE): DeskStyle {
  const inks = DESK_STYLE_INKS[id];
  if (!inks) throw new Error(`desk style ${id} has no colors in DESK_STYLE_INKS`);
  return { id, name, looks: looksOf(id, inks, textures) };
}

// In the order members see them: the Product Designer's four (`assets/desk-styles/desk-styles.json`), then Plain, today's
// flat surface. One 1024 px tile covers 512 desk units (density 2).
const tile = (src: string): DeskTexture => ({ src, width: 1024, height: 1024, density: 2 });
// A built-in tile's `src` is its key in `deskStyleFiles.ts` (`oak-light`), turned into a URL only when the image is fetched.
const textured = (id: string, name: string): DeskStyle => style(id, name, { light: tile(`${id}-light`), dusk: tile(`${id}-dusk`), dark: tile(`${id}-dark`) });
const BUILT_IN: readonly DeskStyle[] = [
  textured('oak', 'Light oak'),
  textured('ash', 'White ash'),
  textured('walnut', 'Walnut'),
  textured('linoleum', 'Linoleum'),
  style('plain', 'Plain'),
];

/** The style a desk wears until its member picks another. */
export const DEFAULT_DESK_STYLE = 'oak';
let defaultId = DEFAULT_DESK_STYLE;

/** A style a test brings, with its own colors and images: never in a production build. */
interface TestStyle {
  id: string;
  name: string;
  default?: boolean;
  /** Leaves only Plain of the built-in styles, so a test sees one flat style beside its own. */
  onlyPlain?: boolean;
  looks: Record<ThemeId, Omit<DeskStyleInk, 'deskText'> & { deskText?: string; texture: DeskTexture | null }>;
}

function withTestStyles(): readonly DeskStyle[] {
  if (import.meta.env.MODE === 'production' || typeof window === 'undefined') return BUILT_IN;
  const extra = (window as unknown as { __maTestDeskStyles?: TestStyle[] }).__maTestDeskStyles;
  if (!Array.isArray(extra)) return BUILT_IN;
  const base = extra.some((s) => s.onlyPlain) ? BUILT_IN.filter((b) => b.id === 'plain') : BUILT_IN;
  if (base !== BUILT_IN) defaultId = 'plain';
  const added = extra.filter((s) => isDeskStyleId(s.id) && !BUILT_IN.some((b) => b.id === s.id)).map((s): DeskStyle => {
    if (s.default) defaultId = s.id;
    const inks = Object.fromEntries(THEME_IDS.map((theme) => [theme, { base: s.looks[theme].base, etch: s.looks[theme].etch, deskText: s.looks[theme].deskText ?? THEMES[theme].text.secondary }])) as Record<ThemeId, DeskStyleInk>;
    const textures = Object.fromEntries(THEME_IDS.map((theme) => [theme, s.looks[theme].texture])) as Textures;
    return { id: s.id, name: s.name, looks: looksOf(s.id, inks, textures) };
  });
  return [...base, ...added];
}

const STYLES = withTestStyles();
const BY_ID = new Map(STYLES.map((s) => [s.id, s]));

/** Every style, in the order members see them. */
export const deskStyles = (): readonly DeskStyle[] => STYLES;

/** The one a desk wears until its member picks another. */
export const defaultDeskStyleId = (): string => defaultId;

/** A desk's style: what it stores, or the default for nothing stored and for an id this build doesn't know. */
export const deskStyleOf = (id: string | undefined): DeskStyle => (id && BY_ID.get(id)) || BY_ID.get(defaultId)!;

/**
 * Today's flat surface and etch, straight from the theme, whatever the registry holds. A desk draws this under
 * `prefers-contrast: more`, where the name is plain text and a texture would only stand between it and the surface.
 */
const FLAT = looksOf('flat', Object.fromEntries(THEME_IDS.map((theme) => [theme, { base: THEMES[theme].surface.panel, etch: THEMES[theme].etch, deskText: THEMES[theme].text.secondary }])) as Record<ThemeId, DeskStyleInk>, NO_TEXTURE);

/** How a desk looks in this theme. The same object every time, so a draw compares it and builds nothing. */
export const deskLook = (id: string | undefined, theme: ThemeId, moreContrast: boolean): DeskStyleLook => (moreContrast ? FLAT[theme] : deskStyleOf(id).looks[theme]);
