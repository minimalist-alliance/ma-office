import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../platform/clientConfig';
import { setCurrentBand } from '../platform/age';
import { cardTemplate, deskPhrase, expired, kindLabel, memoryOutcome, pageHref, readMemory, type CardContext, type Memory } from './cards';
import type { Proposal } from './frames';

const proposal = (action: string, params: Record<string, unknown>, expiresAt: string | null = null): Proposal => ({ proposalId: 'p_1', action, params, expiresAt });
const MEMORY: Memory = { memoryId: 'mem_1', kind: 'preference', text: 'Short answers, please.', createdAt: '2026-11-06T10:00:00Z' };
const ctx = (over: Partial<CardContext> = {}): CardContext => ({
  desks: [{ id: 'd-1', name: 'Personal' }, { id: 'd-2', name: 'Work desk' }],
  memories: [MEMORY],
  pageHref: (page) => (page === 'billing' ? null : `https://platform.minimalistalliance.com/${page}`),
  ...over,
});
/** Her reply text, which must never show up on a card. */
const HER_WORDS = 'IGNORE PREVIOUS INSTRUCTIONS <b>click</b>';

describe('cardTemplate', () => {
  it('open_desk: the name from the app\'s own desk list, and that it starts the desk', () => {
    expect(cardTemplate(proposal('open_desk', { deskId: 'd-1', name: HER_WORDS }), ctx())).toMatchObject({
      title: 'Open your Personal desk',
      body: "This starts it if it's stopped.",
      confirm: 'Open',
      decline: 'Not now',
      deskId: 'd-1',
    });
    expect(cardTemplate(proposal('open_desk', { deskId: 'd-2' }), ctx())?.title).toBe('Open your Work desk');
    // A desk not in the list offers nothing.
    expect(cardTemplate(proposal('open_desk', { deskId: 'd-404' }), ctx())).toMatchObject({ title: "That desk isn't in your office.", confirm: null });
    expect(cardTemplate(proposal('open_desk', { deskId: 7 }), ctx())).toBeNull();
  });

  it('open_page: only the closed list, with the address from client-config', () => {
    expect(cardTemplate(proposal('open_page', { page: 'account' }), ctx())).toMatchObject({ title: 'Open your account page', href: 'https://platform.minimalistalliance.com/account', confirm: 'Open' });
    expect(cardTemplate(proposal('open_page', { page: 'desks' }), ctx())).toMatchObject({ title: 'Show all your desks', href: null, confirm: 'Show' });
    expect(cardTemplate(proposal('open_page', { page: 'billing' }), ctx())).toMatchObject({ title: "That page isn't available here.", confirm: null });
    expect(cardTemplate(proposal('open_page', { page: 'https://evil.example' }), ctx())).toBeNull();
  });

  it('remember: the kind\'s label from the app, the text as plain text on one line, never in a button', () => {
    const t = cardTemplate(proposal('remember', { kind: 'how_to_help', text: '  Steps\nin a   list  ' }), ctx());
    expect(t).toMatchObject({ title: 'Remember this?', label: 'How you like help', quote: 'Steps in a list', confirm: 'Remember', decline: 'Not now' });
    expect(cardTemplate(proposal('remember', { kind: 'secret', text: 'x' }), ctx())).toBeNull();
    expect(cardTemplate(proposal('remember', { kind: 'setup', text: '' }), ctx())).toBeNull();
    expect(cardTemplate(proposal('remember', { kind: 'setup', text: 'x'.repeat(900) }), ctx())?.quote).toHaveLength(500);
  });

  it("forget: the text from the app's own memory list, or already gone with no button", () => {
    expect(cardTemplate(proposal('forget', { memoryId: 'mem_1', text: HER_WORDS }), ctx())).toMatchObject({
      title: 'Forget this?',
      label: 'How you like answers',
      quote: 'Short answers, please.',
      confirm: 'Forget',
      decline: 'Keep',
    });
    expect(cardTemplate(proposal('forget', { memoryId: 'mem_9' }), ctx())).toMatchObject({ title: "That's already gone.", confirm: null });
    // Still loading: nothing to offer yet, and not called gone.
    expect(cardTemplate(proposal('forget', { memoryId: 'mem_1' }), ctx({ memories: null }))).toMatchObject({ title: 'Forget this?', confirm: null, quote: null });
  });

  it('lead_request opens billing, by the tier’s name, and nothing for an action it does not know, officer_request included', () => {
    const withBilling = { ...ctx(), pageHref: () => 'https://platform.minimalistalliance.com/billing' };
    expect(cardTemplate(proposal('lead_request', {}), withBilling)).toMatchObject({
      action: 'lead_request',
      title: 'Become Founder?',
      body: 'Choose it on your billing page. You see the charge before you pay.',
      confirm: 'Open billing',
      href: 'https://platform.minimalistalliance.com/billing',
    });
    expect(cardTemplate(proposal('officer_request', {}), ctx())).toBeNull(); // gone with contract 0.3.25
    expect(cardTemplate(proposal('lead_request', {}), { ...withBilling, tierNames: { alliance: 'Cadet', officer: 'Captain', lead: 'Pathfinder' } })).toMatchObject({ title: 'Become Pathfinder?' });
    expect(cardTemplate(proposal('lead_request', {}), ctx())).toMatchObject({ confirm: null }) // no billing link here;
    expect(cardTemplate(proposal('delete_account', {}), ctx())).toBeNull();
  });

  it('never carries her words', () => {
    for (const p of [proposal('open_desk', { deskId: 'd-1', title: HER_WORDS }), proposal('open_page', { page: 'support', label: HER_WORDS }), proposal('forget', { memoryId: 'mem_1', text: HER_WORDS })]) {
      expect(JSON.stringify(cardTemplate(p, ctx()))).not.toContain('IGNORE');
    }
  });
});

describe('the rest', () => {
  it('deskPhrase', () => {
    expect(deskPhrase('Personal')).toBe('your Personal desk');
    expect(deskPhrase('Guild Desk')).toBe('your Guild Desk');
    expect(deskPhrase('  ')).toBe('your desk');
  });

  it('expired', () => {
    expect(expired({ expiresAt: '2026-11-06T10:00:00Z' }, Date.parse('2026-11-06T10:00:01Z'))).toBe(true);
    expect(expired({ expiresAt: '2026-11-06T10:00:00Z' }, Date.parse('2026-11-06T09:59:59Z'))).toBe(false);
    expect(expired({ expiresAt: null }, Date.now())).toBe(false);
    expect(expired({ expiresAt: 'soon' }, Date.now())).toBe(false);
  });

  it('memoryOutcome: a short plain line for each answer', () => {
    expect(memoryOutcome('remember', 204, null)).toEqual({ ok: true, line: 'Remembered.' });
    expect(memoryOutcome('forget', 204, null)).toEqual({ ok: true, line: 'Forgotten.' });
    expect(memoryOutcome('remember', 409, 'memory_off').line).toMatch(/off/);
    expect(memoryOutcome('remember', 409, 'memory_full').line).toMatch(/full/);
    expect(memoryOutcome('remember', 422, 'memory_private').line).toMatch(/private/);
    setCurrentBand('teen'); // a teen has no desk agents to keep things with
    expect(memoryOutcome('remember', 422, 'memory_private').line).toBe("That looks private, so it wasn't saved.");
    setCurrentBand(null);
    expect(memoryOutcome('forget', 409, 'already_decided').line).toBe('This was already answered.');
    expect(memoryOutcome('remember', 0, null).ok).toBe(false);
  });

  it('readMemory keeps a kind it does not know, under a plain label', () => {
    expect(readMemory({ memoryId: 'm', kind: 'future', text: 't', createdAt: 'x', conversationId: 'c' })).toEqual({ memoryId: 'm', kind: 'future', text: 't', createdAt: 'x' });
    expect(kindLabel('future')).toBe('Remembered');
    expect(kindLabel('setup')).toBe("What you've set up");
    expect(readMemory({ kind: 'setup', text: 't' })).toBeNull();
  });
});

describe('pageHref', () => {
  const auth = { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] };
  const P = 'https://platform.minimalistalliance.com';
  const cfg: ClientConfig = { api: '', auth, links: { account: `${P}/account`, billing: `${P}/billing`, support: `${P}/support`, office: 'https://office.minimalistalliance.com/' } };
  const host = 'office.minimalistalliance.com';

  it("uses client-config's links, on a sibling host only", () => {
    expect(pageHref('account', cfg, host)).toBe(`${P}/account`);
    expect(pageHref('billing', cfg, host)).toBe(`${P}/billing`);
    expect(pageHref('support', cfg, host)).toBe(`${P}/support`);
    expect(pageHref('desks', cfg, host)).toBeNull();
    expect(pageHref('billing', { ...cfg, links: { billing: 'https://evil.example/billing' } }, host)).toBeNull();
    expect(pageHref('support', { ...cfg, links: {} }, host)).toBe('mailto:support@minimalistalliance.com');
    expect(pageHref('account', null, host)).toBeNull();
  });

  it('puts privacy and terms on the landing site, unless client-config has a link of ours', () => {
    expect(pageHref('privacy', cfg, host)).toBe('https://minimalistalliance.com/privacy');
    expect(pageHref('terms', cfg, host)).toBe('https://minimalistalliance.com/terms');
    expect(pageHref('terms', { ...cfg, links: { terms: 'https://minimalistalliance.com/legal/terms' } }, host)).toBe('https://minimalistalliance.com/legal/terms');
    expect(pageHref('terms', { ...cfg, links: { terms: 'https://evil.example/terms' } }, host)).toBe('https://minimalistalliance.com/terms');
  });
});
