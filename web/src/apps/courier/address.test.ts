// This desk's address (flows 1 and 2): the name's rules as the field checks them, the shared-stem note, the registry's answer
// read field by field, the fingerprint as members see it, and the invite link (whose fragment never reaches a server).
import { describe, expect, it } from 'vitest';
import { checkShape, inviteLink, linkFingerprint, linkShown, readRegistry, sharedStem, shownFingerprint, skeleton } from './address';

const FP = '3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d';

describe("the name's rules", () => {
  it('takes letters, numbers, dots and hyphens, starting with a letter, 3 to 30 long', () => {
    expect(checkShape('alex.rivers')).toBe('ok');
    expect(checkShape('Alex-Rivers2')).toBe('ok');
    expect(checkShape('ab')).toBe('length');
    expect(checkShape('a'.repeat(31))).toBe('length');
    expect(checkShape('a'.repeat(30))).toBe('ok');
    expect(checkShape('2alex')).toBe('chars');
    expect(checkShape('alex_rivers')).toBe('chars');
    expect(checkShape('alex..rivers')).toBe('chars');
    expect(checkShape('alex.-rivers')).toBe('chars');
    expect(checkShape('alex.')).toBe('chars');
    expect(checkShape('älex')).toBe('chars');
    expect(checkShape('alex rivers')).toBe('chars');
  });

  it('keeps names for the service, and their look-alikes', () => {
    for (const n of ['postmaster', 'abuse', 'admin', 'support', 'security', 'noreply', 'mailer-daemon', 'hostmaster', 'webmaster', 'root', 'info', 'officer', 'founder']) expect(checkShape(n)).toBe('reserved');
    // The contract's skeleton: `0` reads as `o`, `1` as `l`, separators drop out.
    expect(skeleton('supp0rt')).toBe('support');
    expect(checkShape('supp0rt')).toBe('reserved');
    expect(checkShape('account-security')).toBe('reserved');
    expect(checkShape('ma-support')).toBe('reserved');
    expect(checkShape('minimalistfan')).toBe('reserved');
    expect(checkShape('my.courier.box')).toBe('reserved');
    expect(checkShape('harbor')).toBe('ok');
  });
});

describe('the shared-stem note', () => {
  const others = [
    { name: 'Personal', address: { name: 'dana.ortiz', address: 'dana.ortiz@courier.example' } },
    { name: 'Guild', address: null },
  ];
  it('names the desk whose address shares a first part of 4 or more, or that the name starts with', () => {
    expect(sharedStem('dana.work', others)).toBe('Personal');
    expect(sharedStem('dana.ortiz2', others)).toBe('Personal');
    expect(sharedStem('harbor', others)).toBeNull();
    // A first part under 4 letters isn't a stem.
    expect(sharedStem('dan.work', [{ name: 'Work', address: { name: 'dan.home', address: 'dan.home@courier.example' } }])).toBeNull();
  });
});

describe("the registry's answer", () => {
  it('is read field by field: a desk without an id, a bad name or a bad domain is dropped', () => {
    const r = readRegistry({
      enabled: true,
      domain: 'courier.minimalistalliance.com',
      desks: [
        { deskId: 'd-personal1', name: 'Personal', kind: 'personal', address: { address: 'alex.rivers@courier.minimalistalliance.com', name: 'alex.rivers' }, pending: 3 },
        { deskId: 'd-work1', name: 'Work‮', kind: 'work', address: null, pending: 5000 },
        { deskId: 'bad id!', name: 'x' },
        { deskId: 'd-x', name: 'X', address: { name: '<script>' } },
      ],
    });
    expect(r?.enabled).toBe(true);
    expect(r?.desks.map((d) => d.deskId)).toEqual(['d-personal1', 'd-work1', 'd-x']);
    expect(r?.desks[0]?.address).toEqual({ name: 'alex.rivers', address: 'alex.rivers@courier.minimalistalliance.com' });
    expect(r?.desks[1]?.name).toBe('Work');
    expect(r?.desks[1]?.pending).toBe(1000);
    expect(r?.desks[2]?.address).toBeNull();
    expect(readRegistry({ enabled: true, domain: 'not a domain', desks: [] })).toBeNull();
    expect(readRegistry(null)).toBeNull();
    expect(readRegistry({ enabled: false, reason: 'paused', domain: 'courier.example', desks: [] })?.enabled).toBe(false);
  });
});

describe('the fingerprint and the link', () => {
  it('shows exactly the code the link carries, all 8 groups, nothing derived', () => {
    const g = shownFingerprint(FP);
    expect(g).toEqual(['3f2a', '91c0', '7d4e', 'b815', '0a6c', 'e2f9', '5b37', 'c41d']);
    expect(shownFingerprint('3f2a91c0')).toBeNull();
    expect(shownFingerprint('3F2A-91C0-7D4E-B815-0A6C-E2F9-5B37-C41D')).toBeNull();
    expect(shownFingerprint(null)).toBeNull();
  });

  // Security: what the member reads aloud or compares must be what the receiving desk checks. A mismatch here is a security
  // bug (the Designer's call, Nov 14), so it's held for every fingerprint shape, not one example.
  it('never shows a code other than the link’s k=', () => {
    const hex = '0123456789abcdef';
    for (let n = 0; n < 200; n += 1) {
      let fp = '';
      for (let i = 0; i < 32; i += 1) fp += (i && i % 4 === 0 ? '-' : '') + hex[Math.floor(Math.random() * 16)];
      const link = inviteLink('https://platform.example', 'alex', fp, 'Alex');
      expect(linkFingerprint(link)).toBe(fp);
      expect(shownFingerprint(fp)!.join('-')).toBe(linkFingerprint(link));
    }
    expect(linkFingerprint('https://platform.example/c/alex')).toBeNull();
    expect(linkFingerprint('https://platform.example/c/alex#k=nope')).toBeNull();
  });

  it('carries the name, the fingerprint and the display name after #, which no server ever sees', () => {
    const link = inviteLink('https://platform.minimalistalliance.com', 'alex.rivers', FP, 'Alex Rivers');
    expect(link).toBe(`https://platform.minimalistalliance.com/c/alex.rivers#k=${FP}&n=Alex%20Rivers`);
    const url = new URL(link!);
    expect(url.pathname).toBe('/c/alex.rivers');
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#k=')).toBe(true);
    expect(linkShown(link!)).toBe(`platform.minimalistalliance.com/c/alex.rivers#k=${FP}&n=Alex%20Rivers`);
    expect(inviteLink('https://platform.example', 'alex', FP, '')).toBe(`https://platform.example/c/alex#k=${FP}`);
    expect(inviteLink('https://platform.example', 'alex', FP, '&k=evil')).toBe(`https://platform.example/c/alex#k=${FP}&n=%26k%3Devil`);
    expect(inviteLink(null, 'alex', FP, 'A')).toBeNull();
    expect(inviteLink('https://platform.example', 'Bad Name', FP, 'A')).toBeNull();
    expect(inviteLink('https://platform.example', 'alex', 'nope', 'A')).toBeNull();
    expect(inviteLink('javascript:alert(1)', 'alex', FP, 'A')).toBeNull();
  });
});

describe("an invite link's Add, arriving in the office", () => {
  it('is read field by field, and dropped after 10 minutes', async () => {
    const { readInvite } = await import('./invite');
    const now = 1_000_000;
    const hash = `#courier-add=dana.ortiz&d=d-work00001&k=${FP}&n=Dana%20Ortiz`;
    expect(readInvite(`${now}${hash}`, now)).toEqual({ deskId: 'd-work00001', name: 'dana.ortiz', fingerprint: FP, displayName: 'Dana Ortiz' });
    expect(readInvite(`${now - 11 * 60_000}${hash}`, now)).toBeNull();
    expect(readInvite(`${now}#courier-add=%3Cb%3E&d=x`, now)).toBeNull();
    expect(readInvite(`${now}#courier-add=dana&d=d-1&k=nope`, now)?.fingerprint).toBeNull();
    expect(readInvite('not kept', now)).toBeNull();
    expect(readInvite(null, now)).toBeNull();
  });
});
