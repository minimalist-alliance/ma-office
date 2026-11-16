// Whether Maia shows in the office at all. This and `net.ts` are her only code in the initial bundle: the widget is a
// lazy chunk, loaded only once client-config has a `maia` block and `GET /v1/maia/state` says `enabled: true`.
// No block (prod today) means nothing: no chunk, no request to any Maia URL. Contract maia.md, "The widget".
// Reading her state's answer (`state.ts`) is a chunk of its own since `sub/mm-js-budget`, fetched beside the ask.
import type { ClientConfig } from '../platform/clientConfig';
import { maiaFetch } from './net';
import type { MaiaState } from './state';

export type { Free, MaiaState } from './state';

const LOCAL = /^(localhost|127\.0\.0\.1)$/;

export interface Here {
  origin: string;
  hostname: string;
}

/**
 * The base of Maia's member routes, or null for no Maia. Only `https`, with no credentials, query or fragment. With
 * `allowLocal` (builds that aren't production), the page's own origin on localhost too: the test harness's fake Maia.
 */
export function maiaBase(cfg: ClientConfig | null | undefined, here: Here, allowLocal: boolean): string | null {
  const block: unknown = (cfg as { maia?: unknown } | null | undefined)?.maia;
  const raw = block && typeof block === 'object' ? (block as { url?: unknown }).url : undefined;
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = allowLocal && url.protocol === 'http:' && LOCAL.test(here.hostname) && url.origin === here.origin;
  if (url.protocol !== 'https:' && !local) return null;
  return url.href.replace(/\/+$/, '');
}

/** Her state, or null on any failure, which means no widget. */
export async function fetchMaiaState(base: string, signal?: AbortSignal): Promise<MaiaState | null> {
  try {
    const [res, { readState }] = await Promise.all([maiaFetch(base, '/v1/maia/state', signal ? { signal } : {}), import('./state')]);
    if (!res.ok) return null;
    return readState(await res.json());
  } catch {
    return null;
  }
}
