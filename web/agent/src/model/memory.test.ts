import { describe, expect, it } from 'vitest';
import { barText, dayText, forgetBody, forgetQuestion, marked, matching, MEMORY_WORDS, searchPlaceholder, sourceText } from './memory';

const nov11 = new Date(2026, 10, 11, 9, 0).getTime();
const agents = [{ id: 'writer', name: 'Writer' }];

describe('memory words (spec 3.2)', () => {
  it('says where a line came from on today’s desk, which sends no source', () => {
    expect(dayText(nov11)).toBe('Nov 11');
    expect(sourceText({ createdAt: nov11, untrusted: false }, agents)).toBe('Saved · Nov 11');
    expect(sourceText({ createdAt: nov11, untrusted: true }, agents)).toBe('Saved after you approved · Nov 11');
  });

  it('uses the spec’s words where a desk sends a source', () => {
    expect(sourceText({ createdAt: nov11, untrusted: false, source: { kind: 'chat' } }, agents)).toBe('From your chat · Nov 11');
    expect(sourceText({ createdAt: nov11, untrusted: false, source: { kind: 'member' } }, agents)).toBe('You added it · Nov 11');
    expect(sourceText({ createdAt: 0, updatedAt: nov11, untrusted: false, source: { kind: 'edited' } }, agents)).toBe('You changed it · Nov 11');
    expect(sourceText({ createdAt: nov11, untrusted: false, source: { kind: 'timer', timerLabel: 'Morning brief' } }, agents)).toBe('From the timer Morning brief · Nov 11');
    expect(sourceText({ createdAt: nov11, untrusted: false, source: { kind: 'agent', fromAgentId: 'writer' } }, agents)).toBe('From a message from Writer · Nov 11');
    expect(sourceText({ createdAt: nov11, untrusted: false, source: { kind: 'approval' } }, agents)).toBe('Saved after you approved · Nov 11');
  });

  it('counts against the desk’s limit, and says when it’s full', () => {
    expect(barText(12, 50, 'Scout')).toBe('12 memories · up to 50');
    expect(barText(1, 50, 'Scout')).toBe('1 memory · up to 50');
    expect(barText(50, 50, 'Scout')).toBe('50 memories · full. Scout saves no more until you delete some.');
    expect(searchPlaceholder(12)).toBe('Search 12 memories');
  });

  it('makes forgetting everything honest', () => {
    expect(forgetQuestion(12, 'Scout')).toBe('Forget all 12 things Scout remembers?');
    expect(forgetBody('Scout')).toBe('Scout won’t recall any of them again. This can’t be undone. Your desk’s daily snapshots still hold them until each one expires, within 7 days.');
    expect(MEMORY_WORDS.empty('Scout')).toBe('Scout doesn’t remember anything yet. Tell it “remember …” in the chat, or it saves what helps as you talk.');
    expect(MEMORY_WORDS.none('Scout', 'desk lamp')).toBe('Nothing Scout remembers matches “desk lamp”.');
  });
});

describe('search', () => {
  it('filters case-insensitively and marks every match', () => {
    const lines = [{ text: 'Desk is 120 cm' }, { text: 'Budget $300' }, { text: 'A desk lamp for the desk' }];
    expect(matching(lines, 'DESK').map((l) => l.text)).toEqual(['Desk is 120 cm', 'A desk lamp for the desk']);
    expect(matching(lines, '  ')).toHaveLength(3);
    expect(marked('A desk lamp for the desk', 'desk')).toEqual([
      { text: 'A ', hit: false },
      { text: 'desk', hit: true },
      { text: ' lamp for the ', hit: false },
      { text: 'desk', hit: true },
    ]);
    expect(marked('Nothing', '')).toEqual([{ text: 'Nothing', hit: false }]);
  });
});
