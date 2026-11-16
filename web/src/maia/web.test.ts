// Maia's web search in the office (ma-platform ADR 0137): one card for a reply's whole batch, an answer that is one turn
// with no message, expiry, the auto line and the sources. A mocked Maia only: no network, no real chat.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('./net', () => ({
  maiaFetch: (...a: unknown[]) => fetchMock(...a),
  errorCode: async () => null,
}));
vi.mock('../desk/liveStore', () => ({ getLive: () => ({ refusal: null }) }));
vi.mock('../state/viewStore', () => ({ getView: () => ({ mode: 'office', activeDesk: null }) }));

import { Chat } from './chat';
import { readFrame } from './frames';
import type { MaiaState } from './gate';
import { readState } from './state';
import { WEB_WORDS, answerBody, readPending, readQueries, readSources, refusedAnswer, sourceHref } from './web';

const BATCH = `w_${'a'.repeat(20)}`;
const CONV = `c_${'b'.repeat(20)}`;
const QUERIES = ['firefox esr release schedule', 'chrome extended stable', 'safari 27 release'];
const state = (over: Partial<MaiaState> = {}): MaiaState => ({
  enabled: true, modelLabel: '', limited: null, retentionDays: null, animation: { enabled: false, sleepAfterSec: 300 }, memory: { enabled: false, maxItems: 0 }, free: null, usedFraction: null, resetsAt: null, attachments: null, webSearch: { mode: 'ask' }, ...over,
});
const sse = (...frames: unknown[]): Response =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''))); c.close(); } }), { status: 200 });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const asked = (expiresAt = later(600_000)) => sse(
  { type: 'start', conversationId: CONV, messageId: 'm1', newConversation: true },
  { type: 'web_search', batchId: BATCH, mode: 'ask', queries: QUERIES, expiresAt },
  { type: 'done', messageId: 'm1' },
);
const answered = () => sse(
  { type: 'start', conversationId: CONV, messageId: 'm2', newConversation: false },
  { type: 'status', code: 'web' },
  { type: 'text', text: 'Firefox 152 ESR is due December 8 [1].' },
  { type: 'sources', messageId: 'm2', sources: [{ n: 1, title: 'Firefox ESR', url: 'https://www.mozilla.org/firefox/esr/', domain: 'mozilla.org' }, { n: 2, title: 'bad', url: 'javascript:alert(1)', domain: 'x' }] },
  { type: 'done', messageId: 'm2' },
);

beforeEach(() => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  vi.stubGlobal('window', { sessionStorage: store, localStorage: store, setTimeout, clearTimeout });
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const herLast = (chat: Chat) => chat.get().messages.filter((m) => m.role === 'maia').at(-1)!;
const sent = (i: number) => JSON.parse((fetchMock.mock.calls[i]![2] as { body: string }).body) as Record<string, unknown>;

describe('the frames', () => {
  it('reads a web_search frame only with a batch id, a mode and plain queries; anything else is dropped', () => {
    expect(readFrame({ type: 'web_search', batchId: BATCH, mode: 'ask', queries: QUERIES, expiresAt: 'x' })).toEqual({ type: 'web_search', batchId: BATCH, mode: 'ask', queries: QUERIES, expiresAt: 'x' });
    expect(readFrame({ type: 'web_search', batchId: 'nope', mode: 'ask', queries: QUERIES })).toBeNull();
    expect(readFrame({ type: 'web_search', batchId: BATCH, mode: 'maybe', queries: QUERIES })).toBeNull();
    expect(readFrame({ type: 'web_search', batchId: BATCH, mode: 'ask', queries: [1, 2] })).toBeNull();
    expect(readFrame({ type: 'web_search', batchId: BATCH, mode: 'ask', queries: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBeNull();
    expect(readQueries(['  two   spaces  '])).toEqual(['two spaces']);
  });

  it('keeps only http(s) sources with no credentials, as plain text', () => {
    expect(sourceHref('javascript:alert(1)')).toBeNull();
    expect(sourceHref('https://u:p@example.com/')).toBeNull();
    expect(sourceHref('data:text/html,hi')).toBeNull();
    expect(sourceHref('https://example.com/a')).toBe('https://example.com/a');
    expect(readSources([{ n: 1, title: ' A  title ', url: 'https://example.com/', domain: 'example.com' }, { n: 2, url: 'ftp://x/' }])).toEqual([{ n: 1, title: 'A title', url: 'https://example.com/', domain: 'example.com' }]);
    expect(readFrame({ type: 'sources', messageId: 'm', sources: [{ url: 'javascript:x' }] })).toBeNull();
  });

  it('reads web search from the state, and nothing while it is off', () => {
    expect(readState({ enabled: true, webSearch: { enabled: true, mode: 'auto' } })?.webSearch).toEqual({ mode: 'auto' });
    expect(readState({ enabled: true })?.webSearch).toBeNull();
    expect(readState({ enabled: true, webSearch: { enabled: true, mode: 'always' } })?.webSearch).toBeNull();
  });
});

describe('the card', () => {
  it('a reply with a batch is one card listing every query, never one per search', async () => {
    fetchMock.mockResolvedValueOnce(asked());
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('When is the next Firefox ESR?');
    await tick();
    const her = herLast(chat);
    expect(her.web).toEqual({ batchId: BATCH, queries: QUERIES, expiresAt: expect.any(String), status: 'pending', line: null });
    expect(chat.get().messages.filter((m) => m.web)).toHaveLength(1);
    expect(chat.get().said).toContain(WEB_WORDS.title);
  });

  it('Search: one turn with no message and only the batch and decision, then her reply and its sources stream in', async () => {
    fetchMock.mockResolvedValueOnce(asked()).mockResolvedValueOnce(answered());
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('When is the next Firefox ESR?');
    await tick();
    const key = herLast(chat).key;
    await chat.answerWeb(key, 'approve');
    await tick();
    const body = sent(1);
    expect(Object.keys(body).sort()).toEqual(['clientContext', 'conversationId', 'webSearch']);
    expect(body['webSearch']).toEqual({ batchId: BATCH, decision: 'approve' });
    expect(body['conversationId']).toBe(CONV);
    expect(chat.get().messages.find((m) => m.key === key)?.web?.status).toBe('done');
    expect(chat.get().messages.find((m) => m.key === key)?.web?.line).toBe(WEB_WORDS.searching);
    const reply = herLast(chat);
    expect(reply.text).toContain('Firefox 152 ESR');
    expect(reply.sources).toEqual([{ n: 1, title: 'Firefox ESR', url: 'https://www.mozilla.org/firefox/esr/', domain: 'mozilla.org' }]);
    expect(chat.get().phase).toBe('idle');
  });

  it('Not now: the decline is sent, and the card says nothing was searched', async () => {
    fetchMock.mockResolvedValueOnce(asked()).mockResolvedValueOnce(sse({ type: 'start', conversationId: CONV, messageId: 'm2', newConversation: false }, { type: 'text', text: "I didn't search." }, { type: 'done', messageId: 'm2' }));
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('q');
    await tick();
    const key = herLast(chat).key;
    await chat.answerWeb(key, 'decline');
    await tick();
    expect((sent(1)['webSearch'] as { decision: string }).decision).toBe('decline');
    expect(chat.get().messages.find((m) => m.key === key)?.web?.line).toBe(WEB_WORDS.declined);
  });

  it('Always allow: sends always, and the member is in auto mode from then on', async () => {
    fetchMock.mockResolvedValueOnce(asked()).mockResolvedValueOnce(answered());
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('q');
    await tick();
    await chat.answerWeb(herLast(chat).key, 'always');
    await tick();
    expect((sent(1)['webSearch'] as { decision: string }).decision).toBe('always');
    expect(chat.get().webMode).toBe('auto');
  });

  it('expired: nothing is sent, and the card says so; a 410 from the server says the same', async () => {
    fetchMock.mockResolvedValueOnce(asked(later(-1000)));
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('q');
    await tick();
    expect(herLast(chat).web?.status).toBe('expired');
    await chat.answerWeb(herLast(chat).key, 'approve');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(asked()).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'web_search_expired' } }), { status: 410 }));
    const two = new Chat('https://m', state(), () => null);
    await two.send('q');
    await tick();
    const key = herLast(two).key;
    await two.answerWeb(key, 'approve');
    expect(two.get().messages.find((m) => m.key === key)?.web).toMatchObject({ status: 'expired', line: WEB_WORDS.expired });
    expect(two.get().phase).toBe('idle');
    expect(refusedAnswer(404).status).toBe('done');
  });

  it('a card answered once is not answered again', async () => {
    fetchMock.mockResolvedValueOnce(asked()).mockResolvedValueOnce(answered());
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('q');
    await tick();
    const key = herLast(chat).key;
    await chat.answerWeb(key, 'approve');
    await tick();
    await chat.answerWeb(key, 'approve');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('auto, the mode, and a chat read back', () => {
  it('auto: no card; the line says what was searched, and "Ask me first" saves ask', async () => {
    fetchMock.mockResolvedValueOnce(sse(
      { type: 'start', conversationId: CONV, messageId: 'm1', newConversation: true },
      { type: 'web_search', batchId: BATCH, mode: 'auto', queries: QUERIES.slice(0, 1), expiresAt: null },
      { type: 'text', text: 'Due December 8 [1].' },
      { type: 'done', messageId: 'm1' },
    )).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const chat = new Chat('https://m', state({ webSearch: { mode: 'auto' } }), () => null);
    await chat.send('q');
    await tick();
    expect(herLast(chat).web).toBeUndefined();
    expect(herLast(chat).searched).toEqual(QUERIES.slice(0, 1));
    expect(await chat.setWebMode('ask')).toBe(true);
    expect(fetchMock.mock.calls[1]![1]).toBe('/v1/maia/preferences');
    expect(JSON.parse((fetchMock.mock.calls[1]![2] as { body: string }).body)).toEqual({ webSearch: { mode: 'ask' } });
    expect(chat.get().webMode).toBe('ask');
  });

  it('a reloaded chat brings back a waiting card and each reply sources, and an expired one stays gone', async () => {
    window.sessionStorage.setItem('ma.maia.conversation.v1', CONV);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      messages: [
        { role: 'user', text: 'q', at: 'x' },
        { role: 'assistant', text: 'Due [1].', at: 'x', sources: [{ n: 1, title: 'T', url: 'https://example.com/', domain: 'example.com' }] },
      ],
      pendingWebSearch: { batchId: BATCH, queries: QUERIES, expiresAt: later(60_000) },
    }), { status: 200 }));
    const chat = new Chat('https://m', state(), () => null);
    await chat.loadConversation();
    const msgs = chat.get().messages;
    expect(msgs[1]!.sources?.[0]?.url).toBe('https://example.com/');
    expect(msgs.at(-1)!.web?.batchId).toBe(BATCH);
    expect(readPending({ batchId: BATCH, queries: QUERIES, expiresAt: later(-1) }, Date.now())).toBeNull();
  });

  it('the answer body is exactly the contract: the chat, the context, the batch and the decision', () => {
    expect(answerBody(CONV, BATCH, 'decline', { surface: 'office' })).toEqual({ conversationId: CONV, clientContext: { surface: 'office' }, webSearch: { batchId: BATCH, decision: 'decline' } });
  });
});
