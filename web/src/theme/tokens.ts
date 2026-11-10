// The only file allowed to hold color literals (ADR 0029, ESLint rule `ma/no-color-literals`).
// Semantic tokens and values follow docs/desk-design.md section 3.12. Every theme is typed
// as `Tokens`, so TypeScript rejects a theme that misses a key.
//
// Extras the design table lacks (surface.fill, surface.fillStrong, surface.chrome, surface.chip,
// glyph.soft, glyph.globe, glyph.page, status.offline) come from the prototype's tokens, so the
// ported UI keeps its look.
//
// Dusk's whites are neutral, not warm: see ADR 0050 (T12). Reverting is a change to this file only.

/** One shadow layer. Canvas sprites draw layers with a blur or offset. A `spread` layer is a hairline, for CSS, and on a canvas only as `tileStacked`'s edge. */
export interface ShadowLayer {
  dy: number;
  blur: number;
  spread?: number;
  color: string;
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
    fill: string;
    fillStrong: string;
    chrome: string;
    chip: string;
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    link: string;
    onAccent: string;
    disabled: string;
    /** Destructive words, such as Delete (the kit's `text.danger`, Notebook look 6 of 9). `status.error` stays for dots and badges. */
    danger: string;
  };
  glyph: { default: string; soft: string; globe: string; page: string };
  accent: { default: string; hover: string; pressed: string; subtle: string };
  border: { hairline: string; default: string; strong: string };
  focus: { ring: string };
  ring: { activeDesk: string; activeGlow: string };
  /** A desk's etched name and icons (ADR 0064): a cut, with a shaded upper wall, a fill, and a lit lower lip. */
  etch: { fill: string; wall: string; highlight: string };
  badge: { bg: string; fg: string };
  status: { online: string; warn: string; error: string; offline: string };
  mark: { disc: string; fg: string };
  switcher: { track: string; selected: string; text: string };
  /**
   * The member's initials avatar (task 45; the Product Designer's badge spec, `spec.json`): six tints, one per member from
   * their id and the same hue in every theme, each a top-to-bottom gradient with its own ink for the initials, all at 5:1
   * or better. `hairline` is the circle's inset edge (none in Dusk).
   */
  avatar: {
    blueTop: string; blueBottom: string; blueInk: string;
    greenTop: string; greenBottom: string; greenInk: string;
    amberTop: string; amberBottom: string; amberInk: string;
    roseTop: string; roseBottom: string; roseInk: string;
    violetTop: string; violetBottom: string; violetInk: string;
    slateTop: string; slateBottom: string; slateInk: string;
    hairline: string;
  };
  /** A tier's badge on the avatar, option 1's corner seal (same spec): `officer` outlined with a chevron, `lead` solid with a star. */
  seal: { officerFill: string; officerLine: string; officerMark: string; leadTop: string; leadBottom: string; leadMark: string };
  elevation: {
    tile: ShadowLayer[];
    /** Only a tile that overlaps one below it, or one being dragged (ADR 0064): a stronger shadow, and an edge. This is the one exception to Dusk's flat tiles. */
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
    fill: '#ECEEF2',
    fillStrong: '#DFE2E6',
    chrome: 'rgba(251, 251, 252, 0.96)',
    chip: '#FFFFFF',
  },
  text: {
    primary: '#2B2D31',
    secondary: '#5F6166',
    tertiary: '#666970',
    link: '#3D6FA8',
    onAccent: '#FFFFFF',
    disabled: '#A3A6AC',
    danger: '#D0201F',
  },
  glyph: { default: '#4A5158', soft: '#8B939C', globe: '#5F7180', page: '#EEF0F3' },
  accent: { default: '#3D6FA8', hover: '#355F91', pressed: '#2D5079', subtle: '#E8F0FF' },
  border: { hairline: 'rgba(16, 24, 40, 0.06)', default: 'rgba(16, 24, 40, 0.12)', strong: '#80858E' },
  focus: { ring: '#3D6FA8' },
  ring: { activeDesk: '#5F7FB0', activeGlow: '#DBE8FF' },
  etch: { fill: '#70757D', wall: '#3A3F47', highlight: '#FFFFFF' },
  badge: { bg: '#D0201F', fg: '#FFFFFF' },
  status: { online: '#2E9B5F', warn: '#B5790E', error: '#D0201F', offline: '#80858E' },
  mark: { disc: '#FFFFFF', fg: '#2B2D31' },
  switcher: { track: '#E9EBEF', selected: '#D3D6DB', text: '#1F2124' },
  avatar: {
    blueTop: '#E2EAF4', blueBottom: '#D1DDEE', blueInk: '#3C4C65',
    greenTop: '#E1EDE6', greenBottom: '#CFE2D7', greenInk: '#3A534B',
    amberTop: '#F6ECDB', amberBottom: '#F1E1C6', amberInk: '#625136',
    roseTop: '#F5E5E7', roseBottom: '#F0D5D8', roseInk: '#60434C',
    violetTop: '#E9E5F3', violetBottom: '#DBD5EC', violetInk: '#484363',
    slateTop: '#E5E7EA', slateBottom: '#D5D9DD', slateInk: '#414751',
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

const DUSK_HAIRLINE = 'rgba(250, 250, 250, 0.08)';
const DUSK_BORDER = 'rgba(250, 250, 250, 0.14)';

const dusk: Tokens = {
  surface: {
    // The office's ground is lighter than a desk's panel, so desks stand apart from it (the owner, 2026-11-08: it was
    // the panel's own color). Text, the focus ring and the active desk's ring still meet their contrast on it.
    worldHi: '#5D636D',
    worldBase: '#585E68',
    worldLo: '#535963',
    panel: '#4A5059',
    tile: '#50565F',
    window: '#4A5059',
    overlay: '#50565F',
    sunken: '#434850',
    scrim: 'rgba(28, 31, 37, 0.45)',
    fill: '#535963',
    fillStrong: '#5E646E',
    chrome: '#50565F',
    chip: '#5E646E',
  },
  text: {
    primary: '#FAFAFA',
    secondary: '#E2E2E2',
    tertiary: '#DADADA',
    link: '#B4CDF0',
    onAccent: '#1E232B',
    disabled: '#9A9C9F',
    danger: '#F9CBC5',
  },
  glyph: { default: '#E2E2E2', soft: '#ACB1B9', globe: '#C9D5E2', page: '#656B75' },
  accent: { default: '#A6C3EC', hover: '#B8D0F1', pressed: '#94B5E6', subtle: '#3C4E66' },
  border: { hairline: DUSK_HAIRLINE, default: DUSK_BORDER, strong: '#A2A8B1' },
  focus: { ring: '#C3D7F4' },
  ring: { activeDesk: '#A6C3EC', activeGlow: 'rgba(166, 195, 236, 0.16)' },
  etch: { fill: '#D2D6DB', wall: '#20242B', highlight: 'rgba(250, 250, 250, 0.30)' },
  badge: { bg: '#F4A399', fg: '#2B1714' },
  status: { online: '#8DD5A6', warn: '#EBC274', error: '#F4A399', offline: '#B3B8C0' },
  mark: { disc: '#E6E6E6', fg: '#2E3238' },
  switcher: { track: '#41464F', selected: '#5E646E', text: '#FAFAFA' },
  avatar: {
    blueTop: '#A3BAD8', blueBottom: '#99B2D4', blueInk: '#282F3A',
    greenTop: '#A2C6B4', greenBottom: '#98C0AC', greenInk: '#283331',
    amberTop: '#D6BD94', amberBottom: '#D1B688', amberInk: '#353028',
    roseTop: '#D6ABB4', roseBottom: '#D1A2AC', roseInk: '#352C30',
    violetTop: '#B7B1D9', violetBottom: '#AFA8D5', violetInk: '#2D2D3A',
    slateTop: '#B1B8C3', slateBottom: '#A8B0BC', slateInk: '#2C2F34',
    hairline: 'transparent',
  },
  seal: { officerFill: '#4F5663', officerLine: '#A5BCDD', officerMark: '#B6C9E4', leadTop: '#B6C9E4', leadBottom: '#94AFD5', leadMark: '#15171B' },
  elevation: {
    tile: [],
    tileTextured: [],
    tileStacked: [shadow(3, 10, 'rgba(15, 18, 24, 0.45)'), hairline('rgba(250, 250, 250, 0.22)')],
    panel: [shadow(1, 2, 'rgba(28, 31, 37, 0.35)'), hairline(DUSK_HAIRLINE)],
    panelActive: [shadow(1, 2, 'rgba(28, 31, 37, 0.35)'), hairline(DUSK_HAIRLINE)],
    window: [shadow(4, 12, 'rgba(28, 31, 37, 0.35)'), hairline(DUSK_BORDER)],
    menu: [shadow(2, 8, 'rgba(28, 31, 37, 0.35)')],
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
    fill: '#33373E',
    fillStrong: '#3A3E45',
    chrome: 'rgba(38, 41, 46, 0.96)',
    chip: '#3A3E45',
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
  glyph: { default: '#C9CDD3', soft: '#858D97', globe: '#A3B6C6', page: '#3A4048' },
  accent: { default: '#7FA7DD', hover: '#93B6E4', pressed: '#6B95CF', subtle: '#22344D' },
  border: { hairline: DARK_HAIRLINE, default: DARK_BORDER, strong: '#757B85' },
  focus: { ring: '#8DB3E6' },
  ring: { activeDesk: '#6F93C6', activeGlow: 'rgba(111, 147, 198, 0.22)' },
  etch: { fill: '#A6ACB6', wall: '#050608', highlight: 'rgba(255, 255, 255, 0.22)' },
  badge: { bg: '#F0646A', fg: '#1F0F10' },
  status: { online: '#4CC27E', warn: '#E0A23A', error: '#F0646A', offline: '#7D848D' },
  mark: { disc: '#DADDE2', fg: '#1E2126' },
  switcher: { track: '#1F2226', selected: '#3A3E45', text: '#ECEDEF' },
  avatar: {
    blueTop: '#485B76', blueBottom: '#43536A', blueInk: '#DCE6F2',
    greenTop: '#466357', greenBottom: '#415951', greenInk: '#DBEAE1',
    amberTop: '#705E3D', amberBottom: '#63553C', amberInk: '#F2E7D3',
    roseTop: '#6F4C56', roseBottom: '#634750', roseInk: '#F2DDE0',
    violetTop: '#565074', violetBottom: '#4E4A68', violetInk: '#E4E0F1',
    slateTop: '#545B65', slateBottom: '#4D535C', slateInk: '#E3E5E8',
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
export const THEME_LABELS: Record<ThemeId, string> = { light: 'Light', dusk: 'Dusk', dark: 'Dark' };
export const THEMES: Record<ThemeId, Tokens> = { light, dusk, dark };
/**
 * The Browser's simplified view (task 47; the Product Designer's spec, `design-drafts/simplified/sv.css`, proposed as kit
 * additions). `media` is drawn over a video, so it's the same dark glass in every theme (Dusk's near-whites, as ever):
 * the letterbox, the controls' glyphs and text, the shade under them (`mediaShade` at 38%, `mediaShadeDeep` at the edge,
 * so the time holds 4.5:1 over a white frame: the spec's section 12), the scrubber's track and buffered part, the play
 * disc and the duration badge. `star` is a rating's (Light's is `status.warn`, for 3:1). `photoWell` is white in every
 * theme (Dusk's near-white, as its whites are): product photos are shot on white, and a dark band round one reads as a hole (the Designer's brand review).
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
  light: { star: '#B5790E', mediaLetterbox: '#0E1013', mediaFg: '#FFFFFF', mediaShade: 'rgba(10, 12, 15, 0.6)', mediaShadeDeep: 'rgba(10, 12, 15, 0.72)', mediaTrack: 'rgba(255, 255, 255, 0.28)', mediaBuffered: 'rgba(255, 255, 255, 0.38)', mediaDisc: 'rgba(18, 20, 24, 0.52)', mediaBadge: 'rgba(12, 14, 17, 0.72)', photoWell: '#FFFFFF' },
  dusk: { star: '#EBC274', mediaLetterbox: '#0E1013', mediaFg: '#FAFAFA', mediaShade: 'rgba(10, 12, 15, 0.6)', mediaShadeDeep: 'rgba(10, 12, 15, 0.72)', mediaTrack: 'rgba(250, 250, 250, 0.28)', mediaBuffered: 'rgba(250, 250, 250, 0.38)', mediaDisc: 'rgba(18, 20, 24, 0.52)', mediaBadge: 'rgba(12, 14, 17, 0.72)', photoWell: '#FAFAFA' },
  dark: { star: '#E0A23A', mediaLetterbox: '#0E1013', mediaFg: '#FFFFFF', mediaShade: 'rgba(10, 12, 15, 0.6)', mediaShadeDeep: 'rgba(10, 12, 15, 0.72)', mediaTrack: 'rgba(255, 255, 255, 0.28)', mediaBuffered: 'rgba(255, 255, 255, 0.38)', mediaDisc: 'rgba(18, 20, 24, 0.52)', mediaBadge: 'rgba(12, 14, 17, 0.72)', photoWell: '#FFFFFF' },
};

/** CSS color-scheme per theme: native scrollbars and form controls follow it. */
export const COLOR_SCHEME: Record<ThemeId, 'light' | 'dark'> = { light: 'light', dusk: 'dark', dark: 'dark' };

/** Sizes that go with the ring tokens (design 3.12: 1.5 px ring, 4 px glow). */
export const RING = { width: 1.5, glow: 4 };

/**
 * A desk style's colors in one theme (`theme/deskStyles.ts`, the owner's desk textures). `base` is the flat surface under
 * its texture: what shows while the texture loads, behind a swatch, and against what the status line is checked. `etch`
 * is its etched name and icons, which the owner wants to blend into the desk ("dark text for dark mode, light text for
 * light, and medium for dusk"). Values per style come from the Product Designer.
 */
export interface DeskStyleInk {
  base: string;
  etch: DeskEtch;
  /** Text drawn on the desk (the strip's status line and "Undo"): `text.secondary` where that holds 4.5:1 on `base`, otherwise a stronger ink. */
  deskText: string;
}

/** A style's etch. Like `Tokens['etch']`, but a null `highlight` draws no lit lip. */
export interface DeskEtch { fill: string; wall: string; highlight: string | null }

/** Every desk style's colors, by style id and theme, from the Product Designer (`assets/desk-styles/desk-styles.json`). `plain` is today's surface and etch. A null `highlight` is not drawn. */
/** base, etch fill, etch wall, etch highlight (null: none), and the text on the desk. */
const ink = (base: string, fill: string, wall: string, highlight: string | null, deskText: string): DeskStyleInk => ({ base, etch: { fill, wall, highlight }, deskText });

export const DESK_STYLE_INKS: Record<string, Record<ThemeId, DeskStyleInk>> = {
  oak: {
    light: ink('#A5A6A2', '#E3E3E0', '#5E5F5D', null, '#2A2E35'),
    dusk: ink('#444B58', '#777C86', '#2A2D34', null, '#E2E2E2'),
    dark: ink('#3B3F48', '#07080A', '#040506', '#585B62', '#BEC2C9'),
  },
  ash: {
    light: ink('#BFC0BC', '#FDFDFB', '#6E6F6D', null, '#2A2E35'),
    dusk: ink('#4A5059', '#7E8289', '#2E3136', null, '#E2E2E2'),
    dark: ink('#454A53', '#1A1D21', '#131517', '#666A71', '#BEC2C9'),
  },
  walnut: {
    light: ink('#3E4553', '#6B6F76', '#20242C', null, '#FAFAF7'),
    dusk: ink('#2A2E35', '#5B5E64', '#181A1E', null, '#E2E2E2'),
    dark: ink('#383C45', '#030304', '#020202', '#54575E', '#BEC2C9'),
  },
  linoleum: {
    light: ink('#A8B0BB', '#EEEFEF', '#61656B', null, '#2A2E35'),
    dusk: ink('#404D5F', '#757E8D', '#282F39', null, '#E2E2E2'),
    dark: ink('#3E4756', '#14181F', '#0E1115', '#5E6572', '#BEC2C9'),
  },
  plain: {
    light: { base: light.surface.panel, etch: light.etch, deskText: light.text.secondary },
    dusk: { base: dusk.surface.panel, etch: dusk.etch, deskText: dusk.text.secondary },
    dark: { base: dark.surface.panel, etch: dark.etch, deskText: dark.text.secondary },
  },
};
