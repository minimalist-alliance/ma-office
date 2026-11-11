import { describe, expect, it } from 'vitest';
import { closedLine, closedMembership } from './closed';

describe('closedMembership', () => {
  it('is true for ended and suspended, and nothing else', () => {
    expect(closedMembership('ended')).toBe(true);
    expect(closedMembership('suspended')).toBe(true);
    for (const s of ['active', 'past_due', 'canceling', 'closed', 'unpaid', '', null, undefined]) expect(closedMembership(s)).toBe(false);
  });
  it('words the line the same for both, never saying ended or suspended', () => {
    expect(closedLine('Dec 1, 2026')).toBe("Your membership isn't active. Your desks are kept until Dec 1, 2026, so you can take everything with you.");
    expect(closedLine(null)).not.toMatch(/ended|suspend|30 days/i);
  });
});
