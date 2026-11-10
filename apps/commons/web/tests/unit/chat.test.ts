// The room client's chat and channels against a small in-memory stand-in for the server's rules
// (server/internal/room): a seq per message, the author's copy with its nonce, pages, edits, deletes,
// channel switches and settings.
import { describe, expect, it, vi } from 'vitest';
import type { CommonsLink, LinkState } from '../../src/net/link.ts';
import { REC, ctrl, decodeCtrl, eachRecord } from '../../src/net/protocol.ts';
import { RoomClient, type ChatMsg } from '../../src/room/client.ts';

type Msg = Record<string, unknown>;

class FakeServer {
  threads: Record<string, ChatMsg[]> = { main: [], design: [] };
  seen = new Map<string, number>();
  links = new Set<FakeLink>();
  sends = 0;
  refuse: string | null = null;
  settings = { joinMuted: true, maxChannels: 10 };

  welcome(l: FakeLink): void {
    l.ch = 'main';
    l.deliver({
      t: 'welcome',
      v: 2,
      you: { i: l.idx, id: l.id, name: l.name, role: 'member', color: 0, ch: 'main', in: false, muted: false },
      members: [],
      ch: 'main',
      channels: Object.keys(this.threads).map((id) => ({ id, name: id === 'main' ? 'Main' : 'Design', main: id === 'main', created: 0, last: this.threads[id]!.at(-1)?.seq ?? 0 })),
      settings: { t: 'settings', settings: this.settings, max: 10, ceiling: 10 },
      can: { manage: false, moderate: false },
      boards: { list: [], active: 'b1' },
      slots: 0,
    });
    l.deliver({ t: 'chat-page', ch: 'main', msgs: this.threads['main']!.slice(-50), more: this.threads['main']!.length > 50, latest: true });
  }

  receive(l: FakeLink, m: Msg): void {
    switch (m['t']) {
      case 'hello':
        this.welcome(l);
        break;
      case 'chat-send': {
        this.sends++;
        if (this.refuse) {
          l.deliver({ t: 'error', code: 'chat', reason: this.refuse, ch: m['ch'], nonce: m['nonce'] });
          return;
        }
        const key = `${l.id}/${String(m['nonce'])}`;
        const th = this.threads[String(m['ch'])]!;
        let msg = th.find((x) => x.seq === this.seen.get(key));
        if (!msg) {
          msg = { seq: (th.at(-1)?.seq ?? 0) + 1, from: l.id, name: l.name, text: String(m['text']), at: Date.now() };
          th.push(msg);
          this.seen.set(key, msg.seq);
          for (const o of this.links) if (o !== l) o.deliver({ t: 'chat', ch: m['ch'], m: msg });
        }
        l.deliver({ t: 'chat', ch: m['ch'], m: { ...msg, nonce: m['nonce'] } });
        break;
      }
      case 'chat-edit': {
        const th = this.threads[String(m['ch'])]!;
        const msg = th.find((x) => x.seq === m['seq'])!;
        msg.text = String(m['text']);
        msg.edited = Date.now();
        for (const o of this.links) o.deliver({ t: 'chat-edit', ch: m['ch'], m: msg });
        break;
      }
      case 'chat-delete': {
        const ch = String(m['ch']);
        this.threads[ch] = this.threads[ch]!.filter((x) => x.seq !== m['seq']);
        for (const o of this.links) o.deliver({ t: 'chat-delete', ch, seq: m['seq'] });
        break;
      }
      case 'chat-history': {
        const th = this.threads[String(m['ch'])]!.filter((x) => x.seq < Number(m['before']));
        l.deliver({ t: 'chat-page', ch: m['ch'], msgs: th.slice(-Number(m['limit'])), more: th.length > Number(m['limit']), before: m['before'] });
        break;
      }
      case 'channel':
        l.ch = String(m['id']);
        l.deliver({ t: 'channel', ch: l.ch, boards: { list: [], active: `b-${l.ch}` } });
        l.deliver({ t: 'chat-page', ch: l.ch, msgs: this.threads[l.ch]!.slice(-50), more: false, latest: true });
        break;
    }
  }
}

let nextIdx = 1;
class FakeLink implements CommonsLink {
  state: LinkState = 'connecting';
  buffered = 0;
  idx = nextIdx++;
  ch = 'main';
  onOpen = (): void => {};
  onMessage: (msg: Uint8Array) => void = () => {};
  onClose = (): void => {};
  constructor(
    private readonly server: FakeServer,
    readonly id: string,
    readonly name: string,
  ) {}
  open(): void {
    this.server.links.add(this);
    this.state = 'open';
    this.onOpen();
  }
  drop(): void {
    this.state = 'closed';
    this.server.links.delete(this);
    this.onClose();
  }
  deliver(m: Msg): void {
    if (this.state === 'open') this.onMessage(ctrl(m));
  }
  send(msg: Uint8Array): void {
    if (this.state !== 'open') return;
    eachRecord(msg, (t, p) => {
      if (t === REC.ctrl) this.server.receive(this, decodeCtrl(p));
    });
  }
  close(): void {
    this.drop();
  }
}

function member(s: FakeServer, id: string, name: string): { c: RoomClient; link: FakeLink } {
  const link = new FakeLink(s, id, name);
  const c = new RoomClient(link, {});
  link.open();
  return { c, link };
}

const texts = (c: RoomClient, ch = 'main') => (c.state.threads[ch]?.msgs ?? []).map((m) => `${m.text}${m.pending ? ' (pending)' : ''}${m.failed ? ' (failed)' : ''}`);

describe('chat', () => {
  it('a message shows pending, then settles with its number; the others get it', () => {
    const s = new FakeServer();
    const a = member(s, 'gm-ana', 'Ana');
    const b = member(s, 'gm-ben', 'Ben');
    a.link.state = 'closed'; // hold the send back to see the pending state
    a.c.say('Standup moved to 10:30');
    expect(texts(a.c)).toEqual(['Standup moved to 10:30 (pending)']);
    a.link.state = 'open';
    a.c['flushOutbox']();
    expect(texts(a.c)).toEqual(['Standup moved to 10:30']);
    expect(a.c.state.threads['main']!.msgs[0]!.seq).toBe(1);
    expect(texts(b.c)).toEqual(['Standup moved to 10:30']);
    expect(b.c.state.threads['main']!.msgs[0]!.nonce).toBeUndefined();
  });

  it('a message written offline goes once the link is back, and only once', () => {
    const s = new FakeServer();
    const a = member(s, 'gm-ana', 'Ana');
    const b = member(s, 'gm-ben', 'Ben');
    a.link.drop();
    a.c.say('Pushed the fix');
    a.c.say('Review please');
    expect(texts(a.c)).toEqual(['Pushed the fix (pending)', 'Review please (pending)']);
    a.link.open();
    expect(texts(a.c)).toEqual(['Pushed the fix', 'Review please']);
    expect(texts(b.c)).toEqual(['Pushed the fix', 'Review please']);
    // A reconnect resends nothing that settled.
    const before = s.sends;
    a.link.drop();
    a.link.open();
    expect(s.sends).toBe(before);
    expect(s.threads['main']!.length).toBe(2);
  });

  it('a refused message says why, and can be tried again', () => {
    const s = new FakeServer();
    const a = member(s, 'gm-ana', 'Ana');
    s.refuse = 'too-long';
    a.c.say('x'.repeat(10));
    expect(texts(a.c)).toEqual(['xxxxxxxxxx (failed)']);
    expect(a.c.state.threads['main']!.msgs[0]!.failed).toMatch(/4,000 characters/);
    s.refuse = null;
    a.c.retrySay(a.c.state.threads['main']!.msgs[0]!.nonce!);
    expect(texts(a.c)).toEqual(['xxxxxxxxxx']);
  });

  it('a rate refusal waits and goes again by itself', () => {
    vi.useFakeTimers();
    try {
      const s = new FakeServer();
      const a = member(s, 'gm-ana', 'Ana');
      s.refuse = 'rate';
      a.c.say('quick');
      expect(texts(a.c)).toEqual(['quick (pending)']);
      s.refuse = null;
      vi.advanceTimersByTime(1500);
      expect(texts(a.c)).toEqual(['quick']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits and deletes reach everyone', () => {
    const s = new FakeServer();
    const a = member(s, 'gm-ana', 'Ana');
    const b = member(s, 'gm-ben', 'Ben');
    a.c.say('first');
    a.c.say('second');
    a.c.editMessage(1, 'first, edited');
    expect(texts(b.c)).toEqual(['first, edited', 'second']);
    expect(b.c.state.threads['main']!.msgs[0]!.edited).toBeGreaterThan(0);
    a.c.deleteMessage(2);
    expect(texts(b.c)).toEqual(['first, edited']);
  });

  it('each channel has its thread; another channel’s message marks it unread', () => {
    const s = new FakeServer();
    const a = member(s, 'gm-ana', 'Ana');
    const b = member(s, 'gm-ben', 'Ben');
    b.c.openChannel('design');
    expect(b.c.state.ch).toBe('design');
    b.c.say('Mockups are on the board');
    expect(texts(b.c, 'design')).toEqual(['Mockups are on the board']);
    expect(texts(a.c, 'main')).toEqual([]);
    const design = a.c.state.channels.find((c) => c.id === 'design')!;
    expect(design.last).toBe(1);
    expect(a.c.state.read['design'] ?? 0).toBe(0);
    a.c.openChannel('design');
    expect(texts(a.c, 'design')).toEqual(['Mockups are on the board']);
    expect(a.c.state.read['design']).toBe(1);
  });

  it('pages older messages in above', () => {
    const s = new FakeServer();
    for (let i = 1; i <= 120; i++) s.threads['main']!.push({ seq: i, from: 'gm-x', name: 'X', text: `m${i}`, at: i });
    const a = member(s, 'gm-ana', 'Ana');
    expect(a.c.state.threads['main']!.msgs.length).toBe(50);
    expect(a.c.state.threads['main']!.more).toBe(true);
    a.c.loadOlder();
    a.c.loadOlder();
    const th = a.c.state.threads['main']!;
    expect(th.msgs.length).toBe(120);
    expect(th.msgs[0]!.seq).toBe(1);
    expect(th.more).toBe(false);
  });

  it('joining follows the guild’s join-muted setting', () => {
    const s = new FakeServer();
    const a = member(s, 'gm-ana', 'Ana');
    expect(a.c.state.settings.joinMuted).toBe(true);
  });
});
