// "You're on {Free} now" in the office (the Sales Engineer's `business/ended-membership-copy.md` section 1A; the owner, prod,
// Nov 12: "nothing tells me that I am now a free member and its not clear to me what I've lost"). Ended-to-Free is on in prod
// (ma-platform tiers.md 11.8): a paid membership that ends in good standing lands on Free, so `/v1/me` says `tier: free`,
// `active`, and only billing's status says where it came from (`steppedDown {from, at}`, billing.md 0.3.87). So this part of
// the free chunk asks `GET /v1/billing/status` once a page, only where Platform's own client-config has Pay open and Free open,
// and draws the card when billing names a paid tier.
//
// The card is card D's look and list (`chrome/endedCard.tsx`, its own chunk, fetched only then): the title, the line, With {Tier}
// against On {Free}, Rejoin with that tier and today's price, Compare memberships and, while a desk is kept for it, Download your
// data. Its desk row reads the desk list: a desk Free can't hold is "Stopped, kept for you to download" (`DeskInfo.notInPlan`).
// - Where the member still has a desk of their own to open (Personal became the free desk), it's said once for that move: it
//   has a close button, its links open in a new tab (no window is lost), and closing it is kept in the layout document's prefs
//   (`freeNowSeen`, that move's `at`), so it doesn't come back on any browser.
// - Where every desk of theirs is kept for download (an Alliance desk, or a Personal desk, on an instance of its own), nothing
//   sits behind it: it stays over the stopped desks as card D does, with no close, and its links go in this tab.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Icon } from '../chrome/icons';
import { spaceKey } from '../lib/spaceKey';
import { api } from '../platform/api';
import { exportPageUrl, supportAddress } from '../platform/clientConfig';
import { loadOffer, useOffer } from '../platform/membershipOffer';
import { useSession } from '../platform/session';
import { tierNamesFrom, type TierId } from '../platform/tiers';
import { announce } from '../shell/announce';
import { useDeskStore } from '../state/deskStore';
import { create } from 'zustand';
import { useFree } from './door';
import { FREE_NOW_SEEN, usePref, writePref } from './prefs';
import { useFreeState } from './state';
import { freeName, membershipUrl } from './wire';
import { NEW_TAB } from './words';

type EndedChunk = typeof import('../chrome/endedCard');

/** The move billing names, once it has answered: the paid tier and when. Null until then, or for anyone else. */
export const useFreeNow = create<{ step: { from: TierId; at: string } | null; chunk: EndedChunk | null; closed: boolean }>(() => ({ step: null, chunk: null, closed: false }));

const paidTier = (v: unknown): TierId | null => (v === 'alliance' || v === 'officer' || v === 'lead' ? v : v === 'member' ? 'officer' : null);
const freeOpen = (free: unknown): boolean => !!free && typeof free === 'object' && (free as { open?: unknown }).open === true;

let asked = false;

/** Once a page, from `office.tsx` `open`: Pay and Free open on Platform's answer, then billing's status, then the card's chunk. */
export function watchFreeNow(): void {
  if (asked) return;
  asked = true;
  void (async () => {
    await loadOffer();
    const { offer, free } = useOffer.getState();
    if (!offer?.open || !freeOpen(free)) return;
    let body: { steppedDown?: { from?: unknown; at?: unknown } | null } | null = null;
    try {
      body = (await api<{ steppedDown?: { from?: unknown; at?: unknown } | null }>('/v1/billing/status')).data;
    } catch {
      return; // billing out of reach: nothing is said, as if nothing moved
    }
    const from = paidTier(body?.steppedDown?.from);
    const at = body?.steppedDown?.at;
    if (!from || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return;
    const chunk = await import('../chrome/endedCard').catch(() => null);
    if (chunk) useFreeNow.setState({ step: { from, at }, chunk });
  })();
}

/** Tests only. */
export const resetFreeNow = (): void => {
  asked = false;
  useFreeNow.setState({ step: null, chunk: null, closed: false });
};

/** `endedFacts` reads `/v1/me`'s tier, which is `free` now: Rejoin's price is the tier billing names, never a teen's. */
const factsFor = <F extends { teen: boolean; priceUsd: number | null }>(f: F, usd: number | null): F => ({ ...f, priceUsd: f.teen ? null : usd });

/** Enter and Space belong to the card's own controls, not the office's desk keys (as on card D). */
function ownKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
}

export function FreeNow() {
  const { step, chunk, closed } = useFreeNow();
  const phase = useFreeState((s) => s.phase);
  const config = useSession((s) => s.config);
  const me = useSession((s) => s.me);
  const listed = useDeskStore((s) => s.status === 'ready');
  const desks = useDeskStore((s) => s.desks);
  const prices = useOffer((s) => s.prices);
  const free = useOffer((s) => s.free);
  const seen = usePref(FREE_NOW_SEEN);
  const own = desks.filter((d) => d.kind === 'personal' || d.kind === 'work');
  const kept = { personal: own.some((d) => d.kind === 'personal' && d.notInPlan), work: own.some((d) => d.kind === 'work' && (d.notInPlan || d.ended)) };
  // A desk of their own they can still open: then the card is said once, and closes.
  const closable = own.some((d) => !d.notInPlan);
  const shows = !!step && !!chunk && phase === 'free' && me?.membership?.status === 'active' && listed && own.length > 0 && !(closable && (closed || seen === step.at));
  const names = tierNamesFrom(config?.tierNames);
  const card = shows && step && chunk
    ? chunk.freeNowCard(step.from, factsFor(chunk.endedFacts(me, config, prices, names), prices?.[step.from] ?? null), freeName(config), chunk.browserMinutesOf(free), kept, {
        rejoin: membershipUrl(config),
        compare: chunk.compareUrl(config?.links),
        // The office's export page where it's on, else Sales' "Ask for your data" by email (card D's).
        download: {
          label: exportPageUrl(config) ? chunk.ENDED_WORDS.download : chunk.ENDED_WORDS.askForData,
          href: chunk.EXPORT_TARGET({ account: null, billing: null, exportPage: exportPageUrl(config), support: supportAddress(config) }),
        },
      })
    : null;
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (card && said !== card.say) {
      setSaid(card.say);
      announce(card.say);
    }
  }, [card, said]);
  // While it shows, a kept desk's own panel (`chrome/EndedDeskPanel.tsx`) waits: this card already says it.
  const showing = !!card;
  useEffect(() => {
    if (!showing) return undefined;
    useFree.setState({ nowCard: true });
    return () => useFree.setState({ nowCard: false });
  }, [showing]);
  if (!card || !step) return null;
  // In a new tab where the office stays usable behind the card; in this tab where nothing is behind it, as card D's.
  const tab = closable ? { target: '_blank', rel: 'noopener' } : {};
  const newTab = closable ? <span className="sr-only">{NEW_TAB}</span> : null;
  const close = (): void => {
    writePref(FREE_NOW_SEEN, step.at);
    useFreeNow.setState({ closed: true });
  };
  return (
    <section className="desk-notice free-now" data-card="1A" data-testid="free-now" data-closable={closable || undefined} aria-labelledby="free-now-title" onKeyDown={ownKeys}>
      {closable && (
        <button type="button" className="free-now-close" aria-label="Close" data-testid="free-now-close" onClick={close}>
          <Icon name="close" />
        </button>
      )}
      <h2 id="free-now-title">{card.title}</h2>
      <p>{card.line}</p>
      {card.list}
      {card.action && (
        <a className="btn primary" href={card.action.href} {...tab} {...spaceKey}>
          {card.action.label}
          {newTab}
        </a>
      )}
      {card.link && (
        <a className="desk-notice-link" href={card.link.href} {...tab}>
          {card.link.label}
          {newTab}
        </a>
      )}
      {card.more.map((l) => (
        <a key={l.label} className="desk-notice-link" href={l.href} {...tab}>
          {l.label}
          {newTab}
        </a>
      ))}
    </section>
  );
}
