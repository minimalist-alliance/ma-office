// The free models' Connect (agent-free-key spec §2): PKCE, the one pending Connect, what the office does with each answer from
// its page, the hand-off over the channel, the exchange, and who is offered it. No real OpenRouter: the exchange runs against
// a stand-in `fetch`, and nothing here ever logs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../client/agentClient';
import { KeySecret, REDACTED } from '../client/keySecret';
import { parseAnswer, parseGot } from './channel';
import {
  AUTH_URL,
  authUrl,
  base64url,
  challengeOf,
  CHANNEL,
  claim,
  clearPending,
  CONNECT_MS,
  CONNECT_WORDS,
  ConnectError,
  deskFailure,
  exchange,
  freeOffered,
  judge,
  KEYS_URL,
  listen,
  modelOption,
  onFreeModels,
  PENDING_KEY,
  prepare,
  readPending,
  savePending,
  UNUSED,
  type Pending,
} from './openrouter';

const KEY = 'sk-or-v1-TEST-not-a-real-key-0000000000007Q2f';

/** A sessionStorage stand-in. */
function store(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const pending = (over: Partial<Pending> = {}): Pending => ({ verifier: 'v'.repeat(43), state: 'state-1', deskId: 'd-1', agentId: 'manager', startedAt: 1_000, ...over });

let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a));
});
afterEach(() => {
  vi.restoreAllMocks();
  // Nothing in this module ever writes to the console: not a verifier, a code, a state or a key.
  expect(logged).toEqual([]);
});

describe('PKCE (RFC 7636)', () => {
  it('makes the S256 challenge of the RFC’s own example', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('base64url has no padding and no + or /', () => {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
  });
  it('a verifier is 32 random bytes (43 characters of the unreserved set), a state 16, and each is new', async () => {
    const a = await prepare();
    const b = await prepare();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.challenge).toBe(await challengeOf(a.verifier));
    expect(new Set([a.verifier, b.verifier, a.state, b.state]).size).toBe(4);
  });
  it('the address carries the challenge, S256, the state and a return to the office, never the verifier', async () => {
    const p = await prepare();
    const url = new URL(authUrl({ origin: 'https://office.example.test', challenge: p.challenge, state: p.state, deskName: 'Personal' }));
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_URL);
    expect(url.searchParams.get('callback_url')).toBe('https://office.example.test/connect/openrouter');
    expect(url.searchParams.get('code_challenge')).toBe(p.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(p.state);
    expect(url.searchParams.get('key_label')).toBe('Minimalist Alliance, Personal desk');
    expect(url.href).not.toContain(p.verifier);
    expect(new URL(authUrl({ origin: 'https://o.test', challenge: 'c', state: 's' })).searchParams.has('key_label')).toBe(false);
  });
});

describe('the one pending Connect, in this tab’s sessionStorage only', () => {
  it('keeps it under ma.agent.orConnect, reads it back, and refuses anything malformed', () => {
    const s = store();
    savePending(pending(), s);
    expect([...s.map.keys()]).toEqual([PENDING_KEY]);
    expect(readPending(s)).toEqual(pending());
    s.setItem(PENDING_KEY, '{"state":"x"}');
    expect(readPending(s)).toBeNull();
    s.setItem(PENDING_KEY, 'not json');
    expect(readPending(s)).toBeNull();
  });
  it('clears only its own: a newer Connect for another agent stays', () => {
    const s = store();
    savePending(pending({ state: 'newer' }), s);
    clearPending('state-1', s);
    expect(readPending(s)?.state).toBe('newer');
    clearPending('newer', s);
    expect(s.map.size).toBe(0);
  });
  it('where storage throws, holds it in memory for this tab and nowhere else', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined };
    savePending(pending({ state: 'mem' }), broken);
    expect(readPending(broken)?.state).toBe('mem');
    clearPending('mem', broken);
    expect(readPending(broken)).toBeNull();
  });
});

describe('what the office does with an answer (judge)', () => {
  const now = 1_000 + 60_000;
  it('another state is someone else’s: ignored, never acted on', () => {
    expect(judge({ kind: 'code', code: 'c', state: 'other' }, 'state-1', pending(), now)).toEqual({ act: 'ignore' });
    expect(judge({ kind: 'error', state: 'other' }, 'state-1', pending(), now)).toEqual({ act: 'ignore' });
  });
  it('its own state with nothing pending, or a newer Connect in its place, didn’t match', () => {
    expect(judge({ kind: 'code', code: 'c', state: 'state-1' }, 'state-1', null, now)).toEqual({ act: 'fail', why: 'mismatch' });
    expect(judge({ kind: 'code', code: 'c', state: 'state-1' }, 'state-1', pending({ state: 'newer' }), now)).toEqual({ act: 'fail', why: 'mismatch' });
  });
  it('after 10 minutes, nothing is exchanged', () => {
    expect(judge({ kind: 'code', code: 'c', state: 'state-1' }, 'state-1', pending(), 1_000 + CONNECT_MS + 1)).toEqual({ act: 'fail', why: 'expired' });
  });
  it('its own state in time: the code, with the verifier only this tab holds', () => {
    expect(judge({ kind: 'code', code: 'c', state: 'state-1' }, 'state-1', pending(), now)).toEqual({ act: 'exchange', code: 'c', verifier: 'v'.repeat(43) });
  });
  it('no code (declined, or OpenRouter’s error, which carries no state) ends the wait with nothing added', () => {
    expect(judge({ kind: 'error', state: null }, 'state-1', pending(), now)).toEqual({ act: 'fail', why: 'declined' });
    expect(judge({ kind: 'error', state: 'state-1' }, 'state-1', pending(), now)).toEqual({ act: 'fail', why: 'declined' });
  });
  it('a code is used once, though two cards may wait on it', () => {
    expect(claim('once-1')).toBe(true);
    expect(claim('once-1')).toBe(false);
  });
  it('reads only well-formed messages', () => {
    expect(parseAnswer({ code: 'c', state: 's' })).toEqual({ kind: 'code', code: 'c', state: 's' });
    expect(parseAnswer({ state: 's', error: true })).toEqual({ kind: 'error', state: 's' });
    expect(parseAnswer({ error: true })).toEqual({ kind: 'error', state: null });
    for (const bad of [null, 'x', {}, { code: 'c' }, { code: 7, state: 's' }, { code: '', state: 's' }, { got: 's' }]) expect(parseAnswer(bad)).toBeNull();
    expect(parseGot({ got: 's' })).toEqual({ got: 's' });
    expect(parseGot({ got: null })).toEqual({ got: null });
    expect(parseGot({ got: 5 })).toBeNull();
    expect(parseGot({ code: 'c', state: 's' })).toBeNull();
  });
});

describe('the hand-off over the channel', () => {
  it('the page relays a code, the office hears it and answers {got}, and the page hears that', async () => {
    const page = new BroadcastChannel(CHANNEL);
    const heard: unknown[] = [];
    const answered = new Promise<unknown>((resolve) => {
      page.onmessage = (e: MessageEvent) => resolve(e.data);
    });
    const off = listen((answer, reply) => {
      heard.push(answer);
      reply(answer.state);
    });
    page.postMessage({ code: 'the-code', state: 'state-9' });
    page.postMessage({ nonsense: true });
    expect(parseGot(await answered)).toEqual({ got: 'state-9' });
    expect(heard).toEqual([{ kind: 'code', code: 'the-code', state: 'state-9' }]);
    off();
    page.close();
  });
});

describe('the exchange, at OpenRouter’s own endpoint, from this browser', () => {
  it('posts the code, the verifier and S256, with no cookies and no referrer, and hands back a KeySecret', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ key: KEY }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const secret = await exchange('the-code', 'the-verifier', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(KEYS_URL);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'the-code', code_verifier: 'the-verifier', code_challenge_method: 'S256' });
    expect(secret).toBeInstanceOf(KeySecret);
    expect(String(secret)).toBe(REDACTED);
    expect(JSON.stringify({ secret })).not.toContain(KEY);
    expect(secret.withPlaintext((k) => k)).toBe(KEY);
    secret.wipe();
  });
  it('a refusal, a body with no key, or anything but an sk-or- key is refused', async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    for (const f of [answer(403, { error: 'invalid code' }), answer(200, {}), answer(200, { key: 'sk-ant-TEST-0000000000' }), answer(200, { key: 'sk-or-has spaces in it' }), answer(200, 'nope')]) {
      await expect(exchange('c', 'v', f)).rejects.toEqual(new ConnectError('refused'));
    }
  });
  it('a network failure (or the office’s CSP) is unreachable', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(exchange('c', 'v', f)).rejects.toMatchObject({ why: 'unreachable' });
  });
});

describe('what the desk said, in the spec’s words (§2.4)', () => {
  it('names why, and says an unused key stays at OpenRouter only once one exists', () => {
    expect(deskFailure(new AgentError('unavailable', { reason: 'storage' }))).toBe(CONNECT_WORDS.storage + UNUSED);
    expect(deskFailure(new AgentError('precondition_failed', { reason: 'key_refused', detail: 'auth' }))).toBe(CONNECT_WORDS.keyRefused + UNUSED);
    expect(deskFailure(new AgentError('unavailable', { reason: 'unavailable', detail: 'unavailable' }))).toBe(CONNECT_WORDS.deskUnreachable + UNUSED);
    expect(deskFailure(new AgentError('unavailable', { mayHaveApplied: true }))).toBe(CONNECT_WORDS.dropped);
    expect(deskFailure({ inFlight: true })).toBe(CONNECT_WORDS.dropped);
    expect(CONNECT_WORDS.mismatch).toBe("That answer from OpenRouter didn't match, so nothing was added. Connect again.");
    expect(Object.values(CONNECT_WORDS).join(' ')).not.toMatch(/\$0/);
  });
});

describe('who is offered it (spec §8)', () => {
  const providers = [{ id: 'anthropic' }, { id: 'openai' }, { id: 'xai' }, { id: 'openrouter' }];
  it('an adult on their own desk that serves OpenRouter, with no OpenRouter key yet', () => {
    expect(freeOffered({ providers, keys: [{ provider: 'anthropic' }], guild: false, allowed: true })).toBe(true);
  });
  it('never a teen, never on a Guild Desk', () => {
    expect(freeOffered({ providers, keys: [], guild: false, allowed: false })).toBe(false);
    expect(freeOffered({ providers, keys: [], guild: true, allowed: true })).toBe(false);
  });
  it('an older desk-agent, which doesn’t list OpenRouter, gets no card', () => {
    expect(freeOffered({ providers: providers.slice(0, 3), keys: [], guild: false, allowed: true })).toBe(false);
  });
  it('a desk that has an OpenRouter key offers that key instead', () => {
    expect(freeOffered({ providers, keys: [{ provider: 'openrouter' }], guild: false, allowed: true })).toBe(false);
  });
});

describe('the model picker’s words (§3.2)', () => {
  it('free models say so, and a model with no tools says it only chats', () => {
    expect(modelOption({ label: 'NVIDIA: Nemotron 3.5 Super VL (free)', free: true, tools: true })).toBe('NVIDIA: Nemotron 3.5 Super VL · Free');
    expect(modelOption({ label: 'Example Labs: Chat 8B (free)', free: true, tools: false })).toBe('Example Labs: Chat 8B · Free · Chats only');
    expect(modelOption({ label: 'Claude Sonnet 4.5' })).toBe('Claude Sonnet 4.5');
    expect(onFreeModels({ provider: 'openrouter' })).toBe(true);
    expect(onFreeModels({ provider: 'anthropic' })).toBe(false);
    expect(onFreeModels(null)).toBe(false);
  });
});
