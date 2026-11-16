// Where the welcome meets work other builders own (Nov 15). Each seam is one switch and one shape, so the piece that lands
// turns its part on without touching the welcome's flow:
//   - The focus shield (`sub/mm-shield`, deskd API.md §23 "What reaches the member"): Q4 and Q6, and Q5's catch-up times, go to
//     `agent.maia.reach.set` on the home desk. Off until the shield ships: the honesty rule (CONCEPT.md §5.1) means Q4 and Q6
//     aren't asked and nothing claims them, and Q5 maps onto today's attention fields.
//   - Helpers on MA's credits (`sub/mm-helpers-provider`, API.md §24): a helper made with no key takes the member's credits
//     where the desk offers them. Nothing to switch here: the welcome reads the helper's key after `agent.create` and says
//     "Needs a key" only when it has none.
//   - Courier (`apps/courier/door.ts` `courierOn`): F3, and the Inbox helper's mail.
//   - Voice: none for launch (the owner, Nov 15: captions and music only). `voiceFor` is the seam a later voice fills; it gives
//     nothing, so every line is a caption.
//   - Documents (`sub/mm-documents`): "Bills and things to sign" also writes the documents' welcome rule once that rule exists;
//     until then the shield's `money` match carries it.
import type { ClientConfig } from '../platform/clientConfig';

/**
 * The shield is on main beside the welcome (ma-desk `7998c857` and its finish), so both ship in the same release: this is true,
 * and the release that carries the welcome carries the shield's desk side too. Client-config `welcome.shield: false` is its kill
 * switch here (true turns it on anywhere). A home desk still on an older desk-agent can't take `agent.maia.reach.set`, so the
 * welcome asks the desk first (`homeTakesReach`): only then are Q4 and Q6 asked (the honesty rule).
 */
export const SHIELD_READY = true;
export function shieldReady(config: ClientConfig | null | undefined): boolean {
  const w = (config as { welcome?: { shield?: unknown } } | null | undefined)?.welcome;
  return typeof w?.shield === 'boolean' ? w.shield : SHIELD_READY;
}

/**
 * Whether the home desk takes the shield's settings: its `agent.maia.reach.get` answers (Desk Maia need not be on). An older
 * desk says `not_found` (deskd's "No such method", or desk-agent's): no. A desk that can't be asked yet (its link isn't open, a
 * fresh desk still starting) is taken as current, since a new desk starts on the release's own services. Any other refusal is a
 * yes: the desk knows the method.
 */
export async function homeTakesReach(call: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | null): Promise<boolean> {
  if (!call) return true;
  try {
    await call('agent.maia.reach.get', {});
    return true;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return code !== 'not_found';
  }
}

/** The welcome's kill switch: client-config `welcome: {enabled: false}`. Absent is on (prelaunch features ship on). */
export function welcomeOn(config: ClientConfig | null | undefined): boolean {
  const w = (config as { welcome?: { enabled?: unknown } } | null | undefined)?.welcome;
  return !!config && w?.enabled !== false;
}

/** A pre-recorded line for a fixed line's id, or null (none at launch). */
export const VOICE = false;
export const voiceFor = (id: string): string | null => (VOICE && id ? null : null);

/** Q4 to Q7 as the shield's settings (`{reach}`), the times in the desk's own zone. */
export function reachFor(r: { q4?: readonly string[]; q5?: readonly string[]; q6?: readonly string[]; q7?: readonly string[] }, names: readonly string[]): Record<string, unknown> {
  const q4 = r.q4 ?? [];
  const holdAll = q4.includes('nothing');
  const letThrough: Record<string, unknown>[] = [];
  if (!holdAll) {
    if (q4.includes('family')) letThrough.push({ kind: 'group', group: 'family', anyTime: true, source: 'welcome' });
    if (q4.includes('boss')) letThrough.push({ kind: 'group', group: 'boss', anyTime: false, source: 'welcome' }, { kind: 'group', group: 'clients', anyTime: false, source: 'welcome' });
    if (q4.includes('due')) letThrough.push({ kind: 'match', match: 'due_today', anyTime: false, source: 'welcome' });
    if (q4.includes('bills')) letThrough.push({ kind: 'match', match: 'money', anyTime: false, source: 'welcome' });
    for (const n of names) letThrough.push({ kind: 'person', person: { pendingName: n }, anyTime: false, source: 'welcome' });
  }
  const catchUps: Record<string, string[]> = { three: ['09:00', '13:00', '17:00'], two: ['09:00', '17:00'], often: ['09:00', '11:00', '13:00', '15:00', '17:00'], ask: [] };
  const q6 = r.q6 ?? [];
  const focusHours = [...(q6.includes('mornings') ? [{ from: '09:00', to: '12:00' }] : []), ...(q6.includes('afternoons') ? [{ from: '14:00', to: '17:00' }] : [])];
  return {
    letThrough: letThrough.slice(0, 5),
    holdAll,
    ...(r.q5?.[0] ? { catchUps: catchUps[r.q5[0]] ?? catchUps['three'] } : {}),
    focusHours,
    ...(r.q7?.[0] ? { detail: r.q7[0] } : {}),
  };
}

/** Names typed under Q4: plain, 1 to 60 characters each, at most 5, never sent anywhere but the home desk. */
export function namesFrom(text: string): string[] {
  return text
    .split(/[,;\n]| and /)
    .map((s) => s.replace(/[^\p{L}\p{N} .'’-]/gu, '').trim())
    .filter((s) => s.length >= 1 && s.length <= 60)
    .slice(0, 5);
}
