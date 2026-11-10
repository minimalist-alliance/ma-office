// Commons' own DataChannelLink on the Guild Desk's `commons` channel, handed each new session's channel as the link moves on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabChannel, CollabEnd, DeskLink, LinkState } from '../desk/deskLink';
import { guildRoomLink } from './commonsLink';

class FakeChannel implements CollabChannel {
  open = true;
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  onEnd: ((why: CollabEnd) => void) | null = null;
  sent: Uint8Array[] = [];
  send(bytes: Uint8Array): boolean {
    this.sent.push(bytes);
    return this.open;
  }
}

function fakeLink() {
  const listeners = new Set<(s: LinkState) => void>();
  const link = {
    state: 'idle' as LinkState,
    channel: null as FakeChannel | null,
    commons: () => (link.state === 'open' ? link.channel : null),
    onStatus: (fn: (s: LinkState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** A session opens with a fresh channel, or goes. */
    session(on: boolean, ready = true): FakeChannel | null {
      link.channel?.onEnd?.('ended');
      link.channel = on ? Object.assign(new FakeChannel(), { open: ready }) : null;
      link.state = on ? 'open' : 'retrying';
      for (const fn of listeners) fn(link.state);
      return link.channel;
    },
    listeners,
  };
  return link;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function attach(link: ReturnType<typeof fakeLink>) {
  const handle = guildRoomLink(link as unknown as DeskLink);
  if (!handle) throw new Error('no room link');
  const { room } = handle;
  const seen: string[] = [];
  room.onOpen = () => seen.push('open');
  room.onClose = () => seen.push('close');
  room.onMessage = (m) => seen.push(`msg:${m[0]}`);
  return { handle, room, seen };
}

describe('guildRoomLink', () => {
  it('has nothing to start from before a session brings its channel', () => {
    expect(guildRoomLink(fakeLink() as unknown as DeskLink)).toBeNull();
  });

  it('opens a task later, so the room client sets its handlers first', async () => {
    const link = fakeLink();
    link.session(true);
    const { room, seen } = attach(link);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['open']);
    expect(room.state).toBe('open');
  });

  it('carries messages both ways while open', async () => {
    const link = fakeLink();
    const ch = link.session(true)!;
    const { room, seen } = attach(link);
    await vi.advanceTimersByTimeAsync(0);
    room.send(new Uint8Array([7]));
    expect(ch.sent).toHaveLength(1);
    ch.onMessage?.(new Uint8Array([9]) as Uint8Array<ArrayBuffer>);
    expect(seen).toEqual(['open', 'msg:9']);
  });

  it('closes with the session and opens on the next one, so the room client says hello again', async () => {
    const link = fakeLink();
    link.session(true);
    const { room, seen } = attach(link);
    await vi.advanceTimersByTimeAsync(0);
    link.session(false);
    expect(seen).toEqual(['open', 'close']);
    room.send(new Uint8Array([1])); // nowhere to go, and nothing breaks
    const next = link.session(true)!;
    expect(seen).toEqual(['open', 'close', 'open']);
    room.send(new Uint8Array([2]));
    expect(next.sent).toHaveLength(1);
  });

  it('a reset from deskd is a close and, after a pause, an open: Commons on the desk came back', async () => {
    const link = fakeLink();
    const ch = link.session(true)!;
    const { seen } = attach(link);
    await vi.advanceTimersByTimeAsync(0);
    ch.onEnd?.('reset');
    expect(seen).toEqual(['open', 'close']);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual(['open', 'close', 'open']);
  });

  it('a message from an old session never reaches the room', async () => {
    const link = fakeLink();
    const old = link.session(true)!;
    const { seen } = attach(link);
    await vi.advanceTimersByTimeAsync(0);
    link.session(true);
    old.onMessage?.(new Uint8Array([5]) as Uint8Array<ArrayBuffer>);
    expect(seen.filter((s) => s.startsWith('msg'))).toEqual([]);
  });

  it('stop lets go of the link for good', async () => {
    const link = fakeLink();
    link.session(true);
    const { handle, room, seen } = attach(link);
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
    expect(link.listeners.size).toBe(0);
    link.session(true);
    expect(seen).toEqual(['open']);
    expect(room.state).toBe('closed');
  });
});
