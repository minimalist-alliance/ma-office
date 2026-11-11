// The setup circle's state for React: the member, their tier, their steps and what's settled, and what the circle holds.
// The rules are `steps.ts`'s; this only gathers what they read. In the initial chunk, as the ring needs it to draw.
import { ageBandOf } from '../platform/age';
import { useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { useDeskStore } from '../state/deskStore';
import { afterOn, filesOn, guildsOpen, setupOn, setupTierOf, whatsNewItems } from './config';
import { readHidden, readOfferNotNow, readSeen, readSetup, useMirrorTick } from './prefs';
import { useSetupSignals } from './signals';
import { circleOf, offerFor, pickWhatsNew, progressOf, stepsFor, type Circle, type Progress, type SetupPrefs, type SetupTier, type WhatsNewItem } from './steps';

export interface SetupModel {
  circle: Circle;
  tier: SetupTier | null;
  teen: boolean;
  /** The member's steps and how far along, whatever the circle shows now (the panel keeps its list until it closes). */
  progress: Progress | null;
  prefs: SetupPrefs;
  hidden: boolean;
  /** Every What's new item that fits now, for marking them all seen together. */
  items: readonly WhatsNewItem[];
}

export function useSetupModel(now: number = Date.now()): SetupModel {
  const me = useSession((s) => s.me);
  const config = useSession((s) => s.config);
  const doc = useLayoutPrefs();
  useMirrorTick((s) => s.n);
  const trial = useSetupSignals((s) => s.trial);
  const hasDesks = useDeskStore((s) => s.desks.some((d) => d.kind !== 'guild'));

  const tier = setupTierOf(me);
  const teen = ageBandOf(me) === 'teen';
  const prefs = readSetup(doc);
  const hidden = readHidden(doc);
  const on = !!config && setupOn(config) && hasDesks && tier !== null;
  const steps = on && tier ? stepsFor({ tier, teen, guildsOpen: guildsOpen(config), filesOn: filesOn(config), maiaTrial: trial !== 'none' }) : null;
  const progress = steps ? progressOf(steps, prefs) : null;
  const items = on ? whatsNewItems(config) : [];
  const whatsNew = on && tier ? pickWhatsNew(items, { tier, band: ageBandOf(me) }, readSeen(doc), now) : null;
  const circle = circleOf({
    hidden,
    progress,
    afterOn: afterOn(config),
    whatsNew,
    offer: tier ? offerFor(tier, teen, guildsOpen(config)) : null,
    offerNotNowUntil: readOfferNotNow(doc),
    now,
  });
  return { circle, tier, teen, progress, prefs, hidden, items };
}

/** Whether the account menu's "Show setup and what's new" has anything to say: the member has a tier and it's on here. */
export function useSetupAvailable(): boolean {
  const me = useSession((s) => s.me);
  const config = useSession((s) => s.config);
  return !!config && setupOn(config) && setupTierOf(me) !== null;
}
