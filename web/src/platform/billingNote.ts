// The office's parts of the billing launch features (the Product Designer's billing spec, Nov 11, stills 14 and 32), with no
// React and no network in them, so `billingNote.test.ts` covers them. Each is drawn only while Platform sends its field, so a
// Platform from before them draws today's office exactly.
//
// - The account menu's fourth header line (option C2): the card Stripe charges next expires before that charge (contract
//   ma-platform billing.md 0.3.86, `/v1/me` `membership.cardExpiresSoon`, built), or the last payment failed
//   (`membership.billingNote` of kind `payment_failed`, not built yet), which comes first.
// - "Stops on {date}" under a Work desk's kind in its menu, for a desk a step down ends at renewal (`endsAt` on the desk object,
//   not built yet).

export interface CardSoon {
  month: number;
  year: number;
  last4: string;
}

export interface MenuNote {
  /** `payment` is drawn in `text.danger` (money has failed); `card` in `text.secondary`. */
  kind: 'payment' | 'card';
  text: string;
  link: string;
}

const LAST4 = /^\d{4}$/;
const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function cardSoonOf(raw: unknown): CardSoon | null {
  if (!raw || typeof raw !== 'object') return null;
  const { month, year, last4 } = raw as { month?: unknown; year?: unknown; last4?: unknown };
  return whole(month, 1, 12) && whole(year, 2000, 2999) && typeof last4 === 'string' && LAST4.test(last4) ? { month, year, last4 } : null;
}

const mmYy = (c: CardSoon): string => `${String(c.month).padStart(2, '0')}/${String(c.year % 100).padStart(2, '0')}`;

/** A card works through the last day of its expiry month, UTC (contract billing.md). */
export const cardExpired = (c: CardSoon, now: number): boolean => now >= Date.UTC(c.year, c.month, 1);

export const UPDATE_CARD = 'Update card';
export const PAY_NOW = 'Pay now';
export const PAYMENT_FAILED = "Your last payment didn't go through.";

/** "Card ending 4242 expires 11/26." (still 32), or "expired" once it has. */
export function cardLine(c: CardSoon, now: number): string {
  return `Card ending ${c.last4} ${cardExpired(c, now) ? 'expired' : 'expires'} ${mmYy(c)}.`;
}

/**
 * The account menu's note, or null: a failed payment first, then the card. Only with somewhere to send the member (the billing
 * page, `billingUrl`, checked by the caller), since both lines end with their link.
 */
export function menuNoteOf(membership: { billingNote?: unknown; cardExpiresSoon?: unknown } | undefined, billingUrl: string | null, now: number = Date.now()): MenuNote | null {
  if (!membership || !billingUrl) return null;
  const note = membership.billingNote;
  if (note && typeof note === 'object' && (note as { kind?: unknown }).kind === 'payment_failed') return { kind: 'payment', text: PAYMENT_FAILED, link: billingUrl };
  const card = cardSoonOf(membership.cardExpiresSoon);
  return card ? { kind: 'card', text: cardLine(card, now), link: billingUrl } : null;
}

/** "Stops on December 1", in UTC as the billing page's dates are. Null for a time that doesn't parse. */
export function stopsOnLine(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `Stops on ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(t)}`;
}
