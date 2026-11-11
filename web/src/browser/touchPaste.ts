import type { BrowserDriver } from './driver';

/**
 * Paste, called from the button's own click and nowhere else: one `readText` per tap, its text straight into the paste
 * path and dropped (no state, no store, no log). Refused, unsupported or any error: the line, and nothing more.
 */
export function readForPaste(driver: Pick<BrowserDriver, 'pastePhone' | 'pasteRefused'>): void {
  let read: Promise<string> | undefined;
  try {
    read = navigator.clipboard?.readText();
  } catch {
    read = undefined;
  }
  if (!read) {
    driver.pasteRefused();
    return;
  }
  read.then(driver.pastePhone, driver.pasteRefused);
}
