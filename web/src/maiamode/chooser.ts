// The startup chooser: "Open your office in: Maia or Desks?" on the loading overlay (CONCEPT.md §2 "At startup";
// the owner, Nov 12; still `pick-chooser.png`). Plain DOM in the startup chunk, drawn the moment the entry runs, never waiting
// for React or the office.
//
// It's the overlay's own ground, mark and track, at the same place as the loader's (`#ma-ld`, ADR 0058), with the question
// under them; drawn as an element of the office's own (`#mm-ld`, after `#ma-ld` at the same z-index, so it's on top), so the
// loader's 15 s and loading.css's 20 s endings can't take it away while it waits on the member: an answer pending, not a stuck
// load. The office below is `inert` while it asks, and the overlay takes the pointer only then. No timer, no auto-pick, no
// answer ever invented. System font: the loader page has no web fonts. No inline style or script (the office's CSP): classes,
// and transforms through the CSSOM.
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import markZen from '../assets/brand/ma-mark-zen.svg';
import maiaDark from '../assets/maia/maia-dark-md.svg';
import maiaDusk from '../assets/maia/maia-dusk-md.svg';
import maiaLight from '../assets/maia/maia-light-md.svg';
import type { Mode } from './prefs';
import './chooser.css';
import { followStillLine } from './stillLoading';
import { W } from './words';

export interface Chooser {
  /** The member picked: the question goes and the overlay stays as the loader's, until `end`. */
  readonly el: HTMLElement;
  /** Fades the whole overlay out and removes it (the office is ready in the picked mode). */
  end(): void;
  /** At once, with nothing (a failure, a sign-out, the member no longer allowed). */
  remove(): void;
}

const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function img(src: string, cls: string): HTMLImageElement {
  const i = el('img', cls);
  i.src = src;
  i.alt = '';
  i.decoding = 'async';
  return i;
}

/** The desks glyph: two rounded panels. */
function desksGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'mm-ch-glyph');
  for (const x of ['3', '13']) {
    const r = document.createElementNS(SVG, 'rect');
    for (const [k, v] of [['x', x], ['y', '5'], ['width', '8'], ['height', '14'], ['rx', '2']]) r.setAttribute(k as string, v as string);
    svg.append(r);
  }
  return svg;
}

const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Shows the question. `def` is the default, the last used (or the member's chosen) mode: highlighted, focused, and what Enter
 * and Esc pick. `onPick` hears the mode and whether "Ask every time" is still ticked. `withAsk` false leaves the checkbox out:
 * the first load's question to a member who hasn't turned Maia Mode on (`offers` in `prefs.ts`), asked only once.
 */
export function showChooser(def: Mode, onPick: (mode: Mode, ask: boolean) => void, withAsk = true): Chooser {
  const root = el('div', 'mm-ld');
  root.id = 'mm-ld';
  const mount = el('div', 'mm-ld-c');
  const head = el('div', 'mm-ld-in');
  head.append(img(markOnLight, 'mm-ld-m mm-th on-light'), img(markZen, 'mm-ld-m mm-th on-zen'), img(markOnDark, 'mm-ld-m mm-th on-dark'));
  const track = el('span', 'mm-ld-t');
  track.append(el('span', 'mm-ld-g'));
  head.append(track);
  // The overlay's status, as the loader's says it (§2, "Keyboard and screen readers").
  const status = el('span', 'mm-ld-sr', W.chooserLoading);
  status.setAttribute('role', 'status');

  const group = el('div', 'mm-ch');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', 'mm-ch-q');
  const q = el('p', 'mm-ch-q', W.chooserQuestion);
  q.id = 'mm-ch-q';
  const row = el('div', 'mm-ch-row');
  // The one card that moves to whichever option has the focus: the highlight is never on two things at once.
  const card = el('span', 'mm-ch-card');
  card.setAttribute('aria-hidden', 'true');
  row.append(card);

  const option = (mode: Mode): HTMLButtonElement => {
    const b = el('button', 'mm-ch-b');
    b.type = 'button';
    b.dataset['mode'] = mode;
    const name = mode === 'maia' ? W.openMaia : W.openDesk;
    if (mode === 'maia') {
      b.append(img(maiaLight, 'mm-ch-maia mm-th on-light'), img(maiaDusk, 'mm-ch-maia mm-th on-zen'), img(maiaDark, 'mm-ch-maia mm-th on-dark'));
    } else b.append(desksGlyph());
    // Named by its words ("Maia, last used" and "Desks"; never "Maia Mode", the owner, Nov 15); the small line is for the eye.
    const words = el('span', 'mm-ch-w');
    const label = el('span', 'mm-ch-name', name);
    if (mode === def) label.append(el('span', 'mm-ld-sr', ', last used'));
    const line = el('small', `mm-ch-line${mode === def ? ' def' : ''}`, mode === def ? W.chooserLast : mode === 'maia' ? W.chooserMaiaLine : W.chooserDeskLine);
    line.setAttribute('aria-hidden', 'true');
    words.append(label, line);
    b.append(words);
    return b;
  };
  const buttons = [option('maia'), option('desk')];
  row.append(...buttons);

  const box = el('input', '');
  box.type = 'checkbox';
  box.checked = true;
  group.append(q, row);
  if (withAsk) {
    const ask = el('label', 'mm-ch-ask');
    ask.append(box, el('span', '', W.chooserAsk));
    group.append(ask);
  }
  // Only while the office really is still loading (`stillLoading.ts`), never over one that's ready.
  const still = el('p', 'mm-ld-s', W.stillLoading);
  still.setAttribute('aria-hidden', 'true');
  mount.append(head, group, still);
  root.append(mount, status);
  const stopStill = followStillLine(still);

  let picked = false;
  let on: HTMLButtonElement = buttons.find((b) => b.dataset['mode'] === def) ?? buttons[0]!;
  const place = (b: HTMLButtonElement, now: boolean): void => {
    on = b;
    for (const x of buttons) x.classList.toggle('on', x === b);
    // "Enter" only under the option Enter picks: with the highlight moved, the default says "Last used".
    const defLine = row.querySelector('.mm-ch-line.def');
    if (defLine) defLine.textContent = b.dataset['mode'] === def ? W.chooserLast : W.chooserLastShort;
    if (now || reduced()) card.classList.add('jump');
    else card.classList.remove('jump');
    card.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
    card.style.width = `${b.offsetWidth}px`;
    card.style.height = `${b.offsetHeight}px`;
  };
  const pick = (b: HTMLButtonElement): void => {
    if (picked) return;
    picked = true;
    root.classList.add('picked');
    group.setAttribute('aria-hidden', 'true');
    for (const x of buttons) x.disabled = true;
    box.disabled = true;
    document.removeEventListener('keydown', early, true);
    onPick(b.dataset['mode'] === 'maia' ? 'maia' : 'desk', box.checked);
  };

  for (const b of buttons) {
    b.addEventListener('focus', () => place(b, false));
    // Hovering moves the highlight, and the focus with it, so there's never a second ring.
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'touch' && !picked) b.focus({ preventScroll: true });
    });
    b.addEventListener('click', () => pick(b));
  }
  // Enter or Esc pressed before the focus has landed (or wherever it is) still answer: the highlighted one, or the default.
  const early = (e: KeyboardEvent): void => {
    if (picked || root.contains(e.target as Node) || (e.key !== 'Enter' && e.key !== 'Escape')) return;
    e.preventDefault();
    e.stopPropagation();
    pick(e.key === 'Enter' ? on : (buttons.find((b) => b.dataset['mode'] === def) ?? on));
  };
  document.addEventListener('keydown', early, true);
  root.addEventListener('keydown', (e) => {
    if (picked) return;
    // From the keyboard, the glass card also wears the office's focus ring (3:1), which the glass alone doesn't give.
    if (e.key === 'Tab' || e.key.startsWith('Arrow')) row.classList.add('kb');
    if (e.key === 'Escape') {
      // Esc picks the default, which is labelled so.
      e.preventDefault();
      pick(buttons.find((b) => b.dataset['mode'] === def) ?? on);
      return;
    }
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  });

  // The office below can't take focus or a press while the question is up; it gets them back when the overlay ends.
  const office = document.getElementById('ma-root');
  office?.setAttribute('inert', '');
  // After the loader's own overlay, at the same z-index, so it's on top of it; its ground is the same, so nothing flashes.
  document.body.append(root);
  // The mark is already showing under it if the loader's has begun to appear: then no fade-in, so it doesn't blink.
  const ld = document.querySelector('#ma-ld .ma-ld-in');
  if (ld && getComputedStyle(ld).opacity !== '0') root.classList.add('shown');
  requestAnimationFrame(() => {
    place(on, true);
    on.focus({ preventScroll: true });
  });

  let gone = false;
  const remove = (): void => {
    if (gone) return;
    gone = true;
    stopStill();
    document.removeEventListener('keydown', early, true);
    office?.removeAttribute('inert');
    root.remove();
  };
  return {
    el: root,
    remove,
    end() {
      if (gone) return;
      office?.removeAttribute('inert');
      root.setAttribute('aria-hidden', 'true');
      if (document.hidden || reduced()) root.classList.add('out-fast');
      else root.classList.add('out');
      root.addEventListener('animationend', (e) => {
        if (e.target === root) remove();
      });
      window.setTimeout(remove, 700);
    },
  };
}
