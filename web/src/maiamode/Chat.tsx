// The chat with Desk Maia (CONCEPT.md §2): it runs up under her, and its oldest lines fade into her and her glow. The fade is
// decoration: a mask only while the member reads the latest lines, cleared over anything they scroll back to, gone under
// `prefers-contrast: more`, and screen readers get every line (the list is a polite `log`).
//
// Her multiple-choice replies (the owner's requirement, Nov 12, ESSENTIAL): 2 to 4 short answers, her pick first, and "Other",
// in a group just over the composer, in thumb reach on a phone. A tap answers; "Other" turns the composer into the answer; a
// reply typed past them tells her they were ignored, so her weight can fall (the runtime keeps it, counts only).
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type AnimationEvent, type KeyboardEvent, type ReactNode } from 'react';
import { splitMore } from './glide';
import { optionName, openChoices, plain } from './model';
import { Say } from './Say';
import type { CardPointer, RoomMessage, RoomSource, RoomState } from './source';
import { takeMaiaDraft, useMaiaDraft } from './ask';
import { HandoverCard } from './Handover';
import { openViewport } from './ui';
import { W } from './words';
import { paperTokens } from './tray';

/** The decision tray's papers named in her reply, drawn from the home desk's own papers (the shield's chunk, already here). */
const ChatPapers = lazy(() => import('./shield/Tray').then((m) => ({ default: m.ChatPapers })));

const LEVEL: Record<CardPointer['level'], string> = {
  send: 'Sends outside your desk',
  egress: 'Sends outside your desk',
  spend: 'Costs money',
  write: 'Changes your things',
  delete: 'Deletes something',
};

function NoteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
      <path d="M5 4h10l4 4v12H5z" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

function OutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

/**
 * A line that arrived while the room was open comes in gently: its space opens over the same moment its words fade in, so
 * nothing above it jumps. One already there when the room opened (a reload, a reconnect) is simply there.
 */
function useArrival(live: boolean | undefined): [string, (el: HTMLLIElement | null) => void, (e: AnimationEvent) => void] {
  const [arriving, setArriving] = useState(() => !!live && !reducedMotionNow());
  // Its height, read before the first paint, so its space opens from nothing (a member's line; hers opens with her words).
  const measure = useCallback((el: HTMLLIElement | null) => {
    if (el && el.classList.contains('mm-me')) el.style.setProperty('--mm-h', `${el.offsetHeight}px`);
  }, []);
  return [arriving ? ' mm-arrive' : '', measure, (e) => e.target === e.currentTarget && setArriving(false)];
}

/** Shown while `on`, and for `ms` after, marked leaving, so it can close its own space instead of vanishing. */
function useLinger(on: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(on);
  useEffect(() => {
    if (on) {
      setMounted(true);
      return undefined;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return { mounted: on || mounted, leaving: !on };
}

const reducedMotionNow = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

function Message({ m, source, deskName, shown, onShown }: { m: RoomMessage; source: RoomSource; deskName: (id: string) => string | null; shown: boolean; onShown: (id: string) => void }) {
  const [arrive, measure, arrived] = useArrival(m.live);
  if (m.from === 'member') return <li ref={arrive ? measure : undefined} className={`mm-me${arrive}`} data-mid={m.id} onAnimationEnd={arrived}>{m.text}</li>;
  const card = m.card;
  const cardDesk = card ? deskName(card.deskId) : null;
  // `[paper:pp-…]` in her words: taken out, and the paper drawn from the home desk's own (never from her text).
  const papers = paperTokens(m.text);
  return (
    <li className={`mm-her${arrive}`} data-mid={m.id} onAnimationEnd={arrived}>
      <Say id={m.id} text={papers.text} live={!!m.live} shown={shown} onShown={onShown} />
      {papers.ids.length > 0 && !m.live && (
        <Suspense fallback={null}>
          <ChatPapers ids={papers.ids} />
        </Suspense>
      )}
      {m.cost && <p className="mm-cost">{plain(m.cost, 80)}</p>}
      {m.failed && <p className="mm-failed">{m.failed}</p>}
      {m.notes && m.notes.length > 0 && (
        <div className="mm-notes">
          {m.notes.map((n) => (
            <span key={n.id} className="mm-note">
              <NoteIcon />
              {/* §23: a failed chip and an undone one say so in the room's words; only a filed one has Undo. */}
              {n.state === 'failed' ? W.noteFailed : n.state === 'undone' ? W.noteRemoved : plain(n.line, 60)}
              {n.state === 'filed' && n.undo ? (
                <button type="button" className="mm-link" aria-label={`${W.undo}: ${plain(n.line, 60)}`} onClick={() => source.undoNote(n.undo ?? '')}>
                  {W.undo}
                </button>
              ) : n.state === 'pending' ? (
                <span className="mm-note-undone">{W.noteFiling}</span>
              ) : null}
            </span>
          ))}
        </div>
      )}
      {m.show && deskName(m.show.deskId) !== null && (
        <div className="mm-acts">
          <button type="button" className="mm-btn" onClick={() => m.show && openViewport(m.show, 'maia')}>
            {W.showMe}
          </button>
        </div>
      )}
      {m.doc && deskName(m.doc.deskId) !== null && <HandoverCard doc={m.doc} deskName={deskName(m.doc.deskId) ?? ''} />}
      {card && cardDesk !== null && (
        <div className="mm-card" role="group" aria-label={`${LEVEL[card.level]}: ${plain(card.title)}`}>
          <p className="mm-card-lvl">
            <OutIcon />
            {LEVEL[card.level]} · {plain(cardDesk, 40)} · {plain(card.agentName, 40)}
          </p>
          <p className="mm-card-title">{plain(card.title)}</p>
          <p className="mm-card-meta">Opens {plain(card.agentName, 40)}’s own card, with exactly what it does.</p>
          <div className="mm-acts">
            <button type="button" className="mm-btn primary" onClick={() => openViewport({ deskId: card.deskId, app: 'agent', ref: card.id }, 'member')}>
              {W.review}
            </button>
            <button type="button" className="mm-btn quiet" onClick={() => source.snooze(card.id)}>
              {W.notNow}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Her choices' frame: it opens under her words once they're all shown (a set that came with the thread is simply there), and
 * folds shut when they're answered or passed by. Inert while it folds.
 */
function ChoicesFrame({ live, leaving, children }: { live: boolean; leaving: boolean; children: ReactNode }) {
  const [unfolding, setUnfolding] = useState(() => live && !reducedMotionNow());
  return (
    <div
      className={`mm-choices-wrap${unfolding ? ' unfold' : ''}${leaving ? ' leaving' : ''}`}
      inert={leaving}
      onAnimationEnd={(e) => e.target === e.currentTarget && setUnfolding(false)}
    >
      {/* The clip holds no padding of its own, so the frame really opens from nothing. */}
      <div className="mm-choices-clip">{children}</div>
    </div>
  );
}

/**
 * Her dots, while she thinks. Their space opens and closes by one transition each way (never a keyframe, which would hold the
 * height against the closing), so words arriving mid-opening only turn it around.
 */
function Dots({ ref, leaving }: { ref: (el: HTMLParagraphElement | null) => void; leaving: boolean }) {
  const [open, setOpen] = useState(reducedMotionNow);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setOpen(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <p ref={ref} className={`mm-busy${open && !leaving ? ' open' : ''}`} role="status">
      <span className="mm-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="sr-only">{W.thinking}</span>
    </p>
  );
}

/** The newest lines are in view: the fade can show. Scrolled back, it's cleared over what's being read. */
const AT_END_PX = 24;

/** Her reply with nothing to show yet (its words on their way) takes no space: it opens when they come. */
const visible = (m: RoomMessage): boolean =>
  m.from === 'member' || m.text.trim() !== '' || !!(m.choices || m.card || m.notes?.length || m.show || m.doc || m.failed || m.cost);

export function Chat({ state, source, phone, deskName, onBusy }: {
  state: RoomState;
  source: RoomSource;
  phone: boolean;
  deskName: (id: string) => string | null;
  onBusy: (busy: boolean) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [other, setOther] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  // Words handed over from Documents ("Ask Maia"): they wait in the composer for the member to finish and send (`ask.ts`).
  const draft = useMaiaDraft();
  useEffect(() => {
    if (draft.text === null) return;
    setText(draft.text);
    takeMaiaDraft(draft.seq);
    const el = input.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(draft.text.length, draft.text.length);
    }
  }, [draft]);
  const open = openChoices(state.messages);
  const ready = state.link === 'ready';
  // Her replies whose words are all shown: her choices and her "More" wait for them, then fade in after.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const onShown = useCallback((id: string) => setShown((s) => (s.has(id) ? s : new Set(s).add(id))), []);
  // A reply with choices and no words of its own has nothing to wait for (Security's MV-L3).
  const choicesNow = open !== null && (shown.has(open.message.id) || splitMore(open.message.text).brief === '');
  // Answered or passed by, her choices fold away instead of vanishing, so the lines above them never drop.
  const lastOpen = useRef(open);
  if (open && choicesNow) lastOpen.current = open;
  const choicesLinger = useLinger(choicesNow, 560);
  const offered = choicesNow ? open : choicesLinger.mounted ? lastOpen.current : null;
  // Her dots give way as her words come, closing their space as the words open theirs.
  const tail = state.messages[state.messages.length - 1];
  const speaking = !!tail && tail.from === 'maia' && splitMore(tail.text).brief !== '';
  const dots = useLinger(state.busy && !speaking, 560);
  const log = useRef<HTMLOListElement>(null);
  // "Nothing new appears while you're typing" (§3): the desk hears when the member types and stops, at most once a change.
  const said = useRef(false);
  const quiet = useRef(0);
  const typing = (on: boolean): void => {
    window.clearTimeout(quiet.current);
    if (on) quiet.current = window.setTimeout(() => typing(false), 15_000);
    if (said.current === on) return;
    said.current = on;
    source.typing(on);
  };
  useEffect(() => () => window.clearTimeout(quiet.current), []);

  useEffect(() => onBusy(state.busy), [state.busy, onBusy]);
  // "Other" belongs to the set it was pressed for: a new question ends it.
  useEffect(() => {
    if (other && open?.set.id !== other) setOther(null);
  }, [open?.set.id, other]);

  // New lines keep the newest in view, unless the member has scrolled back to read; so does the chat's box changing size (the
  // viewport opening, the choices coming and going, a phone's keyboard).
  const end = useRef(atEnd);
  end.current = atEnd;
  // The lines under the log (her dots, the link's line, a problem and its button) count too: the log fills the box, so in a
  // short thread they start below it, and a new member's first message refused for want of a key showed nothing (release 4's B8).
  const problemLine = state.problem ? `${state.problem.line}|${state.problem.action ?? ''}` : null;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atEnd) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, open?.set.id, atEnd, state.busy, ready, problemLine]);
  const watcher = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(() => {
      if (end.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    // The thread growing as a line opens or her "More" unfolds: frame by frame, so the newest lines glide up, never jump.
    if (log.current) watch.observe(log.current);
    if (dotsEl.current) watch.observe(dotsEl.current);
    watcher.current = watch;
    return () => {
      watcher.current = null;
      watch.disconnect();
    };
  }, []);
  // Her dots open and close their own space: watched too while they're there.
  const dotsEl = useRef<HTMLParagraphElement | null>(null);
  const watchDots = useCallback((el: HTMLParagraphElement | null) => {
    if (dotsEl.current && dotsEl.current !== el) watcher.current?.unobserve(dotsEl.current);
    dotsEl.current = el;
    if (el) watcher.current?.observe(el);
  }, []);

  const grow = (): void => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  const send = (): void => {
    const words = text.trim();
    if (!words || !ready) return;
    if (open) source.send(words, { choices: open.set.id, as: other === open.set.id ? 'other' : 'ignored' });
    else source.send(words);
    setText('');
    setOther(null);
    setAtEnd(true);
    typing(false);
    requestAnimationFrame(grow);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // Left and Right move along her choices, as a toolbar's buttons do; Tab still reaches each.
  const onChoiceKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]?.focus();
  };

  const question = offered ? `mm-q-${offered.message.id}` : undefined;
  return (
    <section className="mm-chat" aria-label={W.conversation}>
      <div
        ref={list}
        className={`mm-msgs${atEnd ? ' faded' : ''}`}
        role="log"
        aria-live="polite"
        aria-label={W.conversation}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX);
        }}
      >
        <ol className="mm-log" ref={log}>
          {state.messages.filter(visible).map((m) => (
            <Message key={m.id} m={m} source={source} deskName={deskName} shown={shown.has(m.id)} onShown={onShown} />
          ))}
        </ol>
        {dots.mounted && <Dots ref={watchDots} leaving={dots.leaving} />}
        {!ready && <p className="mm-link-line" role="status">{state.link === 'offline' ? W.offline : W.connecting}</p>}
        {state.problem && (
          <div className="mm-problem" role="status">
            <p>{state.problem.line}</p>
            {state.problem.action && (
              <button type="button" className="mm-btn primary" onClick={() => source.fix()}>
                {state.problem.action}
              </button>
            )}
          </div>
        )}
      </div>
      {offered && (
        <ChoicesFrame key={offered.set.id} live={!!offered.message.live} leaving={!choicesNow}>
        <div className="mm-choices" role="group" aria-label={W.choices} aria-describedby={question} onKeyDown={onChoiceKey}>
          <span id={question} className="sr-only">{plain(splitMore(offered.message.text).brief, 200)}</span>
          {offered.set.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              className={`mm-choice${i === 0 && offered.set.pick !== false ? ' pick' : ''}`}
              aria-label={optionName(o.label, i === 0 && offered.set.pick !== false)}
              disabled={!ready || !choicesNow}
              onClick={() => {
                setAtEnd(true);
                source.choose(offered.message.id, o.id);
              }}
            >
              {plain(o.label, 40)}
            </button>
          ))}
          {offered.set.other !== false && (
            <button
              type="button"
              className={`mm-choice other${other === offered.set.id ? ' on' : ''}`}
              aria-pressed={other === offered.set.id}
              disabled={!ready || !choicesNow}
              onClick={() => {
                setOther(offered.set.id);
                input.current?.focus();
              }}
            >
              {W.other}
            </button>
          )}
        </div>
        </ChoicesFrame>
      )}
      <form
        className="mm-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={text}
          aria-label={other ? W.composerOther : 'Message Maia'}
          placeholder={other ? W.composerOther : phone ? W.composerPhone : W.composer}
          onChange={(e) => {
            setText(e.target.value);
            grow();
            typing(e.target.value !== '');
          }}
          onBlur={() => typing(false)}
          onKeyDown={onKey}
        />
        <button type="submit" className="mm-send" aria-label={W.send} aria-disabled={!text.trim() || !ready}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
    </section>
  );
}
