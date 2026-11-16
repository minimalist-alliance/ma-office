// Quick reply's pieces (the owner, Nov 15): the visible way in is a reply-arrow button on each card, held row and paper about a
// message from a person ("Reply to Rosa"); dragging the card down (or a long press on a phone) is a shortcut to the same; R on a
// focused card, Esc to close, Cmd/Ctrl+Enter to send. The field opens right there, focused, with their last message quoted above
// it; Send holds 5 s with "Sent to Rosa · Undo", then goes the way the message came. Pills and insets of Maia's tray only; the drag
// is transform-only on the compositor with a spring settle, and none under reduced motion.
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { R } from '../words';
import { canOffer, holdSend, MEDIUM_WORDS, openLink, replyContextCached, sendReply, type Held, type ReplyContext, type ReplyTarget } from './quickReply';

/**
 * Whether a reply can go to this person from here: Courier on and that desk's channel open, then their thread's way of sending
 * able to send (read once a minute at most). Null while it's being read: the arrow shows only once it can.
 */
export function useCanReply(target: ReplyTarget | null): ReplyTarget | null {
  const key = target ? `${target.deskId}|${target.channelId}` : null;
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setOk(null);
    if (!target || !canOffer(target.deskId)) return undefined;
    void replyContextCached(target).then((c) => live && c.canSend && setOk(key));
    return () => {
      live = false;
    };
    // The target's ids are the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return target && ok === key ? target : null;
}

const REPLY_GLYPH = 'M10 7.5 5 12l5 4.5M5.6 12H14a5 5 0 0 1 5 5v1.5';

/** The reply arrow: the main way in. Its name says who ("Reply to Rosa"). */
export function ReplyButton({ name, onClick, className = '' }: { name: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`sh-reply-btn ${className}`} aria-label={R.replyTo(name)} title={R.replyTo(name)} data-testid="quick-reply-open" onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-ico">
        <path d={REPLY_GLYPH} />
      </svg>
    </button>
  );
}

const reduced = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** How far a drag must pull before it opens the reply, in px; the pull is damped past it. */
export const PULL_OPEN = 48;
const LONG_PRESS_MS = 500;

/**
 * The secondary way in: drag `target` down by its handle (a mouse, or a finger where the handle takes the touch), or a long press
 * with a finger. Transform-only, one rAF a frame; a spring back on release; nothing moves under reduced motion. Never on a button,
 * a field or a link, so it can't answer anything.
 */
export function useReplyGesture(handle: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>, open: (() => void) | null): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const h = handle.current;
    if (!h) return undefined;
    let start: { x: number; y: number; id: number; touch: boolean } | null = null;
    let dy = 0;
    let frame = 0;
    let press = 0;
    const paint = (): void => {
      frame = 0;
      const el = target.current;
      if (!el || reduced()) return;
      // Damped past the threshold, so it feels like pulling a sheet.
      const y = dy <= PULL_OPEN ? dy : PULL_OPEN + Math.sqrt(dy - PULL_OPEN) * 4;
      el.style.transition = 'none';
      el.style.transform = y > 0 ? `translate3d(0, ${y.toFixed(1)}px, 0)` : '';
    };
    const settle = (): void => {
      const el = target.current;
      if (!el) return;
      el.style.transition = reduced() ? 'none' : 'transform 420ms cubic-bezier(0.18, 0.89, 0.32, 1.18)';
      el.style.transform = '';
    };
    const end = (fire: boolean): void => {
      window.clearTimeout(press);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const pulled = dy >= PULL_OPEN;
      start = null;
      dy = 0;
      settle();
      if (fire && pulled) openRef.current?.();
    };
    const down = (e: PointerEvent): void => {
      if (!openRef.current || e.button !== 0 || (e.target as Element | null)?.closest('button, a, input, textarea, select, [contenteditable]')) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === 'touch' };
      dy = 0;
      if (start.touch) {
        press = window.setTimeout(() => {
          if (start && dy < 8) {
            end(false);
            openRef.current?.();
          }
        }, LONG_PRESS_MS);
      }
    };
    const move = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      const ddx = Math.abs(e.clientX - start.x);
      dy = Math.max(0, e.clientY - start.y);
      if (dy > 8 || ddx > 8) window.clearTimeout(press);
      if (ddx > 24 && dy < 12) {
        end(false);
        return;
      }
      if (dy > 4) {
        try {
          h.setPointerCapture(e.pointerId);
        } catch {
          // A pointer that already left: the move still counts.
        }
      }
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const up = (e: PointerEvent): void => {
      if (start && e.pointerId === start.id) end(true);
    };
    const cancel = (): void => end(false);
    h.addEventListener('pointerdown', down);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', cancel);
    return () => {
      h.removeEventListener('pointerdown', down);
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', cancel);
      window.clearTimeout(press);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [handle, target]);
}

export interface QuickReplyProps {
  target: ReplyTarget;
  /** Their name as that desk's Courier has it (drawn here), else null ("them"). */
  name: string | null;
  onClose(): void;
  /** Sent (after the hold) or undone: the card, row or paper collapses. */
  onDone(result: 'sent' | 'undone' | 'failed'): void;
  /** Where the words go, when not straight to Courier (a paper's answer records it on the home desk first). */
  send?: (text: string, ctx: ReplyContext | null) => Promise<void>;
  /** Shown while held (a paper keeps its own place in the stack). */
  className?: string;
}

/** The field, right where the card was: their last message quoted, the reply focused, how it goes, Cancel and Send. */
export function QuickReply({ target, name, onClose, onDone, send, className = '' }: QuickReplyProps) {
  const [ctx, setCtx] = useState<ReplyContext | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState('');
  const [held, setHeld] = useState<Held | null>(null);
  const [outcome, setOutcome] = useState<'sent' | 'undone' | 'failed' | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const who = name ?? 'them';

  const { deskId, channelId } = target;
  useEffect(() => {
    let live = true;
    void replyContextCached({ deskId, channelId, who: null }).then(
      (c) => live && setCtx(c),
      () => live && setFailed(true),
    );
    box.current?.focus({ preventScroll: true });
    return () => {
      live = false;
    };
  }, [deskId, channelId]);

  const go = useCallback((): void => {
    const words = text.trim();
    if (!words || held) return;
    const run = async (): Promise<void> => {
      if (send) return send(words, ctx);
      const link = openLink(target.deskId);
      if (!link) throw new Error('closed');
      return sendReply(link, target.channelId, words, ctx);
    };
    const h = holdSend(run);
    setHeld(h);
    void h.done.then((r) => {
      // Undo: back to the field with their words, nothing sent.
      if (r === 'undone') {
        setHeld(null);
        window.setTimeout(() => box.current?.focus({ preventScroll: true }), 0);
        return;
      }
      setOutcome(r);
      onDone(r);
    });
  }, [text, held, send, ctx, target, onDone]);

  if (held && !outcome) {
    return (
      <div className={`sh-qr sh-qr-held ${className}`} role="status" data-testid="quick-reply-held">
        <span className="sh-qr-sent">{R.sentTo(who)}</span>
        <button
          type="button"
          className="sh-btn quiet"
          onClick={() => {
            held.undo();
          }}
        >
          {R.undo}
        </button>
      </div>
    );
  }
  if (outcome === 'failed') {
    return (
      <div className={`sh-qr sh-qr-held ${className}`} role="status">
        <span className="sh-qr-sent">{R.replyFailed}</span>
        <button type="button" className="sh-btn quiet" onClick={onClose}>
          {R.close}
        </button>
      </div>
    );
  }

  const cantSend = ctx !== null && !ctx.canSend;
  return (
    <div
      className={`sh-qr ${className}`}
      data-testid="quick-reply"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          go();
        }
      }}
    >
      {ctx?.quote && (
        <blockquote className="sh-qr-quote">
          <span className="sh-qr-who">{who}</span>
          <q>{ctx.quote.text}</q>
        </blockquote>
      )}
      <label className="sr-only" htmlFor={id}>
        {R.replyTo(who)}
      </label>
      <textarea id={id} ref={box} className="sh-qr-box" rows={2} maxLength={2000} placeholder={`${R.replyTo(who)}…`} value={text} disabled={cantSend} onChange={(e) => setText(e.target.value)} />
      <div className="sh-qr-foot">
        <span className="sh-qr-how">{failed ? R.materialFailed : cantSend ? R.cantReplyHere : ctx?.medium ? MEDIUM_WORDS[ctx.medium] : R.loadingMaterial}</span>
        <button type="button" className="sh-btn quiet" onClick={onClose}>
          {R.cancel}
        </button>
        <button type="button" className="sh-btn primary" data-testid="quick-reply-send" disabled={!text.trim() || cantSend || !ctx} onClick={go}>
          {R.send}
        </button>
      </div>
    </div>
  );
}
