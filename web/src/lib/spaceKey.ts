// A link styled as a button (it goes to another page, so it stays a link for a screen reader) is pressed with Space as
// well as Enter, as a button is: on the key's release, with nothing scrolling on the way down. Enter stays the link's own.
import type { KeyboardEvent } from 'react';

export const spaceKey = {
  onKeyDown(e: KeyboardEvent<HTMLAnchorElement>): void {
    if (e.key === ' ') e.preventDefault();
  },
  onKeyUp(e: KeyboardEvent<HTMLAnchorElement>): void {
    if (e.key !== ' ') return;
    e.preventDefault();
    e.currentTarget.click();
  },
};
