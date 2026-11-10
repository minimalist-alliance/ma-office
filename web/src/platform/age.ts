// A member's age band, exactly as `GET /v1/me` says it (ma-platform contract age.md, section 3). The server decides:
// nothing here looks at a birth date or `adultFrom`, and no age is ever asked or worked out in this app. `null` means the
// app behaves as it always has, which is what every member gets until the Alliance tier opens with these fields.
//
// A teen has no Agent app and no Claude app (ma-platform draft-age-rules.md, 3.2): the layout holds no tile for them, no
// window opens and no summary speaks of them. Nothing says why, because they simply aren't there.
import type { Me } from './api';
import type { ClientConfig } from './clientConfig';

export type AgeBand = 'teen' | 'adult' | null;

/** No `ageBand`, or `null`: as today. A value this build doesn't know is read the careful way, as a teen. */
export function ageBandOf(me: Me | null | undefined): AgeBand {
  const said: unknown = me?.membership?.ageBand;
  if (said === undefined || said === null) return null;
  return said === 'adult' ? 'adult' : 'teen';
}

/** A teen whose state asks for a parent's agreement, and who doesn't have it yet. */
export const awaitingParent = (me: Me | null | undefined): boolean => ageBandOf(me) === 'teen' && me?.membership?.parent === 'pending';

/** Whether this environment has the age rules on at all. Off or absent, as in prod until the Alliance tier opens. */
export const ageRulesOn = (cfg: ClientConfig | null | undefined): boolean => cfg?.ageRules?.enabled === true;

/** Every app a teen can't have. An adults-only app joins this list and needs nothing else here. */
const ADULT_ONLY_APPS: readonly string[] = ['agent', 'claude'];
/** Each agent's own app (`agent:<agentId>`, task 49) is an Agent app, and as adults-only. */
export const adultOnly = (app: string): boolean => ADULT_ONLY_APPS.includes(app) || app.startsWith('agent:');

/** The band this tab is working to, set by the session as soon as `/v1/me` answers. */
let band: AgeBand = null;
export const currentBand = (): AgeBand => band;
export const setCurrentBand = (next: AgeBand): void => {
  band = next;
};

/** Whether this tab's member can have this app. */
export const mayHaveApp = (app: string): boolean => currentBand() !== 'teen' || !adultOnly(app);
