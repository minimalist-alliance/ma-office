// Full screen with Keyboard Lock (Chromium only): while the office is full screen, the keys a member's hands reach for by
// habit (Ctrl+W, T and N, Ctrl+Tab, Ctrl+L, Ctrl+R and F5, Cmd on a Mac) are the office's, so they reach the desk through the
// Browser's input (`keyAction`) instead of closing or leaving the office. Leaving full screen lets them go. In the office's
// own installed window the browser keeps none of them anyway, so there they're the desk's without full screen.
// Escape isn't locked, so one press still leaves full screen, as the browser's own line says on the way in. Locked, leaving
// would take holding Esc down (Chromium's rule for a locked Escape), so it stays the browser's. The top bar's full-screen
// change loads and calls this (`chrome/TopBar.tsx`), whether or not any app has loaded, so it's no weight on the first load.
// Where `navigator.keyboard` isn't (Safari, Firefox), nothing here does anything and nothing is said.

/** By the physical key (`KeyboardEvent.code`), as the API takes them. A layout that moves a letter adds its own place. */
export const LOCKED_KEYS: readonly string[] = ['KeyW', 'KeyT', 'KeyN', 'Tab', 'PageUp', 'PageDown', 'KeyL', 'KeyR', 'F5'];
/** The letters the browser's own shortcuts go by, wherever this keyboard has them. */
const LETTERS = ['w', 't', 'n', 'l', 'r'];

interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
  getLayoutMap?(): Promise<ReadonlyMap<string, string>>;
}

function keyboard(): KeyboardLock | null {
  if (typeof navigator === 'undefined') return null;
  const k = (navigator as { keyboard?: Partial<KeyboardLock> }).keyboard;
  return k && typeof k.lock === 'function' && typeof k.unlock === 'function' ? (k as KeyboardLock) : null;
}

/** Whether full screen keeps those keys here: a Chromium on a computer. Android's has the call, which only refuses. */
export function canLockKeys(): boolean {
  return keyboard() !== null && !/Android/.test(navigator.userAgent);
}

/** The codes to lock for this keyboard: the list, and wherever the layout puts the letters (an AZERTY's w is on KeyZ). */
export function lockCodes(layout: ReadonlyMap<string, string> | null): string[] {
  const codes = new Set(LOCKED_KEYS);
  if (layout) for (const [code, key] of layout) if (LETTERS.includes(key.toLowerCase())) codes.add(code);
  return [...codes];
}

let locked = false;
let asked = 0;
let installed: MediaQueryList | null | undefined;

/**
 * Whether the office runs as an installed app, in its own window (Platform's loader manifest, `display: standalone`). Chromium
 * reserves no keys there, so the page has Ctrl+W, T and N first, full screen or not.
 */
export function installedWindow(): boolean {
  if (installed === undefined) {
    installed = typeof matchMedia === 'function' ? matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)') : null;
  }
  return installed?.matches ?? false;
}

/** Whether those keys are the desk's right now: full screen with the browser's lock, or the office's own window. */
export function keysToDesk(): boolean {
  return (locked && !!document.fullscreenElement) || installedWindow();
}

/** Follows full screen: asks for the lock on the way in, lets go on the way out. A refusal leaves things as they were. */
export async function followFullscreen(): Promise<void> {
  const kb = keyboard();
  if (!kb) return;
  const n = (asked += 1);
  if (!document.fullscreenElement) {
    locked = false;
    kb.unlock();
    return;
  }
  try {
    const layout = kb.getLayoutMap ? await kb.getLayoutMap().catch(() => null) : null;
    if (n !== asked || !document.fullscreenElement) return;
    await kb.lock(lockCodes(layout));
    if (n === asked) locked = !!document.fullscreenElement;
  } catch {
    if (n === asked) locked = false;
  }
}
