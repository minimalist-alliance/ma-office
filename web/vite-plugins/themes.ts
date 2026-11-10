// Generates themes.css from src/theme/tokens.ts (design 3.12). Vite restarts the dev server when
// a config dependency changes, so a token edit shows up at once.
import type { Plugin } from 'vite';
import { themeCss } from '../src/theme/themeCss.ts';

const ID = 'virtual:ma-themes.css';
const RESOLVED = `\0${ID}`;

export function themesPlugin(): Plugin {
  return {
    name: 'ma-themes',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? themeCss() : null),
  };
}
