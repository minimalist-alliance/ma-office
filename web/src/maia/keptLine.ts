// The Maia panel's second line (the owner, Nov 9): how long chats are kept, that they pass through us, and, where the member
// has desk agents, where private things go. The days are the server's `retentionDays`, never a number of our own.
export function keptLine(retentionDays: number | null, agents: boolean): string {
  const kept = retentionDays ? `Chats are kept ${retentionDays} days and pass through us` : 'Chats pass through us';
  return agents ? `${kept}, so keep private things with your desk agents.` : `${kept}.`;
}
