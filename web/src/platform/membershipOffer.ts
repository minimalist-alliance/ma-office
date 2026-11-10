// What the office's membership card may offer: whether Pay is open, and the Alliance tier's price while that tier
// is on sale. Platform says both in one place, the `billing` block of `GET /v1/client-config?app=platform-web`
// (contract billing.md), and only there: `?app=desk-web` has no `billing` block in any environment. So the office
// reads Platform's own answer, which is public, and Pay is open here exactly when the account page shows Pay.
// Nothing is hard-coded: no block, or a block that can't be used, is Pay off.
import { create } from 'zustand';
import { currentApiBase } from './hosts';

export interface MembershipOffer {
  /** The account page has Pay (`billingSwitch` in ma-platform `web/platform/src/billing.ts` says on). */
  open: boolean;
  /**
   * Alliance Member's monthly price, from settings, only while that tier is on sale: `billing.allianceMonthlyUsd`, which
   * Platform sends once the owner's price slider has set one (ma-platform ADR 0097). Until then the Alliance line is hidden.
   */
  allianceMonthlyUsd: number | null;
}

const CLOSED: MembershipOffer = { open: false, allianceMonthlyUsd: null };

const price = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Read the way Platform's app reads it: anything but `enabled: true` with a usable price for `officer` is Pay off. The
 * price is `officerMonthlyUsd` (contract tiers.md section 3), and only where that's absent the `memberMonthlyUsd` it
 * renames, which Platform keeps one step as an alias. So this works on either side of the alias going, and a bad
 * `officerMonthlyUsd` is never covered up by the old name.
 */
export function offerFrom(cfg: unknown): MembershipOffer {
  const b = (cfg as { billing?: { enabled?: unknown; officerMonthlyUsd?: unknown; memberMonthlyUsd?: unknown; allianceMonthlyUsd?: unknown } } | null)?.billing;
  const officerUsd = b && (b.officerMonthlyUsd !== undefined ? price(b.officerMonthlyUsd) : price(b.memberMonthlyUsd));
  if (!b || b.enabled !== true || !officerUsd) return CLOSED;
  return { open: true, allianceMonthlyUsd: price(b.allianceMonthlyUsd) };
}

/** $10, or $7.50: as Platform's pages and Stripe's line show a price (`formatUsd` in ma-platform). */
export function formatUsd(usd: number): string {
  const cents = Math.round(usd * 100);
  const opts = cents % 100 === 0 ? {} : { minimumFractionDigits: 2 };
  return `$${(cents / 100).toLocaleString('en-US', opts)}`;
}

/** Null until Platform has answered. `failed`: it didn't, so the card offers nothing and promises nothing. */
export const useOffer = create<{ offer: MembershipOffer | null; failed: boolean }>(() => ({ offer: null, failed: false }));

const TIMEOUT_MS = 5000;
let asking: Promise<void> | null = null;

/** Asked once a page, and only by an account that sees card A. A failure is asked again on the next call. */
export function loadOffer(): Promise<void> {
  if (useOffer.getState().offer) return Promise.resolve();
  asking ??= (async () => {
    try {
      const base = currentApiBase();
      if (!base) throw new Error('This host is not a Desk host');
      const res = await fetch(`${base}/v1/client-config?app=platform-web`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`client-config -> ${res.status}`);
      useOffer.setState({ offer: offerFrom(await res.json()), failed: false });
    } catch {
      useOffer.setState({ failed: true });
    } finally {
      asking = null;
    }
  })();
  return asking;
}
