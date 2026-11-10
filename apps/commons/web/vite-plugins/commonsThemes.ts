// Serves `virtual:ma-commons-themes.css`: Commons' own per-theme colors (inks, note fills, member
// colors) from src/theme/tokens.ts, as the Desk app's themes plugin does for its tokens. The Desk
// app adds this plugin to its vite.config.ts when it adopts Commons (see STATUS.md).
import type { Plugin } from 'vite';
import { commonsThemeCss } from '../src/theme/tokens.ts';

const ID = 'virtual:ma-commons-themes.css';
const RESOLVED = `\0${ID}`;

export function commonsThemesPlugin(): Plugin {
  return {
    name: 'ma-commons-themes',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? commonsThemeCss() : null),
  };
}
