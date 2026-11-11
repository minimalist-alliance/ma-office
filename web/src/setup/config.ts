// What the setup circle reads from client-config and `/v1/me`, in one place. Pure but for `window.location`. Fields that
// don't exist in Platform's contract yet are this app's proposed shapes (STATUS.md, "For Platform"); each one missing
// leaves out what depends on it, never shows a figure of this app's own.
import type { Me } from '../platform/api';
import { accountUrl, type ClientConfig } from '../platform/clientConfig';
import { siblingUrl } from '../platform/hosts';
import { liveTier } from '../platform/tiers';
import { readItem, type SetupTier, type WhatsNewItem } from './steps';
import { WHATS_NEW_MANIFEST } from './whatsNewManifest';

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null);
const block = (cfg: ClientConfig | null | undefined, key: string): Loose | null => obj((cfg as Loose | null | undefined)?.[key]);

/** The whole circle and the empty Guild Desk spot: client-config `setupCircle: { enabled: false }` turns them off. Absent is on. */
export const setupOn = (cfg: ClientConfig | null | undefined): boolean => block(cfg, 'setupCircle')?.['enabled'] !== false;

/** What the circle holds after setup (What's new and the offer): `whatsNew: { enabled: false }` turns it off. Absent is on. */
export const afterOn = (cfg: ClientConfig | null | undefined): boolean => block(cfg, 'whatsNew')?.['enabled'] !== false;

/** Guilds exist here: client-config `guilds.open` isn't `false` (the kill switch `guild/guildStore.ts` reads too). */
export const guildsOpen = (cfg: ClientConfig | null | undefined): boolean => block(cfg, 'guilds')?.['open'] !== false;

/** The Files app is on (its kill switch, `files.enabled`). */
export const filesOn = (cfg: ClientConfig | null | undefined): boolean => cfg?.files?.enabled !== false;

/**
 * The member's tier as the circle knows it: `free` as `/v1/me` says it (contract tiers.md section 11), else the live paid
 * tier (`liveTier`), so an unpaid sign-up has no circle.
 */
export function setupTierOf(me: Me | null | undefined): SetupTier | null {
  const m = me?.membership as { tier?: unknown; status?: string } | undefined;
  if (m?.tier === 'free') return 'free';
  return liveTier(me?.membership);
}

/** Our own host, or nothing (`siblingUrl`: https, a sibling of this host, never this app's own). */
export const ourLink = (href: string, hostname: string = window.location.hostname): string | null => siblingUrl(href, hostname)?.href ?? null;

/** client-config's What's new list when it has one, else the repo's (`whatsNewManifest.ts`), each item read field by field. */
export function whatsNewItems(cfg: ClientConfig | null | undefined, hostname: string = window.location.hostname): WhatsNewItem[] {
  const fromConfig = block(cfg, 'whatsNew')?.['items'];
  const list = Array.isArray(fromConfig) ? fromConfig : WHATS_NEW_MANIFEST;
  return list.slice(0, 50).flatMap((raw) => {
    const item = readItem(raw, (href) => ourLink(href, hostname));
    return item ? [item] : [];
  });
}

/** Where See membership goes: `links.membership` once Platform sends one, else the account page, in a new tab. */
export function membershipHref(cfg: ClientConfig | null | undefined, hostname: string = window.location.hostname): string | null {
  if (!cfg) return null;
  return siblingUrl(cfg.links?.['membership'], hostname)?.href ?? accountUrl(cfg, hostname);
}

/** A page of the Guild app (`links.guildAdmin`, guild.<env>): `/new` founds a guild, `/<guildId>/invites` invites, `/` finds one. */
export function guildAppHref(cfg: ClientConfig | null | undefined, path: string, hostname: string = window.location.hostname): string | null {
  const base = siblingUrl(cfg?.links?.['guildAdmin'], hostname);
  return base ? new URL(path, base).href : null;
}

const gb = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100_000 ? `${Math.round(v * 10) / 10} GB` : null);

/** {allianceDrive}: client-config `tierAllowances.alliance.driveGb` (contract tiers.md 11.3), as "25 GB". */
export const allianceDrive = (cfg: ClientConfig | null | undefined): string | null => gb(obj(obj(block(cfg, 'tierAllowances')?.['alliance']))?.['driveGb']);

/** {officerWeekly}: client-config `tierAllowances.officer.weeklyAllowanceGb` (proposed, from `pricing#current`), as "30 GB". */
export const officerWeekly = (cfg: ClientConfig | null | undefined): string | null => gb(obj(block(cfg, 'tierAllowances')?.['officer'])?.['weeklyAllowanceGb']);
