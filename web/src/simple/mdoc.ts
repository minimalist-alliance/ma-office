// The simple view's page model (design 7.3, ADR 0030): what `deskd`'s MDoc becomes before React sees it. Pure.
//
// The wire is `deskd`'s MDoc v1 (`ma-desk` `sub/minified-stage-a`, `services/deskd/docs/API.md` section 14 at `8161db0`,
// with the closed schema `services/deskd/src/test/resources/minified/mdoc-schema.json`, copied beside this file). MDoc is
// a web page's own content, so it's attacker-written (security review T47-6). Every head, block, run and part is held to
// the schema first (`schema.ts`, T47O-1): one that doesn't fit is dropped, a sensitive one still becomes the real page's
// sign-in, and a field that doesn't fit is never an input. Nothing from it is ever spread into props or rendered as HTML:
// what fits is rebuilt here, field by field, with its strings cleaned and bounded and its URLs checked. The renderer
// only ever sees these types.
import { cleanText } from '../browser/address';
import { fits } from './schema';

/** Bounds on what one page may hold, so a hostile or broken desk can't stall the office. */
export const LIMITS = {
  blocks: 8000,
  /** A paragraph's text, all of a code block's, a field's value. */
  text: 20_000,
  label: 200,
  url: 2048,
  /** Inline runs in one block, counted through every level. */
  runs: 4000,
  depth: 6,
  rows: 300,
  cols: 20,
  options: 300,
  cards: 300,
  /** A card's meta lines, its chips, its actions. */
  cardParts: 4,
  /** The bar's folded groups, such as "Site menu" and "Filters". */
  groups: 8,
  /** Blocks under one `group` or `fold` header. */
  groupBlocks: 300,
  /** A comment's nesting. */
  nest: 8,
} as const;

export type Emphasis = 'strong' | 'em' | 'code' | 'sup' | 'sub' | 'del';

/**
 * A field's on-screen keyboard, from `deskd`'s own word for it. Only ever an `inputMode`: an `<input>` here is always
 * `type="text"`, never a type from the page (T47-1), so no password manager or card filler takes it for a sign-in.
 */
export type InputHint = 'text' | 'search' | 'email' | 'tel' | 'url' | 'numeric';

/** What a password, code, card or payment field becomes (T47-1): never an input, but the real page, one press away. */
export type SecretKind = 'signin' | 'pay';

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'mark'; kind: Emphasis; c: Inline[] }
  | { t: 'br' }
  /**
   * `ref` is its node, which the desk acts on; null when it isn't usable here. `url` is its destination as an http(s)
   * address, for showing and for a new desk tab, never an `href` (T47-6): a search engine's redirect already resolved.
   */
  | { t: 'link'; ref: string | null; url: string | null; c: Inline[]; name: string; next: boolean }
  /** `src` is the image's opaque id, which the desk resolves (`SimpleSource.image`). Never fetched from here (T47-5). */
  | { t: 'img'; src: string; alt: string; w: number; h: number }
  | { t: 'button'; ref: string | null; label: string; name: string; pressed: boolean | null; expanded: boolean | null; selected: boolean | null; disabled: boolean; primary: boolean }
  | { t: 'field'; ref: string | null; kind: 'line' | 'lines' | 'checkbox' | 'radio'; hint: InputHint; label: string; value: string; placeholder: string; checked: boolean; group: string; disabled: boolean; enterSubmits: boolean }
  /** A select by index (`options` are its labels), as `act select` takes it. */
  | { t: 'select'; ref: string | null; label: string; selected: number; options: string[]; disabled: boolean }
  /**
   * A date, time, colour, range or file field, a select of several, or a field of a kind this office doesn't know or that
   * doesn't fit the schema: nothing can be typed into it here, so it shows its label and "Use the real page" (section 14:
   * "offer the stream"; T47O-1: never an input).
   */
  | { t: 'picker'; label: string; value: string; disabled: boolean }
  /** Where a password, one-time code, card or payment field is (T47-1): "Sign in on (site)" or "Pay on (site)". */
  | { t: 'secret'; kind: SecretKind; origin: string | null }
  /** A site's up and down votes and score as one control (R26): each arrow is the real page's own control. */
  | { t: 'vote'; up: string | null; down: string | null; score: string; state: 'up' | 'down' | null };

interface Common {
  /** Part of a dialog the page put over itself, such as a cookie banner, shown in a frame of its own with the site's name. */
  dialog: boolean;
}

export interface FigureImage {
  src: string;
  alt: string;
  w: number;
  h: number;
}

export interface Cell {
  head: boolean;
  span: number;
  c: Inline[];
}

export type IslandKind = 'video' | 'audio' | 'canvas' | 'frame';

export type ButtonRun = Extract<Inline, { t: 'button' }>;
export type LinkRun = Extract<Inline, { t: 'link' }>;
export type VoteRun = Extract<Inline, { t: 'vote' }>;

/** What the desk says of an island's media element: seconds, whether it plays, captions, and DRM, which can't play here. */
export interface IslandMedia {
  duration: number | null;
  time: number;
  playing: boolean;
  /** It has a captions or subtitles track: the island shows its own captions button. */
  captions: boolean;
  /** Which track turns captions on (`act media` `track`), or -1. */
  captionsTrack: number;
  /** A captions or subtitles track shows now. */
  captionsOn: boolean;
  drm: boolean;
}

/** One of the site's few essential actions in the site row (section 14's `site.actions`). */
export interface SiteAction {
  kind: 'search' | 'sections' | 'signin' | 'cart';
  ref: string;
  label: string;
  /** The cart's count, or null. */
  count: number | null;
}

/** Who the page is: the site row's name, favicon and actions. */
export interface SiteInfo {
  name: string;
  /** An image id the desk resolves, never fetched from here (T47-5). */
  icon: string | null;
  actions: SiteAction[];
}

export const HIDDEN_KINDS = ['ads', 'sponsored', 'cookie', 'newsletter', 'popup', 'recommended', 'shorts', 'shelves', 'signin', 'other'] as const;
export type HiddenKind = (typeof HIDDEN_KINDS)[number];

/** What the desk removed from the page, by kind (section 14's `hidden`). Trackers were never on screen, so they're apart. */
export interface Hidden {
  counts: Record<HiddenKind, number>;
  trackers: number;
  /** What the desk did with the cookie banner: answered "Reject all" for the member, or only hid it. */
  cookie: 'rejected' | 'hidden' | null;
  /** The banner's button the desk pressed, as the page labeled it ("Reject all"), when it pressed one (section 14's `done.label`). */
  cookieLabel: string;
  /**
   * Ads and trackers are blocked on this site (ADR 0073's per-site switch, section 14's `hidden.blocking`). Absent on the
   * wire is on: `deskd` sends `false` only for a site the member turned it off for.
   */
  blocking: boolean;
}

/** The sum the hidden control shows, which is exactly the sum of the rows its popover lists. */
export const hiddenTotal = (h: Hidden | null): number => (h ? HIDDEN_KINDS.reduce((n, k) => n + h.counts[k], 0) : 0);

/** One of a run of repeated things on a page: a product, a result, a video, a post (section 14's `cards`). */
export interface Card {
  /** What a press on the card opens: its title's node on the real page. */
  ref: string | null;
  url: string | null;
  title: string;
  img: FigureImage | null;
  /** As the page wrote them, such as "$24.99", or empty. */
  price: string;
  listPrice: string;
  /** Out of 5, such as "4.5", or empty; and how many rated it, such as "1,204". */
  stars: string;
  ratingCount: string;
  /** At most one: the site's badge, a deal, a delivery line. */
  badge: string;
  deal: string;
  delivery: string;
  /** A video's length as the page printed it, such as "8:14". */
  duration: string;
  meta: string[];
  snippet: string;
  chips: string[];
  /** One row of its own buttons, such as "Add to cart". */
  actions: ButtonRun[];
}

/** One of the chrome's folded groups: its name, such as "Site menu" or "Filters", and its links and buttons. */
export interface MenuGroup {
  name: string;
  kind: 'menu' | 'filters' | 'contents';
  c: Inline[];
}

export type CommentKind = 'comment' | 'answer' | 'question';

/** Any block but the chrome and a header's group, which is what a `group` or `fold` may hold. */
export type InnerBlock = Common &
  (
    | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
    /** `nest`: a comment's depth in its thread, 0 for none. */
    | { t: 'para'; c: Inline[]; quote: number; nest: number }
    /** Who wrote it and when, under an article's title. */
    | { t: 'byline'; c: Inline[] }
    /** `marker`: "3." in a numbered list, null for a bullet. `cont`: the same item goes on, with no marker. */
    | { t: 'item'; depth: number; marker: string | null; bullet: boolean; term: boolean; c: Inline[]; quote: number }
    | { t: 'code'; text: string }
    | { t: 'rule' }
    /** `ref` and `url`: the link the image opens on the real page, if it's one. */
    | { t: 'figure'; img: FigureImage; ref: string | null; url: string | null }
    | { t: 'table'; rows: Cell[][] }
    /**
     * What can't be simple, such as a video, shown as a live crop of the real page (design 7.4). `key` is its block's key,
     * which names it here; `ref` is its island id, which names it to the desk (`island`, `act media`), or null when it
     * isn't live here. `main`: the page's own video, at its top. `preroll`: an ad plays in it. `poster`: an image id.
     */
    | ({ t: 'island'; key: string; ref: string | null; kind: IslandKind; w: number; h: number; name: string; main: boolean; preroll: boolean; poster: string | null } & IslandMedia)
    | { t: 'cards'; layout: 'grid' | 'list'; items: Card[] }
    /**
     * One comment, answer or question (R26 to R30): who wrote it, the vote control and Reply on its name line, its body.
     * `more`: how many replies the real page holds back under it. `collapsed`: the site folds it.
     */
    | { t: 'comment'; kind: CommentKind; nest: number; author: string; role: string; vote: VoteRun | null; reply: ButtonRun | null; collapsed: boolean; more: number; accepted: boolean; c: Inline[] }
  );

export type Block =
  | InnerBlock
  | (Common &
      (
        /**
         * The site's own controls, collapsed into the site row (section 14's `bar`, and `controls` from the first
         * distiller): `fields` show in a row, such as the search box and its button; `groups` are folded.
         */
        /**
         * `actions`: the bar's own sign-in and cart, kept as plain actions in the row, never folded (section 4; the
         * Designer's finding 2 on P24, where a loose "Log in" became a second "Menu").
         */
        | { t: 'bar'; fields: Inline[]; groups: MenuGroup[]; actions: SiteAction[] }
        /** What the site recommends after the content, such as "More from this site": folded at the end. */
        | { t: 'group'; name: string; blocks: InnerBlock[] }
        /**
         * A fold-out line (R17, R32): a video's Description or its Comments, closed to one row with its count; or a post's
         * comments, the first `lead` shown and the rest behind "N more comments".
         */
        | { t: 'fold'; name: string; meta: string; kind: 'description' | 'comments' | 'other'; lead: number; blocks: InnerBlock[] }
        /** A search engine's own answer (R22): one card above the results, folded at about 8 lines, sources as chips. */
        | { t: 'answer'; name: string; blocks: InnerBlock[]; sources: LinkRun[] }
        /** A listing's filter rail as one row (R10): All filters (N), the first filters as chips, then Sort. */
        | { t: 'filters'; count: number | null; chips: Inline[]; sort: Inline | null; groups: MenuGroup[] }
        /** The real page stops here for this member (a paywall): the view ends with one line, and nothing after it. */
        | { t: 'paywall' }
      ));

export interface Article {
  kicker: string;
  /** Names, as the page gave them. */
  byline: string[];
  date: string;
  readMinutes: number;
  lead: { img: FigureImage; caption: string; credit: string } | null;
}

/** A page the desk says only the real page can show, with the line that says why (section 14's `challenge`). */
export type Challenge = 'person_check' | 'sign_in' | 'payment';

export interface PageMeta {
  url: string | null;
  /** `https://host[:port]`, the host in punycode: shown outside the content, as what a dialog or a sign-in is "on". */
  origin: string | null;
  title: string;
  /** The document's revision: an action carries the one it was in (T47-2). */
  rev: number;
  /** `article` came from a reader pass, `page` from the whole-page walk. */
  mode: 'article' | 'page';
  /** This tab, or another page of its site, showed a password, code, card or payment field: it only goes one way. */
  sensitive: boolean;
  truncated: boolean;
  loading: boolean;
  site: SiteInfo | null;
  hidden: Hidden | null;
  challenge: Challenge | null;
  article: Article | null;
}

// ----------------------------------------------------------------- strings, numbers, URLs

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => cleanText(v, max);
const label = (v: unknown): string => str(v, LIMITS.label).trim();
const short = (v: unknown, max = 60): string => str(v, max).trim();
const int = (v: unknown, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);
const bool = (v: unknown): boolean => v === true;
const flag = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A table's own entry for a word from the page, never one it inherits (`constructor`, `__proto__`). */
const own = <T>(table: Record<string, T>, key: unknown): T | undefined => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/** A node's id, or an island's: what `act` and `island` name it by. deskd's own are shorter; anything else is unusable here. */
const REF = /^[\w.:~-]{1,64}$/;
export const parseRef = (v: unknown): string | null => (typeof v === 'string' && REF.test(v) ? v : null);
/** A node's fingerprint, sent back with every action on it (T47-2). */
const FP = /^[\w.~-]{1,64}$/;
/** An image's opaque id (T47-5): only a key for `browser.minified.image`, so it's bounded and nothing else. */
const IMAGE_ID = /^[\w.:~-]{1,128}$/;
const imageId = (v: unknown): string | null => (typeof v === 'string' && IMAGE_ID.test(v) ? v : null);

/** An http(s) URL with no credentials in it, or null. Every other scheme, `javascript:`, `data:` and `blob:` included, is null. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > LIMITS.url) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

/** `https://host[:port]` only, or null: what "Sign in on (origin)" names. */
function safeOrigin(v: unknown): string | null {
  const url = safeUrl(v);
  return url ? new URL(url).origin : null;
}

/** A code block keeps its lines and tabs; every other control and bidi override goes. */
function codeText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .slice(0, LIMITS.text)
    .split('\n')
    .map((line) => line.split('\t').map((part) => cleanText(part, LIMITS.text)).join('\t'))
    .join('\n');
}

// ----------------------------------------------------------------- what a block's controls are, for `act`

/** A usable node: its fingerprint, and the key of the block it's in, which `act` sends back with it (section 14). */
export interface Target {
  fp: string;
  block: string;
}

/** Parsing one block: its budget of runs, and the nodes it found, each with its fingerprint. */
interface Ctx {
  runs: number;
  nodes: [string, string][];
}

/** The node a run or part names, usable only with both a node and a fingerprint; registered for `act`. */
function node(o: Record<string, unknown>, ctx: Ctx): string | null {
  const ref = parseRef(o['node']);
  const fp = typeof o['fp'] === 'string' && FP.test(o['fp']) ? o['fp'] : null;
  if (!ref || !fp) return null;
  ctx.nodes.push([ref, fp]);
  return ref;
}

// ----------------------------------------------------------------- inline runs

const MARKS: Record<string, Emphasis> = { b: 'strong', i: 'em', code: 'code', sup: 'sup', sub: 'sub', s: 'del' };
/**
 * `deskd`'s words for a field (section 14), to an on-screen keyboard. Never to an `<input type>` (T47-1). `plain` and
 * `multiline` are text; the `_choice` kinds and `file_choice` can't be typed into, and become a picker.
 */
/** `deskd`'s pickers and its upload: shown with their value, done on the real page. */
const CHOICES: ReadonlySet<string> = new Set(['date_choice', 'time_choice', 'datetime_choice', 'month_choice', 'week_choice', 'colour_choice', 'range_choice', 'file_choice']);
const HINTS: Record<string, InputHint> = { plain: 'text', query: 'search', email_address: 'email', phone_number: 'tel', web_address: 'url', numeric: 'numeric' };

function runs(raw: unknown, ctx: Ctx, depth: number): Inline[] {
  if (!Array.isArray(raw)) return [];
  const out: Inline[] = [];
  for (const x of raw) {
    if (ctx.runs-- <= 0) break;
    const r = run(x, ctx, depth);
    if (r) out.push(r);
  }
  return out;
}

/** A `button` run that fits the schema, or null: in a card's actions, a comment's reply and its arrows. */
function buttonRun(v: unknown, ctx: Ctx): ButtonRun | null {
  return fits('run:button', v) && v['r'] === 'button' ? button(v, ctx) : null;
}

function button(o: Record<string, unknown>, ctx: Ctx): ButtonRun {
  return {
    t: 'button',
    ref: node(o, ctx),
    label: label(o['label']) || label(o['text']) || '•',
    name: label(o['name']),
    pressed: flag(o['pressed']),
    expanded: flag(o['expanded']),
    selected: flag(o['selected']),
    disabled: bool(o['disabled']),
    primary: bool(o['primary']),
  };
}

function vote(o: Record<string, unknown>, ctx: Ctx): Inline | null {
  const arrow = (v: unknown): string | null => (fits('part:arrow', v) ? node(v, ctx) : null);
  const up = arrow(o['up']);
  const down = arrow(o['down']);
  const score = short(o['score'], 16);
  if (!up && !down) return score ? { t: 'text', text: score } : null;
  return { t: 'vote', up, down, score, state: o['state'] === 'up' || o['state'] === 'down' ? o['state'] : null };
}

/** The `kind` a field or a sensitive run names is read here, failing closed, so a word the schema lacks isn't a drop. */
const KIND: ReadonlySet<string> = new Set(['kind']);

function run(x: unknown, ctx: Ctx, depth: number): Inline | null {
  if (typeof x === 'string') {
    const text = str(x, LIMITS.text);
    return text ? { t: 'text', text } : null;
  }
  if (!isObj(x) || typeof x['r'] !== 'string') return null;
  const o = x;
  const r = x['r'];
  // Where a secret field is, it's the real page's sign-in whatever else is wrong with it (T47-1, T47O-1).
  if (r === 'sensitive') return secret(fits('run:sensitive', o, KIND) ? o : {});
  // A field that doesn't fit is never an input: its label, and the real page.
  if (r === 'field') return fits('run:field', o, KIND) ? field(o, ctx) : { t: 'picker', label: label(o['label']), value: '', disabled: false };
  if (!fits(`run:${r}`, o)) return null;
  const mark = own(MARKS, r);
  if (mark) {
    if (depth >= LIMITS.depth) return { t: 'text', text: plainText(runs(o['runs'], ctx, depth + 1)) };
    const c = runs(o['runs'], ctx, depth + 1);
    return c.length ? { t: 'mark', kind: mark, c } : null;
  }
  switch (r) {
    case 'br':
      return { t: 'br' };
    case 'link': {
      const ref = node(o, ctx);
      const url = safeUrl(o['url']);
      const c = depth >= LIMITS.depth ? [] : runs(o['runs'], ctx, depth + 1);
      if (!c.length) c.push({ t: 'text', text: url ? shortUrl(url) : 'link' });
      return { t: 'link', ref, url, c, name: label(o['name']), next: bool(o['next']) };
    }
    case 'image': {
      const src = imageId(o['image']);
      if (!src) return null;
      return { t: 'img', src, alt: label(o['alt']), w: int(o['renderedWidth'] ?? o['width'], 0, 10000), h: int(o['renderedHeight'] ?? o['height'], 0, 10000) };
    }
    case 'button':
      return button(o, ctx);
    case 'check':
      return { t: 'field', ref: node(o, ctx), kind: o['kind'] === 'radio' ? 'radio' : 'checkbox', hint: 'text', label: label(o['label']), value: '', placeholder: '', checked: bool(o['checked']), group: short(o['group'], 40), disabled: bool(o['disabled']), enterSubmits: false };
    case 'select': {
      const options = Array.isArray(o['options']) ? o['options'].slice(0, LIMITS.options).map((op) => label(op)) : [];
      const selected = typeof o['selected'] === 'number' && Number.isInteger(o['selected']) && o['selected'] >= -1 && o['selected'] < options.length ? o['selected'] : -1;
      if (o['multiple'] === true) {
        return { t: 'picker', label: label(o['label']), value: selected >= 0 ? (options[selected] ?? '') : '', disabled: bool(o['disabled']) };
      }
      return { t: 'select', ref: node(o, ctx), label: label(o['label']), selected, options, disabled: bool(o['disabled']) };
    }
    case 'vote':
      return vote(o, ctx);
    default:
      return null;
  }
}

/**
 * A field, by `deskd`'s own word for it (section 14). Only its plain kinds are ever an input here, and never with an
 * `<input type>` from the word: `plain`, `query`, `email_address`, `phone_number`, `web_address`, `numeric` and
 * `multiline`. A picker, an upload, or a word this office doesn't know is shown, and the real page does it. A plain field
 * whose own words ask for a password, a code or a card is the real page's sign-in too: the office's second net, under
 * deskd's own (T47O-1).
 */
function field(o: Record<string, unknown>, ctx: Ctx): Inline {
  const kind = typeof o['kind'] === 'string' ? o['kind'] : '';
  const name = label(o['label']);
  const placeholder = label(o['placeholder']);
  const disabled = bool(o['disabled']);
  const hint = kind === 'multiline' ? 'text' : own(HINTS, kind);
  // A picker's value shows as text ("12 Nov"); a word this office doesn't know shows none of what the page holds.
  if (!hint) return { t: 'picker', label: name || placeholder, value: CHOICES.has(kind) ? short(str(o['value'], LIMITS.text), 80) : '', disabled };
  const looks = looksSecret(name, placeholder);
  if (looks) return { t: 'secret', kind: looks, origin: null };
  const value = str(o['value'], LIMITS.text);
  if (kind === 'multiline') {
    return { t: 'field', ref: node(o, ctx), kind: 'lines', hint: 'text', label: name, value, placeholder, checked: false, group: '', disabled, enterSubmits: false };
  }
  return { t: 'field', ref: node(o, ctx), kind: 'line', hint, label: name, value, placeholder, checked: false, group: '', disabled, enterSubmits: bool(o['enter']) || kind === 'query' };
}

// The office's own net for secret fields (T47O-1), under deskd's: a plain field whose label or placeholder asks for a
// password, a sign-in code, or a card's number, code or expiry, in the languages members most often meet. Never "code"
// alone, so a postal, promo or coupon code stays a field.
const SIGN_IN_WORDS = new RegExp(
  [
    'pass(word|code|phrase)',
    '\\bpin\\b',
    'passwort|kennwort|contrase(ñ|n)a|mot de passe|senha|wachtwoord|parola d.ordine|has(ł|l)o|lösenord|adgangskode|salasana',
    'пароль|密码|密碼|パスワード|비밀번호|كلمة المرور|סיסמה',
    '(one[- ]?time|verification|security|authenti(cation|cator)|auth|log ?in|sign[- ]?in|access|confirmation|sms|2fa|mfa|backup|recovery|\\d[- ]?digit)[- ]?code',
    '\\b(otp|totp|2fa|mfa)\\b',
    'c(ó|o)digo de (verificaci(ó|o)n|seguridad|acceso|verifica(ç|c)(ã|a)o)|code (de|d.)(vérification|verification|sécurité|securite|accès|acces)|bestätigungscode|sicherheitscode|verificatiecode|codice (di verifica|di sicurezza)',
  ].join('|'),
  'i',
);
const PAY_WORDS = /card ?(number|no\b)|\b(credit|debit) ?card|\b(cvc|cvv|csc|cvc2|cvv2|cid)\b|\b(card|cc) ?exp(iry|iration)?\b|\bmm ?\/ ?yy|\biban\b|n(ú|u)mero de (la )?tarjeta|num(é|e)ro de (la )?carte|kartennummer|numero (della )?carta|kaartnummer|n(ú|u)mero do cart(ã|a)o|номер карты/i;

/** "pay" or "signin" when a field's own words ask for a card or a sign-in secret, else null. */
export function looksSecret(...words: string[]): SecretKind | null {
  const text = words.join(' ');
  if (!text.trim()) return null;
  if (PAY_WORDS.test(text)) return 'pay';
  if (SIGN_IN_WORDS.test(text)) return 'signin';
  return null;
}

/** A password, one-time code, card or masked field, or a payment frame (T47-1): never a field, and no node to act on. */
function secret(o: Record<string, unknown>): Inline {
  return { t: 'secret', kind: o['kind'] === 'payment' || o['kind'] === 'card' ? 'pay' : 'signin', origin: safeOrigin(o['origin']) };
}

/** What a link shows when it has no words of its own: its host and path, short. */
function shortUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname === '/' ? '' : u.pathname;
  return (u.host.replace(/^www\./, '') + path).slice(0, 60);
}

export function plainText(c: readonly Inline[]): string {
  let s = '';
  for (const r of c) {
    if (r.t === 'text') s += r.text;
    else if (r.t === 'mark' || r.t === 'link') s += plainText(r.c);
    else if (r.t === 'br') s += ' ';
    else if (r.t === 'button') s += r.label;
    else if (r.t === 'vote') s += r.score;
    if (s.length > LIMITS.text) break;
  }
  return s;
}

/** The first secret field in a run of inline content, anywhere, or null. */
export function secretIn(c: readonly Inline[]): Extract<Inline, { t: 'secret' }> | null {
  for (const r of c) {
    if (r.t === 'secret') return r;
    if (r.t === 'mark' || r.t === 'link') {
      const inner = secretIn(r.c);
      if (inner) return inner;
    }
  }
  return null;
}

// ----------------------------------------------------------------- blocks

/**
 * Frames the size of a standard ad slot (IAB sizes, give or take a few pixels): a frame that size is an ad far more
 * often than content. `deskd` marks ads (`ad: true`) and its blocklist drops most; this is the last word on the rest.
 */
const AD_SIZES: readonly (readonly [number, number])[] = [
  [300, 250], [728, 90], [160, 600], [300, 600], [320, 50], [320, 100], [970, 250], [970, 90], [336, 280], [468, 60], [300, 50], [120, 600], [250, 250], [200, 200],
];
export const adSized = (w: number, h: number): boolean => AD_SIZES.some(([aw, ah]) => Math.abs(w - aw) <= 4 && Math.abs(h - ah) <= 4);

const ISLAND_KINDS: Record<string, IslandKind> = { video: 'video', audio: 'audio', canvas: 'canvas', frame: 'frame', embed: 'frame' };

function island(raw: Record<string, unknown>, key: string, dialog: boolean, ctx: Ctx): InnerBlock | null {
  // An ad is never a player here (section 14).
  if (raw['ad'] === true) return null;
  const kind = own(ISLAND_KINDS, raw['kind']) ?? 'frame';
  const w = int(raw['width'], 0, 10000);
  const h = int(raw['height'], 0, 10000);
  if (w < 120 || h < 60) return null;
  if (kind === 'frame' && adSized(w, h)) return null;
  // Live here only with deskd's island id and its fingerprint, in the `live` state; else it shows, and the real page plays it.
  const ref = raw['state'] === 'live' ? node({ node: raw['island'], fp: raw['fp'] }, ctx) : null;
  const media = fits('part:media', raw['media']) ? raw['media'] : {};
  const tracks = Array.isArray(media['tracks']) ? media['tracks'].slice(0, 16).filter((x) => fits('part:track', x)) : [];
  const captionsTrack = tracks.findIndex((x) => isObj(x) && (x['kind'] === 'captions' || x['kind'] === 'subtitles'));
  const on = tracks.some((x) => isObj(x) && (x['kind'] === 'captions' || x['kind'] === 'subtitles') && x['on'] === true);
  const duration = num(media['duration']);
  const time = num(media['time']);
  return {
    t: 'island',
    key,
    ref,
    kind,
    w,
    h,
    name: label(raw['label']),
    main: bool(raw['main']),
    preroll: bool(raw['preRoll']),
    poster: imageId(media['poster']),
    duration: duration !== null && duration > 0 ? Math.min(duration, 360_000) : null,
    time: time !== null ? Math.max(0, Math.min(time, 360_000)) : 0,
    playing: media['paused'] === false,
    captions: captionsTrack >= 0,
    captionsTrack,
    captionsOn: on,
    drm: bool(media['drm']),
    dialog,
  };
}

function card(raw: unknown, ctx: Ctx): Card | null {
  if (!fits('part:card', raw) || !fits('part:link', raw['title'])) return null;
  const head = raw['title'];
  const title = label(head['text']);
  if (!title) return null;
  let img: FigureImage | null = null;
  const i = raw['image'];
  if (fits('part:cardImage', i)) {
    const src = imageId(i['image']);
    if (src) img = { src, alt: '', w: int(i['width'], 0, 10000), h: int(i['height'], 0, 10000) };
  }
  const list = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.slice(0, LIMITS.cardParts).map((x) => short(x, max)).filter(Boolean) : []);
  const actions: ButtonRun[] = [];
  if (Array.isArray(raw['actions'])) {
    for (const x of raw['actions'].slice(0, LIMITS.cardParts)) {
      const b = buttonRun(x, ctx);
      if (b?.ref && b.label !== '•') actions.push(b);
    }
  }
  const rating = typeof raw['rating'] === 'string' ? raw['rating'].trim() : '';
  return {
    ref: node(head, ctx),
    url: safeUrl(head['url']),
    title,
    img,
    price: short(raw['price'], 32),
    listPrice: short(raw['listPrice'], 32),
    stars: /^[0-5](\.\d)?$/.test(rating) ? rating : '',
    ratingCount: short(raw['ratingCount'], 16),
    badge: short(raw['badge'], 32),
    deal: short(raw['deal'], 80),
    delivery: short(raw['delivery'], 80),
    duration: typeof raw['duration'] === 'string' && /^\d{1,2}(:\d{2}){1,2}$/.test(raw['duration'].trim()) ? raw['duration'].trim() : '',
    meta: list(raw['meta'], 80),
    snippet: str(raw['snippet'], 300).trim(),
    chips: list(raw['chips'], 24),
    actions,
  };
}

const MENU_KINDS: ReadonlySet<string> = new Set(['menu', 'filters', 'contents']);

function menus(raw: unknown, ctx: Ctx, max: number = LIMITS.groups): MenuGroup[] {
  const out: MenuGroup[] = [];
  if (!Array.isArray(raw)) return out;
  for (const g of raw.slice(0, max)) {
    if (!fits('part:menu', g)) continue;
    const c = runs(g['runs'], ctx, 0).filter((r) => !(r.t === 'text' && !r.text.trim()));
    const kind = typeof g['kind'] === 'string' && MENU_KINDS.has(g['kind']) ? (g['kind'] as MenuGroup['kind']) : 'menu';
    if (c.length) out.push({ name: label(g['label']), kind, c });
  }
  return out;
}

/** The site's sign-in and cart, by their own words (section 4's row: Search, Sections or Menu, Sign in, Cart). */
const BAR_SIGN_IN = /^(log ?in|sign ?in|log ?on|sign ?on)$/i;
const BAR_CART = /^(cart|basket|bag|shopping (cart|basket|bag))\b/i;

const refOf = (r: Inline): string | null => ('ref' in r && typeof r.ref === 'string' ? r.ref : null);

/** A loose link or button of the bar that is the site's sign-in or cart, as a site action; else null. */
function barAction(r: Inline): SiteAction | null {
  if ((r.t !== 'link' && r.t !== 'button') || !r.ref) return null;
  const words = (r.t === 'link' ? plainText(r.c) || r.name : r.label).replace(/\s+/g, ' ').trim();
  if (BAR_SIGN_IN.test(words)) return { kind: 'signin', ref: r.ref, label: words, count: null };
  const cart = BAR_CART.exec(words);
  if (cart) {
    const n = /\d+/.exec(words.slice(cart[0].length));
    return { kind: 'cart', ref: r.ref, label: cart[0], count: n ? Math.min(999, Number(n[0])) : null };
  }
  return null;
}

/**
 * The chrome's own runs: its fields (the search box and its button) show in the row; its sign-in and cart stay plain
 * actions; its other links fold as "Site menu". Groups of one name merge (the bar's leftovers and the distiller's own
 * "Site menu" were two "Menu"s on P24), and an entry the row already shows isn't repeated in a menu.
 */
function chrome(c: Inline[], groups: MenuGroup[], dialog: boolean): Block | null {
  const isField = (r: Inline): boolean => r.t === 'field' || r.t === 'select' || r.t === 'secret' || r.t === 'picker';
  const fields: Inline[] = [];
  c.forEach((r, i) => {
    // A field and the button right after it, such as Search, stay together.
    if (fields.length < 4 && (isField(r) || (r.t === 'button' && i > 0 && isField(c[i - 1] as Inline)))) fields.push(r);
  });
  const actions: SiteAction[] = [];
  const rest: Inline[] = [];
  for (const r of c) {
    if (fields.includes(r) || (r.t === 'text' && !r.text.trim())) continue;
    const a = barAction(r);
    if (a && !actions.some((x) => x.kind === a.kind)) actions.push(a);
    else rest.push(r);
  }
  const shown = new Set([...fields.map(refOf), ...actions.map((a) => a.ref)].filter((x): x is string => !!x));
  const merged: MenuGroup[] = [];
  for (const g of rest.length ? [{ name: 'Site menu', kind: 'menu' as const, c: rest }, ...groups] : groups) {
    const same = merged.find((m) => m.name === g.name && m.kind === g.kind);
    const seen = new Set([...shown, ...(same?.c.map(refOf).filter((x): x is string => !!x) ?? [])]);
    const c2 = g.c.filter((r) => {
      const ref = refOf(r);
      if (!ref) return true;
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    });
    if (!c2.length) continue;
    if (same) same.c = [...same.c, ...c2];
    else merged.push({ ...g, c: c2 });
  }
  return fields.length || merged.length || actions.length ? { t: 'bar', fields, groups: merged.slice(0, LIMITS.groups), actions, dialog } : null;
}

/**
 * One block from the wire, with the nodes it found, or a null block to drop it. `key` is its key on the wire. A `group`
 * or `fold` header comes back with no blocks: `docStore` puts the `grouped` blocks after it under it.
 */
export function parseBlock(raw: unknown, key: string): { block: Block | null; nodes: [string, string][] } {
  const ctx: Ctx = { runs: LIMITS.runs, nodes: [] };
  const block = parse(raw, key, ctx);
  return { block, nodes: block ? ctx.nodes : [] };
}

function parse(raw: unknown, key: string, ctx: Ctx): Block | null {
  if (!isObj(raw) || typeof raw['t'] !== 'string') return null;
  const dialog = raw['dialog'] === true;
  // Where a secret field is, it's the real page's sign-in whatever else is wrong with it (T47-1, T47O-1).
  if (raw['t'] === 'sensitive') return { t: 'para', c: [secret(fits('block:sensitive', raw, KIND) ? raw : {})], quote: 0, nest: 0, dialog };
  // Anything else that doesn't fit the schema isn't deskd's, and isn't shown.
  if (!fits(`block:${raw['t']}`, raw)) return null;
  switch (raw['t']) {
    case 'bar':
    case 'controls':
      return chrome(runs(raw['runs'], ctx, 0), menus(raw['menus'], ctx), dialog);
    case 'group':
      return { t: 'group', name: label(raw['label']) || 'More from this site', blocks: [], dialog: false };
    case 'fold': {
      const kind = raw['kind'] === 'description' || raw['kind'] === 'comments' ? raw['kind'] : 'other';
      const name = label(raw['label']) || (kind === 'description' ? 'Description' : kind === 'comments' ? 'Comments' : '');
      if (!name) return null;
      return { t: 'fold', name, meta: short(raw['meta'], 80), kind, lead: int(raw['lead'], 0, 20), blocks: [], dialog: false };
    }
    case 'answer': {
      const c = runs(raw['runs'], ctx, 0);
      const sources = runs(raw['sources'], ctx, 0)
        .filter((r): r is LinkRun => r.t === 'link')
        .slice(0, 8);
      return c.length ? { t: 'answer', name: label(raw['label']) || 'Answer', blocks: [{ t: 'para', c, quote: 0, nest: 0, dialog: false }], sources, dialog } : null;
    }
    case 'filters': {
      const chips = runs(raw['runs'], ctx, 0).filter((r) => r.t !== 'text' && r.t !== 'br').slice(0, 12);
      const sort = raw['sort'] !== undefined ? run(raw['sort'], ctx, 0) : null;
      const groups = menus(raw['menus'], ctx, 80).map((g) => ({ ...g, kind: 'filters' as const }));
      const count = typeof raw['count'] === 'number' ? int(raw['count'], 0, 999) : groups.length || null;
      return chips.length || groups.length || sort ? { t: 'filters', count, chips, sort, groups, dialog } : null;
    }
    case 'paywall':
      return { t: 'paywall', dialog: false };
    default:
      return parseInner(raw, key, dialog, ctx);
  }
}

function parseInner(raw: Record<string, unknown>, key: string, dialog: boolean, ctx: Ctx): InnerBlock | null {
  const quote = int(raw['quote'], 0, 6);
  switch (raw['t']) {
    case 'heading': {
      const c = runs(raw['runs'], ctx, 0);
      return c.length ? { t: 'heading', level: int(raw['level'], 1, 6) as 1 | 2 | 3 | 4 | 5 | 6, c, dialog } : null;
    }
    case 'para': {
      const c = runs(raw['runs'], ctx, 0);
      if (!c.length) return null;
      // R44: a paragraph that starts with ">" is a quote: the mark goes, and it sits under the quote's rule.
      const first = c[0];
      if (first?.t === 'text' && /^\s*>\s?/.test(first.text)) {
        const rest = first.text.replace(/^\s*>\s?/, '');
        const body = rest ? [{ ...first, text: rest }, ...c.slice(1)] : c.slice(1);
        if (body.length) return { t: 'para', c: body, quote: Math.max(quote, 1), nest: int(raw['depth'], 0, LIMITS.nest), dialog };
      }
      return { t: 'para', c, quote, nest: int(raw['depth'], 0, LIMITS.nest), dialog };
    }
    case 'meta': {
      const c = runs(raw['runs'], ctx, 0);
      return c.length ? { t: 'byline', c, dialog } : null;
    }
    case 'item': {
      const c = runs(raw['runs'], ctx, 0);
      if (!c.length) return null;
      const cont = raw['cont'] === true;
      const ordinal = int(raw['ordinal'], 0, 1_000_000);
      return { t: 'item', depth: int(raw['depth'], 1, 6), marker: !cont && ordinal ? `${ordinal}.` : null, bullet: !cont && !ordinal, term: false, c, quote: 0, dialog };
    }
    case 'code': {
      const text = codeText(raw['text']);
      return text.trim() ? { t: 'code', text, dialog } : null;
    }
    case 'rule':
      return { t: 'rule', dialog };
    case 'image': {
      const src = imageId(raw['image']);
      if (!src) return null;
      const link = fits('part:link', raw['link']) ? raw['link'] : null;
      const ref = link ? node(link, ctx) : null;
      return {
        t: 'figure',
        img: { src, alt: label(raw['alt']), w: int(raw['renderedWidth'] ?? raw['width'], 0, 10000), h: int(raw['renderedHeight'] ?? raw['height'], 0, 10000) },
        ref,
        url: link ? safeUrl(link['url']) : null,
        dialog,
      };
    }
    case 'table': {
      if (!Array.isArray(raw['rows'])) return null;
      const rows: Cell[][] = [];
      for (const row of raw['rows'].slice(0, LIMITS.rows)) {
        if (!Array.isArray(row)) continue;
        const cells: Cell[] = [];
        for (const cell of row.slice(0, LIMITS.cols)) {
          if (!fits('part:cell', cell)) continue;
          cells.push({ head: cell['head'] === true, span: int(cell['span'], 1, LIMITS.cols), c: runs(cell['runs'], ctx, 0) });
        }
        if (cells.length) rows.push(cells);
      }
      return rows.length ? { t: 'table', rows, dialog } : null;
    }
    case 'island':
      return island(raw, key, dialog, ctx);
    case 'cards': {
      if (!Array.isArray(raw['items'])) return null;
      const items: Card[] = [];
      for (const x of raw['items'].slice(0, LIMITS.cards)) {
        const c = card(x, ctx);
        if (c) items.push(c);
      }
      return items.length ? { t: 'cards', layout: raw['layout'] === 'grid' ? 'grid' : 'list', items, dialog } : null;
    }
    case 'comment': {
      const c = runs(raw['runs'], ctx, 0);
      const more = int(raw['more'], 0, 1_000_000);
      if (!c.length && !more) return null;
      const author = fits('part:author', raw['author']) ? raw['author'] : {};
      const upRun = buttonRun(raw['up'], ctx);
      const downRun = buttonRun(raw['down'], ctx);
      const up = upRun?.ref ?? null;
      const down = downRun?.ref ?? null;
      const score = short(raw['score'], 16);
      const reply = buttonRun(raw['reply'], ctx);
      const kind = raw['kind'] === 'answer' || raw['kind'] === 'question' ? raw['kind'] : 'comment';
      return {
        t: 'comment',
        kind,
        nest: int(raw['depth'], 0, LIMITS.nest),
        author: short(author['name'], 80),
        role: short(author['role'], 24),
        vote: up || down ? { t: 'vote', up, down, score, state: upRun?.pressed ? 'up' : downRun?.pressed ? 'down' : null } : null,
        reply: reply?.ref ? reply : null,
        collapsed: bool(raw['collapsed']),
        more,
        accepted: bool(raw['accepted']),
        c,
        dialog,
      };
    }
    default:
      // `structured` (JSON-LD for recipes and products) and anything newer: not drawn yet.
      return null;
  }
}

// ----------------------------------------------------------------- the head

const SITE_TAGS: ReadonlySet<string> = new Set(['search', 'sections', 'signin', 'cart']);

/** The site row's facts. `ctx`'s nodes are the site actions', whose `block` for `act` is `"site"`. */
function parseSite(raw: unknown, ctx: Ctx): SiteInfo | null {
  if (!fits('part:site', raw)) return null;
  const actions: SiteAction[] = [];
  if (Array.isArray(raw['actions'])) {
    for (const x of raw['actions'].slice(0, 3)) {
      if (!fits('part:action', x) || typeof x['tag'] !== 'string' || !SITE_TAGS.has(x['tag'])) continue;
      const ref = node(x, ctx);
      if (!ref) continue;
      actions.push({ kind: x['tag'] as SiteAction['kind'], ref, label: label(x['label']), count: typeof x['count'] === 'number' ? int(x['count'], 0, 999) : null });
    }
  }
  return { name: short(raw['name'], 60), icon: imageId(raw['icon']), actions };
}

function parseHidden(raw: unknown): Hidden | null {
  if (!fits('part:hidden', raw) || !fits('part:counts', raw['counts'])) return null;
  const c = raw['counts'];
  const counts = Object.fromEntries(HIDDEN_KINDS.map((k) => [k, int(c[k], 0, 9999)])) as Record<HiddenKind, number>;
  const done = fits('part:done', raw['done']) ? raw['done'] : null;
  const cookie = done?.['cookie'];
  return {
    counts,
    trackers: int(raw['trackers'], 0, 99_999),
    cookie: cookie === 'rejected' || cookie === 'hidden' ? cookie : null,
    // The page's own words for the button, so they're text, short, and only beside what the desk says it pressed.
    cookieLabel: cookie === 'rejected' ? short(done?.['label'], 40) : '',
    blocking: raw['blocking'] !== false,
  };
}

function parseArticle(raw: unknown): Article | null {
  if (!fits('part:article', raw)) return null;
  const lead = fits('part:lead', raw['lead']) ? raw['lead'] : null;
  const leadImg = lead ? imageId(lead['image']) : null;
  return {
    kicker: short(raw['kicker'], 60),
    byline: Array.isArray(raw['byline']) ? raw['byline'].slice(0, 6).map((n) => short(n, 80)).filter(Boolean) : [],
    date: short(raw['date'], 40),
    readMinutes: int(raw['readMinutes'], 0, 600),
    lead: lead && leadImg ? { img: { src: leadImg, alt: '', w: int(lead['width'], 0, 10000), h: int(lead['height'], 0, 10000) }, caption: str(lead['caption'], 400).trim(), credit: short(lead['credit'], 120) } : null,
  };
}

const CHALLENGES: ReadonlySet<string> = new Set(['person_check', 'sign_in', 'payment']);

/**
 * The head of an MDoc (with its `blocks`, which are read apart), or null when it doesn't fit the schema: then nothing of
 * the page shows, and the real page comes in its 1.5 s. The site's actions' nodes go into `nodes`.
 */
export function parseHead(raw: unknown, nodes: Map<string, Target>): PageMeta | null {
  if (!fits('head', raw) || raw['v'] !== 1) return null;
  const rev = raw['rev'] as number;
  const ctx: Ctx = { runs: LIMITS.runs, nodes: [] };
  const site = parseSite(raw['site'], ctx);
  for (const [ref, fp] of ctx.nodes) nodes.set(ref, { fp, block: 'site' });
  const challenge = fits('part:challenge', raw['challenge']) && typeof raw['challenge']['reason'] === 'string' && CHALLENGES.has(raw['challenge']['reason']) ? (raw['challenge']['reason'] as Challenge) : null;
  return {
    url: safeUrl(raw['url']),
    origin: safeOrigin(raw['origin']),
    title: label(raw['title']),
    rev,
    mode: raw['kind'] === 'article' ? 'article' : 'page',
    sensitive: raw['sensitive'] === true,
    truncated: raw['truncated'] === true,
    loading: raw['loading'] === true,
    site,
    hidden: parseHidden(raw['hidden']),
    challenge,
    article: parseArticle(raw['article']),
  };
}

function firstRefIn(c: readonly Inline[]): string | null {
  for (const r of c) {
    if ((r.t === 'link' || r.t === 'button' || r.t === 'field' || r.t === 'select') && r.ref) return r.ref;
    if (r.t === 'vote' && (r.up ?? r.down)) return r.up ?? r.down;
    if (r.t === 'mark' || r.t === 'link') {
      const inner = firstRefIn(r.c);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The first element a block acts on, if any: blocks are keyed by it (design 7.4, "Blocks are keyed by ref"), so a field
 * the member is typing in keeps its element, focus and caret when the page's echo changes the block around it.
 */
export function blockRef(b: Block): string | null {
  switch (b.t) {
    case 'island':
    case 'figure':
      return b.ref;
    case 'table':
      for (const row of b.rows) for (const cell of row) {
        const r = firstRefIn(cell.c);
        if (r) return r;
      }
      return null;
    case 'bar':
      return firstRefIn(b.fields) ?? (b.groups[0] ? firstRefIn(b.groups[0].c) : null);
    case 'cards':
      return b.items.find((i) => i.ref)?.ref ?? null;
    case 'comment':
      return b.vote?.up ?? b.vote?.down ?? b.reply?.ref ?? firstRefIn(b.c);
    case 'group':
    case 'fold':
    case 'answer':
      for (const x of b.blocks) {
        const r = blockRef(x);
        if (r) return r;
      }
      return null;
    case 'filters':
      return firstRefIn(b.chips) ?? (b.sort ? firstRefIn([b.sort]) : null);
    case 'code':
    case 'rule':
    case 'paywall':
      return null;
    default:
      return firstRefIn(b.c);
  }
}

// ---------------------------------------------------------------- rules the renderer applies (pure, so they are tested)

/** A score as a site draws it: digits with separators, a k or m after, a sign before ("27548", "1,204", "-3", "1.2k"). */
const SCORE = /^[+\-\u2212]?\d[\d,.\s]*[kKmM]?$/;

/**
 * R26's vote control, where the distiller left it as plain runs: a line whose only words are a number between two buttons
 * ("▲ 27548 ▼"). Never a name line, so it gets no avatar and its arrows aren't pills. Null for any other line.
 */
export function bareVote(c: readonly Inline[]): VoteRun | null {
  const parts = c.filter((r) => !(r.t === 'text' && !r.text.trim()));
  const [up, mid, down] = parts;
  if (parts.length !== 3 || up?.t !== 'button' || down?.t !== 'button' || mid?.t !== 'text' || !SCORE.test(mid.text.trim())) return null;
  return { t: 'vote', up: up.ref, down: down.ref, score: mid.text.trim(), state: up.pressed ? 'up' : down.pressed ? 'down' : null };
}

/** Replies deeper than this fold into one line (the Designer's spec, section 4: "at most three levels"). */
export const MAX_NEST = 3;
/** A `comment` block's depth starts at 0 for a top-level comment, so R27's three levels (comment, reply, reply to a reply) end at 2. */
export const MAX_COMMENT_NEST = 2;
export const foldsDeep = (b: Block): boolean => (b.t === 'para' && b.nest > MAX_NEST) || (b.t === 'comment' && b.nest > MAX_COMMENT_NEST);

/** A day as ISO 8601 writes it, with or without a time: what a page's JSON-LD `datePublished` usually is. */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An article's date for its facts line: an ISO 8601 date ("2003-12-30T21:52:59Z") reads as the day the page gave, "Dec 30,
 * 2003", never a machine's timestamp; any other words stay as the page wrote them.
 */
export function shownDate(s: string): string {
  const m = ISO_DAY.exec(s.trim());
  if (!m) return s;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return s;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(day);
}

/** One place in the site row: the bar's own search, a menu (by index into `bar.groups`), or a press on the real page. */
export type RowSlot = { t: 'search' } | { t: 'menu'; i: number } | { t: 'action'; a: SiteAction };

/**
 * The site row's actions (section 4), built from both sources and in its order: Search, Menu or Sections, Cart, Sign in,
 * then any other menu; at most three. A cart comes before Sign in. The head's `site.actions` and the bar's own sign-in and cart are one set (a kind
 * shows once, the head's press first); the bar's search field and menus are drawn in place when it has them. On a results
 * page the query is already there, so no Search.
 */
export function rowSlots(site: SiteInfo | null, bar: Extract<Block, { t: 'bar' }> | null, searchPage: boolean): RowSlot[] {
  const by = (kind: SiteAction['kind']): SiteAction | undefined => site?.actions.find((x) => x.kind === kind) ?? bar?.actions.find((x) => x.kind === kind);
  const groups = bar?.groups ?? [];
  const out: RowSlot[] = [];
  if (!searchPage) {
    const s = by('search');
    if (bar?.fields.length) out.push({ t: 'search' });
    else if (s) out.push({ t: 'action', a: s });
  }
  const sections = site?.actions.find((x) => x.kind === 'sections');
  if (groups[0]) out.push({ t: 'menu', i: 0 });
  else if (sections) out.push({ t: 'action', a: sections });
  // A cart comes before Sign in, with a count or without (the Product Designer's re-review, Nov 9): a shop's row is
  // Search, Menu, Cart, and its count would otherwise swap the row the moment something is added.
  for (const kind of ['cart', 'signin'] as const) {
    const a = by(kind);
    if (a) out.push({ t: 'action', a });
  }
  for (let i = 1; i < groups.length; i++) out.push({ t: 'menu', i });
  return out.slice(0, 3);
}
