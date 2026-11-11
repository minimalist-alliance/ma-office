// The desk hands over a link (#9, S-141): the card at the top of the picture, TD-225's look in its two-line form. Our
// sentence by the link's kind alone, the address as plain text, and nothing opens without the member pressing "Open on this
// device"; "Not now" puts it away. It never takes focus, so typing into the page carries on; its buttons come in the Tab
// order after the bar's. See `handoff.ts` for the signal and its rules.
import { useEffect, useState } from 'react';
import type { DeskLink } from '../desk/deskLink';
import { linksOn } from '../open/intent';
import { useSession } from '../platform/session';
import { announce } from '../shell/announce';
import { HANDOFF_STALE_MS, HANDOFF_WORDS, HandoffWatch, parseLinkOut, streamInputAt, type Handoff } from './handoff';
import { LinkIcon } from './linkIcons';
import { openSchemeOnDevice } from './openOnDevice';
import './cards.css';

/** After Open on this device, the card's second form stays this long. */
export const AFTER_SHOWN_MS = 8_000;
const COPIED_MS = 2_000;

export const HANDOFF_AFTER = 'If nothing opened, this device may not have an app for it.';

type Card = { h: Handoff; stage: 'ask' | 'after' };

export function HandoffNote({ deskId, link, hidden, onShown }: { deskId: string; link: DeskLink | null; hidden: boolean; onShown: (shown: boolean) => void }) {
  const on = useSession((s) => linksOn(s.config));
  const [watch] = useState(() => new HandoffWatch());
  const [card, setCard] = useState<Card | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!link || !on) return undefined;
    // A deskd before Links out refuses with `not_found`, and the image's side isn't baked yet: then there's never a card.
    return link.subscribe('browser.links', (m) => {
      const h = parseLinkOut(m);
      if (!watch.take(h, streamInputAt(deskId)) || !h) return;
      setCard({ h, stage: 'ask' });
      setCopied(false);
      announce(`${HANDOFF_WORDS[h.scheme].say} Open on this device, or Not now.`);
    });
  }, [link, on, deskId, watch]);

  // The card goes by itself: a hand-off after 2 minutes, its second form after 8 s.
  useEffect(() => {
    if (!card) return undefined;
    const ms = card.stage === 'after' ? AFTER_SHOWN_MS : Math.max(0, card.h.at + HANDOFF_STALE_MS - Date.now());
    const timer = window.setTimeout(() => setCard((c) => (c === card ? null : c)), ms);
    return () => window.clearTimeout(timer);
  }, [card]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const shown = !!card && !hidden && on;
  useEffect(() => onShown(shown), [shown, onShown]);
  if (!card || !shown) return null;

  const { h, stage } = card;
  const words = HANDOFF_WORDS[h.scheme];
  const open = (): void => {
    // Inside the press, so the device takes it as the member's own.
    openSchemeOnDevice(h.url);
    watch.answer(h.id);
    setCard({ h, stage: 'after' });
  };
  const notNow = (): void => {
    watch.answer(h.id);
    setCard(null);
  };
  const copy = (): void => {
    void navigator.clipboard?.writeText(h.url).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <div className="br-card two-line" role="group" aria-label={stage === 'ask' ? words.say : HANDOFF_AFTER} data-testid="browser-handoff" data-stage={stage} data-scheme={h.scheme}>
      <span className="br-card-chip" aria-hidden="true">
        <LinkIcon name={words.glyph} size={17} />
      </span>
      <span className="br-card-text">
        <span className="br-card-say">{stage === 'ask' ? words.say : HANDOFF_AFTER}</span>
        <span className="br-card-addr" title={h.shown} data-testid="browser-handoff-address">{h.shown}</span>
      </span>
      <span className="br-card-acts">
        {stage === 'ask' ? (
          <>
            <button type="button" className="br-card-go" onClick={open}>Open on this device</button>
            <button type="button" className="br-card-no" onClick={notNow}>Not now</button>
          </>
        ) : (
          <>
            <button type="button" className="br-card-go" onClick={copy} aria-live="polite">{copied ? 'Copied' : 'Copy the address'}</button>
            <button type="button" className="br-card-x" aria-label="Dismiss" title="Dismiss" onClick={() => setCard(null)}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </>
        )}
      </span>
    </div>
  );
}
