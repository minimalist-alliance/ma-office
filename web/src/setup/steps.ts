// The setup circle's rules (S-121, the Product Designer's `design-drafts/setup-circle/README.md`), pure. Which steps a
// member's tier has, how far along they are, and what the circle holds once setup is over: What's new, then the one
// upgrade offer, or nothing. A step is done only by using the feature (`signals.ts` notices), or skipped by the member;
// nothing here reads a desk's content. Every word a member reads is in `words.ts`, which the lazy panel loads.

export type StepId = 'found-guild' | 'invite' | 'work-desk' | 'browser' | 'agent-key' | 'files' | 'maia-trial' | 'guild-join' | 'name-desks';
export const STEP_IDS: readonly StepId[] = ['found-guild', 'invite', 'work-desk', 'browser', 'agent-key', 'files', 'maia-trial', 'guild-join', 'name-desks'];
export const isStepId = (v: unknown): v is StepId => typeof v === 'string' && (STEP_IDS as readonly string[]).includes(v);

/** The four memberships the circle knows: the free tier's id is `free` (contract tiers.md section 11). */
export type SetupTier = 'free' | 'alliance' | 'officer' | 'lead';

/** Each tier's list, in order, at most seven (the draft's table). */
const LISTS: Readonly<Record<SetupTier, readonly StepId[]>> = {
  free: ['browser', 'agent-key', 'files', 'maia-trial'],
  alliance: ['browser', 'agent-key', 'files', 'guild-join'],
  officer: ['work-desk', 'browser', 'agent-key', 'files', 'guild-join', 'name-desks'],
  lead: ['found-guild', 'invite', 'work-desk', 'browser', 'agent-key', 'files', 'name-desks'],
};

const GUILD_STEPS: readonly StepId[] = ['found-guild', 'invite', 'guild-join'];

export interface StepContext {
  tier: SetupTier;
  /** `membership.ageBand` says a teen: no Agent, so no `agent-key`. */
  teen: boolean;
  /** client-config's `guilds.open` isn't `false`. */
  guildsOpen: boolean;
  /** The Files app is on (client-config `files.enabled` isn't `false`). */
  filesOn: boolean;
  /** Maia's trial is there for this member (`GET /v1/maia/state` has a `trial` that isn't `off`), or not known yet. */
  maiaTrial: boolean;
}

/** The member's steps, in order. */
export function stepsFor(c: StepContext): StepId[] {
  return LISTS[c.tier].filter((id) => {
    if (id === 'agent-key') return !c.teen;
    if (GUILD_STEPS.includes(id)) return c.guildsOpen;
    if (id === 'files') return c.filesOn;
    if (id === 'maia-trial') return c.maiaTrial;
    return true;
  });
}

/** `prefs.setup` in the layout document: done and skipped ids. Done stays done whatever happens later. */
export interface SetupPrefs {
  done: readonly StepId[];
  skipped: readonly StepId[];
}

export interface Progress {
  steps: readonly StepId[];
  /** Done or skipped, the circle's filled segments. */
  settled: number;
  /** Open steps, in order. */
  open: StepId[];
}

export function progressOf(steps: readonly StepId[], p: SetupPrefs): Progress {
  const open = steps.filter((id) => !p.done.includes(id) && !p.skipped.includes(id));
  return { steps, settled: steps.length - open.length, open };
}

/** The ring's accessible name: "Setup: 2 of 5 done". Skipped steps count, as the ring fills them. */
export const setupLabel = (p: Progress): string => `Setup: ${p.settled} of ${p.steps.length} done`;

// ----- What's new

export type AgeBandLike = 'teen' | 'adult' | null;

/** One item of client-config's `whatsNew.items` (proposed, from Platform's `whats_new#current`), read field by field. */
export interface WhatsNewItem {
  id: string;
  title: string;
  line: string;
  /** Open an app on the member's first own desk, or a link on one of our own hosts, in a new tab. */
  action: { app: 'browser' | 'notebook' | 'agent' | 'files' } | { href: string };
  /** Absent: every tier. */
  tiers: readonly SetupTier[] | null;
  /** Absent: both. */
  ages: readonly ('teen' | 'adult')[] | null;
  from: number;
  until: number;
}

const ACTION_APPS = ['browser', 'notebook', 'agent', 'files'] as const;
const TIERS: readonly SetupTier[] = ['free', 'alliance', 'officer', 'lead'];
/** "At most 20 words" (the draft); a little room for long words, and nothing a line of chrome can't hold. */
const MAX_TITLE = 60;
const MAX_LINE = 160;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
};
const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * One item, or null if anything about it can't be used. A link goes through `allowHref`, which keeps only our own
 * hosts (`siblingUrl`), so nothing in a setting can send a member somewhere else.
 */
export function readItem(raw: unknown, allowHref: (href: string) => string | null): WhatsNewItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r['id'], 64);
  const title = text(r['title'], MAX_TITLE);
  const line = text(r['line'], MAX_LINE);
  const from = time(r['from']);
  const until = time(r['until']);
  if (!id || !title || !line || from === null || until === null || until <= from) return null;
  const a = r['action'] && typeof r['action'] === 'object' ? (r['action'] as Record<string, unknown>) : {};
  let action: WhatsNewItem['action'] | null = null;
  if ((ACTION_APPS as readonly unknown[]).includes(a['app'])) action = { app: a['app'] as (typeof ACTION_APPS)[number] };
  else if (typeof a['href'] === 'string') {
    const href = allowHref(a['href']);
    if (href) action = { href };
  }
  if (!action) return null;
  const list = <T extends string>(v: unknown, known: readonly T[]): T[] | null =>
    Array.isArray(v) ? v.filter((x): x is T => (known as readonly unknown[]).includes(x)) : null;
  return { id, title, line, action, tiers: list(r['tiers'], TIERS), ages: list(r['ages'], ['teen', 'adult'] as const), from, until };
}

/**
 * The one item to show, or null: the newest that fits the member's tier and age and is within its dates, and only if
 * they haven't seen it. Older ones are dropped, not queued, so a member who was away comes back to one thing.
 */
export function pickWhatsNew(items: readonly WhatsNewItem[], who: { tier: SetupTier; band: AgeBandLike }, seen: readonly string[], now: number): WhatsNewItem | null {
  const age = who.band === 'teen' ? 'teen' : 'adult';
  const fits = items.filter((i) => (!i.tiers || i.tiers.includes(who.tier)) && (!i.ages || i.ages.includes(age)) && i.from <= now && now < i.until);
  const newest = fits.reduce<WhatsNewItem | null>((a, b) => (!a || b.from > a.from ? b : a), null);
  return newest && !seen.includes(newest.id) ? newest : null;
}

/** Every item that fits now, which a Try it or Got it marks seen with the shown one, so none of them comes up later. */
export function fittingIds(items: readonly WhatsNewItem[], who: { tier: SetupTier; band: AgeBandLike }, now: number): string[] {
  const age = who.band === 'teen' ? 'teen' : 'adult';
  return items.filter((i) => (!i.tiers || i.tiers.includes(who.tier)) && (!i.ages || i.ages.includes(age)) && i.from <= now && now < i.until).map((i) => i.id);
}

// ----- the upgrade offer

/** The tier the card names: the next one up, and never {officer} or {lead} for anyone under 18 (`platform/age.ts`). */
export type OfferTier = 'alliance' | 'officer' | 'lead';

export function offerFor(tier: SetupTier, teen: boolean, guildsOpen: boolean): OfferTier | null {
  if (tier === 'free') return 'alliance';
  if (teen) return null;
  if (tier === 'alliance') return 'officer';
  // {lead}'s card is all about a guild of one's own, so it waits while guilds are closed.
  if (tier === 'officer') return guildsOpen ? 'lead' : null;
  return null;
}

export const OFFER_NOT_NOW_DAYS = 30;
export const SPOT_HIDE_DAYS = 30;
export const DAY_MS = 86_400_000;

// ----- what the circle holds

export type Circle =
  | { kind: 'none' }
  | { kind: 'setup'; progress: Progress }
  | { kind: 'after'; whatsNew: WhatsNewItem | null; offer: OfferTier | null };

export interface CircleInput {
  hidden: boolean;
  progress: Progress | null;
  /** client-config `whatsNew.enabled` isn't `false`: the after-setup state's kill switch. */
  afterOn: boolean;
  whatsNew: WhatsNewItem | null;
  offer: OfferTier | null;
  offerNotNowUntil: number | null;
  now: number;
}

/**
 * Hidden is the member's word and nothing overrides it. Any open step is setup (a new tier's new steps bring a finished
 * circle back to setup). Then What's new and the offer, or nothing at all.
 */
export function circleOf(c: CircleInput): Circle {
  if (c.hidden || !c.progress) return { kind: 'none' };
  if (c.progress.open.length) return { kind: 'setup', progress: c.progress };
  if (!c.afterOn) return { kind: 'none' };
  const offer = c.offer && !(c.offerNotNowUntil !== null && c.offerNotNowUntil > c.now) ? c.offer : null;
  return c.whatsNew || offer ? { kind: 'after', whatsNew: c.whatsNew, offer } : { kind: 'none' };
}
