// Proposal cards (contract maia.md, "Proposals" and "Memory cards"): built from these templates, in the app's own
// words, with desk names from the app's own desk list and memory text from the app's own memory list. None of
// Maia's reply text is ever in a card. The one exception the contract makes is a `remember` card's `text`, which
// shows as plain text in a quote, never Markdown, a link, a button or a label. Pure.
import { currentBand } from '../platform/age';
import { accountUrl, supportAddress, type ClientConfig } from '../platform/clientConfig';
import { siblingUrl } from '../platform/hosts';
import { DEFAULT_TIER_NAMES, type TierNames } from '../platform/tiers';
import type { Proposal } from './frames';
import { ourLink } from './links';

export type MemoryKind = 'preference' | 'how_to_help' | 'setup';

export const KIND_LABELS: Record<MemoryKind, string> = {
  preference: 'How you like answers',
  how_to_help: 'How you like help',
  setup: "What you've set up",
};

export const isMemoryKind = (k: unknown): k is MemoryKind => typeof k === 'string' && Object.hasOwn(KIND_LABELS, k);

/** A kind this app doesn't know yet still shows, under a plain label, so it can still be deleted. */
export const kindLabel = (kind: string): string => (isMemoryKind(kind) ? KIND_LABELS[kind] : 'Remembered');

export interface Memory {
  memoryId: string;
  kind: string;
  text: string;
  createdAt: string;
}

export type Page = 'account' | 'billing' | 'desks' | 'support' | 'privacy' | 'terms';
const PAGES: readonly Page[] = ['account', 'billing', 'desks', 'support', 'privacy', 'terms'];

export interface CardContext {
  desks: readonly { id: string; name: string }[];
  /** Null while the list hasn't loaded. */
  memories: readonly Memory[] | null;
  /** Where each page opens; null for one this app has no good address for. `desks` is this office itself. */
  pageHref: (page: Page) => string | null;
  /** The tiers' names, the owner's setting (contract tiers.md). The defaults where it's left out. */
  tierNames?: TierNames;
}

export interface CardTemplate {
  /** `lead_request` is the offer of the `lead` tier, which is bought on the billing page (ADR 0114); it opens billing. */
  action: 'open_desk' | 'open_page' | 'lead_request' | 'remember' | 'forget';
  title: string;
  /** A small label above the title: a memory's kind. */
  label: string | null;
  /** The memory's words, as plain text. */
  quote: string | null;
  body: string | null;
  /** The buttons. Null: there's nothing to confirm, as for a desk or memory that isn't there. */
  confirm: string | null;
  decline: string | null;
  /** open_page: the confirm is this link, in its own tab. */
  href: string | null;
  deskId: string | null;
  memoryId: string | null;
  page: Page | null;
}

const MAX_QUOTE = 500;

const base = (action: CardTemplate['action'], title: string): CardTemplate => ({
  action, title, label: null, quote: null, body: null, confirm: null, decline: null, href: null, deskId: null, memoryId: null, page: null,
});

/** "Personal" is "your Personal desk"; a name that already says desk isn't said twice. */
export function deskPhrase(name: string): string {
  const n = name.trim() || 'desk';
  return /\bdesk$/i.test(n) ? `your ${n}` : `your ${n} desk`;
}

const PAGE_TITLES: Record<Page, string> = {
  account: 'Open your account page',
  billing: 'Open billing',
  desks: 'Show all your desks',
  support: 'Open Support',
  privacy: 'Open the Privacy Policy',
  terms: 'Open the Terms of Service',
};

/** The card for a proposal, or null for one this app doesn't render: an unknown action, or params it can't use. */
export function cardTemplate(p: Proposal, ctx: CardContext): CardTemplate | null {
  const params = p.params;
  switch (p.action) {
    case 'open_desk': {
      const deskId = params['deskId'];
      if (typeof deskId !== 'string') return null;
      const desk = ctx.desks.find((d) => d.id === deskId);
      if (!desk) return { ...base('open_desk', "That desk isn't in your office."), deskId };
      return { ...base('open_desk', `Open ${deskPhrase(desk.name)}`), body: "This starts it if it's stopped.", confirm: 'Open', decline: 'Not now', deskId };
    }
    case 'open_page': {
      const page = params['page'];
      if (typeof page !== 'string' || !(PAGES as readonly string[]).includes(page)) return null;
      const pg = page as Page;
      if (pg === 'desks') return { ...base('open_page', PAGE_TITLES.desks), confirm: 'Show', decline: 'Not now', page: pg };
      const href = ctx.pageHref(pg);
      if (!href) return { ...base('open_page', "That page isn't available here."), page: pg };
      return {
        ...base('open_page', PAGE_TITLES[pg]),
        body: href.startsWith('mailto:') ? null : 'It opens in a new tab.',
        confirm: 'Open',
        decline: 'Not now',
        href,
        page: pg,
      };
    }
    case 'lead_request': {
      // Founder is bought now (ADR 0114): the server answers the old request 410 lead_by_checkout, so the card opens billing.
      const href = ctx.pageHref('billing');
      if (!href) return { ...base('open_page', "That page isn't available here."), page: 'billing' };
      return { ...base('lead_request', `Become ${(ctx.tierNames ?? DEFAULT_TIER_NAMES).lead}?`), body: 'Choose it on your billing page. You see the charge before you pay.', confirm: 'Open billing', decline: 'Not now', href };
    }
    case 'remember': {
      const { kind, text } = params;
      if (!isMemoryKind(kind) || typeof text !== 'string' || !text.trim()) return null;
      return {
        ...base('remember', 'Remember this?'),
        label: KIND_LABELS[kind],
        quote: oneLine(text),
        confirm: 'Remember',
        decline: 'Not now',
      };
    }
    case 'forget': {
      const memoryId = params['memoryId'];
      if (typeof memoryId !== 'string') return null;
      const memory = ctx.memories?.find((m) => m.memoryId === memoryId);
      if (!memory) {
        // Still loading reads as gone only once the list is known.
        return ctx.memories ? { ...base('forget', "That's already gone."), memoryId } : { ...base('forget', 'Forget this?'), memoryId };
      }
      return {
        ...base('forget', 'Forget this?'),
        label: kindLabel(memory.kind),
        quote: oneLine(memory.text),
        confirm: 'Forget',
        decline: 'Keep',
        memoryId,
      };
    }
    default:
      return null;
  }
}

/** Plain, on one line, and not longer than a memory can be. */
function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t;
}

/** A card past its `expiresAt` offers nothing. A missing or unreadable time never expires here; the server decides. */
export function expired(p: Pick<Proposal, 'expiresAt'>, now: number): boolean {
  const at = p.expiresAt ? Date.parse(p.expiresAt) : NaN;
  return Number.isFinite(at) && at <= now;
}

/** The plain line after a decision on a memory card, from the decision's answer. */
export function memoryOutcome(action: 'remember' | 'forget', status: number, code: string | null): { ok: boolean; line: string } {
  if (status === 204 || status === 200) return { ok: true, line: action === 'remember' ? 'Remembered.' : 'Forgotten.' };
  switch (code) {
    case 'memory_off':
      return { ok: false, line: 'Memory is off now, so nothing changed.' };
    case 'memory_full':
      return { ok: false, line: "Maia's memory is full. Delete something in What Maia remembers first." };
    case 'memory_private':
      // A teen has no desk agents to keep things with.
      return { ok: false, line: currentBand() === 'teen' ? "That looks private, so it wasn't saved." : "That looks private, so it wasn't saved. Keep private things with your desk agents." };
    case 'already_decided':
      return { ok: false, line: 'This was already answered.' };
    default:
      return { ok: false, line: status === 404 ? 'This suggestion is no longer available.' : "That didn't go through. Try again in a moment." };
  }
}

/** A memory from `GET /v1/maia/memories`, or null for one this app can't show. */
export function readMemory(m: unknown): Memory | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  if (typeof r['memoryId'] !== 'string' || !r['memoryId'] || typeof r['text'] !== 'string') return null;
  return { memoryId: r['memoryId'], kind: typeof r['kind'] === 'string' ? r['kind'] : '', text: r['text'], createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : '' };
}

/** The legal pages are on the landing site, which client-config has no link for yet. */
const LANDING = 'https://minimalistalliance.com';
/** Where a page opens, from client-config's own links. Null for one there's no good address for. */
export function pageHref(page: Page, cfg: ClientConfig | null, hostname: string): string | null {
  if (!cfg) return null;
  const link = (name: string): string | null => siblingUrl(cfg.links?.[name], hostname)?.href ?? null;
  switch (page) {
    case 'account':
      return accountUrl(cfg, hostname);
    case 'billing':
      return link('billing');
    case 'support':
      return link('support') ?? `mailto:${supportAddress(cfg)}`;
    case 'privacy':
    case 'terms':
      return ourLink(cfg.links?.[page] ?? '') ?? `${LANDING}/${page}`;
    default:
      return null; // `desks` is this office, and needs no address
  }
}
