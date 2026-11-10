// First import: sets data-theme before anything paints, as the Desk app's theme/boot does.
export const THEME_KEY = 'ma.notebook-demo.theme';
export type DemoTheme = 'light' | 'dusk' | 'dark';

export function savedTheme(): DemoTheme {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'light' || q === 'dusk' || q === 'dark') return q;
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dusk' || v === 'dark') return v;
  } catch {
    // Storage off: fall through to the system's preference.
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

document.documentElement.setAttribute('data-theme', savedTheme());
