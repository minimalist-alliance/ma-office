// The member's chats with Maia, for "Your chats" (ma-platform contract maia.md: `GET /v1/maia/conversations`, then
// `GET` or `DELETE /v1/maia/conversations/{id}`). /privacy promises a member can go back to a chat and delete it sooner
// than its retention (Security's maia-2): this is the list that makes that true.

export interface ChatSummary {
  conversationId: string;
  title: string;
  updatedAt: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The list from the server, newest first. Anything malformed is left out, never shown half-read. */
export function readChats(body: unknown): ChatSummary[] {
  const list = body && typeof body === 'object' ? (body as { conversations?: unknown }).conversations : undefined;
  if (!Array.isArray(list)) return [];
  const out: ChatSummary[] = [];
  for (const c of list as Record<string, unknown>[]) {
    const id = c?.['conversationId'];
    if (typeof id !== 'string' || !ID.test(id)) continue;
    const title = typeof c['title'] === 'string' ? c['title'].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const updatedAt = typeof c['updatedAt'] === 'string' ? c['updatedAt'] : typeof c['createdAt'] === 'string' ? c['createdAt'] : '';
    out.push({ conversationId: id, title, updatedAt });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** What a chat is called in the list: its title, or plainly a chat when the server has none yet. */
export const chatTitle = (c: ChatSummary): string => c.title || 'A chat with Maia';

/** The panel's line under "Your chats", with the server's days where it gives them. */
export function chatsLine(retentionDays: number | null): string {
  return retentionDays
    ? `Chats are kept ${retentionDays} days. Open one to go back to it, or delete it sooner.`
    : 'Open a chat to go back to it, or delete it.';
}

export const CHATS_EMPTY = 'No chats yet. Each chat you have with Maia shows here until it’s deleted.';
export const CHATS_LOAD_FAILED = "Couldn't reach your chats. Try again in a moment.";
export const CHAT_DELETE_FAILED = "That didn't delete. Try again in a moment.";
export const CHAT_OPEN_FAILED = "That chat couldn't be opened. It may have been deleted.";
export const CHAT_LOAD_FAILED = "That chat didn't load. Try again in a moment.";
