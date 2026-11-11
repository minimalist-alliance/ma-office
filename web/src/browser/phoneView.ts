// The desk's phone view (deskd API.md section 10, "On a phone"; the Desk Engineer's half, ma-desk bfaa1ee2): while this
// office's Browser shows the real page on a phone, it tells the desk the phone's box with `desk.attention.set`'s
// `device`, and deskd lays every tab out at that size, with Chromium's touch emulation, at the top left of its screen.
// `browser.view` says when that's done and where (`region`), and what field has focus. The picture then shows only the
// region, scaled to fill the box, and a finger goes as the primary button (`touchInput.ts`, `direct`). Desktop site sends
// no device, so the desk keeps its own view. Pure, so it's tested without a desk (`phoneView.test.ts`).
import type { BrowserViewMessage, PhoneDevice } from '../desk/deskLink';

/** A phone, as deskd's view means it: a finger first, and a screen whose shorter side is under 600 px. */
export function isPhoneScreen(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 600;
  } catch {
    return false;
  }
}

/** iOS raises its keyboard only for a focus inside the tap, so there the Keyboard button stays the way in. */
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const DEVICE_MIN = 160;
const DEVICE_MAX = 2048;

/** The box the picture fills, as deskd takes it: whole CSS pixels from 160 to 2048, or null for a box too small to lay out. */
export function phoneDevice(box: { width: number; height: number }): PhoneDevice | null {
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width < DEVICE_MIN || height < DEVICE_MIN) return null;
  return { kind: 'phone', width: Math.min(DEVICE_MAX, width), height: Math.min(DEVICE_MAX, height) };
}

/** What the window knows of the desk's view, for this session. */
export interface PhoneView {
  /** The desk serves the view (its topic answered). */
  served: boolean;
  /** The tabs have this session's phone's view: show `region`, and a finger is the primary button. */
  mine: boolean;
  /** Another session's phone has them: the picture's top left is that phone's page. */
  other: boolean;
  region: { x: number; y: number; width: number; height: number } | null;
  screen: { width: number; height: number } | null;
  field: BrowserViewMessage['field'];
}

export const NO_PHONE_VIEW: PhoneView = { served: false, mine: false, other: false, region: null, screen: null, field: null };

/** `browser.view` as this session sees it. With no `sessionId` to go by, a phone view is ours if we asked for one. */
export function readView(m: BrowserViewMessage, ownSession: string | null, asked: boolean): PhoneView {
  const phone = m.mode === 'phone' && !!m.region && !!m.screen && m.region.width > 0 && m.region.height > 0;
  const mine = phone && (m.sessionId && ownSession ? m.sessionId === ownSession : asked);
  return { served: true, mine, other: phone && !mine, region: mine ? m.region! : null, screen: mine ? m.screen! : null, field: mine ? m.field : null };
}

/**
 * Where the video element goes in the box so that only the phone's region shows, filling it: the whole picture scaled
 * by the box over the region, offset so the region's corner is the box's. Input then maps through the element as ever,
 * normalized to the whole picture, which is what deskd asks.
 */
export function regionFrame(region: { x: number; y: number; width: number; height: number }, screen: { width: number; height: number }, box: { width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const k = Math.min(box.width / region.width, box.height / region.height);
  return { left: -region.x * k, top: -region.y * k, width: screen.width * k, height: screen.height * k };
}
