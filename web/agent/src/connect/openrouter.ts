// OpenRouter's PKCE sign-in, run in the member's own browser (the Product Designer's spec `agent-free-key` §2, OpenRouter's
// OAuth PKCE docs). Nobody at Minimalist Alliance issues, sees or keeps the key: this tab makes a verifier, opens OpenRouter,
// trades the code OpenRouter sends back for a key at OpenRouter's own endpoint, and hands the key to the desk with
// `agent.key.add`, as a pasted one goes. The verifier lives in this tab's sessionStorage from the press until the code comes
// back, and then goes; the key is a `KeySecret` from the moment it's read. Nothing here logs anything.
//
// The window OpenRouter sends back (`/connect/openrouter`, `web/src/agent/connectCallback.tsx`) is never trusted: it holds no
// verifier and exchanges nothing. It only relays `{code, state}` over a BroadcastChannel, and this tab acts on a code only for a
// state it made itself, within 10 minutes, once.
import { AgentError } from '../client/agentClient';
import { KeySecret, keyFormatProblem } from '../client/keySecret';
import type { KeyMeta, ModelInfo, Provider } from '../client/types';
import { CALLBACK_PATH, CHANNEL, CONNECT_MS, isText, parseAnswer, type Answer } from './channel';

export { CALLBACK_PATH, CHANNEL, CONNECT_MS, parseAnswer, parseGot, type Answer } from './channel';

/** The provider id desk-agent gives OpenRouter (ma-desk `2b6b5534`). */
export const OPENROUTER = 'openrouter';
export const AUTH_URL = 'https://openrouter.ai/auth';
/** OpenRouter's exchange, the one origin the office's `connect-src` allows for this. */
export const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const KEY_PREFIX = 'sk-or-';
/** This tab's one Connect in progress, in sessionStorage, and nowhere else. */
export const PENDING_KEY = 'ma.agent.orConnect';
/** A connected key's name on the desk. */
export const KEY_LABEL = 'Free models';
/** How long the exchange may take before it counts as unreachable. */
const EXCHANGE_MS = 30_000;

// ------------------------------------------------------------ PKCE

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `n` random bytes, base64url. */
export function randomToken(n: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

/** S256: the verifier's SHA-256, base64url (RFC 7636 4.2). */
export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** A Connect made ready before the press, so the window opens in the press itself and the browser lets it. */
export interface Prepared {
  verifier: string;
  state: string;
  challenge: string;
}

export async function prepare(): Promise<Prepared> {
  const verifier = randomToken(32);
  return { verifier, state: randomToken(16), challenge: await challengeOf(verifier) };
}

/** Where the press sends the member. The key's label names the desk, so the member knows it in their OpenRouter account. */
export function authUrl({ origin, challenge, state, deskName }: { origin: string; challenge: string; state: string; deskName?: string | null }): string {
  const q = new URLSearchParams({ callback_url: `${origin}${CALLBACK_PATH}`, code_challenge: challenge, code_challenge_method: 'S256', state });
  const name = deskName?.trim().slice(0, 40);
  if (name) q.set('key_label', `Minimalist Alliance, ${name} desk`);
  return `${AUTH_URL}?${q.toString()}`;
}

// ------------------------------------------------------------ the one pending Connect

export interface Pending {
  verifier: string;
  state: string;
  deskId: string;
  agentId: string;
  startedAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Where storage can't be written (a locked-down browser), the same tab keeps it in memory instead: never anywhere else. */
let inMemory: string | null = null;

function session(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePending(p: Pending, store: Store | null = session()): void {
  const text = JSON.stringify(p);
  try {
    if (!store) throw new Error('no storage');
    store.setItem(PENDING_KEY, text);
    inMemory = null;
  } catch {
    inMemory = text;
  }
}

export function readPending(store: Store | null = session()): Pending | null {
  let text: string | null = null;
  try {
    text = store?.getItem(PENDING_KEY) ?? null;
  } catch {
    text = null;
  }
  text ??= inMemory;
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Partial<Pending> | null;
    if (!p || !isText(p.verifier) || !isText(p.state) || !isText(p.deskId) || !isText(p.agentId) || typeof p.startedAt !== 'number') return null;
    return { verifier: p.verifier, state: p.state, deskId: p.deskId, agentId: p.agentId, startedAt: p.startedAt };
  } catch {
    return null;
  }
}

/** Forgets the pending Connect, but only the one for `state` when it's given: another agent's newer Connect stays. */
export function clearPending(state?: string, store: Store | null = session()): void {
  const p = readPending(store);
  if (state !== undefined && p && p.state !== state) return;
  try {
    store?.removeItem(PENDING_KEY);
  } catch {
    // nothing to remove
  }
  inMemory = null;
}

// ------------------------------------------------------------ the answer from the window

export type Verdict = { act: 'ignore' } | { act: 'exchange'; code: string; verifier: string } | { act: 'fail'; why: 'mismatch' | 'declined' | 'expired' };

/**
 * What a card waiting on `waiting` (its own state) does with an answer. Another state is someone else's (another tab, another
 * desk), so it's ignored. Its own state with nothing pending to match, or a newer Connect pending in its place, is the spec's
 * "didn't match". An error with no state is OpenRouter's refusal, which carries none: it ends any wait, and adds nothing.
 */
export function judge(answer: Answer, waiting: string, pending: Pending | null, now: number): Verdict {
  if (answer.kind === 'error') return answer.state === null || answer.state === waiting ? { act: 'fail', why: 'declined' } : { act: 'ignore' };
  if (answer.state !== waiting) return { act: 'ignore' };
  if (!pending || pending.state !== waiting) return { act: 'fail', why: 'mismatch' };
  if (now - pending.startedAt > CONNECT_MS) return { act: 'fail', why: 'expired' };
  return { act: 'exchange', code: answer.code, verifier: pending.verifier };
}

/** States this tab has acted on: a code is used once, though two cards (the key screen and Keys) may both be waiting on it. */
const claimed = new Set<string>();
export function claim(state: string): boolean {
  if (claimed.has(state)) return false;
  claimed.add(state);
  return true;
}

/** Hears the callback page. `reply` tells it the office has the answer, so it stops. */
export function listen(onAnswer: (answer: Answer, reply: (state: string | null) => void) => void): () => void {
  if (typeof BroadcastChannel !== 'function') return () => undefined;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    const answer = parseAnswer(e.data);
    if (answer) onAnswer(answer, (state) => ch.postMessage({ got: state }));
  };
  return () => ch.close();
}

// ------------------------------------------------------------ the exchange

export class ConnectError extends Error {
  constructor(readonly why: 'unreachable' | 'refused') {
    super(why);
    this.name = 'ConnectError';
  }
}

/**
 * The code and verifier for a key, at OpenRouter's own endpoint, from this browser: no cookies, no referrer. Anything but a
 * well-formed `sk-or-` key is a refusal. The verifier and code go nowhere else.
 */
export async function exchange(code: string, verifier: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<KeySecret> {
  let res: Response;
  try {
    res = await fetchFn(KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(EXCHANGE_MS),
    });
  } catch {
    throw new ConnectError('unreachable');
  }
  if (!res.ok) throw new ConnectError('refused');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ConnectError('refused');
  }
  const held = body && typeof body === 'object' ? (body as { key?: unknown }) : null;
  const text = typeof held?.key === 'string' ? held.key : null;
  // The parsed body goes with this call; its key is the KeySecret's alone from here.
  if (held) held.key = undefined;
  if (!text) throw new ConnectError('refused');
  const secret = KeySecret.fromText(text);
  if (keyFormatProblem(secret, KEY_PREFIX)) {
    secret.wipe();
    throw new ConnectError('refused');
  }
  return secret;
}

// ------------------------------------------------------------ who's offered it, and the words

/**
 * Whether the key screen offers the free card: the desk serves OpenRouter (an older desk-agent doesn't list it), the member may
 * have it (never a teen, though a teen never reaches the Agent at all), and not on a Guild Desk, where it's paste only (spec
 * §8, open question 3). An OpenRouter key already on the desk hides it too, where "Use a key on this desk" offers that key.
 */
export function freeOffered({ providers, keys, guild, allowed }: { providers: readonly Pick<Provider, 'id'>[]; keys: readonly Pick<KeyMeta, 'provider'>[]; guild: boolean; allowed: boolean }): boolean {
  return allowed && !guild && providers.some((p) => p.id === OPENROUTER) && !keys.some((k) => k.provider === OPENROUTER);
}

/** A model's option text in the picker: a free one's trailing " (free)" goes, and " · Free" and " · Chats only" say it. */
export function modelOption(m: Pick<ModelInfo, 'label' | 'free' | 'tools'>): string {
  if (!m.free) return m.label;
  return `${m.label.replace(/\s*\(free\)\s*$/i, '')} · Free${m.tools === false ? ' · Chats only' : ''}`;
}

/** Whether an agent is on free models: at launch every OpenRouter model desk-agent lists is free (spec §3.1). */
export const onFreeModels = (binding: { provider: string } | null | undefined): boolean => binding?.provider === OPENROUTER;

/** The words for Sales, spec §2.4 and §10. */
export const CONNECT_WORDS = {
  mismatch: "That answer from OpenRouter didn't match, so nothing was added. Connect again.",
  declined: 'OpenRouter didn’t hand over a key, so nothing was added. Connect again.',
  expired: 'That took more than 10 minutes, so nothing was added. Connect again when you’re ready.',
  unreachable: "OpenRouter couldn't be reached from here. Try again in a moment.",
  deskUnreachable: 'Your desk can’t reach OpenRouter right now, so it kept nothing. Try again later, or add a key of your own below.',
  storage: 'Your desk couldn’t save the key, and kept nothing. Connect again.',
  keyRefused: 'OpenRouter refused the new key, so nothing was kept. Connect again.',
  dropped: 'The connection dropped before the desk answered. If no key is listed, connect again.',
  unbound: 'The key is on this desk, but the agent couldn’t start on it yet. Pick it above in a moment.',
} as const;

/** Added only after an exchange that worked: only then is there an unused key. */
export const UNUSED = ' The unused key stays in your OpenRouter account until you delete it there.';

/** The desk didn't take the key OpenRouter made. */
export function deskFailure(err: unknown): string {
  if (err instanceof AgentError && err.reason === 'storage') return CONNECT_WORDS.storage + UNUSED;
  if (err instanceof AgentError && (err.reason === 'key_refused' || err.reason === 'key_malformed')) return CONNECT_WORDS.keyRefused + UNUSED;
  const maybe = err instanceof AgentError ? err.mayHaveApplied : (err as { inFlight?: unknown } | null)?.inFlight === true;
  if (maybe) return CONNECT_WORDS.dropped;
  return CONNECT_WORDS.deskUnreachable + UNUSED;
}

export const awakeText = (agentName: string): string => `${agentName} is awake, on free models through OpenRouter.`;
