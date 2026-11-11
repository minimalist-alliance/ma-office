// The Maia panel's second line (the owner, Nov 9): how long chats are kept, that they pass through us, and, where the member
// has desk agents, where private things go. The days are the server's `retentionDays`, never a number of our own.
// the owner, Nov 10: an info circle right after "pass through us" says what's kept, for what, and that nothing trains a model.

/** The line, split where the info circle goes: `lead` ends "pass through us", `tail` is the rest. */
export function keptParts(retentionDays: number | null, agents: boolean): { lead: string; tail: string } {
  const lead = retentionDays ? `Chats are kept ${retentionDays} days and pass through us` : 'Chats pass through us';
  return { lead, tail: agents ? ', so keep private things with your desk agents.' : '.' };
}

export function keptLine(retentionDays: number | null, agents: boolean): string {
  const { lead, tail } = keptParts(retentionDays, agents);
  return lead + tail;
}

/**
 * The info circle's words (the owner, Nov 10; the Sales Engineer's final words, matching /privacy). True of the server as built:
 * chats are deleted at `retentionDays` with no backup, attached files are never kept, only their names (ADR 0109), and no
 * member's chat goes to a provider whose terms let it train (ma-platform `mayTrain`; the owner's OpenAI and xAI accounts opt out).
 */
export function keptInfo(retentionDays: number | null): string {
  const time = retentionDays ? `for ${retentionDays} days` : 'for a limited time';
  return (
    'Nothing you send through Maia is used to train AI models. ' +
    `We keep chats ${time}, so you can come back to them and so we can read them to fix problems and improve Maia and Minimalist Alliance. ` +
    "Then they're deleted. We never keep files you attach: your chat keeps only their names."
  );
}

/** The circle's accessible name. */
export const KEPT_INFO_LABEL = 'How Maia keeps chats';
