// Maia Mode's room chunk (`door.ts` `roomChunk`): fetched when the member first enters, or with a page that starts in the room.
// Its styles are a file of their own, fetched with it and loaded before anything of the room draws (as the tour's and the
// simplified view's are), so the app's one stylesheet stays as it was. A sheet that fails rejects like a failed chunk, and
// nothing of the room shows.
import roomCssUrl from './room.css?url';
import { Room } from './Room';
import { loadShieldSheet } from './shield/chunk';
import { enter, leave, reset } from './ui';

let sheet: Promise<void> | undefined;
function loadSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = roomCssUrl;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      sheet = undefined;
      reject(new Error('Maia Mode’s stylesheet did not load'));
    };
    document.head.appendChild(link);
  });
  return sheet;
}

/** The chunk, once its stylesheet is in. */
/** The chunk, once its stylesheets are in: the room's, and the held line's (its card and catch-up sit in the To-do column). */
export const ready = () => Promise.all([loadSheet(), loadShieldSheet()]).then(() => ({ Room, enter, leave, reset }));
