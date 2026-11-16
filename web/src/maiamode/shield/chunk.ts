// The held line's chunk (the focus shield): fetched only while Desk Maia is on (`shieldStart.ts`), with its own stylesheet, loaded
// before anything of it draws (as the room's `chunk.ts` does), so the office's one stylesheet and first load stay as they were.
import cssUrl from './shield.css?url';
import { HeldLine } from './HeldLine';

let sheet: Promise<void> | undefined;
export function loadShieldSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssUrl;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      sheet = undefined;
      reject(new Error('The held line’s stylesheet did not load'));
    };
    document.head.appendChild(link);
  });
  return sheet;
}

export const ready = () => loadShieldSheet().then(() => ({ HeldLine }));
