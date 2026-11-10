// The data guard's words on screen (ma-platform ADR 0110), a lazy chunk: only a member the guard holds ever loads it. The
// platform's `message` as given and, on a member's own desk, "Your next billing day is <date>." in the member's time zone.
// A Guild Desk's words already say when, so nothing is added there.
import { useOnGuildDesk } from '../guild/words';

/** Shown if the platform's `message` is missing; the platform's own words win whenever it sends them. */
export const DATA_GUARD_FALLBACK = 'Your desks were stopped because your data use this month went past your plan.';

export interface BillingClock {
  now: number;
  locale?: string;
  timeZone?: string;
}

/** "Your next billing day is Nov 17.", or null when the platform gave no date. */
export function billingDayLine(resumesAt: string | null | undefined, c: BillingClock = { now: Date.now() }): string | null {
  if (!resumesAt || Number.isNaN(Date.parse(resumesAt))) return null;
  const opts = c.timeZone ? { timeZone: c.timeZone } : {};
  return `Your next billing day is ${new Intl.DateTimeFormat(c.locale, { month: 'short', day: 'numeric', ...opts }).format(Date.parse(resumesAt))}.`;
}

export interface DataGuardNoticeProps {
  message: string | null;
  resumesAt: string | null;
  /** A guild's own refusal: its words say when. */
  guild?: boolean;
}

export default function DataGuardView({ message, resumesAt, guild }: DataGuardNoticeProps) {
  const onGuild = useOnGuildDesk();
  const day = guild || onGuild ? null : billingDayLine(resumesAt);
  return (
    <div className="data-guard" data-testid="data-guard">
      <p data-testid="data-guard-message">{message ?? DATA_GUARD_FALLBACK}</p>
      {day && <p data-testid="data-guard-day">{day}</p>}
    </div>
  );
}
