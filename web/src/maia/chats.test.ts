// "Your chats" (Security's maia-2): the list, going back to a chat, and deleting one for good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('./net', () => ({
  maiaFetch: (...a: unknown[]) => fetchMock(...a),
  errorCode: async () => null,
}));
vi.mock('../desk/liveStore', () => ({ getLive: () => ({ refusal: null }) }));
vi.mock('../state/viewStore', () => ({ getView: () => ({ mode: 'office', activeDesk: null }) }));

import { Chat } from './chat';
import { CHAT_DELETE_FAILED, CHAT_LOAD_FAILED, CHAT_OPEN_FAILED, CHATS_LOAD_FAILED, chatTitle, chatsLine, readChats } from './chats';
import type { MaiaState } from './gate';

const state = (): MaiaState => ({
  enabled: true, modelLabel: '', limited: null, retentionDays: 30, animation: { enabled: false, sleepAfterSec: 300 }, memory: { enabled: false, maxItems: 0 }, free: null, usedFraction: null, resetsAt: null, attachments: null,
});
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LIST = {
  conversations: [
    { conversationId: 'c_old', title: 'Desk sizes', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z' },
    { conversationId: 'c_new', title: '  How do   guilds work?  ', createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-09T10:00:00Z' },
    { conversationId: 'c_untitled', title: '', createdAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z' },
  ],
};
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

beforeEach(() => {
  vi.stubGlobal('window', { sessionStorage: store(), localStorage: store(), setTimeout, clearTimeout });
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('readChats', () => {
  it('newest first, titles tidied, and anything malformed left out', () => {
    const list = readChats({ conversations: [...LIST.conversations, { conversationId: '../../x', title: 'bad' }, null, { title: 'no id' }] });
    expect(list.map((c) => c.conversationId)).toEqual(['c_new', 'c_untitled', 'c_old']);
    expect(list[0]!.title).toBe('How do guilds work?');
    expect(readChats(null)).toEqual([]);
    expect(readChats({ conversations: 'no' })).toEqual([]);
  });
  it('a chat with no title is still named, and the line uses the server days', () => {
    expect(chatTitle({ conversationId: 'c', title: '', updatedAt: '' })).toBe('A chat with Maia');
    expect(chatsLine(30)).toBe('Chats are kept 30 days. Open one to go back to it, or delete it sooner.');
    expect(chatsLine(null)).not.toMatch(/\d/);
  });
});

describe('Chat: your chats', () => {
  it('loads the list, or says it could not', async () => {
    const chat = new Chat('https://m', state(), () => null);
    fetchMock.mockResolvedValueOnce(json(LIST));
    await chat.loadChats();
    expect(fetchMock.mock.calls[0]![1]).toBe('/v1/maia/conversations');
    expect(chat.get().chats?.map((c) => c.conversationId)).toEqual(['c_new', 'c_untitled', 'c_old']);
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await chat.loadChats();
    expect(chat.get().chatsLine).toBe(CHATS_LOAD_FAILED);
    expect(chat.get().chats).toHaveLength(3);
  });

  it('opens an earlier chat: it becomes the chat, with its messages as kept', async () => {
    const chat = new Chat('https://m', state(), () => null);
    fetchMock.mockResolvedValueOnce(json({ conversationId: 'c_old', messages: [{ role: 'user', text: 'How big is a desk?' }, { role: 'assistant', text: 'Two sizes.' }] }));
    expect(await chat.openChat('c_old')).toBe(true);
    expect(fetchMock.mock.calls[0]![1]).toBe('/v1/maia/conversations/c_old');
    expect(chat.get().conversationId).toBe('c_old');
    expect(chat.get().messages.map((m) => [m.role, m.text])).toEqual([['me', 'How big is a desk?'], ['maia', 'Two sizes.']]);
  });

  it('a chat gone since the list was read: a plain line, and it leaves the list', async () => {
    const chat = new Chat('https://m', state(), () => null);
    fetchMock.mockResolvedValueOnce(json(LIST));
    await chat.loadChats();
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await chat.openChat('c_old')).toBe(false);
    expect(chat.get().conversationId).toBeNull();
    expect(chat.get().line).toBe(CHAT_OPEN_FAILED);
    expect(chat.get().chats?.some((c) => c.conversationId === 'c_old')).toBe(false);
    // And one that didn't come back for another reason stays the chat, saying so.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await chat.openChat('c_new')).toBe(true);
    expect(chat.get().line).toBe(CHAT_LOAD_FAILED);
  });

  it('deletes for good; the open chat goes with it and a new one starts; a 404 is already gone; a failure says so', async () => {
    const chat = new Chat('https://m', state(), () => null);
    fetchMock.mockResolvedValueOnce(json(LIST));
    await chat.loadChats();
    fetchMock.mockResolvedValueOnce(json({ conversationId: 'c_new', messages: [{ role: 'user', text: 'Hi' }] }));
    await chat.openChat('c_new');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await chat.deleteChat('c_new')).toBe(true);
    expect(fetchMock.mock.calls.at(-1)![1]).toBe('/v1/maia/conversations/c_new');
    expect(fetchMock.mock.calls.at(-1)![2]).toEqual({ method: 'DELETE' });
    expect(chat.get().conversationId).toBeNull();
    expect(chat.get().messages).toEqual([]);
    expect(chat.get().chats?.map((c) => c.conversationId)).toEqual(['c_untitled', 'c_old']);
    fetchMock.mockResolvedValueOnce(json({}, 404));
    expect(await chat.deleteChat('c_old')).toBe(true);
    expect(chat.get().chats?.map((c) => c.conversationId)).toEqual(['c_untitled']);
    fetchMock.mockResolvedValueOnce(json({}, 500));
    expect(await chat.deleteChat('c_untitled')).toBe(false);
    expect(chat.get().chatsLine).toBe(CHAT_DELETE_FAILED);
    expect(chat.get().chats).toHaveLength(1);
  });

  it('never opens another chat while she is answering', async () => {
    const chat = new Chat('https://m', state(), () => null);
    chat.store.setState({ phase: 'streaming' });
    expect(await chat.openChat('c_old')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
