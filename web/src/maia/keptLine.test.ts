import { describe, expect, it } from 'vitest';
import { keptInfo, keptLine, keptParts } from './keptLine';

describe('keptLine', () => {
  it('says the server\'s days, and points to desk agents where there are some', () => {
    expect(keptLine(30, true)).toBe('Chats are kept 30 days and pass through us, so keep private things with your desk agents.');
    expect(keptLine(14, false)).toBe('Chats are kept 14 days and pass through us.');
  });
  it('names no number when the server gives none', () => {
    expect(keptLine(null, true)).toBe('Chats pass through us, so keep private things with your desk agents.');
    expect(keptLine(null, false)).toBe('Chats pass through us.');
  });
  it('splits right after "pass through us", where the info circle goes, and the two halves are the line', () => {
    for (const days of [30, 7, null]) {
      for (const agents of [true, false]) {
        const { lead, tail } = keptParts(days, agents);
        expect(lead.endsWith('pass through us')).toBe(true);
        expect(lead + tail).toBe(keptLine(days, agents));
      }
    }
  });
});

describe('keptInfo', () => {
  it('says nothing trains a model, the same days as the line, why they are kept, and that files are not kept', () => {
    expect(keptInfo(30)).toBe(
      "Nothing you send through Maia is used to train AI models. We keep chats for 30 days, so you can come back to them and so we can read them to fix problems and improve Maia and Minimalist Alliance. Then they're deleted. We never keep files you attach: your chat keeps only their names.",
    );
    expect(keptInfo(14)).toContain('for 14 days');
  });
  it('names no number when the server gives none', () => {
    expect(keptInfo(null)).toContain('We keep chats for a limited time,');
    expect(keptInfo(null)).not.toMatch(/\d/);
  });
  it('names no provider or model', () => {
    for (const days of [30, null]) expect(keptInfo(days)).not.toMatch(/anthropic|claude|openai|gpt|xai|grok|moonshot|kimi|gemma|llama/i);
  });
});
