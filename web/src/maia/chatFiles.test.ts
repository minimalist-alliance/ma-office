// The owner's rule: files are never retained. After a send, no file data is left in the store or in any web storage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('./net', () => ({
  maiaFetch: (...a: unknown[]) => fetchMock(...a),
  errorCode: async () => null,
}));
vi.mock('../desk/liveStore', () => ({ getLive: () => ({ refusal: null }) }));
vi.mock('../state/viewStore', () => ({ getView: () => ({ mode: 'office', activeDesk: null }) }));

import { Chat } from './chat';
import type { MaiaState } from './gate';

const CAPS = { enabled: true, maxFiles: 3, maxFileBytes: 2_000_000, maxTotalBytes: 4_000_000, accept: ['png', 'txt', 'pdf'], freeImages: false };
const state = (over: Partial<MaiaState> = {}): MaiaState => ({
  enabled: true, modelLabel: '', limited: null, retentionDays: null, animation: { enabled: false, sleepAfterSec: 300 }, memory: { enabled: false, maxItems: 0 }, free: null, usedFraction: null, resetsAt: null, attachments: CAPS, ...over,
});
const sse = (...frames: unknown[]): Response =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''))); c.close(); } }), { status: 200 });
const file = (name: string, text = 'hello') => new File([text], name, { type: 'text/plain' });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), dump: () => JSON.stringify([...m]) };
};
let local: ReturnType<typeof store>;
let session: ReturnType<typeof store>;

beforeEach(() => {
  local = store();
  session = store();
  vi.stubGlobal('window', { sessionStorage: session, localStorage: local, setTimeout, clearTimeout });
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('Chat with files', () => {
  it('adds files, applies the caps, removes one', async () => {
    const chat = new Chat('https://m', state(), () => null);
    await chat.addFiles([file('a.txt'), file('b.exe'), file('c.txt', 'x'), file('d.pdf'), file('e.pdf', 'y')]);
    expect(chat.get().files.map((f) => f.name)).toEqual(['a.txt', 'c.txt', 'd.pdf']);
    expect(chat.get().attachLine).toContain("can't read .exe");
    expect(chat.get().attachLine).toContain('You can attach up to 3 files, 4 MB in all.');
    chat.removeFile(chat.get().files[0]!.id);
    expect(chat.get().files).toHaveLength(2);
  });

  it('does nothing without caps', async () => {
    const chat = new Chat('https://m', state({ attachments: null }), () => null);
    await chat.addFiles([file('a.txt')]);
    expect(chat.get().files).toEqual([]);
  });

  it('free Maia: an image is not added, a text file is', async () => {
    const chat = new Chat('https://m', state({ free: { until: '2099-01-01T00:00:00Z' } }), () => null);
    await chat.addFiles([new File(['x'], 'p.png', { type: 'image/png' }), file('a.txt')]);
    expect(chat.get().files.map((f) => f.name)).toEqual(['a.txt']);
    expect(chat.get().attachLine).toBe("Free Maia can't read images.");
  });

  it('sends base64 in the body, then keeps no file data anywhere', async () => {
    fetchMock.mockResolvedValue(sse({ type: 'start', conversationId: 'c1', messageId: 'm1' }, { type: 'text', text: 'ok' }, { type: 'done', messageId: 'm1' }));
    const chat = new Chat('https://m', state(), () => null);
    await chat.addFiles([file('secret-notes.txt', 'TOP-SECRET-CONTENT')]);
    expect(await chat.send('What is this?')).toBe(true);
    await tick();
    const body = JSON.parse((fetchMock.mock.calls[0]![2] as { body: string }).body) as { attachments: { name: string; data: string }[] };
    expect(body.attachments).toEqual([{ name: 'secret-notes.txt', type: 'text/plain', data: Buffer.from('TOP-SECRET-CONTENT').toString('base64') }]);
    const s = chat.get();
    expect(s.files).toEqual([]);
    expect(s.messages[0]!.files).toEqual([{ name: 'secret-notes.txt', size: 18 }]);
    const flat = JSON.stringify(s);
    expect(flat).not.toContain('TOP-SECRET');
    expect(flat).not.toContain(Buffer.from('TOP-SECRET-CONTENT').toString('base64'));
    expect(local.dump() + session.dump()).not.toMatch(/secret|SECRET|VE9QLVNFQ1JFVA/);
    expect((chat as unknown as { inflight: unknown }).inflight).toBeNull();
  });

  it('a 400 attachments_rejected gives the files and the words back', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'attachments_rejected', message: 'That PDF is locked.' } }), { status: 400 }));
    const chat = new Chat('https://m', state(), () => null);
    await chat.addFiles([file('a.txt')]);
    expect(await chat.send('Hi')).toBe(false);
    expect(chat.get().messages).toEqual([]);
    expect(chat.get().files.map((f) => f.name)).toEqual(['a.txt']);
    expect(chat.get().line).toBe('That PDF is locked.');
    expect(chat.get().phase).toBe('idle');
  });

  it('a stop with reason attachments undoes the turn', async () => {
    fetchMock.mockResolvedValue(sse({ type: 'start', conversationId: 'c1', messageId: 'm1' }, { type: 'stop', reason: 'attachments', text: 'Those files were too big.' }));
    const chat = new Chat('https://m', state(), () => null);
    await chat.addFiles([file('a.txt')]);
    expect(await chat.send('Hi there')).toBe(true);
    await tick();
    const s = chat.get();
    expect(s.messages).toEqual([]);
    expect(s.files.map((f) => f.name)).toEqual(['a.txt']);
    expect(s.line).toBe('Those files were too big.');
    expect(s.restore?.text).toBe('Hi there');
    expect(s.phase).toBe('idle');
  });

  it('another stop reason works as before', async () => {
    fetchMock.mockResolvedValue(sse({ type: 'start', conversationId: 'c1', messageId: 'm1' }, { type: 'stop', reason: 'too_long', text: 'Long.' }));
    const chat = new Chat('https://m', state(), () => null);
    await chat.send('Hi');
    await tick();
    expect(chat.get().messages.map((m) => m.role)).toEqual(['me', 'maia']);
    expect(chat.get().messages[1]!.stop).toBe('Long.');
  });
});
