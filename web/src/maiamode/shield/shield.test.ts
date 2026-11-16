// The card and the catch-up as they render (the focus shield; CONCEPT.md §7.2, §6, §8): the one thing first, then the time
// choices; `{who}` as "Someone" until that desk's Courier says the name; "Held until 1:00 · Not important · Undo" after Not now;
// the first let-through's Keep and Not for this; riders with their own one thing; a polite live region, never `alert`; the catch-up's
// groups in code's order with their chips, its question and "That's all for now."; and never "urgent", "shield" or an exclamation.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readReach, type CatchUp, type ReachCard } from '../reach';
import { R } from '../words';

vi.mock('./actions', () => ({
  answerCard: () => Promise.resolve(),
  answerItem: () => Promise.resolve(),
  answerCatchup: () => Promise.resolve(),
  answerQuestion: () => Promise.resolve(),
  nameOf: () => Promise.resolve(null),
  quoteOf: () => Promise.resolve(null),
}));
// The decision tray's pieces read the desks' channels; here there are none.
vi.mock('../focusSource', () => ({ useReach: (f: (s: { reach: null }) => unknown) => f({ reach: null }), reachCall: () => Promise.resolve({}) }));
vi.mock('./trayActions', () => ({ answerPaper: () => Promise.resolve({ delivered: 'sent' }), laterPaper: () => Promise.resolve(), approvalOf: () => Promise.resolve(null) }));
// Quick reply reads the live desks (the browser's); none here.
vi.mock('./quickReply', () => ({ HOLD_MS: 5000, canOffer: () => false, openLink: () => null, MEDIUM_WORDS: { email: 'By email', ma: 'MA message', imessage: 'iMessage', sms: 'Text message' }, replyContext: () => Promise.resolve(null), replyContextCached: () => Promise.resolve({ quote: null, medium: null, accountId: null, replyTo: null, subject: null, to: [], canSend: false }), forgetReplies: () => undefined, sendReply: () => Promise.resolve(), holdSend: () => ({ undo: () => true, done: new Promise(() => undefined) }) }));
vi.mock('./Materials', () => ({ Materials: () => null }));
const { Card } = await import('./Card');
const { CatchUpPanel } = await import('./CatchUp');

const reach = readReach({
  on: true,
  line: { kind: 'held', text: '6 held · nothing urgent', held: 6 },
  card: {
    cardId: 'mc-1', itemId: 'mi-1', level: 'interrupt', kind: 'message', deskId: 'd-p', source: 'Personal · {who}', what: '{who} wrote on Personal', why: 'Rosa is on your list',
    whyMore: 'Rosa is on your list', go: { kind: 'show', deskId: 'd-p', app: 'courier', ref: 'ch-1' }, goLabel: 'Reply', choices: [{ id: 'after_this', label: 'After this' }, { id: 'in_20', label: 'In 20 min' }],
    quote: { deskId: 'd-p', channelId: 'ch-1' }, who: { deskId: 'd-p', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' },
    first: { text: 'I let this through because {who} is on your list.', choices: [{ id: 'keep', label: 'Keep' }, { id: 'not_for_this', label: 'Not for this' }] },
    after: null, at: 1, tuckAt: null,
    more: [{ itemId: 'mi-2', kind: 'approval', source: 'Work · Writer', what: 'Writer needs your OK.', why: 'Expires in 40 min', go: { kind: 'approvals', deskId: 'd-w', approvalIds: ['ap'] }, goLabel: 'Review' }],
  },
  held: { count: 6, now: 1 },
})!;
const card = reach.card as ReachCard;
const html = (c: ReachCard): string => renderToStaticMarkup(createElement(Card, { card: c, onGo: () => undefined, onChange: () => undefined }));
const buttons = (markup: string): string[] => Array.from(markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g), (m) => m[1]!);

describe('the card', () => {
  it('draws the source, what and why, the one thing first and then the time choices, and its riders', () => {
    const out = html(card);
    expect(out).toContain('Personal · Someone');
    expect(out).toContain('Someone wrote on Personal');
    expect(out).toContain('I let this through because someone is on your list.');
    expect(buttons(out)).toEqual(['Rosa is on your list', 'Keep', 'Not for this', 'Reply', 'After this', 'In 20 min', 'Review']);
    expect(out).toContain('class="sh-btn primary"');
    expect(out).toContain(R.more(1));
    expect(out).toContain('class="sh-card interrupt');
  });
  it('says itself through a polite live region, never an alert', () => {
    const out = html(card);
    expect(out).toContain('role="status" aria-live="polite"');
    expect(out).not.toContain('role="alert"');
  });
  it('after Not now: the held line and its two choices for 5 s, nothing else', () => {
    const out = html({ ...card, after: { text: 'Held until 1:00', choices: [{ id: 'not_important', label: 'Not important' }, { id: 'undo', label: 'Undo' }], until: 5 } });
    expect(out).toContain('Held until 1:00');
    expect(buttons(out)).toEqual(['Not important', 'Undo']);
    expect(out).not.toContain('Reply');
  });
  it('an offer is quiet: no interrupt weight', () => {
    expect(html({ ...card, level: 'offer' })).not.toContain('interrupt');
  });
});

const catchup: CatchUp = readReach({
  on: true,
  catchup: {
    catchupId: 'cu-1', kind: 'catchup', head: 'Your 1:00 catch-up · 5 things, nothing urgent', waiting: false, at: 1, end: 'That’s all for now.', lines: ['Cleared without you: 6 updates'],
    groups: [
      { id: 'read_later', label: 'Read later', items: [], summary: '4 updates' },
      { id: 'needs_you', label: 'Needs you', items: [{ itemId: 'mi-1', line: 'Writer needs your OK', go: { kind: 'approvals', deskId: 'd-w', approvalIds: ['ap'] }, goLabel: 'Review', choices: [{ id: 'not_important', label: 'Not important' }, { id: 'sooner', label: 'Sooner next time' }] }], summary: null },
    ],
    question: { questionId: 'tag_contact', text: 'Is {who} family, a client, or neither?', choices: [{ id: 'family', label: 'Family' }, { id: 'clients', label: 'A client' }, { id: 'neither', label: 'Neither' }] },
  },
})!.catchup!;

describe('the catch-up', () => {
  it('draws its head, the groups in code’s order with their chips, the summaries, the question and the end', () => {
    const out = renderToStaticMarkup(createElement(CatchUpPanel, { catchup, onGo: () => undefined, onClose: () => undefined }));
    expect(out.indexOf('Needs you')).toBeLessThan(out.indexOf('Read later'));
    expect(buttons(out)).toEqual([R.later, 'Review', 'Not important', 'Sooner next time', 'Family', 'A client', 'Neither']);
    expect(out).toContain('4 updates');
    // A line "label: count" reads as a tally row, its label and its count.
    expect(out).toContain('<span class="sh-tally-label">Cleared without you</span><span class="sh-summary">6 updates</span>');
    expect(out).toContain('Is someone family, a client, or neither?');
    expect(out).toContain('That’s all for now.');
  });
});

describe('the words', () => {
  it('never say shield, Maia Mode, urgent or anything with an exclamation mark', () => {
    const all = JSON.stringify(R) + [R.more(2), R.workingOn('Q3 plan'), R.remove('Rosa'), R.counts(4, 1)].join(' ');
    expect(all).not.toMatch(/shield|maia mode|urgent|important!|don.t miss|!/i);
  });
});
