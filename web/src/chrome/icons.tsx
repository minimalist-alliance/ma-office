// Inline SVG icons for the DOM chrome. Stroke icons use currentColor. App glyphs are the canvas's own drawing (`GlyphCanvas`).
import { useLayoutEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import { glyphOf, lookChunk, maskKey, rosterAgent, useRosterStore, type GlyphId } from '../agent/roster';
import { drawGlyph } from '../canvas/glyphs';
import { deviceBox } from './glyphBox';
import { isAgentApp, isDeskApp, type AppId } from '../canvas/layout';
import { useDoor } from '../deskapps/door';
import { useTheme } from '../theme/themeStore';

const PATHS = {
  chevronLeft: <path d="M14.5 6 8.5 12l6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  chevronUp: <path d="m6 14.5 6-6 6 6" />,
  close: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  fullscreen: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  exitFullscreen: <path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5" />,
  fit: (
    <>
      <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c.9-3.4 3.6-5 7-5s6.1 1.6 7 5" />
    </>
  ),
  shield: <path d="M12 4 5.5 6.5v5c0 4.2 2.7 7 6.5 8.5 3.8-1.5 6.5-4.3 6.5-8.5v-5Z" />,
  shieldOn: (
    <>
      <path d="M12 4 5.5 6.5v5c0 4.2 2.7 7 6.5 8.5 3.8-1.5 6.5-4.3 6.5-8.5v-5Z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </>
  ),
  windowFull: <rect x="5" y="6" width="14" height="12" rx="2" />,
  windowRestore: (
    <>
      <rect x="5" y="9" width="10" height="10" rx="2" />
      <path d="M9 9V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2" />
    </>
  ),
  back: <path d="M19 12H5.5M11 6.5 5.5 12l5.5 5.5" />,
  forward: <path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" />,
  reload: <path d="M18.5 12a6.5 6.5 0 1 1-2-4.7M18.5 5v3.5H15" />,
  soundOff: <path d="M4.5 9.5v5H8l4.5 4v-13L8 9.5ZM16 9.5l4.5 5M20.5 9.5l-4.5 5" />,
  // The top bar's bell (ADR 0125 §9) and the kind icons on its rows (`packages/bell-kit` SPEC.md, `family`): a thread,
  // a card, a desk's screen, the account (above), and a note for anything else. Stroke icons, no stars.
  bell: <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5ZM10 20.5a2 2 0 0 0 4 0" />,
  thread: <path d="M5 6.5h14v9h-9l-4 3.5v-3.5H5Z" />,
  card: (
    <>
      <rect x="4" y="6.5" width="16" height="11" rx="2" />
      <path d="M4 10.5h16" />
    </>
  ),
  screen: (
    <>
      <rect x="4" y="5.5" width="16" height="11" rx="2" />
      <path d="M9 19.5h6M12 16.5v3" />
    </>
  ),
  note: (
    <>
      <path d="M7 4.5h7l4 4v11H7Z" />
      <path d="M14 4.5v4h4M9.5 13h5M9.5 16h5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3.5" y="6.5" width="17" height="11" rx="2" />
      <path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13.5h.01M16 13.5h.01M9.5 13.5h4.5" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5.5" y="5.5" width="13" height="15" rx="2" />
      <path d="M9 5.5V4.5h6v1M9 11h6M9 14.5h4" />
    </>
  ),
  keyboardHide: (
    <>
      <rect x="3.5" y="4" width="17" height="10" rx="2" />
      <path d="M7 7.5h.01M10 7.5h.01M13 7.5h.01M16 7.5h.01M9.5 10.5h4.5M9 17.5l3 2.5 3-2.5" />
    </>
  ),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** An agent's own app (task 49): its mark, as its tile draws it, its uploaded picture through a `blob:` URL from this page. */
function AgentAppGlyph({ app, deskId, size }: { app: AppId; deskId?: string | undefined; size: number }) {
  const agent = useRosterStore((s) => rosterAgent(app, deskId, s));
  const theme = useTheme((s) => s.resolved);
  const url = useRosterStore((s) => (agent?.png != null ? (s.masks[maskKey(deskId ?? '', agent.id, agent.png)]?.url ?? null) : null));
  // The mark's drawing is its own chunk (`lookChunk`): blank for the moment it loads.
  useRosterStore((s) => s.lookReady);
  const Mark = lookChunk()?.AgentMark;
  return (
    <span className="app-glyph" aria-hidden="true" style={{ display: 'inline-flex', width: size, height: size }}>
      {Mark && <Mark icon={agent?.icon ?? 'hat'} color={agent?.color ?? null} tone={agent?.tone ?? 'graphite'} theme={theme} pngUrl={url} size={size} />}
    </span>
  );
}

/** The device pixel ratio, kept current: a window moved to another screen, or the page zoomed, changes it (`resolution` stops matching). */
function watchDpr(changed: () => void): () => void {
  let mq: MediaQueryList;
  const watch = (): void => {
    mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    mq.addEventListener('change', on, { once: true });
  };
  const on = (): void => {
    watch();
    changed();
  };
  watch();
  return () => mq.removeEventListener('change', on);
}
const dpr = (): number => devicePixelRatio || 1;

/**
 * The DOM glyphs' second look, a frame after something may have moved them by a fraction of a pixel: a resize (a density
 * change fires one too, and the layout settles after it) or a CSS transition ending. One listener for them all.
 */
const looks = new Set<() => void>();
let frame = 0;
const moved = (): void => {
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    looks.forEach((look) => look());
  });
};
function lookAgain(look: () => void): () => void {
  if (!looks.size) {
    addEventListener('resize', moved);
    document.addEventListener('transitionend', moved, true);
  }
  looks.add(look);
  return () => {
    looks.delete(look);
    if (looks.size) return;
    removeEventListener('resize', moved);
    document.removeEventListener('transitionend', moved, true);
  };
}

/**
 * An app's glyph in the DOM, drawn by the canvas's own `drawGlyph` (one copy of the shapes) at the screen's pixel density:
 * drawn again on a theme change and when the density changes. Hidden from assistive tech, as the glyph's name is beside it.
 * Its backing store is the element's own box in device pixels, each axis on its own (`deviceBox`, `glyphBox.ts`: its edges
 * snapped where it sits), so the bitmap is never resampled to fit: at 1.25x or 1.5x a rounded `size x devicePixelRatio`
 * could be a pixel off the box the browser paints, and blur. A resize or a transition's end looks again, and a box that
 * now snaps differently draws again.
 */
export function GlyphCanvas({ glyph, size, className = 'app-glyph' }: { glyph: GlyphId; size: number; className?: string }) {
  const t = useTheme((s) => s.t);
  const d = useSyncExternalStore(watchDpr, dpr);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return undefined;
    const draw = (force: boolean): void => {
      const r = c.getBoundingClientRect();
      const { w, h } = deviceBox(r.left, r.top, size, size, d);
      if (!force && w === c.width && h === c.height) return;
      c.width = w;
      c.height = h;
      ctx.setTransform(w / size, 0, 0, h / size, 0, 0);
      drawGlyph(ctx, glyph, t, size);
    };
    draw(true);
    return lookAgain(() => draw(false));
  }, [glyph, size, t, d]);
  return <canvas ref={ref} className={className} aria-hidden="true" style={{ width: size, height: size }} />;
}

export function AppGlyph({ app, size = 18, deskId }: { app: AppId; size?: number; deskId?: string }) {
  // An installed app's (ADR 0054): the desk app host's drawing, a blank of its size until that chunk is here.
  const appsHost = useDoor((s) => s.host);
  // A core app's glyph key: its id, or To-do's blank until its chunk is here.
  const glyph = useRosterStore((s) => (isAgentApp(app) || isDeskApp(app) ? null : glyphOf('', app, s)));
  if (isAgentApp(app)) return <AgentAppGlyph app={app} deskId={deskId} size={size} />;
  if (isDeskApp(app)) return appsHost ? <appsHost.DeskGlyph glyph={appsHost.glyphFor(app.slice(4))} size={size} /> : <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="app-glyph" />;
  return <GlyphCanvas glyph={glyph ?? app} size={size} />;
}
