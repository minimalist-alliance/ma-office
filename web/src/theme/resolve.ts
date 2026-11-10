// Pure theme resolution, shared by the pre-paint boot code and the store.
export type ThemeMode = 'system' | 'light' | 'dusk' | 'dark';
export interface ThemePref {
  mode: ThemeMode;
  systemDark: 'dark' | 'dusk';
}
export type ResolvedTheme = 'light' | 'dusk' | 'dark';

export const DEFAULT_PREF: ThemePref = { mode: 'system', systemDark: 'dark' };

export const PREF_KEY = 'ma.prefs.theme';
export const RESOLVED_KEY = 'ma.theme.resolved';

const isResolved = (v: unknown): v is ResolvedTheme => v === 'light' || v === 'dusk' || v === 'dark';

export function parsePref(raw: string | null): ThemePref | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ThemePref> | null;
    if (!v || (v.mode !== 'system' && !isResolved(v.mode))) return null;
    return { mode: v.mode, systemDark: v.systemDark === 'dusk' ? 'dusk' : 'dark' };
  } catch {
    return null;
  }
}

export function resolveTheme(pref: ThemePref, systemIsDark: boolean): ResolvedTheme {
  if (pref.mode !== 'system') return pref.mode;
  return systemIsDark ? pref.systemDark : 'light';
}

/**
 * What to apply at boot: the preference mirror, resolved against the system. With no preference the
 * default is "system", so it follows the OS even if the OS changed since the last visit. The last
 * resolved theme (which the Platform loader's blocking theme.js paints from) is only the fallback
 * for a browser that can't report the system's scheme.
 */
export function bootTheme(prefRaw: string | null, resolvedRaw: string | null, systemIsDark: boolean | null): ResolvedTheme {
  const pref = parsePref(prefRaw) ?? DEFAULT_PREF;
  if (systemIsDark !== null || pref.mode !== 'system') return resolveTheme(pref, systemIsDark ?? false);
  return isResolved(resolvedRaw) ? resolvedRaw : 'light';
}
