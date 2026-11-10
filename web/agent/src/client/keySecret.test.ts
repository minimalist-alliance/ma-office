import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { KeySecret, keyFormatMessage, keyFormatProblem, keyOwner, providerMismatchMessage, REDACTED } from './keySecret';

const KEY = 'sk-ant-TEST-not-a-real-key-0000-UNIT';

describe('KeySecret', () => {
  it('never prints, serializes or stringifies the key', () => {
    const s = KeySecret.fromText(KEY);
    const seen = [String(s), `${s}`, JSON.stringify(s), JSON.stringify({ secret: s }), inspect(s), inspect({ s }, { depth: 5, showHidden: true }), Object.keys(s).join(','), JSON.stringify(Object.entries(s))];
    for (const text of seen) expect(text).not.toContain(KEY);
    expect(JSON.stringify({ secret: s })).toBe(`{"secret":"${REDACTED}"}`);
  });

  it('holds nothing on the object itself', () => {
    const s = KeySecret.fromText(KEY);
    expect(Object.getOwnPropertyNames(s)).toEqual([]);
    expect(Object.getOwnPropertySymbols(s)).toEqual([]);
    expect(structuredClone(s)).toEqual({});
  });

  it('gives the plaintext only through withPlaintext, and not after a wipe', () => {
    const s = KeySecret.fromText(`  ${KEY}\n`);
    expect(s.withPlaintext((k) => k)).toBe(KEY); // trimmed, as a paste brings a newline
    expect(s.held).toBe(true);
    s.wipe();
    expect(s.held).toBe(false);
    expect(() => s.withPlaintext((k) => k)).toThrow(/wiped/);
    s.wipe(); // twice is fine
  });

  it('takeFrom empties the field in the same call', () => {
    const field = { value: KEY };
    const s = KeySecret.takeFrom(field);
    expect(field.value).toBe('');
    expect(s.withPlaintext((k) => k)).toBe(KEY);
  });

  it('a thrown error from inside withPlaintext carries no key unless the caller put it there', () => {
    const s = KeySecret.fromText(KEY);
    try {
      s.withPlaintext(() => {
        throw new Error('boom');
      });
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
  });
});

describe('keyFormatProblem (task 04 KeyRing rules)', () => {
  const check = (text: string, prefix = 'sk-ant-') => keyFormatProblem(KeySecret.fromText(text), prefix);
  it('accepts a well-formed key', () => expect(check(KEY)).toBeNull());
  it('refuses empty, short, long, spaces, control characters and a wrong prefix', () => {
    expect(check('')).toBe('empty');
    expect(check('   ')).toBe('empty');
    expect(check('sk-ant')).toBe('length');
    expect(check(`sk-ant-${'x'.repeat(1100)}`)).toBe('length');
    expect(check('sk-ant-abc def-ghi')).toBe('charset');
    expect(check('sk-ant-abc\u0007defghi')).toBe('charset');
    expect(check('sk-ant-abcdéfghi')).toBe('charset');
    expect(check('sk-proj-0000000000', 'sk-ant-')).toBe('prefix');
    expect(check('sk-proj-0000000000', 'sk-')).toBeNull();
  });
  it('messages never quote the key', () => {
    for (const p of ['empty', 'length', 'charset', 'prefix'] as const) expect(keyFormatMessage(p, 'sk-ant-')).not.toContain(KEY);
  });
});

describe('whose key it is (deskd API.md §11, `provider_mismatch`)', () => {
  // The shape `agent.providers` answers with, as the real test desk does: anthropic, openai, xai.
  const PROVIDERS = [
    { id: 'anthropic', name: 'Anthropic', keyPrefix: 'sk-ant-' },
    { id: 'openai', name: 'OpenAI', keyPrefix: 'sk-' },
    { id: 'xai', name: 'xAI', keyPrefix: 'xai-' },
  ];
  const owner = (text: string, providers = PROVIDERS) => keyOwner(KeySecret.fromText(text), providers)?.id ?? null;
  it('the longest prefix that fits says whose a key is, so `sk-ant-` is Anthropic\'s though OpenAI\'s `sk-` fits too', () => {
    expect(owner(KEY)).toBe('anthropic');
    expect(owner('sk-proj-0000000000')).toBe('openai');
    expect(owner('xai-0000000000')).toBe('xai');
    // The order the desk lists them in doesn't matter.
    expect(owner(KEY, [...PROVIDERS].reverse())).toBe('anthropic');
  });
  it('a key with no known prefix belongs to nobody, and an empty prefix never claims one', () => {
    expect(owner('gsk_0000000000')).toBeNull();
    expect(owner(KEY, [{ id: 'odd', name: 'Odd', keyPrefix: '' }])).toBeNull();
  });
  it('reads the key without keeping it, and a wiped secret can\'t be read', () => {
    const s = KeySecret.fromText(KEY);
    expect(keyOwner(s, PROVIDERS)?.id).toBe('anthropic');
    s.wipe();
    expect(() => keyOwner(s, PROVIDERS)).toThrow();
  });
  it('one plain line naming the right provider, or, from the desk with no name, the same line without one; never the key', () => {
    expect(providerMismatchMessage('Anthropic')).toBe('That’s a key from Anthropic. Pick Anthropic above and paste it again.');
    expect(providerMismatchMessage(null)).toBe('That’s a key from another provider. Pick its provider above and paste it again.');
    expect(providerMismatchMessage('Anthropic')).not.toContain(KEY);
  });
});
