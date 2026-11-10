// Serves `virtual:ma-notebook-themes.css`: the Notebook's own per-theme colors (tab colors and the
// highlight), from src/theme/tokens.ts, as the Desk app's themes plugin does for its tokens.
// The Desk app adds this plugin to its vite.config.ts when it adopts the Notebook (see STATUS.md).
import type { Plugin } from 'vite';
import { notebookThemeCss } from '../src/theme/tokens.ts';

const ID = 'virtual:ma-notebook-themes.css';
const RESOLVED = `\0${ID}`;

export function notebookThemesPlugin(): Plugin {
  return {
    name: 'ma-notebook-themes',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? notebookThemeCss() : null),
  };
}
