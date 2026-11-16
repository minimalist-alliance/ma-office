// The only file allowed to hold color literals (ADR 0029, ESLint rule `ma/no-color-literals`).
// Semantic tokens and values follow docs/desk-design.md section 3.12. Every theme is typed
// as `Tokens`, so TypeScript rejects a theme that misses a key.
//
// Extras the design table lacks (surface.fill, surface.fillStrong, surface.chrome, surface.chip,
// glyph.soft, glyph.page, status.offline) come from the prototype's tokens, so the
// ported UI keeps its look.
//
// The `dusk` theme is Zen (ADR 0093): a cool slate office with wood only on the desks, and cool near-whites in place of
// ADR 0050's neutral ones. Reverting is a change to this file only.
import { NOTEBOOK_SCHEME } from '../../notebook/src/ui/ink.ts';


/** One shadow layer. Canvas sprites draw layers with a blur or offset. A `spread` layer is a hairline, for CSS, and on a canvas only as `tileStacked`'s edge. `dx` and `inset` are CSS only (the window lift's lit edge, `WINDOW_LIFT`). */
export interface ShadowLayer {
  dx?: number;
  dy: number;
  blur: number;
  spread?: number;
  color: string;
  inset?: boolean;
}

export interface Tokens {
  surface: {
    worldHi: string;
    worldBase: string;
    worldLo: string;
    panel: string;
    tile: string;
    window: string;
    overlay: string;
    sunken: string;
    scrim: string;
    /** The office tour's scrim (ADR 0056): lighter than `scrim`, which is for modals that replace the office, so the office stays readable around the spotlight. */
    spotlight: string;
    fill: string;
    fillStrong: string;
    chrome: string;
    chip: string;
    /** The scrim over an office background, composed as `backdropBlend` says: in Zen a navy that multiplies the picture (never a fog; the picture itself is toned down in the art pipeline). Scenes show in Zen only (the owner, Nov 11), so Light and Dark carry a transparent, never-drawn value. No text sits on the ground: the rings carry their own contrast (ADR 0094). */
    backdrop: string;
    /** How `backdrop` meets the picture: `multiply` (a darken) or `normal` (source-over). Not a colour; it becomes `--ma-surface-backdrop-blend`. */
    backdropBlend: 'normal' | 'multiply';
    /** The edge bands under the scrim, top and bottom, fading out at 14 % of the height, the same navy in every theme: the art pipeline measures text contrast under exactly them. The manifest's `grade.edge_band` may override it (and ask for side bands). */
    backdropBand: string;
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    link: string;
    onAccent: string;
    disabled: string;
    /** Destructive words, such as Delete (the kit's `text.danger`, Notebook look 6 of 9). `status.error` stays for error dots; counts are `badge` (the accent). */
    danger: string;
  };
  glyph: { default: string; soft: string; page: string; filesBody: string; filesSheet: string; filesFront: string; notebookTab: string };
  accent: { default: string; hover: string; pressed: string; subtle: string };
  border: { hairline: string; default: string; strong: string };
  focus: { ring: string };
  /** `halo`: a 1 px dark line outside the active desk's ring and the focus ring while a background shows, so the pair reads on any picture (ADR 0094). */
  ring: { activeDesk: string; activeGlow: string; halo: string };
  /** A desk's etched name and icons (ADR 0064): a cut, with a shaded upper wall, a fill, and a lit lower lip. */
  etch: { fill: string; wall: string; highlight: string };
  badge: { bg: string; fg: string };
  /**
   * Status dots, checks and the warn banners. In the brand's cool palette only (the owner's rule: no green, brown or warm
   * tint anywhere, moved Nov 13): `online` is the theme's accent blue, `warn` its strong cool neutral (Light the kit's
   * graphite), told apart by weight and the words beside them, never by a warning hue. `error` stays red, for a real
   * failure only (the kit's badges note).
   */
  status: { online: string; warn: string; error: string; offline: string };
  mark: { disc: string; fg: string };
  switcher: { track: string; selected: string; text: string };
  /**
   * The member's initials avatar (task 45; the Product Designer's badge spec, `spec.json`): six tints, one per member from
   * their id (`hueOf`, chrome/avatar.ts) and the same tint in every theme, each a top-to-bottom gradient with its own ink for
   * the initials at 4.5:1 or better. All cool (the owner's rule, no green, brown or warm tint; Nov 16, Zen's set taken to
   * Light and Dark): blue, a deep denim, a pale mist grey, periwinkle, steel and slate, told apart by lightness as much as
   * by hue. The Platform and Guild apps hold the same values (ma-platform `account.css` `--k-av-*`). `hairline` is the
   * circle's inset edge (none in Zen).
   */
  avatar: {
    blueTop: string; blueBottom: string; blueInk: string;
    denimTop: string; denimBottom: string; denimInk: string;
    mistTop: string; mistBottom: string; mistInk: string;
    periwinkleTop: string; periwinkleBottom: string; periwinkleInk: string;
    steelTop: string; steelBottom: string; steelInk: string;
    slateTop: string; slateBottom: string; slateInk: string;
    hairline: string;
  };
  /** A tier's badge on the avatar, option 1's corner seal (same spec): `officer` outlined with a chevron, `lead` solid with a star. */
  seal: { officerFill: string; officerLine: string; officerMark: string; leadTop: string; leadBottom: string; leadMark: string };
  elevation: {
    tile: ShadowLayer[];
    /** Only a tile that overlaps one below it, or one being dragged (ADR 0064): a stronger shadow, and an edge. This is the one exception to Zen's flat tiles. */
    tileStacked: ShadowLayer[];
    /** A resting tile on a textured desk: `tile`, and in Dark the 1 px edge it otherwise lacks against the grain. */
    tileTextured: ShadowLayer[];
    panel: ShadowLayer[];
    panelActive: ShadowLayer[];
    window: ShadowLayer[];
    menu: ShadowLayer[];
  };
}

const shadow = (dy: number, blur: number, color: string): ShadowLayer => ({ dy, blur, color });
/** An rgba string from parts, here because this is the one file that may spell a color: the manifest's edge band is read through it. */
export const rgba = (r: number, g: number, b: number, a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`;
const hairline = (color: string): ShadowLayer => ({ dy: 0, blur: 0, spread: 1, color });

const light: Tokens = {
  surface: {
    worldHi: '#F8F8F9',
    worldBase: '#E9EBEF',
    worldLo: '#DCE0E8',
    panel: '#FDFDFD',
    tile: '#FFFFFF',
    window: '#FFFFFF',
    overlay: '#FFFFFF',
    sunken: '#F3F4F6',
    scrim: 'rgba(20, 24, 32, 0.32)',
    spotlight: 'rgba(20, 24, 32, 0.28)',
    fill: '#ECEEF2',
    fillStrong: '#DFE2E6',
    chrome: 'rgba(251, 251, 252, 0.96)',
    chip: '#FFFFFF',
    backdrop: 'rgba(0, 0, 0, 0)',
    backdropBlend: 'normal',
    backdropBand: 'rgba(12, 16, 26, 0.40)',
  },
  text: {
    primary: '#2B2D31',
    secondary: '#5F6166',
    tertiary: '#666970',
    // The kit's link (`docs/assets/brand/ui/tokens.json`, the Designer's pick, Nov 11; accent.hover's value): 4.96:1 or more on
    // every Light ground. The accent's #3D6FA8 was 4.48:1 on surface.fill and 4.00:1 on fillStrong (BRAND-19/20).
    link: '#355F91',
    onAccent: '#FFFFFF',
    disabled: '#A3A6AC',
    danger: '#D0201F',
  },
  glyph: { default: '#4A5158', soft: '#8B939C', page: '#EEF0F3', filesBody: '#4A5158', filesSheet: '#EEF0F3', filesFront: '#9FACBE', notebookTab: NOTEBOOK_SCHEME.light.accent },
  accent: { default: '#3D6FA8', hover: '#355F91', pressed: '#2D5079', subtle: '#E8F0FF' },
  border: { hairline: 'rgba(16, 24, 40, 0.06)', default: 'rgba(16, 24, 40, 0.12)', strong: '#80858E' },
  focus: { ring: '#3D6FA8' },
  ring: { activeDesk: '#747F8F', activeGlow: 'rgba(116, 127, 143, 0.06)', halo: 'rgba(16, 20, 28, 0.95)' },
  etch: { fill: '#70757D', wall: '#3A3F47', highlight: '#FFFFFF' },
  badge: { bg: '#3D6FA8', fg: '#FFFFFF' },
  status: { online: '#3D6FA8', warn: '#3E4553', error: '#D0201F', offline: '#80858E' },
  mark: { disc: '#FFFFFF', fg: '#2B2D31' },
  switcher: { track: '#E9EBEF', selected: '#D3D6DB', text: '#1F2124' },
  avatar: {
    // Zen's six, lighter: mist palest, then blue, periwinkle, steel and slate with dark ink, and a deep denim with white.
    blueTop: '#D2E1F5', blueBottom: '#C6D8EE', blueInk: '#304662',
    denimTop: '#50719E', denimBottom: '#476A98', denimInk: '#F8FAFD',
    mistTop: '#EDF0F3', mistBottom: '#E2E7ED', mistInk: '#404952',
    periwinkleTop: '#C6CDF1', periwinkleBottom: '#BCC3E9', periwinkleInk: '#32375C',
    steelTop: '#9FBCCF', steelBottom: '#93B3C8', steelInk: '#13242E',
    slateTop: '#9EA5AE', slateBottom: '#949CA8', slateInk: '#13161C',
    hairline: 'rgba(42, 46, 53, 0.07)',
  },
  seal: { officerFill: '#FFFFFF', officerLine: '#5076AA', officerMark: '#3E5F8C', leadTop: '#5B7FB0', leadBottom: '#3E5F8C', leadMark: '#FFFFFF' },
  elevation: {
    tile: [shadow(2, 6, 'rgba(20, 30, 50, 0.10)')],
    tileTextured: [shadow(2, 6, 'rgba(20, 30, 50, 0.10)')],
    tileStacked: [shadow(4, 14, 'rgba(20, 30, 50, 0.22)'), hairline('rgba(16, 24, 40, 0.14)')],
    panel: [shadow(12, 32, 'rgba(30, 40, 60, 0.14)'), shadow(2, 6, 'rgba(30, 40, 60, 0.06)')],
    panelActive: [shadow(12, 32, 'rgba(61, 111, 168, 0.18)'), shadow(2, 6, 'rgba(30, 40, 60, 0.06)')],
    window: [shadow(24, 64, 'rgba(20, 30, 50, 0.22)')],
    menu: [shadow(8, 24, 'rgba(20, 30, 50, 0.16)')],
  },
};

// Zen (the `dusk` id; ADR 0093): a natural theme, kept cool. Slate surfaces in MA's own blue-grey (the owner, Nov 10:
// "I hate brown"; only the desks keep a hint of wood), near-white text with a cool cast, MA's blue softened as the accent,
// that blue for online and a cool near-white for warn (Nov 13: no green or gold). Its lines are the white at low alpha.
const DUSK_HAIRLINE = 'rgba(241, 243, 247, 0.08)';
const DUSK_BORDER = 'rgba(241, 243, 247, 0.14)';

const dusk: Tokens = {
  surface: {
    // The office's ground is lighter than a desk's panel, so desks stand apart from it (the owner, 2026-11-08: it was
    // the panel's own color). Text, the focus ring and the active desk's ring still meet their contrast on it.
    worldHi: '#535A69',
    worldBase: '#4D5463',
    worldLo: '#474E5C',
    panel: '#404654',
    tile: '#474D5B',
    window: '#404654',
    overlay: '#474D5B',
    sunken: '#393F4B',
    scrim: 'rgba(16, 20, 30, 0.45)',
    spotlight: 'rgba(12, 16, 26, 0.42)',
    fill: '#4A505E',
    fillStrong: '#555C6B',
    // The bars' pills: a deep slate at 90 %, the owner's direction (near opaque, as `backgrounds.shell.spec.ts` holds them).
    chrome: 'rgba(26, 32, 44, 0.90)',
    chip: '#555C6B',
    backdrop: 'rgba(12, 16, 26, 0)',
    backdropBlend: 'multiply',
    backdropBand: 'rgba(12, 16, 26, 0.40)',
  },
  text: {
    primary: '#F1F3F7',
    secondary: '#DFE3EA',
    tertiary: '#D3D8E0',
    link: '#C4D7EC',
    onAccent: '#1B2029',
    disabled: '#9AA1AD',
    danger: '#F8D0C8',
  },
  glyph: { default: '#DFE3EA', soft: '#AEB5C1', page: '#5B6271', filesBody: '#A0A5AC', filesSheet: '#EDF0F4', filesFront: '#BBC9DB', notebookTab: NOTEBOOK_SCHEME.dusk.accent },
  accent: { default: '#A9C4E4', hover: '#B8CFEA', pressed: '#98B6DA', subtle: '#3C4D66' },
  border: { hairline: DUSK_HAIRLINE, default: DUSK_BORDER, strong: '#A9B1BE' },
  focus: { ring: '#C9DBF0' },
  ring: { activeDesk: '#C3CBD8', activeGlow: 'rgba(195, 203, 216, 0.05)', halo: 'rgba(12, 16, 26, 0.95)' },
  etch: { fill: '#D4DAE3', wall: '#1E222B', highlight: 'rgba(241, 243, 247, 0.30)' },
  badge: { bg: '#A9C4E4', fg: '#1B2029' },
  status: { online: '#A9C4E4', warn: '#DFE3EA', error: '#F2A99C', offline: '#B6BEC9' },
  mark: { disc: '#E9ECF1', fg: '#2A2F38' },
  switcher: { track: '#393F4B', selected: '#555C6B', text: '#F1F3F7' },
  avatar: {
    // The first cool set (Light and Dark took it Nov 16): no green or warm tint, the desks alone may be warm (the owner).
    blueTop: '#A3BAD8', blueBottom: '#99B2D4', blueInk: '#282F3A',
    denimTop: '#4F709B', denimBottom: '#466792', denimInk: '#F6F8FC',
    mistTop: '#D3D9E2', mistBottom: '#C8CFDA', mistInk: '#262B34',
    periwinkleTop: '#BFCDF2', periwinkleBottom: '#B3C3EE', periwinkleInk: '#222B45',
    steelTop: '#90B0C6', steelBottom: '#86A7BE', steelInk: '#0E202C',
    slateTop: '#868E9B', slateBottom: '#7E8692', slateInk: '#13161B',
    hairline: 'transparent',
  },
  seal: { officerFill: '#4F5663', officerLine: '#A5BCDD', officerMark: '#B6C9E4', leadTop: '#B6C9E4', leadBottom: '#94AFD5', leadMark: '#15171B' },
  elevation: {
    tile: [],
    tileTextured: [],
    // Deeper since tiles rest on a lift (APP-TILES), so in hand still reads clearly above one at rest (the brand review).
    tileStacked: [shadow(5, 14, 'rgba(16, 20, 30, 0.50)'), hairline('rgba(241, 243, 247, 0.22)')],
    panel: [shadow(1, 2, 'rgba(16, 20, 30, 0.35)'), hairline(DUSK_HAIRLINE)],
    panelActive: [shadow(1, 2, 'rgba(16, 20, 30, 0.35)'), hairline(DUSK_HAIRLINE)],
    window: [shadow(4, 12, 'rgba(16, 20, 30, 0.35)'), hairline(DUSK_BORDER)],
    menu: [shadow(2, 8, 'rgba(16, 20, 30, 0.35)')],
  },
};

const DARK_HAIRLINE = 'rgba(236, 237, 239, 0.06)';
const DARK_BORDER = 'rgba(236, 237, 239, 0.12)';

const dark: Tokens = {
  surface: {
    worldHi: '#1E2126',
    worldBase: '#1A1D21',
    worldLo: '#16181C',
    panel: '#24272C',
    tile: '#2A2D33',
    window: '#26292E',
    overlay: '#2E3238',
    sunken: '#1F2226',
    scrim: 'rgba(8, 9, 11, 0.60)',
    spotlight: 'rgba(5, 6, 8, 0.44)',
    fill: '#33373E',
    fillStrong: '#3A3E45',
    chrome: 'rgba(38, 41, 46, 0.96)',
    chip: '#3A3E45',
    backdrop: 'rgba(0, 0, 0, 0)',
    backdropBlend: 'normal',
    backdropBand: 'rgba(12, 16, 26, 0.40)',
  },
  text: {
    primary: '#ECEDEF',
    secondary: '#B7BBC2',
    tertiary: '#9FA4AC',
    link: '#8DB3E6',
    onAccent: '#14171B',
    disabled: '#6B7078',
    danger: '#F48C91',
  },
  glyph: { default: '#C9CDD3', soft: '#858D97', page: '#3A4048', filesBody: '#858D97', filesSheet: '#E1E5EA', filesFront: '#A8B5C8', notebookTab: NOTEBOOK_SCHEME.dark.accent },
  accent: { default: '#7FA7DD', hover: '#93B6E4', pressed: '#6B95CF', subtle: '#22344D' },
  border: { hairline: DARK_HAIRLINE, default: DARK_BORDER, strong: '#757B85' },
  focus: { ring: '#8DB3E6' },
  ring: { activeDesk: '#8692A3', activeGlow: 'rgba(134, 146, 163, 0.05)', halo: 'rgba(5, 6, 8, 0.95)' },
  etch: { fill: '#A6ACB6', wall: '#050608', highlight: 'rgba(255, 255, 255, 0.22)' },
  badge: { bg: '#7FA7DD', fg: '#14171B' },
  status: { online: '#7FA7DD', warn: '#C9CDD3', error: '#F0646A', offline: '#7D848D' },
  mark: { disc: '#DADDE2', fg: '#1E2126' },
  switcher: { track: '#1F2226', selected: '#3A3E45', text: '#ECEDEF' },
  avatar: {
    // Zen's six on the dark ground: denim, blue and slate deep with pale ink; steel, periwinkle and mist lighter with dark ink.
    blueTop: '#4D6685', blueBottom: '#445F7F', blueInk: '#E2EAF6',
    denimTop: '#2D4A75', denimBottom: '#25436F', denimInk: '#DCE5F4',
    mistTop: '#A9ADB3', mistBottom: '#9FA6AE', mistInk: '#12161B',
    periwinkleTop: '#9198C0', periwinkleBottom: '#8990BB', periwinkleInk: '#101221',
    steelTop: '#6F8DA0', steelBottom: '#66869A', steelInk: '#040C12',
    slateTop: '#51575E', slateBottom: '#495059', slateInk: '#E5E8EC',
    hairline: 'rgba(232, 234, 237, 0.06)',
  },
  seal: { officerFill: '#383C45', officerLine: '#6A8DBF', officerMark: '#93AED5', leadTop: '#7D9DCA', leadBottom: '#5F83B4', leadMark: '#15171B' },
  elevation: {
    tile: [shadow(1, 3, 'rgba(5, 6, 8, 0.40)')],
    tileTextured: [shadow(1, 3, 'rgba(5, 6, 8, 0.40)'), hairline('rgba(255, 255, 255, 0.12)')],
    tileStacked: [shadow(4, 14, 'rgba(0, 0, 0, 0.60)'), hairline('rgba(255, 255, 255, 0.12)')],
    panel: [shadow(8, 24, 'rgba(5, 6, 8, 0.45)'), hairline(DARK_HAIRLINE)],
    panelActive: [shadow(8, 24, 'rgba(111, 147, 198, 0.20)'), hairline(DARK_HAIRLINE)],
    window: [shadow(16, 48, 'rgba(5, 6, 8, 0.55)'), hairline(DARK_BORDER)],
    menu: [shadow(8, 24, 'rgba(5, 6, 8, 0.50)')],
  },
};

export type ThemeId = 'light' | 'dusk' | 'dark';
export const THEME_IDS: readonly ThemeId[] = ['light', 'dusk', 'dark'];
/** What a member reads for each theme. The `dusk` id reads "Zen" (ADR 0093); this is the only place the name lives. */
export const THEME_LABELS: Record<ThemeId, string> = { light: 'Light', dusk: 'Zen', dark: 'Dark' };
export const THEMES: Record<ThemeId, Tokens> = { light, dusk, dark };

/**
 * Each app's own icon accent (the owner's pick, Nov 15: palette C, the full muted spectrum; the Product Designer's
 * `design-drafts/app-accents/`): per theme, in sRGB from CIE LCh. Browser (the office blue), Files (Silver) and the Bible
 * (Lapis) keep theirs and are not listed. Only the icons read these (`drawGlyph`): badges, focus rings, links, selected
 * states and every app window's ink stay the office blue, and Notebook's window stays its Navy ink. Every accent is 3:1 or
 * more on its tile and on the panel under the window heads and the thumb row.
 */
export const APP_ACCENTS: Record<string, Record<ThemeId, string>> = {
  notebook: { light: '#AB874A', dusk: '#EACA9D', dark: '#C09E6A' },
  agent: { light: '#6C759E', dusk: '#959ECC', dark: '#878EB2' },
  // Coral since Nov 15 night (COURIER-ACCENT, the owner: clay "reads too brown"): CIE LCh hue 34 for 44 at a step more chroma
  // (L*/C* 58/34, 71/26, 73/30), the Product Designer's `design-drafts/app-tiles/src/courier_try.py`.
  courier: { light: '#C3776C', dusk: '#DD9F94', dark: '#E9A296' },
  todo: { light: '#5B7960', dusk: '#B4D8BA', dark: '#718D76' },
  documents: { light: '#548EA7', dusk: '#84A5B6', dark: '#5C8193' },
  commons: { light: '#AB6C78', dusk: '#C8A5AB', dark: '#C88A96' },
};
/**
 * An agent's colour (the owner, Nov 15), by id: the app accents above and the office blue, so an agent's colour is always one an
 * app already wears, 3:1 or more on its tile in every theme. The names and the order a new agent takes them in are the Agent
 * app's (`web/agent/src/look/colors.ts`); the lead keeps the Agent app's own (`indigo`).
 */
export const AGENT_COLORS: Record<string, Record<ThemeId, string>> = {
  blue: { light: light.accent.default, dusk: dusk.accent.default, dark: dark.accent.default },
  sage: APP_ACCENTS['todo']!,
  amber: APP_ACCENTS['notebook']!,
  rose: APP_ACCENTS['commons']!,
  harbor: APP_ACCENTS['documents']!,
  clay: APP_ACCENTS['courier']!,
  indigo: APP_ACCENTS['agent']!,
};
/** Token sets made by `accentTokens`: draw3d's fallback (no relative colour) works their stops out instead of reading its table. */
export const ACCENTED = new WeakSet<object>();
const accented = new Map<string, Tokens>();
/** `t` with app `app`'s own icon accent in place of the office blue (and Notebook's tab), or `t` itself for an app without one. */
export function accentTokens(app: string, t: Tokens, id: ThemeId): Tokens {
  const hex = APP_ACCENTS[app]?.[id];
  if (!hex) return t;
  return inkTokens(app, hex, t, id);
}
/**
 * `t` with `hex` as the icon accent, kept by `key` (an app's own, or an agent's colour: `agent-color:<id>`), so each set is
 * one object a sprite cache can key on.
 */
export function inkTokens(name: string, hex: string, t: Tokens, id: ThemeId): Tokens {
  const key = `${name}:${id}:${hex}`;
  let r = accented.get(key);
  if (!r || r.glyph.default !== t.glyph.default) {
    r = { ...t, accent: { ...t.accent, default: hex }, glyph: { ...t.glyph, notebookTab: hex } };
    ACCENTED.add(r);
    accented.set(key, r);
  }
  return r;
}
/**
 * The Browser's simplified view (task 47; the Product Designer's spec, `design-drafts/simplified/sv.css`, proposed as kit
 * additions). `media` is drawn over a video, so it's the same dark glass in every theme (Zen's cool near-whites, as ever):
 * the letterbox, the controls' glyphs and text, the shade under them (`mediaShade` at 38%, `mediaShadeDeep` at the edge,
 * so the time holds 4.5:1 over a white frame: the spec's section 12), the scrubber's track and buffered part, the play
 * disc and the duration badge. `star` is a rating's, `status.warn` in each theme (a cool ink since Nov 13, never gold). `photoWell` is white in every
 * theme (Zen's cool near-white, as its whites are): product photos are shot on white, and a dark band round one reads as a hole (the Designer's brand review).
 */
export interface ViewTokens {
  star: string;
  mediaLetterbox: string;
  mediaFg: string;
  mediaShade: string;
  mediaShadeDeep: string;
  mediaTrack: string;
  mediaBuffered: string;
  mediaDisc: string;
  mediaBadge: string;
  photoWell: string;

}

/**
 * The simplified view's tokens, by theme: as `--ma-view-*` in themes.css (`themeCss.ts`, at build time). Nothing at run time
 * reads them, so they stay out of the bundle; the view's own chunk uses only the CSS variables.
 */
export const VIEW: Record<ThemeId, ViewTokens> = {
  light: { star: '#3E4553', mediaLetterbox: '#0E1013', mediaFg: '#FFFFFF', mediaShade: 'rgba(10, 12, 15, 0.6)', mediaShadeDeep: 'rgba(10, 12, 15, 0.72)', mediaTrack: 'rgba(255, 255, 255, 0.28)', mediaBuffered: 'rgba(255, 255, 255, 0.38)', mediaDisc: 'rgba(18, 20, 24, 0.52)', mediaBadge: 'rgba(12, 14, 17, 0.72)', photoWell: '#FFFFFF' },
  dusk: { star: '#DFE3EA', mediaLetterbox: '#0E1013', mediaFg: '#F1F3F7', mediaShade: 'rgba(10, 12, 15, 0.6)', mediaShadeDeep: 'rgba(10, 12, 15, 0.72)', mediaTrack: 'rgba(241, 243, 247, 0.28)', mediaBuffered: 'rgba(241, 243, 247, 0.38)', mediaDisc: 'rgba(18, 20, 24, 0.52)', mediaBadge: 'rgba(12, 14, 17, 0.72)', photoWell: '#F1F3F7' },
  dark: { star: '#C9CDD3', mediaLetterbox: '#0E1013', mediaFg: '#FFFFFF', mediaShade: 'rgba(10, 12, 15, 0.6)', mediaShadeDeep: 'rgba(10, 12, 15, 0.72)', mediaTrack: 'rgba(255, 255, 255, 0.28)', mediaBuffered: 'rgba(255, 255, 255, 0.38)', mediaDisc: 'rgba(18, 20, 24, 0.52)', mediaBadge: 'rgba(12, 14, 17, 0.72)', photoWell: '#FFFFFF' },
};

/**
 * An app tile's face on a desk (the owner, Nov 15 night: "proper, clean bevel and lift", and the APP-TILES row): every tile
 * rests on a lift, a contact shadow under a soft one (the window lift's recipe at a tile's size; a third lighter since the
 * owner's look at 6.6: "tone down the shadowing 1/3 and the bezel effect just slightly"), and its edge is a bevel lit
 * from the top left (the window lift's lit edge, enlarged): `lit` inside the top edge, fading down the left side, `shade`
 * inside the foot. No glow, no rim of colour. An icon's tile is tinted by its app's accent (`TILE_TINT`), with a very subtle
 * egg-shaped gradient, lightest where the icon sits. A widget's card is the plain tile with the same bevel and lift. Drawn by
 * `canvas/sprites.ts` `tileSprite`; an agent's mark in the DOM (`AgentMark`) wears the same.
 */
export interface TileFaceTokens {
  /** A tile at rest. Over another, or in hand, it's `elevation.tileStacked`'s, as before. */
  lift: ShadowLayer[];
  /** The lit top edge. */
  lit: string;
  /** The shaded foot. */
  shade: string;
}

export const TILE_FACE: Record<ThemeId, TileFaceTokens> = {
  light: {
    lift: [shadow(1, 2, 'rgba(20, 30, 50, 0.08)'), shadow(3, 8, 'rgba(20, 30, 50, 0.07)')],
    lit: 'rgba(255, 255, 255, 0.83)',
    shade: 'rgba(20, 30, 50, 0.095)',
  },
  dusk: {
    lift: [shadow(1, 2, 'rgba(16, 20, 30, 0.24)'), shadow(2, 6, 'rgba(16, 20, 30, 0.16)')],
    lit: 'rgba(241, 243, 247, 0.19)',
    shade: 'rgba(16, 20, 30, 0.26)',
  },
  dark: {
    lift: [shadow(1, 2, 'rgba(5, 6, 8, 0.33)'), shadow(3, 8, 'rgba(5, 6, 8, 0.23)')],
    lit: 'rgba(236, 237, 239, 0.11)',
    shade: 'rgba(5, 6, 8, 0.36)',
  },
};

/**
 * How an icon's tile takes its app's accent (APP-TILES), in OKLab: the accent's hue at `share` of its chroma, at most `max`,
 * over `cast` of the tile's own cool cast, so in Zen and Dark a tile stays in the slate family with a hint of its app (a warm
 * accent there at full strength reads brown), and in Light (white, no cast) it's a pale wash. The egg's lightness (OKLab L) is
 * `centre` where the icon sits and `rim` at its edge, a very subtle fall-off lit from the front. In Zen and Dark the centre is
 * the tile's own lightness, so every icon keeps the contrast it has on the plain tile; in Light it's a step under white
 * (`tileFace.test.ts` holds every accent at 3:1 or more on the centre in every theme).
 */
export interface TileTint {
  share: number;
  max: number;
  cast: number;
  /** How much less chroma an orange-to-amber accent gives a dark tile (none in Light): a warm tint there is what reads brown. */
  warm: number;
  centre: number;
  rim: number;
}

export const TILE_TINT: Record<ThemeId, TileTint> = {
  light: { share: 0.2, max: 0.014, cast: 0, warm: 0, centre: 0.98, rim: 0.955 },
  dusk: { share: 0.3, max: 0.016, cast: 0.5, warm: 0.9, centre: 0.42, rim: 0.4 },
  dark: { share: 0.25, max: 0.012, cast: 0.5, warm: 1, centre: 0.297, rim: 0.28 },
};

/**
 * The app tile's face (the owner, Nov 16: release 6.6's bevel is "a bit tacky… I want a macOS liquid look"; of the three looks on
 * the glass sheet, `design-drafts/app-tiles/glass/`, his pick: "I want C restrained for the app tiles"): an icon's tile as a thick
 * piece of glass, restrained. The tile's own tint (`TILE_TINT`'s egg) is the glass, mostly solid, with the desk a little through
 * it, frosted, and bent at the rim; a thin light hugs the rim, brightest at the top left and fading round the edge to a faint
 * glint opposite; depth from light, barely there; a contact shadow under a soft one. No bevel, no shaded foot, no hairline.
 * Drawn by `canvas/glass.ts`. Under reduced transparency or more contrast an icon's tile is the solid face (`TILE_FACE`), and so
 * is a widget's card always. The startup chooser's highlighted option wears the same dials in CSS (`glassCss.ts`).
 */
export interface GlassFace {
  /** How much of the body covers the desk behind it (1 is the solid tile); more where the desk would wash the icons out (`glassOpacity`). */
  opacity: number;
  /** The band at the edge where the glass bends what's behind it, as a share of the tile's width. */
  band: number;
  /** How far, at the very edge, the glass reaches out for the desk beyond it, as a share of the band (0: no lens). */
  lens: number;
  /** The frost: how much the desk seen through the body is blurred, in desk px (0: clear). */
  frost: number;
  /** The specular: its colour `r, g, b`; its alpha at the lit corner (top left), at the glint opposite, and along the rest; px wide. */
  spec: string;
  specPeak: number;
  specBack: number;
  specFloor: number;
  specWidth: number;
  /** The soft light just inside the specular, a share of its alpha, and how far in it reaches (px). */
  glow: number;
  glowWidth: number;
  /** Depth from light: a broad sheen down from the top, its alpha. */
  sheen: number;
  /** The thick edge away from the light: a deepening inside the rim, `r, g, b` and its alpha at the edge. */
  depth: string;
  depthAlpha: number;
  /** The contact shadow, and a soft one. */
  lift: ShadowLayer[];
}

/** A glass colour (`r, g, b`) at alpha `a`. */
export const glassRgba = (rgb: string, a: number): string => `rgba(${rgb}, ${a})`;

/**
 * Any ground at all, for the office's chrome in glass (`glassCss.ts` `glassBodyDense`): mixing is per channel and luminance rises
 * with each, so black and white bound every colour that can be behind it.
 */
export const GLASS_ANY_GROUNDS = ['#000000', '#FFFFFF'] as const;

export const GLASS_FACE: Record<ThemeId, GlassFace> = {
  light: {
    opacity: 0.86, band: 0.14, lens: 0.15, frost: 2.5,
    spec: '255, 255, 255', specPeak: 0.7, specBack: 0.14, specFloor: 0.1, specWidth: 1, glow: 0.2, glowWidth: 2.5, sheen: 0.06,
    depth: '20, 30, 50', depthAlpha: 0.04,
    lift: [shadow(1, 1.5, 'rgba(20, 30, 50, 0.08)'), shadow(4, 10, 'rgba(20, 30, 50, 0.06)')],
  },
  dusk: {
    opacity: 0.88, band: 0.14, lens: 0.15, frost: 2.5,
    spec: '241, 243, 247', specPeak: 0.3, specBack: 0.1, specFloor: 0.07, specWidth: 1, glow: 0.2, glowWidth: 2.5, sheen: 0.03,
    depth: '16, 20, 30', depthAlpha: 0.08,
    lift: [shadow(1, 1.5, 'rgba(16, 20, 30, 0.22)'), shadow(3, 9, 'rgba(16, 20, 30, 0.15)')],
  },
  dark: {
    opacity: 0.88, band: 0.14, lens: 0.15, frost: 2.5,
    spec: '236, 237, 239', specPeak: 0.24, specBack: 0.08, specFloor: 0.05, specWidth: 1, glow: 0.2, glowWidth: 2.5, sheen: 0.02,
    depth: '5, 6, 8', depthAlpha: 0.11,
    lift: [shadow(1, 1.5, 'rgba(5, 6, 8, 0.33)'), shadow(4, 10, 'rgba(5, 6, 8, 0.22)')],
  },
};

/**
 * The window lift (the owner's pick on Nov 12: option 5 of the Product Designer's sheet, `design-drafts/window-lift`, "the
 * top-edge highlight plus the contact shadow"; ADR 0029's addendum). An app window on the office (`.ma-window`) sits on a
 * tight contact shadow at its base under a shorter soft one, in place of the menu's and the window's shadows, and every
 * window surface (the window, a desk's carousel stage, an open tile) has a 1 px edge lit from above as the icons are, from
 * the top left: the top strongest, the left a third of it. Each theme's line is its own near-white; Zen and Dark keep their
 * hairline round the active window. The values are the Designer's `options.py`, exactly.
 *
 * As `--ma-window-lift-*` in themes.css (`themeCss.ts`, at build time). Nothing at run time reads them, so they stay out of
 * the bundle, as `VIEW` does.
 */
export interface WindowLiftTokens {
  /** A window at rest, behind the active one. */
  rest: ShadowLayer[];
  /** The active window, and a full one. */
  active: ShadowLayer[];
  /** The lit edge, drawn inside the surface over its content (`::after`). */
  edge: ShadowLayer[];
}

const lit = (dx: number, dy: number, color: string): ShadowLayer => ({ dx, dy, blur: 0, color, inset: true });

export const WINDOW_LIFT: Record<ThemeId, WindowLiftTokens> = {
  light: {
    rest: [shadow(1, 3, 'rgba(20, 30, 50, 0.14)'), shadow(6, 18, 'rgba(20, 30, 50, 0.11)')],
    active: [shadow(1, 3, 'rgba(20, 30, 50, 0.18)'), shadow(18, 48, 'rgba(20, 30, 50, 0.15)')],
    edge: [lit(0, 1, 'rgba(255, 255, 255, 0.9)'), lit(1, 0, 'rgba(255, 255, 255, 0.3)')],
  },
  dusk: {
    rest: [shadow(1, 2, 'rgba(16, 20, 30, 0.45)'), shadow(2, 6, 'rgba(16, 20, 30, 0.26)')],
    active: [shadow(1, 2, 'rgba(16, 20, 30, 0.50)'), shadow(3, 10, 'rgba(16, 20, 30, 0.26)'), hairline(DUSK_BORDER)],
    edge: [lit(0, 1, 'rgba(241, 243, 247, 0.16)'), lit(1, 0, 'rgba(241, 243, 247, 0.053)')],
  },
  dark: {
    rest: [shadow(1, 3, 'rgba(5, 6, 8, 0.55)'), shadow(6, 18, 'rgba(5, 6, 8, 0.38)')],
    active: [shadow(1, 3, 'rgba(5, 6, 8, 0.65)'), shadow(12, 36, 'rgba(5, 6, 8, 0.42)'), hairline(DARK_BORDER)],
    edge: [lit(0, 1, 'rgba(236, 237, 239, 0.1)'), lit(1, 0, 'rgba(236, 237, 239, 0.033)')],
  },
};

/**
 * An app's own tint of the office (the owner, Nov 10: "their own unique color schemes", from the Product Designer's
 * `app-colors` tokens). Each key replaces one office property inside that app's window only, by `appThemeCss`:
 * `window` is `--ma-surface-window`, `sidebar` `--ma-surface-sunken`, `accent*` the accent set and `--ma-focus-ring`,
 * `accentSubtle` `--ma-accent-subtle`, `onAccent` `--ma-text-on-accent`, `link` `--ma-text-link`. Text, borders, status
 * and danger stay the office's. Files is "Silver"; another pick changes these values and nothing else. Keyed by the
 * window's `data-app`: an installed app's is `app:<manifest id>` (ADR 0054), and the desk app host passes its ink to the app's
 * view too (`deskapps/host/tokens.ts`). The Bible is "Lapis", the Product Designer's pick 1 (`design-drafts/bible-app`).
 */
export interface AppInk {
  window: string;
  sidebar: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentSubtle: string;
  onAccent: string;
  link: string;
}

export const APP_INKS: Record<string, Record<ThemeId, AppInk>> = {
  files: {
    light: { window: '#FBFCFE', sidebar: '#F1F3F5', accent: '#3F4E63', accentHover: '#334256', accentPressed: '#29384B', accentSubtle: '#DFE9F5', onAccent: '#FFFFFF', link: '#3F4E63' },
    dusk: { window: '#4A4D51', sidebar: '#414549', accent: '#BBC9DA', accentHover: '#C8D5E7', accentPressed: '#AFBCCD', accentSubtle: '#313D4D', onAccent: '#1B2029', link: '#C8D5E7' },
    dark: { window: '#24272B', sidebar: '#1E2125', accent: '#99A6B7', accentHover: '#A9B5C7', accentPressed: '#8A96A7', accentSubtle: '#25303E', onAccent: '#14171B', link: '#99A6B7' },
  },
  'app:com.minimalistalliance.bible': {
    light: { window: '#FDFDFE', sidebar: '#F0F3F8', accent: '#2C51B6', accentHover: '#1F42A5', accentPressed: '#133395', accentSubtle: '#E0EAFE', onAccent: '#FFFFFF', link: '#2C51B6' },
    dusk: { window: '#414855', sidebar: '#39404E', accent: '#9FBDFE', accentHover: '#B2CAFE', accentPressed: '#90B0F4', accentSubtle: '#455577', onAccent: '#1B2029', link: '#B7CEFF' },
    dark: { window: '#22242A', sidebar: '#1B1D23', accent: '#759BF2', accentHover: '#86ACFF', accentPressed: '#668CE1', accentSubtle: '#273656', onAccent: '#14171B', link: '#81A8FF' },
  },
};

/**
 * Maia Mode's own values (CONCEPT.md Part 2 §2; the Product Designer's `design-drafts/maia-mode/src/chooser.css` and
 * `mock.css`, the owner's pick A2), by theme: as `--ma-maia-mode-*` in themes.css (`themeCss.ts`, at build time). Nothing at
 * run time reads them, so they stay out of the bundle, as `VIEW` does. Cool blues and neutrals only (the owner's rule: no
 * green, brown or warm tints).
 *  - `selTop`, `selFoot`: the startup chooser's highlighted option, a gentle top-to-foot gradient (window lift #5's spirit).
 *  - `selShade`: the soft inner shade at its foot. `selGlow`: its 1 px accent hairline and cool glow.
 *  - `field`, `fieldEdge`: Maia's glow in the room, the accent at the Designer's two strengths.
 *  - `me`: the member's own lines in the chat.
 *  - `veil`: what lies under the room's words in Zen, over the member's office picture (none in Light and Dark).
 *  - The focus shield's tray (the Product Designer's brand pass, `design-drafts/maia-shield-brand/DIRECTION.md`): every surface
 *    Maia hands something over on (the card, the catch-up, the sheet, What reaches you) is one lifted material. `trayTop` and
 *    `trayFoot` are its top-to-foot gradient, `trayInset` the sunken tray inside it (riders, the question, the tally, settings
 *    groups), `soft` and `softHover` the soft pill (a time choice), `pillLit` the primary pill's lit top, `scrim` the light veil
 *    under the sheet.
 */
export interface MaiaModeTokens {
  selTop: string;
  selFoot: string;
  selShade: ShadowLayer[];
  selGlow: ShadowLayer[];
  field: string;
  fieldEdge: string;
  me: string;
  veil: string;
  trayTop: string;
  trayFoot: string;
  trayInset: string;
  soft: string;
  softHover: string;
  pillLit: ShadowLayer[];
  scrim: string;
}

const glow = (color: string, blur: number, spread: number, line: string): ShadowLayer[] => [
  { dy: 0, blur: 0, spread: 1, color: line },
  { dy: 0, blur, spread, color },
];
const footShade = (color: string): ShadowLayer[] => [{ dy: -10, blur: 16, spread: -12, color, inset: true }];

export const MAIA_MODE: Record<ThemeId, MaiaModeTokens> = {
  light: {
    selTop: '#FFFFFF', selFoot: '#F1F4F8', selShade: footShade('rgba(20, 30, 50, 0.14)'),
    selGlow: glow('rgba(61, 111, 168, 0.26)', 26, 2, '#3D6FA8'),
    field: 'rgba(61, 111, 168, 0.13)', fieldEdge: 'rgba(61, 111, 168, 0.05)', me: '#E2E6ED', veil: 'rgba(233, 235, 239, 0)',
    trayTop: '#FFFFFF', trayFoot: '#F5F7FA', trayInset: '#EFF2F6', soft: '#E9EDF3', softHover: '#DEE4EC',
    pillLit: [lit(0, 1, 'rgba(255, 255, 255, 0.22)')], scrim: 'rgba(20, 30, 50, 0.14)',
  },
  dusk: {
    selTop: '#525969', selFoot: '#474D5B', selShade: footShade('rgba(16, 20, 30, 0.40)'),
    selGlow: glow('rgba(169, 196, 228, 0.24)', 28, 2, '#A9C4E4'),
    field: 'rgba(169, 196, 228, 0.20)', fieldEdge: 'rgba(169, 196, 228, 0.06)', me: 'rgba(85, 92, 107, 0.86)', veil: 'rgba(16, 22, 34, 0.38)',
    trayTop: '#4F5667', trayFoot: '#454B59', trayInset: '#3C4250', soft: '#596071', softHover: '#636B7C',
    pillLit: [lit(0, 1, 'rgba(241, 243, 247, 0.40)')], scrim: 'rgba(12, 16, 26, 0.30)',
  },
  dark: {
    selTop: '#32363D', selFoot: '#282B31', selShade: footShade('rgba(5, 6, 8, 0.55)'),
    selGlow: glow('rgba(127, 167, 221, 0.24)', 30, 3, '#7FA7DD'),
    field: 'rgba(127, 167, 221, 0.14)', fieldEdge: 'rgba(127, 167, 221, 0.05)', me: '#33373E', veil: 'rgba(26, 29, 33, 0)',
    trayTop: '#32363D', trayFoot: '#2A2E34', trayInset: '#24272C', soft: '#3B3F47', softHover: '#444951',
    pillLit: [lit(0, 1, 'rgba(255, 255, 255, 0.28)')], scrim: 'rgba(5, 6, 8, 0.40)',
  },
};

/**
 * Documents' viewer (the documents concept §8.1, `apps/documents/`), by theme: as `--ma-docs-*` in themes.css (`themeCss.ts`, at
 * build time). Pages stay paper white in every theme, framed by the theme's surface, so the paper and what marks it are the
 * same in all three: a page image is drawn white by the desk's sandbox whatever the office's theme.
 *  - `paper`: a page while its image is on its way, and the reading view's sheet (Zen's cool near-white there, ADR 0093).
 *    `paperInk`, `paperInkSoft`: text on it.
 *  - `paperEdge`: the hairline round a page on the theme's surface.
 *  - `mark`, `markEdge`: a changed line, the accent blue (Light's, which holds on white) at about 20 % with a 1 px edge.
 */
export interface DocsTokens {
  paper: string;
  paperInk: string;
  paperInkSoft: string;
  paperEdge: string;
  mark: string;
  markEdge: string;
}

const DOCS_PAPER: DocsTokens = { paper: '#FFFFFF', paperInk: '#2B2D31', paperInkSoft: '#5F6166', paperEdge: 'rgba(20, 24, 32, 0.14)', mark: 'rgba(61, 111, 168, 0.20)', markEdge: '#3D6FA8' };

export const DOCS: Record<ThemeId, DocsTokens> = {
  light: DOCS_PAPER,
  // Zen's whites are its cool near-white (ADR 0093), as `VIEW.photoWell`'s: the reading view's sheet and a page still on its way.
  dusk: { ...DOCS_PAPER, paper: '#F1F3F7', paperEdge: 'rgba(10, 14, 22, 0.40)' },
  dark: { ...DOCS_PAPER, paperEdge: 'rgba(5, 6, 8, 0.55)' },
};

/** CSS color-scheme per theme: native scrollbars and form controls follow it. */
export const COLOR_SCHEME: Record<ThemeId, 'light' | 'dark'> = { light: 'light', dusk: 'dark', dark: 'dark' };

/** Sizes that go with the ring tokens (design 3.12: 1.5 px ring, 4 px glow). */
export const RING = { width: 1, glow: 2 };

/**
 * A desk style's colors in one theme (`theme/deskStyles.ts`, the owner's desk textures). `base` is the flat surface under
 * its texture: what shows while the texture loads, behind a swatch, and against what the status line is checked. `etch`
 * is its etched name and icons, which the owner wants to blend into the desk ("dark text for dark mode, light text for
 * light, and medium for dusk", which is Zen). Values per style come from the Product Designer.
 */
export interface DeskStyleInk {
  base: string;
  etch: DeskEtch;
  /** Text drawn on the desk (the strip's status line and "Undo"): `text.secondary` where that holds 4.5:1 on `base`, otherwise a stronger ink. */
  deskText: string;
}

/** A style's etch. Like `Tokens['etch']`, but a null `highlight` draws no lit lip. */
export interface DeskEtch { fill: string; wall: string; highlight: string | null }

/**
 * Every desk style's colors, by style id and theme, from the Product Designer (`assets/desk-styles/desk-styles.json`). `plain` is
 * today's surface and etch. A null `highlight` is not drawn. In Zen (`dusk`, ADR 0093, Ash grey addendum) the three wood desks are
 * weathered grey wood: the brown taken out, a breath of the slate's blue, so none tips warm (the owner: "no green, brown or warm tints");
 * linoleum is a steel-blue slate. `deskText` in Zen is `#DFE3EA` on all four. */
/** base, etch fill, etch wall, etch highlight (null: none), and the text on the desk. */
const ink = (base: string, fill: string, wall: string, highlight: string | null, deskText: string): DeskStyleInk => ({ base, etch: { fill, wall, highlight }, deskText });

export const DESK_STYLE_INKS: Record<string, Record<ThemeId, DeskStyleInk>> = {
  oak: {
    light: ink('#A5A6A2', '#E3E3E0', '#5E5F5D', null, '#2A2E35'),
    dusk: ink('#43454C', '#74767C', '#292A2D', null, '#DFE3EA'),
    dark: ink('#3B3F48', '#07080A', '#040506', '#585B62', '#BEC2C9'),
  },
  // White oak (the owner, Nov 15: "a white oak, not quite as white as Plain but close", "Needs to be closer to white"):
  // near-white with faint tan strands in the grain. Light takes Plain's cut tinted from the wood (darker letters, white lip),
  // since light letters can't read on a near-white desk. Zen's inks have no warm hue; only its grain does (zenWood.shell.spec.ts).
  'white-oak': {
    light: ink('#FBF9F6', '#9D9C9B', '#555454', '#FFFFFF', '#5F6166'),
    dusk: ink('#606162', '#8E8E8F', '#3C3C3D', null, '#DFE3EA'),
    dark: ink('#4B4B4A', '#1E1E1E', '#161616', '#6B6B6A', '#BEC2C9'),
  },
  ash: {
    light: ink('#BFC0BC', '#FDFDFB', '#6E6F6D', null, '#2A2E35'),
    dusk: ink('#5F6168', '#898A90', '#3B3C40', null, '#DFE3EA'),
    dark: ink('#454A53', '#1A1D21', '#131517', '#666A71', '#BEC2C9'),
  },
  walnut: {
    light: ink('#3E4553', '#6B6F76', '#20242C', null, '#FAFAF7'),
    dusk: ink('#303238', '#606268', '#1C1D20', null, '#DFE3EA'),
    dark: ink('#383C45', '#030304', '#020202', '#54575E', '#BEC2C9'),
  },
  linoleum: {
    light: ink('#A8B0BB', '#EEEFEF', '#61656B', null, '#2A2E35'),
    dusk: ink('#3E4754', '#707884', '#262B32', null, '#DFE3EA'),
    dark: ink('#3E4756', '#14181F', '#0E1115', '#5E6572', '#BEC2C9'),
  },
  plain: {
    light: { base: light.surface.panel, etch: light.etch, deskText: light.text.secondary },
    dusk: { base: dusk.surface.panel, etch: dusk.etch, deskText: dusk.text.secondary },
    dark: { base: dark.surface.panel, etch: dark.etch, deskText: dark.text.secondary },
  },
};
