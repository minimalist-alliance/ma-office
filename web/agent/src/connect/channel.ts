// What the office tab and its `/connect/openrouter` page say to each other over a BroadcastChannel (agent-free-key spec §2.1).
// The page, which OpenRouter sends the window back to, relays `{code, state}` (or `{state, error: true}`) and the office answers
// `{got: state}`. Kept apart from `openrouter.ts` so the page's own small chunk carries none of the Agent app.

/** The office's own page OpenRouter sends the window back to. */
export const CALLBACK_PATH = '/connect/openrouter';
export const CHANNEL = 'ma-openrouter';
/** How long a Connect waits, on either side. */
export const CONNECT_MS = 10 * 60_000;

export const isText = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** What the page relays: OpenRouter's code with its state, or no code (the member declined, or OpenRouter erred). */
export type Answer = { kind: 'code'; code: string; state: string } | { kind: 'error'; state: string | null };

export function parseAnswer(data: unknown): Answer | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { code?: unknown; state?: unknown; error?: unknown };
  if (d.error === true) return { kind: 'error', state: isText(d.state) ? d.state : null };
  if (isText(d.code, 2048) && isText(d.state)) return { kind: 'code', code: d.code, state: d.state };
  return null;
}

/** The office's answer: it has what was relayed for this state, so the page can stop. */
export function parseGot(data: unknown): { got: string | null } | null {
  if (!data || typeof data !== 'object' || !('got' in data)) return null;
  const got = (data as { got: unknown }).got;
  return got === null || isText(got) ? { got } : null;
}
