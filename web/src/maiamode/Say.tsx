// Her words in the chat: the short reply, gliding in word by word when it arrives live (`glide.ts`), and her rare longer part
// folded under "More" (the owner, Nov 15). Screen readers get each part as plain text; the gliding words are decoration.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { PACE, paragraphs, reducedMotion, schedule, splitMore } from './glide';
import { W } from './words';

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-more-ico">
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * When each word starts, as a time on the page's clock: words already given a time keep it, and words that arrive later start
 * after the last one, never all at once, however their text came (a burst, or a later step's paragraph).
 */
function useTimes(words: number, rel: readonly number[], glide: boolean): number[] {
  const abs = useRef<number[]>([]);
  if (glide && words > abs.current.length) {
    const t = now();
    const first = abs.current.length;
    const prev = first > 0 ? abs.current[first - 1]! : -Infinity;
    const base = Math.max(t + PACE.start, prev + PACE.word);
    const from = rel[first] ?? 0;
    for (let i = first; i < words; i++) abs.current.push(base + ((rel[i] ?? from) - from));
  }
  return abs.current;
}

/** Her short reply: gliding when it arrived live and motion is welcome, plain otherwise. Tells the chat when it's all shown. */
function Brief({ id, text, live, onShown }: { id: string; text: string; live: boolean; onShown: (id: string) => void }) {
  // Decided once, when the reply first shows: a reply already there (a reload, a reconnect) never glides again.
  const [glide] = useState(() => live && !reducedMotion());
  const paras = paragraphs(text);
  const timed = schedule(paras);
  const abs = useTimes(timed.length, timed.map((w) => w.at), glide);
  // Each word's delay is fixed the first time it renders: a later render never moves an animation already running.
  const delays = useRef<number[]>([]);
  const t = now();
  for (let i = delays.current.length; i < timed.length; i++) delays.current.push(glide ? Math.max(0, Math.round(abs[i]! - t)) : 0);
  // Her words' space opens to fit them, and grows smoothly if more of them come (a burst, a later step), never in a step.
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!glide || !o || !i) return undefined;
    const fit = (): void => {
      o.style.height = `${i.offsetHeight}px`;
    };
    // First the closed height has to be laid out, so the opening is a transition from it.
    void o.offsetHeight;
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(fit);
    watch.observe(i);
    return () => watch.disconnect();
  }, [glide]);

  const lastAbs = abs[timed.length - 1];
  useEffect(() => {
    if (!glide || lastAbs === undefined) {
      onShown(id);
      return undefined;
    }
    const wait = Math.max(0, lastAbs + PACE.fade + PACE.settle - now());
    const timer = window.setTimeout(() => onShown(id), wait);
    return () => window.clearTimeout(timer);
  }, [glide, lastAbs, id, onShown]);

  if (!paras.length) return null;
  if (!glide) {
    return (
      <div className="mm-say">
        {paras.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  }
  let k = 0;
  return (
    <div ref={outer} className="mm-say glide" style={{ height: 0 }}>
      <div ref={inner} className="mm-say-in">
        <span className="sr-only">{paras.join('\n\n')}</span>
        <div aria-hidden="true">
          {paras.map((_, pi) => (
            <p key={pi}>
              {timed
                .filter((w) => w.para === pi)
                .map((w, wi) => {
                  const i = k++;
                  return (
                    <span key={wi}>
                      {wi > 0 ? ' ' : null}
                      <span className="mm-w" style={{ animationDelay: `${delays.current[i]}ms` }}>
                        {w.word}
                      </span>
                    </span>
                  );
                })}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Her longer part: folded under "More" until the member opens it; it unfolds from under the short reply, and folds again. */
function More({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const region = useId();
  const paras = paragraphs(text);
  // Inert while folded: nothing in it takes focus or reaches a screen reader.
  return (
    <>
      <div id={region} className={`mm-more${open ? ' open' : ''}`} inert={!open}>
        <div className="mm-more-in">
          {paras.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </div>
      <button type="button" className={`mm-more-btn${open ? ' open' : ''}${live ? ' arrive' : ''}`} aria-expanded={open} aria-controls={region} onClick={() => setOpen((o) => !o)}>
        {open ? W.less : W.more}
        <Chevron />
      </button>
    </>
  );
}

/** Her reply's words: the short part, and once it's all shown, its longer part's "More". */
export function Say({ id, text, live, shown, onShown }: { id: string; text: string; live: boolean; shown: boolean; onShown: (id: string) => void }) {
  const { brief, more } = splitMore(text);
  return (
    <>
      <span className="sr-only">Maia: </span>
      {brief ? <Brief id={id} text={brief} live={live} onShown={onShown} /> : <EmptyShown id={id} text={text} onShown={onShown} />}
      {more && shown && <More text={more} live={live} />}
    </>
  );
}

/** A reply with no short words yet (still on its way, or only a longer part): nothing to glide, so it's shown. */
function EmptyShown({ id, text, onShown }: { id: string; text: string; onShown: (id: string) => void }) {
  useEffect(() => {
    if (text.trim() !== '') onShown(id);
  }, [id, text, onShown]);
  return null;
}
