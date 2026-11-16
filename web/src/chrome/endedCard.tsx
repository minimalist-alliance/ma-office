// Card D, a membership the member ended whose desks are still kept, in the Sales Engineer's words
// (`~/ma-coord/business/ended-membership-copy.md`, Nov 12; the owner on a prod test account: nothing told him what he is now
// or what he lost). It says what the account is now (no membership: an ended membership never becomes a free one, even where
// the free tier runs), what changed against the tier it had, and Rejoin with that tier and today's price. Every value comes
// from `/v1/me`, client-config or Platform's billing block, and a row or a part whose fact isn't sent is left out, never
// guessed. Its own chunk, loaded only for card D (`DeskNotice.tsx`) and for the "You're on {Free} now" card (Sales' section 1A,
// `free/freeNow.tsx`), so the office's first load doesn't carry it.
import type { ReactNode } from 'react';
import { calendarDate, EXPORT_TARGET, type CardLink, type NoticeCard, type StopLinks } from './membershipCards';

/** For the free chunk's 1A card (`free/freeNow.tsx`), which reaches card D's helpers only through this chunk. */
export { EXPORT_TARGET };
import { siblingUrl } from '../platform/hosts';
import { formatUsd, type TierPrices } from '../platform/membershipOffer';
import { DEFAULT_TIER_NAMES, type TierId, type TierNames } from '../platform/tiers';

/** Every sentence on the card, Sales' (final, Nov 12): one table, so a change is one edit. `{…}` are values, never typed. */
export const ENDED_WORDS = {
  title: (tier: string | null): string => (tier ? `Your ${tier} membership has ended` : 'Your membership has ended'),
  line: (date: string): string => `Your account is still here, without a membership. Rejoin by ${date} and we'll restore your desks.`,
  withHead: (tier: string): string => `With ${tier}`,
  nowHead: 'Now',
  desks: 'Desks',
  desk: 'Desk',
  personalAndWork: 'Personal and Work',
  oneSmallDesk: 'One small desk',
  stoppedKept: (date: string): string => `Stopped, kept until ${date}`,
  forums: 'Forums',
  readAndPost: 'Read and post',
  readOnly: 'Read only',
  guilds: 'Guilds',
  joinAndRun: 'Join and help run them',
  joinUpTo: (n: number): string => `Join up to ${n}`,
  pausedUntilRejoin: 'Paused until you rejoin',
  yourGuild: 'Your guild',
  youLeadIt: 'You lead it',
  guildStays: (lead: string): string => `It stays, but you can't change it until you rejoin as ${lead}`,
  moderating: 'Moderating',
  helpModerate: 'Help moderate the Forums',
  ended: 'Ended',
  badge: 'Badge',
  badgeOf: (tier: string): string => `${tier} badge`,
  none: 'None',
  after: (date: string): string => `After ${date}, we delete your desks and their data, as our Terms say.`,
  rejoin: (tier: string | null, price: string | null): string => (tier ? (price ? `Rejoin ${tier} · ${price} a month` : `Rejoin ${tier}`) : 'Rejoin'),
  askParent: 'Ask your parent to rejoin',
  compare: 'Compare memberships',
  download: 'Download your data',
  askForData: 'Ask for your data',
} as const;

/**
 * Sales' section 1A (Nov 12; the desk cells Nov 14, with ended-to-Free live in prod, where a step to Free deletes nothing, so
 * no {date}): a member `/v1/me` says is on Free whom billing's `steppedDown` names as coming from a paid tier. The same words as
 * ma-platform `web/platform/src/endedMembership.ts` `FREE_NOW`, which /account and /billing draw.
 */
export const FREE_NOW_WORDS = {
  title: (free: string): string => `You're on ${free} now`,
  line: (tier: string, free: string): string => `Your ${tier} membership has ended, and your account moved to ${free}, which has no charge.`,
  onHead: (free: string): string => `On ${free}`,
  /** Officer or Founder whose Personal desk became the free desk, with Work kept for download. */
  workKept: 'Personal. Work is stopped and kept for you to download.',
  /** Officer or Founder whose Personal desk became the free desk, with no Work desk kept. */
  personal: 'Personal',
  /** A desk Free can't hold (an instance of its own, so stopped and kept for export only): never "One desk" or "Personal". */
  keptForDownload: 'Stopped, kept for you to download',
  oneDesk: 'One desk',
  browser: 'Browser',
  withinAllowance: 'Within your monthly allowance',
  minutesADay: (n: number): string => `${n} minutes a day`,
  youNoLongerLeadIt: 'You no longer lead it',
} as const;

/** What the card knows, read by `endedFacts` from `/v1/me`, client-config and the billing block. */
export interface EndedFacts {
  /** The tier the membership ended from, or null when `/v1/me`'s `tier` is missing or unknown. */
  tier: TierId | null;
  names: TierNames;
  /** Today's monthly price for that tier, or null: Pay off, not on sale, a teen (who never sees one). */
  priceUsd: number | null;
  teen: boolean;
  /**
   * A teen whose parent or guardian is the one to act: `/v1/me`'s `parent` is `done` (they agreed and pay; ma-platform
   * age.md section 4, where the parent's page is the only way to pay) or `pending`. Only then "Ask your parent to rejoin";
   * a teen in a state that asks for no parent gets Rejoin with the tier, still with no price.
   */
  parentActs: boolean;
  /** Client-config's `guilds.open`: only then are the guild rows there. */
  guildsOpen: boolean;
  /** Client-config's `guilds.maxGuildsPerMember`, the most guilds one member may join, or null. */
  maxGuilds: number | null;
  /** `/v1/me`'s `guilds[]` has one this member leads. */
  leadsGuild: boolean;
}

export interface EndedRow {
  label: string;
  /** With the tier it ended from; null on every row when the tier isn't known (Sales' "without its With column"). */
  was: string | null;
  now: string;
}

/** `/v1/me`'s `tier` as card D reads it: the paid tier it ended from, `member` (before the migration) as `officer`, else unknown. */
export function endedTier(raw: unknown): TierId | null {
  if (raw === 'alliance' || raw === 'officer' || raw === 'lead') return raw;
  return raw === 'member' ? 'officer' : null;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1000 ? v : null);

export function endedFacts(
  me: { membership?: { tier?: unknown; ageBand?: unknown; parent?: unknown } | null; guilds?: unknown } | null | undefined,
  config: object | null | undefined,
  prices: TierPrices | null | undefined,
  names: TierNames = DEFAULT_TIER_NAMES,
): EndedFacts {
  const m = me?.membership;
  const teen = m?.ageBand !== undefined && m?.ageBand !== null && m?.ageBand !== 'adult';
  const parentActs = teen && (m?.parent === 'done' || m?.parent === 'pending');
  const tier = endedTier(m?.tier);
  const raw = (config as { guilds?: unknown } | null | undefined)?.guilds;
  const g = raw && typeof raw === 'object' ? (raw as { open?: unknown; maxGuildsPerMember?: unknown }) : null;
  const leadsGuild = Array.isArray(me?.guilds) && me.guilds.some((x: unknown) => !!x && typeof x === 'object' && (x as { role?: unknown }).role === 'lead');
  return { tier, names, priceUsd: tier && !teen ? (prices?.[tier] ?? null) : null, teen, parentActs, guildsOpen: g?.open === true, maxGuilds: count(g?.maxGuildsPerMember), leadsGuild };
}

/** The rows by the tier it ended from (Sales' table), each only where its fact is known. */
export function endedRows(f: EndedFacts, kept: string): EndedRow[] {
  const W = ENDED_WORDS;
  const t = f.tier;
  const paid = t === 'officer' || t === 'lead';
  const rows: EndedRow[] = [
    { label: t === 'alliance' ? W.desk : W.desks, was: t === null ? null : t === 'alliance' ? W.oneSmallDesk : W.personalAndWork, now: W.stoppedKept(kept) },
    { label: W.forums, was: t && W.readAndPost, now: W.readOnly },
  ];
  if (f.guildsOpen) {
    if (t === 'lead') {
      if (f.leadsGuild) rows.push({ label: W.yourGuild, was: W.youLeadIt, now: W.guildStays(f.names.lead) });
    } else if (t === 'officer') rows.push({ label: W.guilds, was: W.joinAndRun, now: W.pausedUntilRejoin });
    else if (t === 'alliance') {
      if (f.maxGuilds !== null) rows.push({ label: W.guilds, was: W.joinUpTo(f.maxGuilds), now: W.pausedUntilRejoin });
    } else rows.push({ label: W.guilds, was: null, now: W.pausedUntilRejoin });
  }
  if (paid) {
    rows.push({ label: W.moderating, was: W.helpModerate, now: W.ended });
    rows.push({ label: W.badge, was: W.badgeOf(f.names[t]), now: W.none });
  }
  return rows;
}

/** A page on this site's apex, as the mark's menu checks one (`apexUrl` in `MarkPanel.tsx`, whose chunk this one doesn't load). */
function apexUrl(raw: unknown, hostname: string): URL | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return siblingUrl(`https://a.${url.hostname}/`, hostname) ? url : null;
}

/**
 * Where "Compare memberships" goes: the landing's pricing, Sales' `/#pricing`. Client-config's `links.pricing` once Platform
 * sends one; until then `/#pricing` on the landing that `links.support`, `links.terms` or `links.privacy` names (the site's
 * apex, as the mark's menu finds its policies). None of them a page of this site: left out.
 */
export function compareUrl(links: Record<string, unknown> | undefined, hostname: string = window.location.hostname): string | null {
  const own = links?.['pricing'];
  const direct = apexUrl(own, hostname) ?? siblingUrl(own, hostname);
  if (direct) return direct.href;
  for (const key of ['support', 'terms', 'privacy']) {
    const landing = apexUrl(links?.[key], hostname);
    if (landing) return new URL('/#pricing', landing).href;
  }
  return null;
}

export interface EndedLinks extends StopLinks {
  /** Where Rejoin goes: `links.membership` (contract tiers.md 13.3), else the account page. */
  rejoin: string | null;
  compare: string | null;
}

/** D: the tier it ended from, the line, what changed, the deletion date, and Rejoin with that tier and today's price. */
export function endedCard(dataDeleteAt: string, f: EndedFacts, links: EndedLinks, now: number, timeZone?: string): NoticeCard {
  const W = ENDED_WORDS;
  const kept = calendarDate(dataDeleteAt, now, timeZone);
  const name = f.tier ? f.names[f.tier] : null;
  const rows = endedRows(f, kept);
  const line = W.line(kept);
  const after = W.after(kept);
  const label = f.parentActs ? W.askParent : W.rejoin(name, f.priceUsd !== null ? formatUsd(f.priceUsd) : null);
  const download: CardLink = links.exportPage ? { label: W.download, href: links.exportPage } : { label: W.askForData, href: EXPORT_TARGET(links) };
  return {
    picture: false,
    soon: false,
    alliance: null,
    letter: 'D',
    title: W.title(name),
    body: <DatedLine line={line} date={kept} />,
    say: `${line} ${after}`,
    list: <ChangedList rows={rows} was={name ? W.withHead(name) : null} now={W.nowHead} />,
    after,
    action: links.rejoin ? { label, href: links.rejoin } : null,
    link: links.compare ? { label: W.compare, href: links.compare } : null,
    more: [download],
  };
}

/** The line with its date in bold, the cards' one emphasis. */
function DatedLine({ line, date }: { line: string; date: string }) {
  const at = line.indexOf(date);
  if (at < 0) return <>{line}</>;
  return (
    <>
      {line.slice(0, at)}
      <b>{date}</b>
      {line.slice(at + date.length)}
    </>
  );
}

/**
 * The two columns, `With {tier}` and `Now`, as a description list: each row's label, then both values, each named for a
 * screen reader. At phone width each row is its label, then Now in full, with the With value smaller under it (`app.css`).
 */
function ChangedList({ rows, was, now }: { rows: EndedRow[]; was: string | null; now: string }) {
  return (
    <div className="ended-list" data-testid="ended-changes" data-was={was ? 'yes' : 'no'}>
      <div className="ended-head" aria-hidden="true">
        <span />
        {was && <span className="ended-was">{was}</span>}
        <span className="ended-now">{now}</span>
      </div>
      <dl>
        {rows.map((r) => (
          <div className="ended-row" key={r.label}>
            <dt>{r.label}</dt>
            {was && r.was && (
              <dd className="ended-was">
                <span className="ended-pre">{`${was}: `}</span>
                {r.was}
              </dd>
            )}
            <dd className="ended-now">
              <span className="sr-only">{`${now}: `}</span>
              {r.now}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ----- Sales' section 1A: "You're on {Free} now", drawn by the free tier's chunk (`free/freeNow.tsx`).

/** Which of the member's own desks are kept for download only (`DeskInfo.notInPlan`). */
export interface KeptDesks {
  personal: boolean;
  work: boolean;
}

/**
 * The desk row's `On {Free}` cell (Sales 1A and its Nov 14 note): a Personal desk Free can't hold is "Stopped, kept for you to
 * download" for every tier; else Officer and Founder read "Personal" with Work's line where Work is kept, and Alliance "One desk".
 */
export function freeDeskCell(from: TierId, kept: KeptDesks): string {
  const F = FREE_NOW_WORDS;
  if (kept.personal) return F.keptForDownload;
  if (from === 'alliance') return F.oneDesk;
  return kept.work ? F.workKept : F.personal;
}

/** Client-config's `free.browserMinutesPerDay` (Platform's answer), a positive whole number, or null. */
export function browserMinutesOf(free: unknown): number | null {
  const n = free && typeof free === 'object' ? (free as { browserMinutesPerDay?: unknown }).browserMinutesPerDay : undefined;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 100_000 ? n : null;
}

/**
 * Sales' 1A rows, only rows that changed and whose facts are sent: the desk, the Browser's day, a Founder's guild, moderating
 * and the badge. Left out as ma-platform's /account leaves them out: Files and Guilds (held by Sales) and Maia (neither the
 * config nor `/v1/me` says she was open to this member, and Free in prod has no Maia trial yet).
 */
export function freeNowRows(from: TierId, f: Pick<EndedFacts, 'names' | 'leadsGuild'>, minutes: number | null, kept: KeptDesks): EndedRow[] {
  const W = ENDED_WORDS;
  const F = FREE_NOW_WORDS;
  const big = from === 'officer' || from === 'lead';
  const desk = freeDeskCell(from, kept);
  const rows: EndedRow[] = [big ? { label: W.desks, was: W.personalAndWork, now: desk } : { label: W.desk, was: W.oneSmallDesk, now: desk }];
  if (minutes !== null) rows.push({ label: F.browser, was: F.withinAllowance, now: F.minutesADay(minutes) });
  if (from === 'lead' && f.leadsGuild) rows.push({ label: W.yourGuild, was: W.youLeadIt, now: F.youNoLongerLeadIt });
  if (big) {
    rows.push({ label: W.moderating, was: W.helpModerate, now: W.ended });
    rows.push({ label: W.badge, was: W.badgeOf(f.names[from]), now: W.none });
  }
  return rows;
}

export interface FreeNowCard {
  title: string;
  line: string;
  /** Title and line, for the live region. */
  say: string;
  list: ReactNode;
  action: CardLink | null;
  link: CardLink | null;
  /** "Download your data" while a desk is kept for it. */
  more: CardLink[];
}

/**
 * 1A from what `endedFacts` read (its tier is the one billing says the member stepped down from: `/v1/me`'s is `free` now),
 * the free block's Browser minutes and the desks kept for download. Rejoin is that tier at today's price; a teen's as card D's.
 */
export function freeNowCard(from: TierId, f: EndedFacts, freeWord: string, minutes: number | null, kept: KeptDesks, links: { rejoin: string | null; compare: string | null; download: CardLink }): FreeNowCard {
  const W = ENDED_WORDS;
  const F = FREE_NOW_WORDS;
  const name = f.names[from];
  const price = f.teen ? null : f.priceUsd;
  const label = f.parentActs ? W.askParent : W.rejoin(name, price !== null ? formatUsd(price) : null);
  const title = F.title(freeWord);
  const line = F.line(name, freeWord);
  return {
    title,
    line,
    say: `${title}. ${line}`,
    list: <ChangedList rows={freeNowRows(from, f, minutes, kept)} was={W.withHead(name)} now={F.onHead(freeWord)} />,
    action: links.rejoin ? { label, href: links.rejoin } : null,
    link: links.compare ? { label: W.compare, href: links.compare } : null,
    more: kept.personal || kept.work ? [links.download] : [],
  };
}
