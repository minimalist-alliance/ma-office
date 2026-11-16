// "Flat ground" fallback, from the prototype. The full-screen gradient is composited every
// frame the camera moves. On very large high-DPI screens that cost about 10 fps in software
// rendering (2560x1440 at DPR 2 ran ~50 fps; flat ran 57-60), and 1920x1080 at DPR 2 held
// 60 fps with the gradient. So the cut-off is 12M device pixels.
//
// Automatic only. The account menu's "Plain background" switch is gone (the owner, Nov 13), and so is the choice it kept:
// a member who had turned it on would have had no way back, so the old key is wiped and never read. The fallback drops only
// the gradient; a background scene the member chose in Zen always shows (`app.css`).
const FLAT_GROUND_DEVICE_PX = 12e6;
/** The old switch's record, wiped on the first apply. */
const OLD_KEY = 'ma.prefs.flatGround';

export function autoFlatGround(): boolean {
  const dpr = window.devicePixelRatio || 1;
  return window.innerWidth * window.innerHeight * dpr * dpr > FLAT_GROUND_DEVICE_PX;
}

export const isFlatGround = autoFlatGround;

export function applyFlatGround(): void {
  document.documentElement.classList.toggle('flat-ground', isFlatGround());
}

function forgetOldChoice(): void {
  try {
    window.localStorage.removeItem(OLD_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function watchFlatGround(): () => void {
  forgetOldChoice();
  applyFlatGround();
  window.addEventListener('resize', applyFlatGround); // also fires when the window moves to a screen with another DPR
  return () => window.removeEventListener('resize', applyFlatGround);
}
