// Serves `virtual:ma-desk-themes.css` for the demo page: the Desk app's own Light, Dusk and Dark
// tokens, made by the app's own generator (web/src/theme/themeCss.ts), so the demo shows exactly
// what Commons looks like inside the app today. In the app, the app's themes plugin does this.
import type { Plugin } from 'vite';
import { themeCss } from '../../../../web/src/theme/themeCss.ts';

const ID = 'virtual:ma-desk-themes.css';
const RESOLVED = `\0${ID}`;

export function deskThemesPlugin(): Plugin {
  return {
    name: 'ma-desk-themes',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? themeCss() : null),
  };
}
