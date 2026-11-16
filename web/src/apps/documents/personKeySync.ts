// The office's one person key, the part with no store in it (`personKey.ts` runs it): read each open desk's secret, choose the
// earliest made (or make one), and give it to each desk that doesn't hold it. deskd API.md §25 `docs.key.get` and `docs.key.set`.
type Obj = Record<string, unknown>;

export interface KeyInfo {
  keyId: string;
  shared: boolean;
  /** Only once the office set it: 64 hex characters. */
  key: string | null;
  /** When it was first made (ms), for the earliest-wins rule. */
  at: number | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A desk's `docs.key.get`, held to its shape: null for anything else. */
export function readKeyInfo(v: unknown): KeyInfo | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Obj;
  const keyId = typeof o['keyId'] === 'string' && /^[0-9a-f]{1,16}$/.test(o['keyId']) ? o['keyId'] : null;
  if (!keyId) return null;
  const shared = o['shared'] === true;
  const key = shared && typeof o['key'] === 'string' && HEX64.test(o['key']) ? o['key'] : null;
  const at = shared && typeof o['at'] === 'number' && Number.isFinite(o['at']) && o['at'] > 0 ? o['at'] : null;
  return { keyId, shared: shared && key !== null && at !== null, key, at };
}

/** A new secret: 32 random bytes as 64 hex characters. */
export function makeKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The secret every desk should hold: the earliest made among the desks that have one (ties by the key), else a new one. */
export function chooseKey(infos: readonly (KeyInfo | null)[], make: () => string, now: number): { key: string; at: number } {
  let best: { key: string; at: number } | null = null;
  for (const i of infos) {
    if (!i?.shared || !i.key || !i.at) continue;
    if (!best || i.at < best.at || (i.at === best.at && i.key < best.key)) best = { key: i.key, at: i.at };
  }
  return best ?? { key: make(), at: now };
}

export interface KeyDesk {
  deskId: string;
  call(method: string, params: Obj, idem?: string): Promise<unknown>;
}

/**
 * One pass over the member's open desks: read each one's secret, choose, and give it to each desk that doesn't hold it. A desk
 * without Documents (an older deskd, the switch off) says no and is left out. Returns how many desks were given it.
 */
export async function syncKeys(desks: readonly KeyDesk[], idem: () => string, make: () => string = makeKey, now: () => number = Date.now): Promise<number> {
  if (desks.length === 0) return 0;
  const infos = await Promise.all(desks.map((d) => d.call('docs.key.get', {}).then(readKeyInfo, () => null)));
  const usable = desks.filter((_, n) => infos[n] !== null);
  if (usable.length === 0) return 0;
  const chosen = chooseKey(infos, make, now());
  let given = 0;
  await Promise.all(
    desks.map(async (d, n) => {
      const info = infos[n];
      if (!info || (info.shared && info.key === chosen.key)) return;
      try {
        await d.call('docs.key.set', { key: chosen.key, at: chosen.at }, idem());
        given += 1;
      } catch {
        // The next pass tries again.
      }
    }),
  );
  return given;
}
