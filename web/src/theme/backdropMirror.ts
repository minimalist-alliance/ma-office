// The office background this browser last showed (ADR 0094), mirrored in localStorage so a returning visit paints the
// scene's colour and tiny placeholder on its first frame, before the layout document, the manifest or the picture. In the
// initial bundle, and small: `boot.ts` paints from it, `backdrop.ts` (a lazy chunk) writes it after every change.
export const MIRROR_KEY = 'ma.prefs.background';

export interface BackdropMirror {
  /** The scene's id, or "none". */
  id: string;
  /** The theme it showed in: a boot in another theme paints nothing from it, since the default differs per theme. */
  theme: string;
  average?: string;
  placeholder?: string;
}

export function parseMirror(raw: string | null): BackdropMirror | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BackdropMirror> | null;
    if (!v || typeof v.id !== 'string' || typeof v.theme !== 'string') return null;
    const m: BackdropMirror = { id: v.id, theme: v.theme };
    if (typeof v.average === 'string' && /^#[0-9a-f]{6}$/i.test(v.average)) m.average = v.average;
    if (typeof v.placeholder === 'string' && v.placeholder.startsWith('data:image/')) m.placeholder = v.placeholder;
    return m;
  } catch {
    return null;
  }
}

/**
 * What `<html>` carries for the backdrop: `data-backdrop` is the scene on show (the layer is hidden without it), and the
 * two custom properties are what `.ma-backdrop` paints until the picture arrives. Nothing of a scene is in the initial CSS.
 */
export function paintBackdrop(root: HTMLElement, scene: { id: string; average?: string; placeholder?: string } | null): void {
  const was = root.hasAttribute('data-backdrop');
  paint(root, scene);
  if (was !== root.hasAttribute('data-backdrop')) listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();

/** Whether a scene shows now: the canvas draws the active desk's ring with its halo while one does. */
export const backdropOn = (): boolean => document.documentElement.hasAttribute('data-backdrop');

/** A scene came or went: the canvas redraws, so the ring's halo comes or goes with it. */
export function onBackdropChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function paint(root: HTMLElement, scene: { id: string; average?: string; placeholder?: string } | null): void {
  if (!scene) {
    root.removeAttribute('data-backdrop');
    root.style.removeProperty('--ma-backdrop-color');
    root.style.removeProperty('--ma-backdrop-image');
    return;
  }
  root.setAttribute('data-backdrop', scene.id);
  if (scene.average) root.style.setProperty('--ma-backdrop-color', scene.average);
  else root.style.removeProperty('--ma-backdrop-color');
  if (scene.placeholder) root.style.setProperty('--ma-backdrop-image', `url("${scene.placeholder}")`);
  else root.style.removeProperty('--ma-backdrop-image');
}
