export const KIT: 1;
export type Family = 'thread' | 'card' | 'desk' | 'account' | 'note';
export interface BellItem {
  id: string; type: string; title?: string; body?: string | null; link: string;
  actor?: { name: string; avatarUrl?: string } | null; count?: number;
  createdAt?: string; updatedAt?: string; readAt?: string | null;
}
export interface BellRow { id: string; title: string; second: string; time: string; unread: boolean; family: Family; link: string; hidden: boolean }
export function familyOf(type: string): Family;
export function timeLabel(at: string | number | undefined, now?: number | Date): string;
export function bellLabel(unread: number): string;
export function countLabel(unread: number): string;
export function rowOf(item: BellItem, now?: number | Date): BellRow;
export function rowsOf(items: BellItem[], now?: number | Date): BellRow[];
