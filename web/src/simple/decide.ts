// Which view a Browser tab shows: the simple view or the full page (design 7.4, "Modes and fallbacks"). Pure. It loads with
// the simple view's chunk, as the bar's switch does (`BarSwitch.tsx`); only the kill switch (`flag.ts`) is in the main bundle.

/** What the member chose for a site, kept on the desk (`siteMemory.ts`). Null: they never chose. */
export type SiteChoice = 'simple' | 'full';

/**
 * Why the desk shows a page in full: `fallback.reason` on the wire (`deskd` API.md section 14's table, `sub/minified-stage-a`
 * `8161db0`), with `challenge` read by its `cause`, or a document's own `challenge` (the head's, on a page already held).
 * - `sensitive_site` and `http_auth`: a bank, email, health or other private site, or a server's own sign-in, which is
 *   never simplified (T47-1, T47-7). `sign_in` and `payment`: a sign-in or checkout page (`challenge`'s causes).
 * - `member_choice`: the member chose the full page for this site. `remembered`: its pages fell back twice lately. Both
 *   are the site's, and the switch can undo them.
 * - `dialog`: the page has a question open that only the full page shows, until it's answered.
 * - `person_check`: the site wants to check the member is a person. `terms_wall`: it asks them to agree to its terms.
 * - `not_page`: an empty tab, the new tab page or an error page. `http_error`: the site answered 400 or more, shown as it made it.
 * - The rest: the desk couldn't make a good simple page of this one.
 */
export type FallbackReason =
  | 'not_page'
  | 'sensitive_site'
  | 'member_choice'
  | 'remembered'
  | 'dialog'
  | 'http_auth'
  | 'http_error'
  | 'distiller_error'
  | 'timeout'
  | 'too_large'
  | 'low_confidence'
  | 'canvas_app'
  | 'cross_origin_frames'
  | 'terms_wall'
  | 'person_check'
  | 'sign_in'
  | 'payment';

const REASONS: ReadonlySet<string> = new Set<FallbackReason>(['not_page', 'sensitive_site', 'member_choice', 'remembered', 'dialog', 'http_auth', 'http_error', 'distiller_error', 'timeout', 'too_large', 'low_confidence', 'canvas_app', 'cross_origin_frames', 'terms_wall']);
const CAUSES: ReadonlySet<string> = new Set<FallbackReason>(['person_check', 'sign_in', 'payment']);

/**
 * A reason from the wire, with its `cause`. `challenge` is read by its cause (a person check, a sign-in page, a checkout),
 * and one with no cause this office knows is a person check: only the member can get through it, on the real page.
 * Anything else unknown is the desk not managing this page, which shows it in full without a switch.
 */
export function fallbackReason(v: unknown, cause?: unknown): FallbackReason {
  if (v === 'challenge') return typeof cause === 'string' && CAUSES.has(cause) ? (cause as FallbackReason) : 'person_check';
  return typeof v === 'string' && REASONS.has(v) ? (v as FallbackReason) : 'distiller_error';
}

/** A sign-in, payment or private site: never simplified, whatever the member chose. */
export const isPrivate = (r: FallbackReason): boolean => r === 'sensitive_site' || r === 'http_auth' || r === 'sign_in' || r === 'payment';

export type PageStatus =
  /** Nothing from the desk for this page yet. */
  | { kind: 'waiting' }
  /** Nothing came in time (`NO_PAGE_MS`, the spec's 1.5 s), so this page shows in full, with no line, until the desk answers: never a blank page. */
  | { kind: 'slow' }
  | { kind: 'ready' }
  /** A new tab, or a page with no address: an empty simple page. */
  | { kind: 'blank' }
  | { kind: 'fallback'; reason: FallbackReason };

export interface ViewInput {
  /** The desk serves the simple view. Null until it has said. */
  supported: boolean | null;
  /** The member's choice for this site. Undefined while the desk is asked. */
  choice: SiteChoice | null | undefined;
  /** A choice for this page only, until the tab leaves it, such as "Sign in on (site)". */
  override: SiteChoice | null;
  status: PageStatus;
}

export type ViewWhy = 'unsupported' | 'fallback' | 'override' | 'choice' | 'remembered' | 'slow' | 'ready' | 'waiting';

export interface ViewDecision {
  view: SiteChoice;
  /** The switch can change it. */
  canSwitch: boolean;
  why: ViewWhy;
  reason?: FallbackReason;
}

/**
 * The full page wins whenever the simple one would be worse: the desk can't simplify it, it's sensitive, or the member
 * said so. Only the member's own choice is remembered for the site; a fallback is per page and says nothing.
 */
export function decideView(i: ViewInput): ViewDecision {
  if (i.supported === false) return { view: 'full', canSwitch: false, why: 'unsupported' };
  const reason = i.status.kind === 'fallback' ? i.status.reason : null;
  // The site's own: the member's choice, or pages that fell back lately. A press of the switch asks the desk again.
  if (reason === 'member_choice' && i.choice !== 'simple') return { view: 'full', canSwitch: true, why: 'choice' };
  if (reason === 'remembered' && i.choice !== 'simple') return { view: 'full', canSwitch: true, why: 'remembered' };
  if (reason && reason !== 'member_choice' && reason !== 'remembered') return { view: 'full', canSwitch: false, why: 'fallback', reason };
  if (i.override) return { view: i.override, canSwitch: true, why: 'override' };
  if (i.choice === 'full') return { view: 'full', canSwitch: true, why: 'choice' };
  if (i.status.kind === 'slow') return { view: 'full', canSwitch: true, why: 'slow' };
  if (i.choice === 'simple') return { view: 'simple', canSwitch: true, why: 'choice' };
  return { view: 'simple', canSwitch: true, why: i.status.kind === 'waiting' ? 'waiting' : 'ready' };
}

/** The bar's one line (the Product Designer's spec, section 7): an icon, a few words, and at most one action. */
export interface PageLine {
  icon: 'lock' | 'info' | null;
  text: string;
  action?: 'undo' | 'retry' | 'full';
}

/** A line the member's own last step brought, for a while (`controller.ts`): a press of Real page, or a hand-off. */
export type LineEvent = 'picked' | 'signin' | 'pay' | 'video' | 'refused';

const SIGN_IN: PageLine = { icon: 'lock', text: 'Sign-in is always the real page' };
const PAYMENT: PageLine = { icon: 'lock', text: 'Payment is always the real page' };
const WORKS_BEST: PageLine = { icon: 'info', text: 'This page works best as the real page' };
const COULDNT: PageLine = { icon: 'info', text: "Couldn't simplify this page", action: 'retry' };

/**
 * The line beside the switch, or null. It shows only when the page chose for the member, and says why: never a banner
 * over the page, never a notice that doesn't truly matter.
 */
export function pageLine(d: ViewDecision, event: LineEvent | null): PageLine | null {
  if (event === 'picked' && d.view === 'full') return { icon: null, text: 'Real page here from now on', action: 'undo' };
  if (event === 'signin' && d.view === 'full') return SIGN_IN;
  if (event === 'pay' && d.view === 'full') return PAYMENT;
  if (event === 'video' && d.view === 'full') return { icon: 'info', text: 'This video plays on the real page' };
  // The Designer's section 13: "Real page" alone read as a label, not an action.
  if (event === 'refused') return { icon: 'info', text: "That didn't work here", action: 'full' };
  // A desk still answering is the real page with no line: "Couldn't simplify" waits until the desk has said no (the
  // Product Designer's re-review, Nov 9), so a slow answer never reads as a failure.
  if (d.why === 'slow') return null;
  if (d.why === 'remembered') return WORKS_BEST;
  if (d.why !== 'fallback' || !d.reason) return null;
  switch (d.reason) {
    case 'http_auth':
    case 'sign_in':
      return SIGN_IN;
    case 'payment':
      return PAYMENT;
    case 'sensitive_site':
      return { icon: 'lock', text: 'This site is always the real page' };
    case 'person_check':
      return { icon: 'info', text: "The site wants to check you're human" };
    case 'terms_wall':
      return { icon: 'info', text: 'The site asks you to agree to its terms' };
    case 'dialog':
      return { icon: 'info', text: 'The page is asking you something' };
    case 'distiller_error':
    case 'timeout':
      return COULDNT;
    case 'not_page':
    case 'http_error':
    case 'member_choice':
    case 'remembered':
      return null;
    default:
      return WORKS_BEST;
  }
}

/** The switch's tooltips, one per segment: what a press does, and that the site keeps it. */
export function switchTitles(host: string, d: ViewDecision): { simple: string; full: string } {
  const site = host || 'this site';
  if (!d.canSwitch) {
    const why = pageLine(d, null)?.text ?? 'This page shows as the real page';
    return { simple: why, full: why };
  }
  return {
    simple: d.view === 'simple' ? 'Simplified' : `Show ${site} simplified. Remembered for this site.`,
    full: d.view === 'full' ? 'Real page' : `Show ${site} as the real page. Remembered for this site.`,
  };
}
