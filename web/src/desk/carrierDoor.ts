// The door to the office's carrier (`deskCarrier.ts`, W6), the only part of it in the first load: which links it carries
// between (`carrierRules.ts`), and the carrier itself, fetched as its own chunk once two of the member's own desks have links.
// `liveStore.ts` tells it whenever the links change, and stops it with the office.
import { mayHaveApp } from '../platform/age';
import { useDeskStore } from '../state/deskStore';
import { carriedDeskIds } from './carrierRules';
import type { DeskLink } from './deskLink';

type Carrier = import('./deskCarrier').DeskCarrier;

let carrier: Carrier | null = null;
let loading = false;
/** The links to carry between now: a chunk that lands after the office stopped finds none, and makes nothing. */
let wanted: DeskLink[] = [];

/** The office's links now. Fewer than two of the member's own desks carry nothing, and fetch nothing. */
export function carryBetween(links: readonly DeskLink[]): void {
  const ids = new Set(carriedDeskIds(links.map((l) => l.deskId), useDeskStore.getState().desks, mayHaveApp('agent')));
  wanted = links.filter((l) => ids.has(l.deskId));
  if (carrier) {
    carrier.setLinks(wanted);
    return;
  }
  if (wanted.length < 2 || loading) return;
  loading = true;
  import('./deskCarrier').then(
    ({ DeskCarrier }) => {
      loading = false;
      if (carrier || wanted.length < 2) return;
      carrier = new DeskCarrier();
      carrier.setLinks(wanted);
    },
    () => {
      loading = false; // asked again at the next change of links
    },
  );
}

/** The office is over for this member, or they have no Agent: nothing more is carried. */
export function stopCarrying(): void {
  wanted = [];
  carrier?.destroy();
  carrier = null;
}
