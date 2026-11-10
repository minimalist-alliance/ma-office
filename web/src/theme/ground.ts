// "Flat ground" fallback, from the prototype. The full-screen gradient is composited every
// frame the camera moves. On very large high-DPI screens that cost about 10 fps in software
// rendering (2560x1440 at DPR 2 ran ~50 fps; flat ran 57-60), and 1920x1080 at DPR 2 held
// 60 fps with the gradient. So the cut-off is 12M device pixels.
const FLAT_GROUND_DEVICE_PX = 12e6;
const KEY = 'ma.prefs.flatGround';

export function autoFlatGround(): boolean {
  const dpr = window.devicePixelRatio || 1;
  return window.innerWidth * window.innerHeight * dpr * dpr > FLAT_GROUND_DEVICE_PX;
}

export function flatGroundChoice(): boolean | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch {
    return null;
  }
}

export function isFlatGround(): boolean {
  return flatGroundChoice() ?? autoFlatGround();
}

export function applyFlatGround(): void {
  document.documentElement.classList.toggle('flat-ground', isFlatGround());
}

export function setFlatGround(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, String(on));
  } catch {
    /* storage unavailable */
  }
  applyFlatGround();
}

export function watchFlatGround(): () => void {
  applyFlatGround();
  window.addEventListener('resize', applyFlatGround); // also fires when the window moves to a screen with another DPR
  return () => window.removeEventListener('resize', applyFlatGround);
}
