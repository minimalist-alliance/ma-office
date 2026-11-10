// What a desk that can't open says, in a window and over the office (contract 0.3.11). Very little text. A desk that
// can't be opened shows the support address and nothing else: no reason, and no word that hints at one.
import { lazy, Suspense, type ComponentProps } from 'react';
import type { DeskRefusal } from '../desk/deskLink';
import { useLiveStore } from '../desk/liveStore';
import { supportAddress } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { useDeskStore } from '../state/deskStore';

export function SupportAddress() {
  const address = supportAddress(useSession((s) => s.config));
  return <a className="closed-link" href={`mailto:${address}`} data-testid="support-address">{address}</a>;
}

/** `billingUrl` has already passed `siblingUrl`; without one, the line stands alone. */
export function BillingLink({ billingUrl }: { billingUrl: string | null }) {
  if (!billingUrl) return null;
  return <a className="closed-link" href={billingUrl} target="_blank" rel="noopener noreferrer" data-testid="billing-link">Billing</a>;
}

const DataGuardView = lazy(() => import('./dataGuardView'));

/** The data guard's refusal in a window (ma-platform ADR 0110): the platform's words, a lazy chunk (`dataGuardView.tsx`). */
export function DataGuardNotice(props: ComponentProps<typeof DataGuardView>) {
  return (
    <Suspense fallback={null}>
      <DataGuardView {...props} />
    </Suspense>
  );
}

export const MEMBERSHIP_LINE = 'Your membership is not active';
/** No time: a new desk takes as long as it takes, and it starts on its own. */
export const SETTING_UP_LINE = 'This desk is still being set up';

/** The first refusal's billing link, preferring one that's there. Undefined: no desk was refused for the membership. */
function membershipRefusal(refusals: (DeskRefusal | null)[]): string | null | undefined {
  let found: string | null | undefined;
  for (const r of refusals) {
    if (!r || r.kind === 'unavailable' || r.kind === 'data_guard') continue;
    if (r.billingUrl) return r.billingUrl;
    found = null;
  }
  return found;
}

/** Over the office, for as long as it holds. One notice however many desks were refused. */
export function OfficeNotice() {
  const ids = useDeskStore((s) => s.desks.map((d) => d.id).join(' '));
  const anyHeld = useDeskStore((s) => s.desks.some((d) => d.vm === 'held'));
  const listed = ids ? ids.split(' ') : [];
  const billing = useLiveStore((s) => membershipRefusal(listed.map((id) => s.desks[id]?.refusal ?? null)));
  const unavailable = useLiveStore((s) => listed.some((id) => s.desks[id]?.refusal?.kind === 'unavailable'));
  const membership = billing !== undefined;
  if (!membership && !anyHeld && !unavailable) return null;
  return (
    <div className="office-notice" role="status" data-testid="office-notice">
      {membership && (
        <p>
          {MEMBERSHIP_LINE}. <BillingLink billingUrl={billing ?? null} />
        </p>
      )}
      {(anyHeld || unavailable) && <p><SupportAddress /></p>}
    </div>
  );
}
