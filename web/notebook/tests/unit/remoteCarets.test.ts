import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARET_COLORS, CARET_NAME_MAX, buildCaret, buildSelection, caretColorIndex, caretName } from '../../src/ui/remoteCarets.ts';

describe('remote caret identity', () => {
  it('the colour follows the verified member id, never a colour the client sent', () => {
    const a = caretColorIndex({ memberId: 'gm-ana1', name: 'Ana' });
    expect(caretColorIndex({ memberId: 'gm-ana1', name: 'Someone else', color: '#ff0000' } as never)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(CARET_COLORS);
  });

  it('members spread over the six colours, and a desk that sends no member id falls back to the name', () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => caretColorIndex({ memberId: `gm-member${i}` })));
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(caretColorIndex({ name: 'Bo' })).toBe(caretColorIndex({ name: 'Bo' }));
    expect(caretColorIndex({})).toBeLessThan(CARET_COLORS);
  });

  it('names are trimmed, capped, and "Member" when missing or not text', () => {
    expect(caretName({ name: '  Ana  ' })).toBe('Ana');
    expect(caretName({ name: 'x'.repeat(100) })).toHaveLength(CARET_NAME_MAX);
    expect(caretName({})).toBe('Member');
    expect(caretName({ name: 42 })).toBe('Member');
  });

  it('the selection is classed by colour index only: no colour value from the client', () => {
    expect(buildSelection({ memberId: 'gm-ana1', color: 'red; background: url(x)' })).toEqual({
      class: 'nb-remote-sel',
      'data-c': String(caretColorIndex({ memberId: 'gm-ana1' })),
    });
  });
});

describe('the caret element', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts the name in as text, never as markup', () => {
    const made: { tag: string; className?: string; textContent?: string; dataset: Record<string, string>; children: unknown[] }[] = [];
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el = {
          tag,
          dataset: {} as Record<string, string>,
          children: [] as unknown[],
          className: '',
          textContent: '',
          append(...c: unknown[]) {
            el.children.push(...c);
          },
        };
        made.push(el);
        return el;
      },
    });
    const caret = buildCaret({ name: '<img src=x onerror=alert(1)>', memberId: 'gm-ana1' }) as unknown as (typeof made)[number];
    const label = made.find((e) => e.className === 'nb-caret-label')!;
    expect(label.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(caret.className).toBe('nb-caret');
    expect(caret.dataset['c']).toBe(String(caretColorIndex({ memberId: 'gm-ana1' })));
    expect(caret.children).toContain(label);
  });
});
