// One live picture per member (task 46, lever 2; deskd API.md section 10, "Nobody looking", and ADR 0045). The office tells
// each desk whether it's looked at, per session, with `desk.attention.set {seen}`, and hears back on topic
// `desk.attention {seen, frozen}`. Nobody looking for 5 s, the desk cuts every session's media, sound included; for 60 s
// with nothing working its Chromium, it freezes it. Looked at again, it thaws and sends media at once. The office keeps a
// still up until the first real frame (`browser/driver.ts`).
//
// This file is the one place that decides "looked at". The wire logic each link uses to say it is `rtc/attentionSignal.ts`,
// in the link's own chunk since `sub/mm-js-budget`.
import type { CameraMode } from '../state/viewStore';

/**
 * The desk whose windows are on screen: the active desk, in desk or free mode. The overview parks every window
 * (design 3.6), so it shows none, and nothing at all shows while the office itself isn't (the export page).
 * `WindowLayer` parks the rest by this same rule.
 */
export function shownDesk(v: { mode: CameraMode; activeDesk: string | null }, officeShown = true): string | null {
  return officeShown && v.mode !== 'overview' ? v.activeDesk : null;
}

/**
 * The one desk the member is looking at: the shown desk while the tab can be seen, or while it's hidden and the member is
 * `listening`, as that desk plays sound to this tab (ADR 0038: the desk would otherwise cut the sound with the picture).
 * Every other desk is unseen.
 */
export function lookedAtDesk(v: { mode: CameraMode; activeDesk: string | null }, hidden: boolean, officeShown = true, listening = false): string | null {
  return hidden && !listening ? null : shownDesk(v, officeShown);
}
