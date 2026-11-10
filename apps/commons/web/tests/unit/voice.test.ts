// Voice that can't get through: no connection within BLOCKED_MS, or ICE failing before it ever connected, is
// "blocked" (the room shows a calm line with Retry); a connection that worked and was lost is "failed".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_MS, Voice, type VoiceState } from '../../src/voice/voice.ts';

class FakePC {
  static last: FakePC | null = null;
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  constructor() {
    FakePC.last = this;
  }
  addTransceiver() {
    return { sender: { replaceTrack: async () => {} } };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0' };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription() {}
  getTransceivers() {
    return [];
  }
  close() {
    this.connectionState = 'closed';
  }
  set(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', FakePC);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function voice() {
  const states: VoiceState[] = [];
  const v = new Voice({ send: () => {}, state: (s) => states.push(s), level: () => {} }, 2);
  return { v, states };
}

describe('voice that can’t get through', () => {
  it('is blocked when nothing connects within 8 s, and Retry starts the wait again', async () => {
    const { v, states } = voice();
    await v.start(false);
    expect(states.at(-1)).toBe('connecting');
    vi.advanceTimersByTime(BLOCKED_MS - 1);
    expect(states.at(-1)).toBe('connecting');
    vi.advanceTimersByTime(1);
    expect(states.at(-1)).toBe('blocked');
    v.restart();
    expect(states.at(-1)).toBe('connecting');
    vi.advanceTimersByTime(BLOCKED_MS - 1);
    expect(states.at(-1)).toBe('connecting');
    FakePC.last!.set('connected');
    expect(states.at(-1)).toBe('listening'); // no microphone in this test
    vi.advanceTimersByTime(BLOCKED_MS);
    expect(states.at(-1)).toBe('listening');
    v.stop();
  });

  it('is blocked at once when ICE fails before connecting; a lost connection is failed instead', async () => {
    const { v, states } = voice();
    await v.start(false);
    FakePC.last!.set('failed');
    expect(states.at(-1)).toBe('blocked');
    v.restart();
    FakePC.last!.set('connected');
    FakePC.last!.set('failed');
    expect(states.at(-1)).toBe('failed');
    v.stop();
    vi.advanceTimersByTime(BLOCKED_MS * 2);
    expect(states.at(-1)).toBe('off');
  });
});
