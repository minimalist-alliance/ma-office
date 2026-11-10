// Shared by the browser tests: the test page, the package as built, and frame counting.
import type { Page } from '@playwright/test';

/** Counts every requestAnimationFrame the page asks for, before any of its own code runs. */
export async function countFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { rafCalls: number; cspViolations: string[] };
    w.rafCalls = 0;
    w.cspViolations = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { w.rafCalls += 1; return raf(cb); };
    document.addEventListener('securitypolicyviolation', (e) => w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

export async function openTestPage(page: Page): Promise<void> {
  await countFrames(page);
  await page.goto('/test.html');
  await page.evaluate(async () => {
    (window as unknown as { M: unknown }).M = await import('/lib/maia-avatar.js' as string);
  });
}

export async function loadReference(page: Page): Promise<void> {
  for (const f of ['data', 'vocab', 'engine']) await page.addScriptTag({ url: `/reference/${f}.js` });
}

/**
 * DANCE: a clock driven by hand, for frame-exact runs at 60 frames a second. requestAnimationFrame and performance.now
 * belong to the test: window.__frame(ms) moves time on and runs the frame. The page's real rendering still runs, so
 * IntersectionObserver reports as usual.
 */
export async function handClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let now = 1000, id = 0;
    let queue: [number, FrameRequestCallback][] = [];
    const w = window as unknown as { __frame(ms: number): number; cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    performance.now = () => now;
    window.requestAnimationFrame = (cb) => { id += 1; queue.push([id, cb]); return id; };
    window.cancelAnimationFrame = (h) => { queue = queue.filter(([i]) => i !== h); };
    w.__frame = (ms) => { now += ms; const q = queue; queue = []; for (const [, cb] of q) cb(now); return q.length; };
  });
}

/** DANCE: a PNG with only the chunks that make the image (IHDR, PLTE, tRNS, IDAT, IEND), so no metadata goes into git. */
export function barePng(png: Buffer): Buffer {
  const keep = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  const out = [png.subarray(0, 8)];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), end = at + 12 + len;
    if (keep.has(type)) out.push(png.subarray(at, end));
    at = end;
  }
  return Buffer.concat(out);
}
