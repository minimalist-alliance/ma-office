import { describe, expect, it } from 'vitest';
import { FrameReader, readFrame, type Frame } from './frames';

const sse = (...frames: unknown[]): string => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

const TURN = sse(
  { type: 'start', conversationId: 'c_1', messageId: 'm_1', model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5', newConversation: true },
  { type: 'status', code: 'kb' },
  { type: 'text', text: 'Hello ' },
  { type: 'text', text: 'there.' },
  { type: 'proposal', proposalId: 'p_1', action: 'open_desk', params: { deskId: 'd-1' }, expiresAt: '2026-11-06T12:00:00Z' },
  { type: 'done', messageId: 'm_1' },
  { type: 'animation', messageId: 'm_1', score: { v: 1, mood: 'warm' } },
);

describe('FrameReader', () => {
  it('reads a whole turn in order, animation after done included', () => {
    const r = new FrameReader();
    const types = [...r.push(TURN), ...r.end()].map((f) => f.type);
    expect(types).toEqual(['start', 'status', 'text', 'text', 'proposal', 'done', 'animation']);
  });

  it('gives the same frames however the bytes are split', () => {
    const whole = new FrameReader().push(TURN);
    for (const size of [1, 2, 3, 7, 13, 64]) {
      const r = new FrameReader();
      const got: Frame[] = [];
      for (let i = 0; i < TURN.length; i += size) got.push(...r.push(TURN.slice(i, i + size)));
      got.push(...r.end());
      expect(got).toEqual(whole);
    }
  });

  it('takes CRLF, a data line with no space, several data lines, and a last frame with no blank line after it', () => {
    const r = new FrameReader();
    const got = r.push('data:{"type":"text","text":"a"}\r\n\r\ndata: {"type":"text",\ndata: "text":"b"}\n\n: keep-alive\n\nevent: x\ndata: {"type":"done","messageId":"m"}');
    expect(got).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    expect(r.end()).toEqual([{ type: 'done', messageId: 'm' }]);
  });

  it('drops frame types it does not know, bad JSON and bad fields, and carries on', () => {
    const r = new FrameReader();
    const got = r.push(
      'data: {"type":"future","x":1}\n\n' +
        'data: {not json}\n\n' +
        'data: {"type":"text"}\n\n' +
        'data: {"type":"proposal","proposalId":"p","action":"open_desk","params":[]}\n\n' +
        'data: ["text"]\n\n' +
        sse({ type: 'text', text: 'ok' }),
    );
    expect(got).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it("doesn't hold on to a stream that never ends a frame", () => {
    const r = new FrameReader();
    r.push(`data: ${'x'.repeat(1024 * 1024 + 10)}`);
    expect(r.push(sse({ type: 'text', text: 'after' }))).toEqual([{ type: 'text', text: 'after' }]);
  });
});

describe('readFrame', () => {
  it('reads stop as it came, with defaults for what is missing', () => {
    expect(readFrame({ type: 'stop', reason: 'refusal', text: 'No <b>thanks</b>', retryable: false })).toEqual({ type: 'stop', reason: 'refusal', text: 'No <b>thanks</b>', resetsAt: null, retryable: false, free: null });
    expect(readFrame({ type: 'stop' })).toEqual({ type: 'stop', reason: 'error', text: '', resetsAt: null, retryable: false, free: null });
  });

  it("reads start's null conversation on an unavailable stop", () => {
    expect(readFrame({ type: 'start', conversationId: null, messageId: 'm', modelLabel: 'M', newConversation: false })).toMatchObject({ conversationId: null, messageId: 'm' });
  });

  it('keeps an animation score as it is, for the package to parse', () => {
    const score = { v: 1, mood: 'warm', __proto__: { x: 1 } };
    expect(readFrame({ type: 'animation', messageId: 'm', score })).toEqual({ type: 'animation', messageId: 'm', score });
  });

  it('reads free Maia on start, and nothing for a bad one', () => {
    const until = '2026-11-09T00:00:00.000Z';
    expect(readFrame({ type: 'start', conversationId: 'c', messageId: 'm', newConversation: false, free: { until } })).toMatchObject({ free: { until } });
    expect(readFrame({ type: 'start', conversationId: 'c', messageId: 'm', newConversation: false })).toMatchObject({ free: null });
    for (const free of [true, 'yes', [], { until: 'soon' }, { until: 5 }, { until: 'x'.repeat(41) }]) {
      expect(readFrame({ type: 'start', conversationId: 'c', messageId: 'm', newConversation: false, free })).toMatchObject({ free: null });
    }
  });

  it("reads the free_mode notice's reset time and upgrade, and defaults them on any other notice", () => {
    expect(readFrame({ type: 'notice', code: 'free_mode', text: "You're on free Maia.", resetsAt: '2026-11-09T00:00:00Z', upgrade: true })).toEqual({
      type: 'notice',
      code: 'free_mode',
      text: "You're on free Maia.",
      resetsAt: '2026-11-09T00:00:00Z',
      upgrade: true,
    });
    expect(readFrame({ type: 'notice', code: 'new_chat', text: 'New chat.' })).toEqual({ type: 'notice', code: 'new_chat', text: 'New chat.', resetsAt: null, upgrade: false });
    expect(readFrame({ type: 'notice', code: 'free_mode', text: 'x', resetsAt: 'later', upgrade: 'yes' })).toMatchObject({ resetsAt: null, upgrade: false });
  });

  it("reads why free Maia couldn't answer on a stop, and only the three it knows", () => {
    for (const free of ['busy', 'unavailable', 'limit'] as const) {
      expect(readFrame({ type: 'stop', reason: 'limit_personal', text: 't', free })).toMatchObject({ free });
    }
    expect(readFrame({ type: 'stop', reason: 'limit_personal', text: 't', free: 'down' })).toMatchObject({ free: null });
  });
});

it('a free_queue status carries its line, cut short if long; other statuses have none', () => {
  expect(readFrame({ type: 'status', code: 'free_queue', text: "Free Maia is a bit busy, you're next in line. About 40 seconds." })).toEqual({ type: 'status', code: 'free_queue', text: "Free Maia is a bit busy, you're next in line. About 40 seconds." });
  expect((readFrame({ type: 'status', code: 'free_queue', text: 'x'.repeat(500) }) as { text: string }).text.length).toBe(160);
  expect(readFrame({ type: 'status', code: 'kb' })).toEqual({ type: 'status', code: 'kb', text: null });
});

describe('the attachments stop', () => {
  it('reads reason attachments with its text', () => {
    const f = readFrame({ type: 'stop', reason: 'attachments', text: 'That file type is not supported.', retryable: false });
    expect(f).toMatchObject({ type: 'stop', reason: 'attachments', text: 'That file type is not supported.' });
  });
  it('an unknown reason still reads as it came', () => {
    expect(readFrame({ type: 'stop', reason: 'something_new', text: 'x' })).toMatchObject({ reason: 'something_new' });
    expect(readFrame({ type: 'stop', text: 'x' })).toMatchObject({ reason: 'error' });
  });
});
