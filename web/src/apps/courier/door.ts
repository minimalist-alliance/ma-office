// Courier's switch, the only part of it the office needs before its window opens. Courier stays "Coming later" (its tile's
// chip, the window's "Courier is on its way") until real mail can reach it: `COURIER_READY` turns true with linked mailboxes
// on main (Wave 2.1), and then it ships on, as prelaunch features do. Client-config's `courier: {enabled}` overrides it either
// way: `false` is the kill switch, `true` turns it on before then (a test, staging).
import { loadedConfig, type ClientConfig } from '../../platform/clientConfig';

export const COURIER_READY = false;

export function courierOn(cfg: ClientConfig | null = loadedConfig()): boolean {
  const e = cfg?.courier?.enabled;
  return typeof e === 'boolean' ? e : COURIER_READY;
}

/**
 * An invite link's Add, from the account site (`/c/<name>`, ma-platform): the office opens at `/#courier-add=<name>&d=<desk>&k=…`.
 * The fragment is kept for that desk's Courier in this tab's sessionStorage as `<when><fragment>` (it survives a sign-in's
 * trip) and leaves the address bar at once. Courier's tile chunk opens the window and Courier adds the contact (`invite.ts`).
 */
export const INVITE_KEY = 'ma-courier-add';
try {
  if (location.hash.startsWith('#courier-add=')) {
    sessionStorage[INVITE_KEY] = Date.now() + location.hash;
    history.replaceState(history.state, '', location.pathname + location.search);
  }
} catch {
  // Storage refused (a private window): the invite page's Add then just opens the office.
}
