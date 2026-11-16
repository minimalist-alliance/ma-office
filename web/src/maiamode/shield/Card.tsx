// The card (the focus shield; CONCEPT.md §7.2, deskd API.md §23 `card`): one at a time, at most 360 px wide, sliding from under the
// held line (in her room, in the To-do column). Its source, what, and why now are the desk's code's fixed templates; the browser
// fills `{who}` with the sender's name from that desk's Courier, and a message's quote with the sender's own subject, in quotes,
// when it draws the card. The one thing comes first, then 1 or 2 time choices; "Not now" shrinks it for 5 s to "Held until 1:00 ·
// Not important · Undo". The accent blue gives an interrupt its weight; never a warning colour, never motion beyond the slide in.
// Its look is the brand pass's tray (`design-drafts/maia-shield-brand/DIRECTION.md`): Maia in her field at the head, the desk's
// etched name as the source, an interrupt's why as the accent time chip, pills only, and the riders in a sunken tray at the foot.
import { useEffect, useId, useRef, useState } from 'react';
import { useReach } from '../focusSource';
import { fillWho, type ReachCard, type ReachGo, type Rider } from '../reach';
import { Stack } from './Tray';
import { QuickReply, ReplyButton, useCanReply, useReplyGesture } from './QuickReply';
import { R } from '../words';
import { answerCard, answerItem, nameOf, quoteOf } from './actions';
import { Dot, KindChip, MaiaHalo, Source } from './Maia';

export interface CardProps {
  card: ReachCard;
  /** Runs a one thing: the desk view's window, her room's viewport. */
  onGo: (go: ReachGo, deskId: string | null) => void;
  /** "Change" under Why: What reaches you. */
  onChange: () => void;
  /** The card left the screen (tucked back, or its one thing taken). */
  onGone?: (cardId: string) => void;
  className?: string;
}

/** Says each new card once through a polite live region: never `alert`. */
function Said({ text }: { text: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {text}
    </span>
  );
}

function RiderRow({ r, name, onGo }: { r: Rider; name: string | null; onGo: CardProps['onGo'] }) {
  return (
    <li className="sh-rider">
      <KindChip kind={r.kind} />
      <div className="sh-rider-text">
        <Source text={fillWho(r.source, name)} className="small" />
        <p className="sh-rider-what">{fillWho(r.what, name)}</p>
        {r.why && <p className="sh-why-text">{fillWho(r.why, name)}</p>}
      </div>
      {r.go.kind !== 'none' && (
        <button
          type="button"
          className="sh-btn quiet"
          aria-label={`${r.goLabel}: ${fillWho(r.what, name)}`}
          onClick={() => {
            void answerItem(r.itemId, 'go').catch(() => undefined);
            onGo(r.go, null);
          }}
        >
          {r.goLabel}
        </button>
      )}
    </li>
  );
}

export function Card({ card, onGo, onChange, onGone, className = '' }: CardProps) {
  const [name, setName] = useState<string | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [papered, setPapered] = useState(false);
  const [replying, setReplying] = useState(false);
  const head = useRef<HTMLElement>(null);
  const box = useRef<HTMLElement>(null);
  // Quick reply: a person's message, on a desk whose Courier can send (the reply arrow; drag down or R as shortcuts).
  const replyTarget = useCanReply(card.kind === 'message' && card.who && card.quote ? { deskId: card.quote.deskId, channelId: card.quote.channelId, who: card.who } : null);
  useReplyGesture(head, box, replyTarget && !replying ? () => setReplying(true) : null);
  const tray = useReach((s) => s.reach?.tray ?? null);
  // An item with papers: the card stays the shield's, and its one thing opens the paper in place, never the source app (§8.2).
  const paperIds = (tray?.papers ?? []).filter((p) => p.itemId === card.itemId || (card.go.kind === 'paper' && p.paperId === card.go.paperId)).map((p) => p.paperId);
  const whyId = useId();

  // The sender's name and their own subject, drawn now from that desk's Courier; nothing of them goes anywhere.
  useEffect(() => {
    let live = true;
    setName(null);
    setQuote(null);
    void nameOf(card.who).then((n) => live && setName(n));
    void quoteOf(card.quote).then((q) => live && setQuote(q));
    return () => {
      live = false;
    };
  }, [card.cardId, card.who, card.quote]);

  // An offer tucks back at `tuckAt` if untouched (it stays in To-do). Only while it shows, so a hidden tab runs no timer for it.
  useEffect(() => {
    if (card.tuckAt === null || card.after) return undefined;
    const wait = card.tuckAt - Date.now();
    if (wait <= 0) {
      onGone?.(card.cardId);
      return undefined;
    }
    const t = window.setTimeout(() => onGone?.(card.cardId), wait);
    return () => window.clearTimeout(t);
  }, [card.cardId, card.tuckAt, card.after, onGone]);

  useEffect(() => setBusy(false), [card.cardId, card.after]);
  useEffect(() => {
    setPapered(false);
    setReplying(false);
  }, [card.cardId]);

  const answer = (a: string): void => {
    setBusy(true);
    void answerCard(card, a).then(
      () => setBusy(false),
      () => setBusy(false),
    );
  };
  const source = fillWho(card.source, name);
  const what = fillWho(card.what, name);
  const said = `${source}. ${what}`;

  if (card.after) {
    return (
      <section ref={box} className={`sh-card sh-after ${className}`} aria-label={R.card} data-testid="shield-card">
        <Said text={card.after.text} />
        <MaiaHalo size="sm" />
        <p className="sh-after-text">{card.after.text}</p>
        <div className="sh-acts">
          {card.after.choices.map((c) => (
            <button key={c.id} type="button" className="sh-btn quiet" disabled={busy} onClick={() => answer(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (papered && tray && paperIds.length) {
    return (
      <section ref={box} className={`sh-card sh-card-papers ${className}`} aria-label={R.card} data-testid="shield-card" data-card={card.cardId}>
        <Stack tray={tray} only={paperIds} label={paperIds.length > 1} />
      </section>
    );
  }

  return (
    <section
      ref={box}
      className={`sh-card${card.level === 'interrupt' ? ' interrupt' : ''}${replying ? ' replying' : ''} ${className}`}
      aria-label={R.card}
      data-testid="shield-card"
      data-card={card.cardId}
      onKeyDown={(e) => {
        // R on a focused card opens the reply (never from inside a field).
        if (replyTarget && !replying && (e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as Element).closest('input, textarea')) {
          e.preventDefault();
          setReplying(true);
        }
      }}
    >
      <Said text={said} />
      <header ref={head} className={`sh-head${replyTarget ? ' sh-pull' : ''}`}>
        <MaiaHalo size="sm" />
        <Source text={source} />
        {replyTarget && !replying && <ReplyButton name={name ?? 'them'} onClick={() => setReplying(true)} />}
      </header>
      <p className="sh-what">{what}</p>
      {quote && !replying && (
        <p className="sh-quote">
          <q>{quote}</q>
        </p>
      )}
      {card.why && (
        <p className={`sh-why${card.level === 'interrupt' ? ' time' : ''}`}>
          {card.level === 'interrupt' && <Dot />}
          {card.whyMore ? (
            <button type="button" className="sh-why-btn" aria-expanded={whyOpen} aria-controls={whyId} title={R.why} onClick={() => setWhyOpen(!whyOpen)}>
              {fillWho(card.why, name)}
            </button>
          ) : (
            <span className="sh-why-text">{fillWho(card.why, name)}</span>
          )}
        </p>
      )}
      {whyOpen && card.whyMore && (
        <p id={whyId} className="sh-why-more">
          {fillWho(card.whyMore, name)} ·{' '}
          <button type="button" className="sh-link" onClick={onChange}>
            {R.change}
          </button>
        </p>
      )}
      {card.first && (
        <div className="sh-first sh-inset">
          <p>{fillWho(card.first.text, name)}</p>
          <div className="sh-acts">
            {card.first.choices.map((c) => (
              <button key={c.id} type="button" className="sh-btn quiet" disabled={busy} onClick={() => answer(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {replying && replyTarget && (
        <QuickReply
          target={replyTarget}
          name={name}
          onClose={() => setReplying(false)}
          onDone={(r) => {
            if (r !== 'sent') return;
            // Done where it was: the item's answered and the card goes, with no Back (the member never left).
            void answerCard(card, 'replied').catch(() => undefined);
            onGone?.(card.cardId);
          }}
        />
      )}
      {!replying && (
      <div className="sh-acts">
        {(card.go.kind !== 'none' || paperIds.length > 0) && (
          <button
            type="button"
            className="sh-btn primary"
            disabled={busy}
            aria-label={`${card.goLabel}: ${what}`}
            onClick={() => {
              // Papers open here and the card stays until they're answered (the item leaves when its source does); the
              // answer itself counts as the go.
              if (paperIds.length) {
                setPapered(true);
                return;
              }
              void answerCard(card, 'go').catch(() => undefined);
              onGo(card.go, card.deskId);
              onGone?.(card.cardId);
            }}
          >
            {card.goLabel}
          </button>
        )}
        {card.choices.map((c) => (
          <button key={c.id} type="button" className="sh-btn soft" disabled={busy} onClick={() => answer(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      )}
      {card.more.length > 0 && (
        <div className="sh-inset sh-riders-tray">
          <p className="sh-more-head">{R.more(card.more.length)}</p>
          <ul className="sh-riders">
            {card.more.map((r) => (
              <RiderRow key={r.itemId} r={r} name={null} onGo={onGo} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
