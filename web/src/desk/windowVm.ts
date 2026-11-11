// What an app window draws for its desk's state while the office holds a link's news (TD-227 part 3).
import type { VmState } from './agentStatus';
import type { DeskLink } from './deskLink';

/**
 * The desk's state as an app window should draw it. The office holds what a link says while the camera moves
 * (`whenStill` in `liveStore.ts`, rule "Never sluggish"), and a press on an app in the overview both wakes its desk
 * and glides the camera there, opening the window halfway. So the window would draw the list's "stopped" (asleep,
 * with a Wake button) until the glide ends, and then waking. The link already says the desk is on its way up
 * (`RtcDeskLink.showWaking`), from the press: that word is read here, as the window renders, and wins over a held
 * "stopped" or a not-yet-known state. It's read, not subscribed to, so it adds no render during motion.
 */
export function windowVm(vm: VmState | undefined, link: DeskLink | null): VmState {
  const held = vm ?? 'unknown';
  if (held !== 'stopped' && held !== 'unknown') return held;
  return link?.details().desk?.state === 'starting' ? 'starting' : held;
}
