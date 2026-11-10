import { describe, expect, it } from 'vitest';
import { bootTheme, parsePref, resolveTheme } from './resolve';

describe('resolveTheme', () => {
  it('follows an explicit choice', () => {
    expect(resolveTheme({ mode: 'dusk', systemDark: 'dark' }, false)).toBe('dusk');
  });
  it('follows the system between Light and Dark by default', () => {
    expect(resolveTheme({ mode: 'system', systemDark: 'dark' }, false)).toBe('light');
    expect(resolveTheme({ mode: 'system', systemDark: 'dark' }, true)).toBe('dark');
  });
  it('can use Dusk when the system is dark', () => {
    expect(resolveTheme({ mode: 'system', systemDark: 'dusk' }, true)).toBe('dusk');
  });
});

describe('bootTheme', () => {
  it('prefers the preference mirror', () => {
    expect(bootTheme('{"mode":"dark","systemDark":"dark"}', 'light', false)).toBe('dark');
  });
  it('follows the system with no preference, even if the last resolved theme differs', () => {
    expect(bootTheme(null, 'dusk', false)).toBe('light');
    expect(bootTheme(null, 'light', true)).toBe('dark');
  });
  it('falls back to the last resolved theme only when the system is unknown', () => {
    expect(bootTheme(null, 'dusk', null)).toBe('dusk');
    expect(bootTheme(null, null, null)).toBe('light');
    expect(bootTheme('{"mode":"dark"}', 'light', null)).toBe('dark');
  });
  it('ignores junk', () => {
    expect(parsePref('nope')).toBeNull();
    expect(parsePref('{"mode":"neon"}')).toBeNull();
    expect(bootTheme('nope', 'neon', false)).toBe('light');
    expect(bootTheme('nope', 'neon', null)).toBe('light');
  });
});
