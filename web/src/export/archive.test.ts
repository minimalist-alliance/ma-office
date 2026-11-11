import { describe, expect, it } from 'vitest';
import { setCurrentBand } from '../platform/age';
import { accountFiles, archiveOrder, deskFolders, exportFileName, folderName, partLabel, readme, safePath } from './archive';

describe('the archive layout', () => {
  it('names the file by the date', () => {
    expect(exportFileName(new Date(2026, 10, 6, 23, 59))).toBe('minimalist-alliance-export-2026-11-06.zip');
  });

  it("makes a desk's name a folder any computer can make", () => {
    expect(folderName('Personal', 'd-1')).toBe('Personal');
    expect(folderName('  Work / Home: "notes"?  ', 'd-1')).toBe('Work - Home- -notes--');
    expect(folderName('..', 'd-1')).toBe('d-1');
    expect(folderName('Trip.  ', 'd-1')).toBe('Trip');
    expect(folderName('CON', 'd-1')).toBe('CON desk');
    expect([...folderName('é'.repeat(80), 'd-1')]).toHaveLength(64);
  });

  it('gives two desks with one name two folders', () => {
    const f = deskFolders([
      { deskId: 'a', name: 'Personal' },
      { deskId: 'b', name: 'personal' },
      { deskId: 'c', name: 'Personal' },
    ]);
    expect([...f.values()]).toEqual(['Personal', 'personal (2)', 'Personal (3)']);
  });

  it('refuses a path that could climb out of its folder', () => {
    expect(safePath('profile/Default/Cookies')).toBe('profile/Default/Cookies');
    expect(safePath('Café notes.json')).toBe('Café notes.json');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\..\\b', 'a\0b', 'a/']) expect(safePath(bad)).toBeNull();
  });

  it('lists the README, then the manifest, the account and the desks', () => {
    const names = ['desks/P/files/a', 'manifest.json', 'account/desks.json', 'README.txt', 'account/account.json'];
    expect([...names].sort(archiveOrder)).toEqual(['README.txt', 'manifest.json', 'account/desks.json', 'account/account.json', 'desks/P/files/a']);
  });

  it("writes the account's five files, with null for anything missing", () => {
    const files = accountFiles({ account: { email: 'a@example.org' }, membership: { status: 'ended' }, billingHistory: [], desks: [] });
    expect(files.map(([n]) => n)).toEqual(['account/account.json', 'account/membership.json', 'account/billing-history.json', 'account/maia-memories.json', 'account/desks.json']);
    expect(JSON.parse(files[0]![1])).toEqual({ email: 'a@example.org' });
    expect(files[3]![1]).toBe('null\n');
  });

  it('adds the newer account files only when the platform sends them, and the README lists those', () => {
    const base = accountFiles({ account: {}, desks: [] }).map(([n]) => n);
    expect(base).toHaveLength(5);
    const exp = {
      account: { email: 'a@example.org', activity: [{ at: 't', action: 'sign_out' }], signInFactors: { available: true, phone: '+15555550100' } },
      desks: [],
      maiaChats: { available: true, items: [] },
      supportTickets: { available: true, items: [] },
      formatVersion: 1,
      generatedAt: 'x',
    };
    const more = accountFiles(exp);
    expect(more.map(([n]) => n)).toEqual([...base, 'account/maia-chats.json', 'account/activity-log.json', 'account/support-tickets.json', 'account/sign-in-factors.json']);
    // The nested sections move out of account.json, once.
    expect(JSON.parse(more[0]![1])).toEqual({ email: 'a@example.org' });
    expect(JSON.parse(more[6]![1])).toEqual([{ at: 't', action: 'sign_out' }]);
    expect(JSON.parse(more[8]![1])).toEqual({ available: true, phone: '+15555550100' });
    expect(more.map(([, t]) => t).join('').split('+15555550100')).toHaveLength(2);
    const text = readme({ madeAt: new Date(2026, 10, 6), desks: ['Personal'], notCopied: 0, accountNames: more.map(([n]) => n) });
    for (const f of ['maia-chats.json', 'activity-log.json', 'support-tickets.json', 'sign-in-factors.json']) expect(text).toContain(f);
    expect(readme({ madeAt: new Date(2026, 10, 6), desks: ['Personal'], notCopied: 0, accountNames: base })).not.toContain('maia-chats.json');
  });

  it('README says how a protected download is built and opened, only for one', () => {
    const plain = readme({ madeAt: new Date(2026, 10, 6), desks: [], notCopied: 0 });
    expect(plain).not.toContain('PASSPHRASE');
    const text = readme({ madeAt: new Date(2026, 10, 6), desks: [], notCopied: 0, encrypted: true });
    for (const w of ['THE PASSPHRASE', '.zip.enc', 'PBKDF2-HMAC-SHA-256', 'AES-256-GCM', 'MAEXPORT', 'decrypt.mjs', 'cannot recover']) expect(text).toContain(w);
    expect(text).not.toMatch(/!/);
  });

  it('README says what is where, plainly, says cloud and no provider, and points at bookmarks.html, history.csv and manifest.json', () => {
    const text = readme({ madeAt: new Date(2026, 10, 6), desks: ['Personal', 'Work'], notCopied: 2, incomplete: ["Work: the download isn't available on this desk yet."] });
    expect(text).toContain('Made on November 6, 2026, from your account and these desks: Personal, Work.');
    expect(text).toContain('Your desks sent their files straight to you, encrypted. If your connection needed our relay,');
    expect(text).not.toContain('our servers');
    expect(text).toContain('keep this file somewhere safe');
    for (const word of ['account/', 'browser/', 'browser-readable/', 'bookmarks.html', 'history.csv', 'manifest.json', 'SHA-256', 'cloud', '2 files couldn\'t be copied', 'Work: the download']) expect(text).toContain(word);
    expect(text).not.toMatch(/AWS|Amazon|EC2|S3|!/);
    expect(readme({ madeAt: new Date(2026, 10, 6), desks: [], notCopied: 0 })).not.toContain('notCopied');
  });

  it('puts Notebook in notebook/, its own folder, and desk/ holds settings and Chat (Security NE-3)', () => {
    const text = readme({ madeAt: new Date(2026, 10, 6), desks: ['Personal'], notCopied: 0 });
    expect(text).toContain('  desk/                  Desk settings and Chat.');
    expect(text).toContain('  notebook/              Your Notebook.');
    expect(text).not.toMatch(/desk\/ .*Notebook/);
    expect(partLabel('desk')).toBe('Desk settings and Chat');
    expect(partLabel('notebook')).toBe('Notebook');
  });

  it('says agent/keys holds working AI keys, to keep the file safe, and to revoke them at the provider if it is lost (ADR 0042)', () => {
    const text = readme({ madeAt: new Date(2026, 10, 6), desks: ['Personal'], notCopied: 0 });
    expect(text).toContain('YOUR AI KEYS');
    expect(text).toContain("agent/keys/ in each desk's folder holds the AI keys you added to that desk, and they work:");
    expect(text).toContain('anyone with this file can use them. Keep it somewhere safe. If you lose it, revoke those');
    expect(text).toContain('keys at their provider and add new ones to your desks.');
    expect(text.indexOf('YOUR AI KEYS')).toBeGreaterThan(text.indexOf('YOUR BROWSER PROFILE'));
    expect(text.indexOf('YOUR AI KEYS')).toBeLessThan(text.indexOf('CHECKING THE FILES'));
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(94);
  });
});

describe('the README for a teen', () => {
  const made = { madeAt: new Date(2026, 10, 6), desks: ['Personal'], notCopied: 0 };

  it('has no line for the Agent, and everyone else keeps theirs', () => {
    try {
      setCurrentBand('teen');
      expect(readme(made)).not.toMatch(/agent/i);
      expect(readme(made)).not.toMatch(/AI keys/i);
      setCurrentBand('adult');
      expect(readme(made)).toContain('agent/                 The Agent.');
      expect(readme(made)).toContain('YOUR AI KEYS');
      setCurrentBand(null);
      expect(readme(made)).toContain('agent/                 The Agent.');
      expect(readme(made)).toContain('YOUR AI KEYS');
    } finally {
      setCurrentBand(null);
    }
  });
});
