// Which of the office's desk links carry messages between the member's own desks (W6; deskd API.md section 18). Pure, and in the
// first load with the door (`carrierDoor.ts`): only the member's own desks, never a Guild Desk (its list row's `kind`, or a
// guild's panel, whose link is a guild token's), and nothing at all for a member who has no Agent (a teen).
import { isGuildPanel } from '../guild/panel';

export function carriedDeskIds(deskIds: Iterable<string>, desks: readonly { id: string; kind: string; removed?: boolean }[], mayHaveAgent: boolean): string[] {
  if (!mayHaveAgent) return [];
  const out: string[] = [];
  for (const id of deskIds) {
    const desk = desks.find((d) => d.id === id);
    if (desk && desk.kind !== 'guild' && !desk.removed && !isGuildPanel(id)) out.push(id);
  }
  return out;
}
