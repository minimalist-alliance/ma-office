import { describe, expect, it } from 'vitest';
import {
  asDesks,
  decodeQualityReply,
  deskLevelFor,
  deskLevelsToMove,
  deskOverrideFor,
  deskOwnLevel,
  encodeQuality,
  hasDeskLayer,
  LEVEL_INFO,
  LEVELS,
  levelFor,
  levelOnDesk,
  mergeChanges,
  NEVER_SET,
  overlay,
  overrideFor,
  parseDeskLevels,
  parseStreamQuality,
  STREAMING_APPS,
  streams,
  upTo,
  withDeskLevel,
  type Level,
  type StreamQuality,
} from './levels';

const DESK = 'd-testk3m7q2x';
const OTHER = 'd-test7v4abk3';

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
  it('reads the contract document, desks included (0.3.70)', () => {
    const raw = { default: 'medium', apps: { browser: 'low' }, desks: { [DESK]: { level: 'max', apps: { browser: 'high' } }, [OTHER]: { level: null, apps: { browser: 'low' } } }, updatedAt: '2026-11-10T21:04:11.250Z' };
    expect(parseStreamQuality(raw)).toEqual(raw);
    expect(hasDeskLayer(raw)).toBe(true);
  });

  it('a document from before 0.3.70: a default that was always a level, and no desks', () => {
    const raw = { default: 'high', apps: { browser: 'low' }, updatedAt: '2026-11-06T21:04:11.250Z' };
    expect(parseStreamQuality(raw)).toEqual({ ...raw, desks: {} });
    expect(hasDeskLayer(raw)).toBe(false);
    expect(hasDeskLayer({ ...raw, desks: [] })).toBe(false);
    expect(hasDeskLayer(null)).toBe(false);
  });

  it('a default that is null or missing is not set, never High; an unknown one is High', () => {
    expect(parseStreamQuality({ default: null, apps: {}, desks: {} }).default).toBeNull();
    expect(parseStreamQuality({ apps: {} }).default).toBeNull();
    expect(parseStreamQuality({ default: 'ultra' }).default).toBe('high');
  });

  it('desks: bad ids, empty desks and unknown parts are dropped; a null level is not set', () => {
    const doc = parseStreamQuality(
      JSON.parse(`{"desks":{"__proto__":{"level":"low"},"-x":{"level":"low"},"${DESK}":{"level":null,"apps":{}},"${OTHER}":"low","d-a":{"level":"ultra","apps":{"Bad":"low","browser":null}},"d-b":{"apps":{"browser":"max"}}}}`),
    );
    expect(doc.desks).toEqual({ 'd-a': { level: 'high', apps: {} }, 'd-b': { level: null, apps: { browser: 'max' } } });
    expect(({} as Record<string, unknown>)['level']).toBeUndefined();
  });

  it.each([undefined, null, 'high', 3, [], [{ default: 'low' }]])('anything that is not a document reads as never set: %j', (raw) => {
    expect(parseStreamQuality(raw)).toEqual(NEVER_SET);
  });

  it('an unknown level is High, a null override is none, and a bad app id is dropped', () => {
    const doc = parseStreamQuality({ default: 'ultra', apps: { browser: 'ultra', claude: null, 'Bad Id': 'low', __proto__x: 'low', ['a'.repeat(33)]: 'low', chat: 'max' }, updatedAt: 5 });
    expect(doc).toEqual({ default: 'high', apps: { browser: 'high', chat: 'max' }, desks: {}, updatedAt: null });
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

describe('levelFor (the account\'s layers)', () => {
  it("is the app's level on every desk, else the default, else High", () => {
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

describe('the layers: the app on the desk, the desk, the app on every desk, the account, High', () => {
  it('every combination of set and not set', () => {
    const picks = { deskApp: 'max', desk: 'low', accountApp: 'medium', account: 'low' } as const;
    for (let mask = 0; mask < 32; mask++) {
      const set = { deskApp: !!(mask & 1), desk: !!(mask & 2), accountApp: !!(mask & 4), account: !!(mask & 8), otherApp: !!(mask & 16) };
      const deskApps: Record<string, Level> = { ...(set.deskApp ? { browser: picks.deskApp } : {}), ...(set.otherApp ? { claude: 'high' as const } : {}) };
      const doc: StreamQuality = {
        default: set.account ? picks.account : null,
        apps: set.accountApp ? { browser: picks.accountApp } : {},
        desks: set.desk || Object.keys(deskApps).length ? { [DESK]: { level: set.desk ? picks.desk : null, apps: deskApps } } : {},
        updatedAt: null,
      };
      const account: Level = set.accountApp ? picks.accountApp : set.account ? picks.account : 'high';
      const desk: Level = set.desk ? picks.desk : account;
      const label = JSON.stringify(set);
      expect(levelOnDesk(doc, DESK, 'browser'), label).toBe(set.deskApp ? picks.deskApp : desk);
      expect(deskLevelFor(doc, DESK, 'browser'), label).toBe(desk);
      expect(deskOwnLevel(doc, DESK), label).toBe(set.desk ? picks.desk : null);
      expect(deskOverrideFor(doc, DESK, 'browser'), label).toBe(set.deskApp ? picks.deskApp : null);
      expect(levelOnDesk(doc, OTHER, 'browser'), `another desk follows the account ${label}`).toBe(account);
      expect(levelOnDesk(doc, undefined, 'browser'), `outside a desk ${label}`).toBe(account);
      expect(levelFor(doc, 'browser'), label).toBe(account);
    }
  });

  it('a layer set to High stays set when the one above changes; prototype names are never a layer', () => {
    const doc: StreamQuality = { ...NEVER_SET, default: 'low', desks: { [DESK]: { level: 'high', apps: {} } } };
    expect(levelOnDesk(doc, DESK, 'browser')).toBe('high');
    expect(levelOnDesk(doc, OTHER, 'browser')).toBe('low');
    expect(levelOnDesk(NEVER_SET, 'constructor', 'toString')).toBe('high');
    expect(deskOwnLevel(NEVER_SET, '__proto__')).toBeNull();
  });
});

describe('changes: overlay and mergeChanges', () => {
  const start: StreamQuality = { default: 'medium', apps: { browser: 'low' }, desks: {}, updatedAt: '2026-11-10T10:00:00.000Z' };

  it('overlay sets and clears each layer, drops a desk left with nothing, and keeps updatedAt', () => {
    expect(overlay(start, { default: null })).toEqual({ ...start, default: null });
    const a = overlay(start, { desks: { [DESK]: { level: 'max' } } });
    expect(a.desks).toEqual({ [DESK]: { level: 'max', apps: {} } });
    const b = overlay(a, { desks: { [DESK]: { apps: { browser: 'high' } } } });
    expect(b.desks).toEqual({ [DESK]: { level: 'max', apps: { browser: 'high' } } });
    expect(overlay(b, { desks: { [DESK]: { level: null } } }).desks).toEqual({ [DESK]: { level: null, apps: { browser: 'high' } } });
    expect(overlay(b, { desks: { [DESK]: { level: null, apps: { browser: null } } } }).desks).toEqual({});
    expect(b.updatedAt).toBe(start.updatedAt);
    expect(overlay(start, null)).toBe(start);
  });

  it('the fallback (contract 0.3.78): a free member who never chose streams at Medium, a paid one at High, and a chosen level wins', () => {
    const free = parseStreamQuality({ default: null, apps: {}, desks: {}, updatedAt: null, fallback: 'medium' });
    expect(free.fallback).toBe('medium');
    expect(levelFor(free, 'browser')).toBe('medium');
    expect(levelOnDesk(free, 'd-a', 'browser')).toBe('medium');
    expect(levelFor(parseStreamQuality({ default: 'high', fallback: 'medium' }), 'browser')).toBe('high');
    // A Platform from before sends none: High, as before, and nothing is added to the document.
    expect(parseStreamQuality({ default: null, apps: {}, desks: {}, updatedAt: null })).toEqual({ default: null, apps: {}, desks: {}, updatedAt: null });
    expect(parseStreamQuality({ fallback: 'ultra' }).fallback).toBeUndefined();
    // A change keeps it.
    expect(overlay(free, { default: null }).fallback).toBe('medium');
  });

  it('mergeChanges: the later wins where both say something, desk by desk', () => {
    expect(mergeChanges({ default: 'low' }, { default: null })).toEqual({ default: null });
    expect(mergeChanges({ default: null }, { apps: { browser: 'low' } })).toEqual({ default: null, apps: { browser: 'low' } });
    expect(mergeChanges({ desks: { [DESK]: { level: 'low' } } }, { desks: { [DESK]: { apps: { browser: 'max' } }, [OTHER]: { level: null } } })).toEqual({
      desks: { [DESK]: { level: 'low', apps: { browser: 'max' } }, [OTHER]: { level: null } },
    });
    expect(mergeChanges({ desks: { [DESK]: { apps: { browser: 'max' } } } }, { desks: { [DESK]: { apps: { browser: null } } } })).toEqual({ desks: { [DESK]: { apps: { browser: null } } } });
  });
});

describe("each desk's levels kept in this browser (before contract 0.3.70), and moving them to Platform", () => {
  const account = parseStreamQuality({ default: 'medium', apps: { browser: 'low' }, updatedAt: null });

  it('as the document\'s desk layer, they are each the app on that desk', () => {
    const local = withDeskLevel({}, 'd-personal', 'browser', 'max');
    const doc = { ...account, desks: asDesks(local) };
    expect(levelOnDesk(doc, 'd-personal', 'browser')).toBe('max');
    expect(levelOnDesk(doc, 'd-work', 'browser')).toBe('low');
    expect(levelOnDesk(doc, 'd-work', 'claude')).toBe('medium');
    expect(deskOwnLevel(doc, 'd-personal')).toBeNull();
    expect(withDeskLevel(local, 'd-personal', 'browser', null)).toEqual({});
  });

  it('what moves is only what Platform has no level for on that desk', () => {
    const local = { 'd-personal': { browser: 'max' as const }, 'd-work': { browser: 'low' as const, claude: 'high' as const } };
    expect(deskLevelsToMove(local, account)).toEqual({ desks: { 'd-personal': { apps: { browser: 'max' } }, 'd-work': { apps: { browser: 'low', claude: 'high' } } } });
    const has: StreamQuality = { ...account, desks: { 'd-work': { level: 'max', apps: { browser: 'medium' } } } };
    expect(deskLevelsToMove(local, has)).toEqual({ desks: { 'd-personal': { apps: { browser: 'max' } }, 'd-work': { apps: { claude: 'high' } } } });
    expect(deskLevelsToMove({}, account)).toBeNull();
    expect(deskLevelsToMove({ 'd-work': { browser: 'medium' } }, has)).toBeNull();
  });

  it('reads only desk ids, app ids and levels it knows', () => {
    expect(parseDeskLevels({ 'd-1': { browser: 'low', claude: 'nope', 'Bad App': 'max' }, '__proto__': { browser: 'max' }, 'd-2': [], 'd-3': {} })).toEqual({ 'd-1': { browser: 'low' } });
    expect(parseDeskLevels(null)).toEqual({});
    expect(parseDeskLevels([1])).toEqual({});
  });
});
