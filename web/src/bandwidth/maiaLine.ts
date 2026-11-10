// The one quiet line about Maia under the bandwidth numbers (contract maia.md, `GET /v1/maia/state`). A share of the
// person's own month, never money. No line when she isn't open to the member.
import type { MaiaState } from '../maia/gate';
import { formatReset, type Clock } from './meter';

export function maiaLine(s: MaiaState | null, c: Clock): string | null {
  if (!s) return null;
  if (s.limited) {
    if (s.free) return "Maia: this month's allowance is used. She keeps answering on free Maia.";
    return s.resetsAt ? `Maia: this month's allowance is used. It resets ${formatReset(s.resetsAt, c)}.` : "Maia: this month's allowance is used.";
  }
  if (!s.enabled || s.usedFraction === null) return null;
  if (s.usedFraction <= 0) return "Maia: none of this month's allowance used yet";
  const n = Math.floor(s.usedFraction * 100 + 1e-9);
  return n < 1 ? "Maia: under 1% of this month's allowance used" : `Maia: ${n}% of this month's allowance used`;
}
