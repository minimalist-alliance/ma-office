// A desk's name, etched into its strip (ADR 0064): spaced capitals in Jost 600, self-hosted for this one
// use. A letter Jost can't draw falls back to the app font. This measures and fits the name, once per name,
// so a draw never measures text. The bitmap is in sprites.ts.
import { CANVAS_FONT } from './font';
import { ETCH_ICON, ETCH_SIZE, fitNameText, STRIP } from './layout';

type Ctx = OffscreenCanvasRenderingContext2D;

const TRACKING = 0.16;
const JOST = `600 ${ETCH_SIZE}px "Jost"`;
const STATUS_FONT = `13px ${CANVAS_FONT}`;
const MAX_WIDTHS = 2000;

let measurer: Ctx | null = null;
const widths = new Map<string, number>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let epoch = 0;

function ctx(): Ctx {
  measurer ??= new OffscreenCanvas(1, 1).getContext('2d');
  if (!measurer) throw new Error('2D canvas unavailable');
  return measurer;
}

/** A browser without canvas letter spacing draws the name untracked, which is still its name. */
const tracks = (): boolean => 'letterSpacing' in OffscreenCanvasRenderingContext2D.prototype;

export function setEtchType(c: Ctx): void {
  c.font = `600 ${ETCH_SIZE}px "Jost", ${CANVAS_FONT}`;
  c.textBaseline = 'alphabetic';
  if (tracks()) c.letterSpacing = `${ETCH_SIZE * TRACKING}px`;
}

export function setStatusType(c: Ctx): void {
  c.font = STATUS_FONT;
  c.textBaseline = 'alphabetic';
  if (tracks()) c.letterSpacing = '0px';
}

/** The hidden count's digits: the name's face, at the icons' size, untracked. */
export function setCountType(c: Ctx): void {
  c.font = `600 ${ETCH_ICON}px "Jost", ${CANVAS_FONT}`;
  c.textBaseline = 'alphabetic';
  if (tracks()) c.letterSpacing = '0px';
}

function remember(key: string, measure: () => number): number {
  const known = widths.get(key);
  if (known !== undefined) return known;
  if (widths.size >= MAX_WIDTHS) widths.clear();
  const w = measure();
  widths.set(key, w);
  return w;
}

/** The name as drawn, without the spacing after its last letter, so it centers on what's seen. */
export function etchWidth(text: string): number {
  return remember(`e|${text}`, () => {
    const c = ctx();
    setEtchType(c);
    return c.measureText(text).width - (tracks() ? ETCH_SIZE * TRACKING : 0);
  });
}

export function statusTextWidth(text: string): number {
  return remember(`s|${text}`, () => {
    const c = ctx();
    setStatusType(c);
    return c.measureText(text).width;
  });
}

/** One digit's own width. */
export function countDigitInk(digit: string): number {
  return remember(`c|${digit}`, () => {
    const c = ctx();
    setCountType(c);
    return c.measureText(digit).width;
  });
}

/** A canvas has no tabular-nums, so each digit gets a cell as wide as the widest, which comes to the same thing. */
export function countCell(): number {
  return remember('c|cell', () => Math.ceil(Math.max(...Array.from('0123456789', countDigitInk))));
}

/** Between the icon and its number. */
export const COUNT_GAP = 3;

/** The strip's cleanup control as drawn, and so as its proxy, in CSS pixels: square for the sparkle, and as wide as "Undo" needs. */
export function stripControlSize(undo: boolean, touch: boolean): { w: number; h: number } {
  const h = touch ? STRIP.targetTouch : STRIP.target;
  return { w: undo ? Math.max(h, Math.ceil(statusTextWidth('Undo')) + 16) : h, h };
}

export interface NameFit {
  name: string;
  room: number;
  epoch: number;
  /** Empty when it hides: fewer than four characters would fit. */
  text: string;
  width: number;
}

/** The name in capitals, cut to the room it has. Hands back `prev` unless something changed, so a draw costs a comparison. */
export function fitName(prev: NameFit | null, name: string, room: number): NameFit {
  if (prev && prev.name === name && prev.room === room && prev.epoch === epoch) return prev;
  const text = fitNameText(name.toLocaleUpperCase(), room, etchWidth);
  return { name, room, epoch, text, width: text ? etchWidth(text) : 0 };
}

export const etchEpoch = (): number => epoch;

/** When Jost's letters for a name land, everything measured or drawn before them is out of date. */
export function onEtchFont(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Letters Jost has but hasn't loaded: their subset is fetched on demand. Once per name, and a failure leaves the fallback. */
export function askForEtchFont(text: string): void {
  if (asked.has(text) || document.fonts.check(JOST, text)) return;
  asked.add(text);
  document.fonts.load(JOST, text).then(() => {
    epoch += 1;
    widths.clear();
    listeners.forEach((fn) => fn());
  }, () => {});
}
