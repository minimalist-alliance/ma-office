import { describe, expect, it } from 'vitest';
import { click, EMPTY_SEL, follow, move, reconcile, selectAll, toggleActive, typeAhead } from './selection';

const rows = ['Alpha', 'alps', 'Beta', 'Gamma', 'Delta'].map((name) => ({ key: name, name }));

describe('selection', () => {
  it('a click selects one row, Ctrl toggles, Shift selects the range from the anchor', () => {
    let s = click(rows, EMPTY_SEL, 1);
    expect(s.keys).toEqual(['alps']);
    s = click(rows, s, 3, { shift: true });
    expect(s.keys).toEqual(['alps', 'Beta', 'Gamma']);
    expect(s.anchor).toBe(1);
    s = click(rows, s, 0, { ctrl: true });
    expect(s.keys).toEqual(['alps', 'Beta', 'Gamma', 'Alpha']);
    s = click(rows, s, 2, { ctrl: true });
    expect(s.keys).toEqual(['alps', 'Gamma', 'Alpha']);
  });

  it('arrows move and select, Shift extends, Ctrl moves without selecting, and the ends hold', () => {
    let s = move(rows, EMPTY_SEL, 0);
    expect(s).toEqual({ keys: ['Alpha'], active: 0, anchor: 0 });
    s = move(rows, s, 1, { shift: true });
    s = move(rows, s, 2, { shift: true });
    expect(s.keys).toEqual(['Alpha', 'alps', 'Beta']);
    s = move(rows, s, 4, { ctrl: true });
    expect(s.keys).toEqual(['Alpha', 'alps', 'Beta']);
    expect(s.active).toBe(4);
    expect(move(rows, s, 99).active).toBe(4);
    expect(move(rows, s, -3).active).toBe(0);
    s = toggleActive(rows, s);
    expect(s.keys).toContain('Delta');
  });

  it('select all, and reconciling after the rows change', () => {
    const all = selectAll(rows, EMPTY_SEL);
    expect(all.keys).toHaveLength(5);
    const fewer = rows.filter((r) => r.key !== 'Beta');
    const s = reconcile(fewer, { keys: ['Beta', 'Gamma'], active: 2, anchor: 2 }, 'Beta');
    expect(s.keys).toEqual(['Gamma']);
    expect(s.active).toBe(2);
    expect(reconcile([], all, null)).toEqual(EMPTY_SEL);
    // A list that loads under a keyboard with no place leaves it without one: the first arrow goes to the first row.
    expect(reconcile(rows, EMPTY_SEL, null)).toBe(EMPTY_SEL);
  });

  it('type-ahead finds the next name that starts with what was typed, wrapping, cycling on a repeated letter', () => {
    expect(typeAhead(rows, 0, 'b')).toBe(2);
    expect(typeAhead(rows, 4, 'a')).toBe(0);
    expect(typeAhead(rows, 0, 'a')).toBe(1);
    expect(typeAhead(rows, 1, 'a')).toBe(0);
    expect(typeAhead(rows, 0, 'alp')).toBe(0);
    expect(typeAhead(rows, 0, 'alps')).toBe(1);
    expect(typeAhead(rows, 0, 'zzz')).toBe(-1);
  });

  it('a rename moves the selection to the new key, and a row not selected is left alone', () => {
    const s = follow({ keys: ['Beta'], active: 2, anchor: 2 }, 'Beta', 'Zeta');
    expect(s.keys).toEqual(['Zeta']);
    const after = rows.map((r) => (r.key === 'Beta' ? { key: 'Zeta', name: 'Zeta' } : r));
    expect(reconcile(after, s, 'Zeta').keys).toEqual(['Zeta']);
    const other = { keys: ['Gamma'], active: 3, anchor: 3 };
    expect(follow(other, 'Beta', 'Zeta')).toBe(other);
  });
});
