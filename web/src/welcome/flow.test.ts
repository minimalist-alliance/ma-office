import { describe, expect, it } from 'vitest';
import { QUESTIONS, templateEcho } from './catalogue';
import { captionLines, dots, fillSteps, nextQuestion, offerWrapUp, onlyKnown, pickAck, questionSet, readMs, resolved, skipped, stepsTaken, toggle, type Who } from './flow';

const adult: Who = { teen: false, tier: 'alliance', maia: false, shield: false, rename: false, courier: false };
const officer: Who = { ...adult, tier: 'officer', maia: true, rename: true };

describe('who gets which questions (§4.2 "Counts")', () => {
  it('gives Free and Alliance the four that change something', () => {
    expect(questionSet(adult)).toEqual(['q1', 'q2', 'q3', 'q7']);
  });
  it('gives Maia tiers Q5 and Q8, and Q4 and Q6 only once the shield exists (the honesty rule)', () => {
    expect(questionSet(officer)).toEqual(['q1', 'q2', 'q3', 'q5', 'q7', 'q8']);
    expect(questionSet({ ...officer, shield: true })).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']);
  });
  it('gives teens the light and their own question, nothing else', () => {
    expect(questionSet({ ...officer, teen: true })).toEqual(['q1', 't2']);
  });
});

describe('the next question', () => {
  const set = questionSet({ ...officer, shield: true });
  it('keeps Q1 to Q3 first whatever the model picks', () => {
    expect(nextQuestion(set, {}, 'q8')).toBe('q1');
    expect(nextQuestion(set, { q1: { q: 'q1', choices: ['zen'], text: null } }, 'q8')).toBe('q2');
  });
  it('takes the model pick among the rest only when it is open and in the set', () => {
    const a = Object.fromEntries(['q1', 'q2', 'q3'].map((q) => [q, { q, choices: [], text: null }]));
    expect(nextQuestion(set, a, 'q6')).toBe('q6');
    expect(nextQuestion(set, a, 'q9')).toBe('q4');
    expect(nextQuestion(set, a, 'q1')).toBe('q4');
    expect(nextQuestion(questionSet(adult), a, 'q8')).toBe('q7');
  });
  it('is null once every question has an answer', () => {
    const all = Object.fromEntries(set.map((q) => [q, { q, choices: [], text: null }]));
    expect(nextQuestion(set, all)).toBeNull();
  });
});

describe('taps', () => {
  it('replaces on a single choice, toggles on a multi', () => {
    expect(toggle('q5', ['three'], 'two')).toEqual(['two']);
    expect(toggle('q2', ['email'], 'code')).toEqual(['email', 'code']);
    expect(toggle('q2', ['email', 'code'], 'email')).toEqual(['code']);
  });
  it('holds the max of three helpers', () => {
    expect(toggle('q3', ['sorting', 'research', 'drafts'], 'todos')).toEqual(['sorting', 'research', 'drafts']);
  });
  it('lets an "only" choice clear the rest, and another clear it', () => {
    expect(toggle('q8', ['notes', 'drafts'], 'ask')).toEqual(['ask']);
    expect(toggle('q8', ['ask'], 'notes')).toEqual(['notes']);
    expect(toggle('q6', ['mornings'], 'none')).toEqual(['none']);
  });
  it('keeps only the question’s own ids, in its order', () => {
    expect(onlyKnown('q2', ['code', 'nope', 'email', '<b>'])).toEqual(['email', 'code']);
  });
});

describe('Skip and defaults (§4.2)', () => {
  it('applies each question’s default', () => {
    expect(skipped('q1').choices).toEqual(['zen']);
    expect(skipped('q4').choices).toEqual(['due', 'bills']);
    expect(skipped('q8').choices).toEqual(['ask']);
    expect(skipped('q3').choices).toEqual([]);
  });
  it('resolves a question never reached to its default, and a typed answer to its placed ids', () => {
    const set = questionSet({ ...officer, shield: true });
    const r = resolved(set, { q2: { q: 'q2', choices: ['writing'], text: 'grants' }, q7: { q: 'q7', choices: [], text: 'short please' } });
    expect(r.q2).toEqual(['writing']);
    expect(r.q5).toEqual(['three']);
    expect(r.q7).toEqual([]);
  });
});

describe('fill steps (§4.3)', () => {
  it('names (Officer, two desks), the list, which email (Courier on and email said), then a breath', () => {
    expect(fillSteps({ ...officer, courier: true }, 2, true, [])).toEqual(['names', 'todos', 'email', 'breath']);
    expect(fillSteps(officer, 2, true, [])).toEqual(['names', 'todos', 'breath']);
    expect(fillSteps(adult, 1, false, [])).toEqual(['todos', 'breath']);
    expect(fillSteps({ ...officer, teen: true }, 2, true, ['todos'])).toEqual(['breath']);
  });
  it('caps everything at 10 steps', () => {
    const a = Object.fromEntries(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'f1'].map((q) => [q, { q, choices: [], text: null }]));
    expect(stepsTaken(a, ['names'])).toBe(10);
  });
});

describe('the rest of the rules', () => {
  it('offers Wrap up only with every desk ready and 3 or more core questions left', () => {
    const set = questionSet(officer);
    expect(offerWrapUp(set, { q1: { q: 'q1', choices: [], text: null } }, true)).toBe(true);
    expect(offerWrapUp(set, { q1: { q: 'q1', choices: [], text: null } }, false)).toBe(false);
  });
  it('never uses the same acknowledgement twice in a row', () => {
    expect(pickAck('lovely', 'lovely', ['got_it', 'lovely', 'okay'], 0)).not.toBe('lovely');
    expect(pickAck('okay', 'lovely', ['got_it', 'lovely', 'okay'], 0)).toBe('okay');
    expect(pickAck('weird', null, ['got_it', 'okay', 'noted'], 4)).toMatch(/got_it|okay|noted/);
  });
  it('holds a line at least 1.5 s, 20 characters a second for adults and 17 for teens', () => {
    expect(readMs('Okay.', false)).toBe(1500);
    expect(readMs('x'.repeat(60), false)).toBe(3000);
    expect(readMs('x'.repeat(51), true)).toBe(3000);
  });
  it('breaks a caption into two lines of 42 characters at most', () => {
    const lines = captionLines('While your desks get ready, a few quick questions.');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
  });
  it('counts the soft dots with the follow-ups asked', () => {
    expect(dots(['q1', 'q2'], { q1: { q: 'q1', choices: [], text: null } }, 'f1')).toEqual({ total: 3, at: 1 });
  });
  it('echoes chips as one plain line', () => {
    expect(templateEcho(['Writing', 'Meetings'])).toBe('Writing and meetings.');
    expect(templateEcho([])).toBeNull();
  });
});

describe('the catalogue (§3, §4)', () => {
  it('fits every fixed line in 2 caption lines and says no "Maia Mode"', () => {
    for (const q of Object.values(QUESTIONS)) {
      for (const t of [q.say, q.why, ...q.choices.map((c) => c.label)]) {
        expect(t.length).toBeLessThanOrEqual(84);
        expect(t).not.toMatch(/maia mode|!/i);
      }
    }
  });
  it('offers 3 to 6 choices a question', () => {
    for (const q of Object.values(QUESTIONS)) expect(q.choices.length).toBeGreaterThanOrEqual(3);
    for (const q of Object.values(QUESTIONS)) expect(q.choices.length).toBeLessThanOrEqual(6);
  });
});
