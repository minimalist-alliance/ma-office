import { describe, expect, it } from 'vitest';
import { decodeQualityReply, deskOverrideFor, encodeQuality, LEVEL_INFO, LEVELS, levelFor, levelOnDesk, NEVER_SET, overrideFor, parseDeskLevels, parseStreamQuality, STREAMING_APPS, streams, upTo, withDeskLevel, type Level } from './levels';

describe('the four levels', () => {
  it('are in order, with the words and the data members read (ADR 0039 section 1)', () => {
    expect(LEVELS).toEqual(['low', 'medium', 'high', 'max']);
    expect(LEVELS.map(upTo)).toEqual(['Up to 1.2 GB an hour', 'Up to 1.8 GB an hour', 'Up to 3.6 GB an hour', 'Up to 5.4 GB an hour']);
    expect(LEVELS.map((l) => LEVEL_INFO[l].name)).toEqual(['Low', 'Medium', 'High', 'Max']);
    expect(LEVEL_INFO.low.words).toBe('Uses the least data. Text and video look softer.');
    expect(LEVEL_INFO.high.words).toBe('Sharp text and clear video.');
  });

  it('only the Browser streams today', () => {
    expect(STREAMING_APPS).toEqual(['browser']);
    expect(['browser', 'notebook', 'chat', 'agent'].map(streams)).toEqual([true, false, false, false]);
  });
});

describe('parseStreamQuality', () => {
  it('reads the contract document', () => {
    expect(parseStreamQuality({ default: 'medium', apps: { browser: 'low' }, updatedAt: '2026-11-06T21:04:11.250Z' })).toEqual({
      default: 'medium',
      apps: { browser: 'low' },
      updatedAt: '2026-11-06T21:04:11.250Z',
    });
  });

  it.each([undefined, null, 'high', 3, [], [{ default: 'low' }]])('anything that is not a document reads as never set: %j', (raw) => {
    expect(parseStreamQuality(raw)).toEqual(NEVER_SET);
  });

  it('an unknown level is High, a null override is none, and a bad app id is dropped', () => {
    const doc = parseStreamQuality({ default: 'ultra', apps: { browser: 'ultra', claude: null, 'Bad Id': 'low', __proto__x: 'low', ['a'.repeat(33)]: 'low', chat: 'max' }, updatedAt: 5 });
    expect(doc).toEqual({ default: 'high', apps: { browser: 'high', chat: 'max' }, updatedAt: null });
  });

  it('apps that is not an object is no overrides', () => {
    expect(parseStreamQuality({ default: 'low', apps: ['browser'] }).apps).toEqual({});
    expect(parseStreamQuality({ default: 'low', apps: 'browser' }).apps).toEqual({});
  });

  it('a __proto__ key from JSON never reaches the prototype', () => {
    const doc = parseStreamQuality(JSON.parse('{"default":"low","apps":{"__proto__":{"polluted":"max"}}}'));
    expect(doc.apps).toEqual({});
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('levelFor', () => {
  it("is the app's override, else the default, else High", () => {
    const doc = parseStreamQuality({ default: 'medium', apps: { browser: 'low' } });
    expect(levelFor(doc, 'browser')).toBe('low');
    expect(levelFor(doc, 'claude')).toBe('medium');
    expect(levelFor(NEVER_SET, 'browser')).toBe('high');
    expect(levelFor({ apps: {}, updatedAt: null } as never, 'browser')).toBe('high');
  });

  it("an object's own properties only", () => {
    expect(levelFor(NEVER_SET, 'constructor')).toBe('high');
    expect(overrideFor(NEVER_SET, 'toString')).toBeNull();
    expect(overrideFor(parseStreamQuality({ apps: { browser: 'max' } }), 'browser')).toBe('max');
  });
});

describe('QUALITY on the keys channel (interface section 3)', () => {
  it('type 7 is 16 bytes: type, level 1 to 4, stream 0, then zeros', () => {
    const want: Record<Level, number> = { low: 1, medium: 2, high: 3, max: 4 };
    for (const level of LEVELS) {
      const bytes = encodeQuality(level);
      expect(bytes.length).toBe(16);
      expect([...bytes]).toEqual([7, want[level], 0, ...new Array<number>(13).fill(0)]);
    }
  });

  it('carries the session seq at offset 4, big-endian', () => {
    expect([...encodeQuality('low', 0x01020304)]).toEqual([7, 1, 0, 0, 1, 2, 3, 4, ...new Array<number>(8).fill(0)]);
  });

  it('level 0 withdraws the ask', () => {
    expect([...encodeQuality(null)]).toEqual([7, ...new Array<number>(15).fill(0)]);
  });

  const reply = (bytes: number[]): Uint8Array<ArrayBuffer> => {
    const b = new Uint8Array(16);
    b.set(bytes);
    return b;
  };

  it('type 0x82 carries the level in effect, the limit and the two flags', () => {
    expect(decodeQualityReply(reply([0x82, 3, 0, 0, 0]))).toEqual({ level: 'high', limit: null, heldByLimit: false, raisedByOther: false });
    expect(decodeQualityReply(reply([0x82, 1, 0, 1, 1]))).toEqual({ level: 'low', limit: 'low', heldByLimit: true, raisedByOther: false });
    expect(decodeQualityReply(reply([0x82, 4, 0, 2, 0]))).toEqual({ level: 'max', limit: null, heldByLimit: false, raisedByOther: true });
    expect(decodeQualityReply(reply([0x82, 2, 0, 3, 2]))).toEqual({ level: 'medium', limit: 'medium', heldByLimit: true, raisedByOther: true });
    // An ArrayBuffer, as a data channel hands it over, and a view into a larger buffer.
    expect(decodeQualityReply(reply([0x82, 4, 0, 0, 4]).buffer)).toMatchObject({ level: 'max', limit: 'max' });
    const big = new Uint8Array(32);
    big.set([0x82, 2], 8);
    expect(decodeQualityReply(big.subarray(8, 24))).toMatchObject({ level: 'medium' });
  });

  it('anything else is null', () => {
    expect(decodeQualityReply(reply([0x81, 3]))).toBeNull(); // CURSOR
    expect(decodeQualityReply(reply([0x82, 0]))).toBeNull(); // no level
    expect(decodeQualityReply(reply([0x82, 5]))).toBeNull();
    expect(decodeQualityReply(reply([0x82, 3, 1]))).toBeNull(); // another stream
    expect(decodeQualityReply(reply([0x82, 3, 0, 0, 5]))).toBeNull(); // a limit this build doesn't know
    expect(decodeQualityReply(new Uint8Array([0x82, 3, 0, 0, 0]))).toBeNull(); // short
    expect(decodeQualityReply(new Uint8Array(17).fill(0, 0).map((_, i) => (i === 0 ? 0x82 : i === 1 ? 3 : 0)))).toBeNull(); // long
  });
});

describe('the desk layer (account, then desk, then High)', () => {
  const account = parseStreamQuality({ default: 'medium', apps: { browser: 'low' }, updatedAt: null });

  it("a desk's own wins, a desk without one follows the account's app level, then its default", () => {
    const desks = withDeskLevel({}, 'd-personal', 'browser', 'max');
    expect(levelOnDesk(account, desks, 'd-personal', 'browser')).toBe('max');
    expect(levelOnDesk(account, desks, 'd-work', 'browser')).toBe('low');
    expect(levelOnDesk(account, desks, 'd-work', 'claude')).toBe('medium');
    expect(levelOnDesk(NEVER_SET, {}, undefined, 'browser')).toBe('high');
    expect(deskOverrideFor(desks, 'd-work', 'browser')).toBeNull();
    expect(withDeskLevel(desks, 'd-personal', 'browser', null)).toEqual({});
  });

  it('reads only desk ids, app ids and levels it knows', () => {
    expect(parseDeskLevels({ 'd-1': { browser: 'low', claude: 'nope', 'Bad App': 'max' }, '__proto__': { browser: 'max' }, 'd-2': [], 'd-3': {} })).toEqual({ 'd-1': { browser: 'low' } });
    expect(parseDeskLevels(null)).toEqual({});
    expect(parseDeskLevels([1])).toEqual({});
  });
});
