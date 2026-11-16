// MA Connector for Mac in the office: the code's shape, the Mac account's line, and a pairing's refusals in words.
import { describe, expect, it } from 'vitest';
import { CourierError } from './client';
import { ago, macLine, normalCode, pairWords } from './Setup';
import { readAccounts, readMacSync } from './wire';
import { W } from './words';

describe('the Mac connector in Accounts', () => {
  it('reads a code as two groups of four letters, whatever was typed', () => {
    expect(normalCode('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(normalCode('BCDF-GHJK-EXTRA')).toBe('BCDF-GHJK');
    expect(normalCode('bc')).toBe('BC');
    expect(normalCode('12 34')).toBe('');
  });

  it('says how the Mac stands, and when it needs the member', () => {
    const now = 1_800_000_000_000;
    expect(macLine({ state: 'live', reason: null, path: 'connector', checkedAt: now - 3 * 60_000, check: '4071 2958 3316' }, now)).toEqual({ text: W.mac.live, needsYou: false, quiet: W.mac.checked('3 minutes'), check: W.mac.check('4071 2958 3316') });
    expect(macLine({ state: 'waiting', reason: 'mac', path: 'connector', checkedAt: null, check: null }, now).text).toBe(W.mac.pressConnect);
    expect(macLine({ state: 'needs_you', reason: 'full_disk', path: 'connector', checkedAt: now, check: null }, now).needsYou).toBe(true);
    expect(macLine({ state: 'needs_you', reason: 'automation', path: 'connector', checkedAt: null, check: null }, now).text).toBe(W.mac.automation);
    expect(macLine({ state: 'needs_you', reason: 'unpaired', path: 'connector', checkedAt: null, check: null }, now).text).toBe(W.mac.unpaired);
    expect(macLine({ state: 'off', reason: 'switched_off', path: 'connector', checkedAt: null, check: null }, now).text).toBe(W.mac.off);
    expect(macLine({ state: 'waiting', reason: 'mac', path: 'connector', checkedAt: 7, check: null }, now).text).toBe(W.mac.waiting);
    expect(macLine(null, now).text).toBe(W.mac.waiting);
    expect(ago(30_000)).toBe('a moment');
    expect(ago(3 * 3600_000)).toBe('3 hours');
    expect(ago(49 * 3600_000)).toBe('2 days');
  });

  it("words each of the desk's no's for a code", () => {
    expect(pairWords(new CourierError('bad_request', 'code'))).toBe(W.mac.err.code);
    expect(pairWords(new CourierError('not_found', 'code'))).toBe(W.mac.err.notWaiting);
    expect(pairWords(new CourierError('conflict', 'too_many'))).toBe(W.mac.err.tooMany);
    expect(pairWords(new CourierError('unavailable', 'paused'))).toBe(W.mac.err.paused);
    expect(pairWords(new CourierError('rate_limited', 'rate_limited'))).toBe(W.mac.err.rate);
    expect(pairWords(new CourierError('offline'))).toBe(W.offline);
  });

  it('reads only short words from the Mac account’s sync, never an address or a key', () => {
    expect(readMacSync({ state: 'live', reason: null, path: 'connector', checkedAt: 5, device: { fingerprint: 'abcd', check: '4071 2958 3316' }, mac: { app: '1.0' } })).toEqual({ state: 'live', reason: null, path: 'connector', checkedAt: 5, check: '4071 2958 3316' });
    expect(readMacSync({ device: { check: '<script>' } })?.check).toBeNull();
    expect(readMacSync({ state: '<b>x</b>', path: 'https://evil.example', checkedAt: -1 })).toEqual({ state: 'connecting', reason: null, path: 'bluebubbles', checkedAt: null, check: null });
    const a = readAccounts({ accounts: [{ accountId: 'imessage-00000000000000000001', kind: 'imessage', label: 'Mac', address: null, state: 'ok', sending: true, signedIn: true, sync: { state: 'live', path: 'connector', checkedAt: 9 } }] });
    expect(a[0]?.mac).toEqual({ state: 'live', reason: null, path: 'connector', checkedAt: 9, check: null });
  });

  it('keeps its words calm: no exclamation marks, no provider names', () => {
    const all = JSON.stringify(W.mac);
    expect(all).not.toMatch(/!/);
    expect(all.toLowerCase()).not.toMatch(/amazon|aws|cloudflare|ngrok/);
  });
});
