// The built-in styles' image files, as URLs Vite emits. Apart from `deskStyles.ts` so their hashed names stay out of the
// initial JS: `canvas/deskTexture.ts` asks for this when it fetches an image, and a style's `src` is the key here.
import oakLight from '../assets/desk-styles/oak-light.webp';
import oakDusk from '../assets/desk-styles/oak-dusk.webp';
import oakDark from '../assets/desk-styles/oak-dark.webp';
import ashLight from '../assets/desk-styles/ash-light.webp';
import ashDusk from '../assets/desk-styles/ash-dusk.webp';
import ashDark from '../assets/desk-styles/ash-dark.webp';
import walnutLight from '../assets/desk-styles/walnut-light.webp';
import walnutDusk from '../assets/desk-styles/walnut-dusk.webp';
import walnutDark from '../assets/desk-styles/walnut-dark.webp';
import linoleumLight from '../assets/desk-styles/linoleum-light.webp';
import linoleumDusk from '../assets/desk-styles/linoleum-dusk.webp';
import linoleumDark from '../assets/desk-styles/linoleum-dark.webp';

export const DESK_STYLE_FILES: Record<string, string> = {
  'oak-light': oakLight,
  'oak-dusk': oakDusk,
  'oak-dark': oakDark,
  'ash-light': ashLight,
  'ash-dusk': ashDusk,
  'ash-dark': ashDark,
  'walnut-light': walnutLight,
  'walnut-dusk': walnutDusk,
  'walnut-dark': walnutDark,
  'linoleum-light': linoleumLight,
  'linoleum-dusk': linoleumDusk,
  'linoleum-dark': linoleumDark,
};
