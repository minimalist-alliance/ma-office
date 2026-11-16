// An invite link's Add, arriving in the office (the Designer's flow 3; `door.ts` keeps it): read once for its desk, checked
// field by field, dropped after 10 minutes. The desk adds the member address and pins its key only if it matches the link's
// fingerprint (`courier.contacts.add`, the transports' Wave 2.5: proposed in mm-courier-ui.md, built in the mock desk).
import { INVITE_KEY } from './door';

export interface Invite {
  deskId: string;
  /** The registry name; the address is `<name>@<the Courier domain>`, which the desk knows. */
  name: string;
  fingerprint: string | null;
  displayName: string;
}

const KEEP_MS = 10 * 60_000;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{1,30}[a-z0-9])$/;
const FINGERPRINT = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;

/** What `door.ts` kept: `<epoch ms>#courier-add=…`. */
export function readInvite(raw: string | null, now = Date.now()): Invite | null {
  try {
    const m = /^(\d{1,15})(#courier-add=.*)$/s.exec(raw ?? '');
    if (!m || now - Number(m[1]) > KEEP_MS) return null;
    const p = new URLSearchParams(m[2]!.slice(1));
    const name = (p.get('courier-add') ?? '').toLowerCase();
    const deskId = p.get('d') ?? '';
    const k = (p.get('k') ?? '').toLowerCase();
    if (!NAME.test(name) || !/^[A-Za-z0-9_-]{1,64}$/.test(deskId)) return null;
    const displayName = (p.get('n') ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return { deskId, name, fingerprint: FINGERPRINT.test(k) ? k : null, displayName };
  } catch {
    return null;
  }
}

/** The invite waiting for this desk, if any. `take` drops it once Courier has asked the desk. */
export function pendingInvite(deskId: string, take = false): Invite | null {
  try {
    const inv = readInvite(sessionStorage.getItem(INVITE_KEY));
    if (!inv) sessionStorage.removeItem(INVITE_KEY);
    if (!inv || inv.deskId !== deskId) return null;
    if (take) sessionStorage.removeItem(INVITE_KEY);
    return inv;
  } catch {
    return null;
  }
}
