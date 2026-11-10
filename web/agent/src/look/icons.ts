// The agent role icons: 24 line drawings an agent can wear on its tile.
//
// House style, to match the Desk's own icons (the Agent app's `ui/icons.tsx` and the app glyphs in
// `web/src/canvas/glyphs.ts`): stroke only, no fills, round caps and joins, one stroke weight (STROKE below, 2.0 on this
// 24 grid, a touch heavier than the Agent app's 1.6 on its 20 grid so it sits next to the Desk's app glyphs), a live area of 3 to 21 so the drawing has air
// at the tile's edge, 1.5 corner radii on boxes, and a single idea per icon (no detail finer than the stroke).
//
// How to change one: edit its `paths` (SVG path data on the 24 x 24 grid). A dot is a zero-length segment such as
// `M4.5 7h.01`, which round caps turn into a point. Circles are written as two arcs. To add one, add a row (the id is a
// lowercase word, never reused; saved agents keep it). To drop one, delete its row and map its id to the nearest kept one in RETIRED_ICONS (agents that had it show that one).
// `npm test` checks that each path parses and the ids are unique lowercase words.

export interface AgentIcon {
  id: string;
  label: string;
  /** SVG path data on a 24 x 24 viewBox, to be stroked, never filled. */
  paths: readonly string[];
}

/** Stroke width on the 24 grid. Both the SVG and the canvas drawing use it. */
export const STROKE = 2.0;
/** Side of the grid the paths are drawn on. */
export const GRID = 24;

export const AGENT_ICONS: readonly AgentIcon[] = [
  { id: 'spark', label: 'Spark', paths: ['M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z'] },
  { id: 'compass', label: 'Compass', paths: ['M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0z', 'M15.5 8.5l-2 5-5 2 2-5z'] },
  { id: 'book', label: 'Book', paths: ['M12 6.5C10.5 5.2 8 4.5 4.5 4.5v13c3.5 0 6 .7 7.5 2 1.5-1.3 4-2 7.5-2v-13c-3.5 0-6 .7-7.5 2z', 'M12 6.5v13'] },
  { id: 'pen', label: 'Pen', paths: ['M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5z', 'M14 7l3 3'] },
  { id: 'calendar', label: 'Calendar', paths: ['M5.5 5.5h13A1.5 1.5 0 0 1 20 7v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5V7a1.5 1.5 0 0 1 1.5-1.5z', 'M4 10h16M8.5 3.5v3M15.5 3.5v3'] },
  { id: 'clock', label: 'Clock', paths: ['M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0z', 'M12 7.5V12l3 2'] },
  { id: 'chart', label: 'Chart', paths: ['M4.5 4v15.5H20', 'M8.5 15v-3M12.5 15V8M16.5 15v-5'] },
  { id: 'code', label: 'Code', paths: ['M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5'] },
  { id: 'mail', label: 'Mail', paths: ['M5.5 5.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17V7a1.5 1.5 0 0 1 1.5-1.5z', 'M4.5 7.5L12 13l7.5-5.5'] },
  { id: 'person', label: 'Person', paths: ['M15.5 8a3.5 3.5 0 1 1-7 0a3.5 3.5 0 0 1 7 0z', 'M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6'] },
  { id: 'search', label: 'Search', paths: ['M17.5 11a6.5 6.5 0 1 1-13 0a6.5 6.5 0 0 1 13 0z', 'M16 16l4 4'] },
  { id: 'leaf', label: 'Leaf', paths: ['M19 5c-9 0-14 4-14 9.5 0 2.5 1.5 4.5 4 4.5 6 0 10-5.5 10-14z', 'M5 19.5c2-4.5 5-7.5 9-10'] },
  { id: 'flask', label: 'Flask', paths: ['M9.5 4.5h5M10.5 4.5v5.2L5.2 17.8a1.8 1.8 0 0 0 1.5 2.7h10.6a1.8 1.8 0 0 0 1.5-2.7L13.5 9.7V4.5', 'M8 14.5h8'] },
  { id: 'document', label: 'Document', paths: ['M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z', 'M14 3.5V8h4.5', 'M9 12.5h6M9 16h6'] },
  { id: 'music', label: 'Music', paths: ['M9 17.5V6l10-2v11.5', 'M9 17.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z', 'M19 15.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z'] },
  { id: 'camera', label: 'Camera', paths: ['M4.5 8H7l1.5-2.5h7L17 8h2.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-8A1.5 1.5 0 0 1 4.5 8z', 'M15 13.5a3 3 0 1 1-6 0a3 3 0 0 1 6 0z'] },
  { id: 'plane', label: 'Plane', paths: ['M20 4L3.5 10.5l6.5 2.5 2.5 6.5z', 'M10 13l10-9'] },
  { id: 'shield', label: 'Shield', paths: ['M12 3.5l7 2.5v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z', 'M9 12l2.2 2.2L15.2 10'] },
  { id: 'wallet', label: 'Wallet', paths: ['M5.5 6.5h13A1.5 1.5 0 0 1 20 8v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5V8a1.5 1.5 0 0 1 1.5-1.5z', 'M20 11.5h-4a2 2 0 0 0 0 4h4'] },
  { id: 'bulb', label: 'Bulb', paths: ['M12 3.5a5.5 5.5 0 0 0-3.5 9.8c.7.6 1 1.3 1 2.2v.5h5v-.5c0-.9.3-1.6 1-2.2A5.5 5.5 0 0 0 12 3.5z', 'M10 19h4M10.5 21h3'] },
  { id: 'home', label: 'Home', paths: ['M4 11l8-6.5 8 6.5', 'M6 9.5V19h12V9.5', 'M10 19v-5h4v5'] },
  { id: 'bell', label: 'Bell', paths: ['M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5L19 18H5z', 'M10 20.5h4'] },
  { id: 'list', label: 'List', paths: ['M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01'] },
  { id: 'terminal', label: 'Terminal', paths: ['M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5z', 'M7.5 9.5l3 2.5-3 2.5M12.5 15h4'] },
];

/** What an agent wears before anyone picks. */
export const DEFAULT_ICON = 'spark';

/** Icons that were retired, and the kept one each now shows as. A saved agent keeps its stored id; it renders as the replacement. */
export const RETIRED_ICONS: Readonly<Record<string, string>> = { globe: 'plane', chat: 'person', heart: 'wallet', star: 'bulb', puzzle: 'terminal', briefcase: 'document' };

/** The icon id to use for a stored one: a retired id becomes its replacement, anything else stays. */
export function currentIcon(id: string): string {
  return RETIRED_ICONS[id] ?? id;
}

/** The icon with this id; an unknown id gives the default icon. */
export function iconById(id: string): AgentIcon {
  return AGENT_ICONS.find((i) => i.id === currentIcon(id)) ?? AGENT_ICONS.find((i) => i.id === DEFAULT_ICON) ?? AGENT_ICONS[0]!;
}
