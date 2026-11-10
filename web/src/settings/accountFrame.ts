// The Platform app's account page, framed in Account settings (ADR 0052; ma-platform contract hostnames.md, 0.3.49).
// Platform lets only the office's origins frame `/account`, and only with `?embed=office`. The page says how it's doing
// with one kind of message, `{ type: 'ma-account', state }`, posted to the office's origin and nowhere else.

export type FrameState = 'ready' | 'signed-out' | 'escape';

const STATES: ReadonlySet<string> = new Set<FrameState>(['ready', 'signed-out', 'escape']);

/** How long the frame has to say it's ready before Account settings offers the account page on its own instead. */
export const FRAME_WAIT_MS = 10_000;

/** The account page's address with `embed=office` added, keeping anything it already has. */
export function embedUrl(account: string): string {
  const u = new URL(account);
  u.searchParams.set('embed', 'office');
  return u.href;
}

/**
 * A message from the framed account page, or null for anything else: it must come from that frame's own window, at the
 * account page's origin, in exactly the agreed shape.
 */
export function frameState(e: Pick<MessageEvent, 'origin' | 'source' | 'data'>, frame: Window | null | undefined, origin: string): FrameState | null {
  if (!frame || e.source !== frame || e.origin !== origin) return null;
  const d = e.data as unknown;
  if (!d || typeof d !== 'object') return null;
  const { type, state } = d as Record<string, unknown>;
  return type === 'ma-account' && typeof state === 'string' && STATES.has(state) ? (state as FrameState) : null;
}

/** True for the office's own CSP refusing the frame, which happens until Platform's frame-src is live. */
export function frameRefused(e: Pick<SecurityPolicyViolationEvent, 'effectiveDirective' | 'blockedURI'>, origin: string): boolean {
  return (e.effectiveDirective === 'frame-src' || e.effectiveDirective === 'child-src' || e.effectiveDirective === 'default-src') && e.blockedURI.startsWith(origin);
}
