// What a finger on the picture shows before anything comes back (spec (f) section 4): the tap dot the instant a finger
// lands, and the hold ring filling from 200 to 500 ms. Drawn in `.br-touch-layer` over the picture, by class and transform
// only, never React: the look and its timing are CSS (`app.css`, "touch feedback"). The media set's white and shade, so it
// reads on a white page and a black one alike, in every theme. Nothing here for a pen or a mouse.
import type { Pt } from './touchInput';

export interface TouchFeedback {
  land(at: Pt): void;
  /** The hold is reached: the dot fills. */
  held(): void;
  /** The mark goes: shrinking and fading after a press that lifted (`tap`), at once after a drag or a second finger. */
  lift(tap: boolean): void;
  dispose(): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const TAP_FADE_MS = 240;
/** Under reduced motion a tap's dot shows this long, then goes, unscaled. */
const STILL_MS = 120;

function ring(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'br-ring');
  svg.setAttribute('viewBox', '-30 -30 60 60');
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['br-ring-shade', 'br-ring-arc']) {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('r', '26');
    c.setAttribute('pathLength', '100');
    svg.append(c);
  }
  return svg;
}

export function touchFeedback(surface: HTMLElement, reduced: () => boolean): TouchFeedback {
  const layer = surface.querySelector<HTMLElement>('.br-touch-layer');
  let mark: { el: HTMLElement; at: number } | null = null;
  const timers = new Set<number>();

  const drop = (el: HTMLElement, ms: number): void => {
    if (!ms) {
      el.remove();
      return;
    }
    const id = window.setTimeout(() => {
      timers.delete(id);
      el.remove();
    }, ms);
    timers.add(id);
  };

  return {
    land(at) {
      if (!layer) return;
      if (mark) drop(mark.el, 0);
      const r = layer.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'br-press';
      el.style.transform = `translate(${at.x - r.left}px, ${at.y - r.top}px)`;
      const dot = document.createElement('div');
      dot.className = 'br-dot';
      el.append(dot, ring());
      layer.append(el);
      mark = { el, at: performance.now() };
    },
    held() {
      mark?.el.classList.add('held');
    },
    lift(tap) {
      if (!mark) return;
      const { el, at } = mark;
      mark = null;
      if (!tap) {
        drop(el, 0);
        return;
      }
      if (reduced()) {
        drop(el, Math.max(0, STILL_MS - (performance.now() - at)));
        return;
      }
      el.classList.add('lifted');
      drop(el, TAP_FADE_MS);
    },
    dispose() {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      layer?.replaceChildren();
      mark = null;
    },
  };
}
