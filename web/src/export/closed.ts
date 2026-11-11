/**
 * Whether the membership has stopped in a way that gives the member the export window and the move, not the ordinary
 * desk: ended, or suspended (desks.md 0.3.64). The client can't tell a safety suspension from another; the server's
 * answer to the export `connect` decides, and a refusal shows as the desk's calm "can't be opened" line.
 */
export function closedMembership(status: string | null | undefined): boolean {
  return status === 'ended' || status === 'suspended';
}

/** The page's line under the title for a closed membership. Neutral: true for ended and suspended alike. */
export function closedLine(deleteAt: string | null): string {
  return deleteAt
    ? `Your membership isn't active. Your desks are kept until ${deleteAt}, so you can take everything with you.`
    : "Your membership isn't active. Your desks are kept for now, so you can take everything with you.";
}
