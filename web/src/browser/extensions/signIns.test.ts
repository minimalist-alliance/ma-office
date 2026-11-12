import { describe, expect, it } from 'vitest';
import { firstPin, importDoneWords, importErrorWords, keyExtension, keyName, parseExtensions, pinned, pinsFor, savedWords, deleteAskWords, deletedWords, SignIns, signInsOn, withDeskPins, type DeskExtension } from './signIns';

const BW = 'nngceckbapebfimnlniiiahkandclblb';
const OP = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const PP = 'ghmbeldphafepmbegfdlkpapadhbakde';

const list = (states: Record<string, string>, open: Record<string, boolean> = {}) => ({
  extensions: [
    { id: BW, name: 'Bitwarden', state: states[BW] ?? 'missing', open: open[BW] ?? false },
    { id: OP, name: '1Password', state: states[OP] ?? 'missing', open: open[OP] ?? false },
    { id: PP, name: 'Proton Pass', state: states[PP] ?? 'missing', open: open[PP] ?? false },
  ],
});
const ext = (id: string, state: DeskExtension['state'], name = id): DeskExtension => ({ id, name, maker: null, state, open: false });
const deskError = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(code), { code, details });

describe('the desk’s list', () => {
  it('is read field by field, in the desk’s own order, with each maker by name', () => {
    expect(parseExtensions(list({ [BW]: 'installed' }, { [BW]: true }))).toEqual([
      { id: BW, name: 'Bitwarden', maker: 'Bitwarden Inc.', state: 'installed', open: true },
      { id: OP, name: '1Password', maker: 'AgileBits Inc.', state: 'missing', open: false },
      { id: PP, name: 'Proton Pass', maker: 'Proton AG', state: 'missing', open: false },
    ]);
  });
  it('leaves out anything that isn’t an extension on the desk’s allowlist as deskd says it: no id, a bad id, no name, an unknown state, a repeat', () => {
    const raw = {
      extensions: [
        { id: 'not-an-id', name: 'X', state: 'installed' },
        { id: BW, name: '', state: 'installed' },
        { id: OP, name: '1Password', state: 'enabled' },
        { id: PP, name: 'Proton Pass', state: 'off', open: true },
        { id: PP, name: 'Proton Pass again', state: 'installed' },
        null,
        'x',
      ],
    };
    expect(parseExtensions(raw)).toEqual([{ id: PP, name: 'Proton Pass', maker: 'Proton AG', state: 'off', open: false }]);
    expect(parseExtensions(null)).toEqual([]);
    expect(parseExtensions({ extensions: 'no' })).toEqual([]);
  });
  it('takes deskd’s maker when it gives one, and none for a name it doesn’t know', () => {
    const [a, b] = parseExtensions({ extensions: [{ id: BW, name: 'Bitwarden', maker: 'Someone Else', state: 'missing' }, { id: OP, name: 'Vault', state: 'missing' }] });
    expect(a?.maker).toBe('Someone Else');
    expect(b?.maker).toBeNull();
  });
});

describe('pins and the key', () => {
  const exts = [ext(BW, 'installed', 'Bitwarden'), ext(OP, 'installed', '1Password'), ext(PP, 'missing', 'Proton Pass')];
  it('are kept per desk; another desk’s stay as they came', () => {
    const raw = { d1: [BW], d2: [OP, 'junk'] };
    expect(pinsFor(raw, 'd1')).toEqual([BW]);
    expect(pinsFor(raw, 'd2')).toEqual([OP]);
    expect(pinsFor(raw, 'd3')).toBeNull();
    expect(pinsFor(undefined, 'd1')).toBeNull();
    expect(withDeskPins(raw, 'd1', [])).toEqual({ d1: [], d2: [OP, 'junk'] });
    expect(withDeskPins('odd', 'd1', [BW])).toEqual({ d1: [BW] });
  });
  it('the first manager installed is pinned, only where the member never pinned or unpinned one here', () => {
    expect(firstPin(null, exts)).toEqual([BW]);
    expect(firstPin([], exts)).toBeNull();
    expect(firstPin([OP], exts)).toBeNull();
    expect(firstPin(null, [ext(BW, 'missing'), ext(OP, 'off')])).toBeNull();
  });
  it('one password manager at a time is the key: pinning another replaces it, and unpinning leaves none', () => {
    expect(pinned([BW], OP, true, exts)).toEqual([OP]);
    expect(pinned([BW], BW, false, exts)).toEqual([]);
    expect(pinned(null, BW, true, exts)).toEqual([BW]);
  });
  it('the key is the first pinned manager that’s installed; with none, "Passwords"', () => {
    expect(keyExtension(exts, [OP])?.id).toBe(OP);
    expect(keyExtension(exts, [PP])).toBeNull();
    expect(keyExtension(exts, null)).toBeNull();
    expect(keyName(keyExtension(exts, [BW]))).toBe('Bitwarden, password manager');
    expect(keyName(null)).toBe('Passwords');
  });
});

describe('the words', () => {
  it('say what the import did, in the spec’s words, never a site or a name', () => {
    expect(importDoneWords({ added: 42, alreadySaved: 3, refused: 0 })).toBe('Added 42 passwords to this desk’s Browser. 3 were already here.');
    expect(importDoneWords({ added: 1, alreadySaved: 1 })).toBe('Added 1 password to this desk’s Browser. 1 was already here.');
    expect(importDoneWords({ added: 5, alreadySaved: 0, refused: 2 })).toBe('Added 5 passwords to this desk’s Browser. 2 couldn’t be added.');
  });
  it('say why an import didn’t go', () => {
    expect(importErrorWords(deskError('bad_request', { reason: 'format' }))).toBe('That file isn’t a passwords export. Choose the CSV your browser saved.');
    expect(importErrorWords(deskError('too_large', { limit: 1 }))).toBe('That file is too big to be a passwords export.');
    expect(importErrorWords(deskError('conflict', { reason: 'busy' }))).toBe('Another of your sessions is importing passwords. Try again in a minute.');
    expect(importErrorWords(deskError('unavailable', { reason: 'chromium' }))).toBe('Your desk couldn’t add the passwords. Try again in a moment.');
    expect(importErrorWords(new Error('gone'))).toBe('Your desk couldn’t add the passwords. Try again in a moment.');
  });
  it('count the saved passwords for Stop', () => {
    expect(savedWords(12)).toBe('12 passwords are saved in this desk’s Browser.');
    expect(savedWords(1)).toBe('1 password is saved in this desk’s Browser.');
    expect(deleteAskWords(12)).toBe('Delete 12 saved passwords from this desk’s Browser?');
    expect(deletedWords(12)).toBe('Deleted 12 passwords.');
  });
});

describe('the kill switch', () => {
  it('absent is on; enabled: false is off', () => {
    expect(signInsOn(null)).toBe(true);
    expect(signInsOn({ api: 'x', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] } })).toBe(true);
    expect(signInsOn({ api: 'x', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] }, siteSignIns: { enabled: false } })).toBe(false);
  });
});

/** A link answering each method from a queue, and a clock the test moves. */
function rig(answers: Record<string, Array<unknown | Error>>) {
  const calls: { m: string; idem?: string }[] = [];
  const link = {
    call: (m: string, _p?: Record<string, unknown>, o?: { idem?: string }) => {
      calls.push({ m, idem: o?.idem });
      const q = answers[m] ?? [];
      const next = q.length > 1 ? q.shift() : q[0];
      if (next === undefined) return Promise.reject(deskError('not_found'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  const due = new Map<number, () => void>();
  let next = 0;
  const timers = {
    set: (fn: () => void) => {
      next += 1;
      due.set(next, fn);
      return next;
    },
    clear: (t: unknown) => void due.delete(t as number),
  };
  const store = new SignIns(timers);
  const tick = async (): Promise<void> => {
    const now = [...due.values()];
    due.clear();
    for (const fn of now) fn();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { store, link: link as never, calls, tick };
}

describe('the store', () => {
  it('shows nothing until the desk answers the list; then the list, and Stop only where the count is served', async () => {
    const r = rig({ 'browser.extensions.list': [list({ [BW]: 'installed' })] });
    r.store.setLink(r.link);
    expect(r.store.get().served).toBe(false);
    r.store.newSession();
    await r.tick();
    expect(r.store.get().served).toBe(true);
    expect(r.store.get().exts.map((e) => e.state)).toEqual(['installed', 'missing', 'missing']);
    expect(r.store.get().saved).toBeNull();
    expect(r.calls.map((c) => c.m)).toEqual(['browser.extensions.list', 'browser.passwords.count']);
  });

  it('a deskd before sign-ins (not_found) hides it all, and asks nothing more until a new session', async () => {
    const r = rig({});
    r.store.setLink(r.link);
    r.store.newSession();
    await r.tick();
    expect(r.store.get().served).toBe(false);
    r.store.refresh();
    await r.tick();
    expect(r.calls.map((c) => c.m)).toEqual(['browser.extensions.list']);
    r.store.newSession();
    await r.tick();
    expect(r.calls).toHaveLength(2);
  });

  it('a desk that says forbidden (a teen’s, or an unknown band) hides it all', async () => {
    const r = rig({ 'browser.extensions.list': [deskError('forbidden', { reason: 'age_band' })] });
    r.store.setLink(r.link);
    r.store.newSession();
    await r.tick();
    expect(r.store.get().served).toBe(false);
  });

  it('Chromium starting (unavailable) keeps what was said, and the next change asks again', async () => {
    const r = rig({ 'browser.extensions.list': [list({}), deskError('unavailable', { reason: 'chromium' }), list({ [OP]: 'installed' })] });
    r.store.setLink(r.link);
    r.store.newSession();
    await r.tick();
    r.store.refresh();
    await r.tick();
    expect(r.store.get().served).toBe(true);
    expect(r.store.get().exts.every((e) => e.state === 'missing')).toBe(true);
    r.store.refresh();
    await r.tick();
    expect(r.store.get().exts[1]?.state).toBe('installed');
  });

  it('a burst of tab changes asks once', async () => {
    const r = rig({ 'browser.extensions.list': [list({})], 'browser.passwords.count': [deskError('not_found')] });
    r.store.setLink(r.link);
    r.store.refresh();
    r.store.refresh();
    r.store.refresh();
    await r.tick();
    expect(r.calls.filter((c) => c.m === 'browser.extensions.list')).toHaveLength(1);
  });

  it('the key opens an installed manager’s page and closes it, each a mutation with its own key, then asks the list again', async () => {
    const r = rig({ 'browser.extensions.list': [list({ [BW]: 'installed' })], 'browser.extension.open': [{ tabId: 'x', page: 'extension' }], 'browser.extension.close': [{ closed: 1 }] });
    r.store.setLink(r.link);
    r.store.newSession();
    await r.tick();
    expect(await r.store.open(BW)).toBe('extension');
    expect(r.store.get().exts[0]?.open).toBe(true);
    await r.store.close(BW);
    expect(r.store.get().exts[0]?.open).toBe(false);
    const muts = r.calls.filter((c) => c.m.startsWith('browser.extension.'));
    expect(muts.map((c) => c.m)).toEqual(['browser.extension.open', 'browser.extension.close']);
    expect(muts.every((c) => typeof c.idem === 'string' && c.idem.length === 36)).toBe(true);
    expect(muts[0]?.idem).not.toBe(muts[1]?.idem);
  });

  it('adding a missing one is its Web Store page on the desk, the member’s own click there', async () => {
    const r = rig({ 'browser.extensions.list': [list({})], 'browser.extension.open': [{ tabId: 's', page: 'store' }] });
    r.store.setLink(r.link);
    r.store.newSession();
    await r.tick();
    expect(await r.store.open(PP)).toBe('store');
    expect(r.store.get().exts[2]?.open).toBe(false);
  });

  it('no link (the kill switch, a teen) is nothing at all', async () => {
    const r = rig({ 'browser.extensions.list': [list({})] });
    r.store.setLink(r.link);
    r.store.newSession();
    await r.tick();
    r.store.setLink(null);
    expect(r.store.get()).toEqual({ served: false, exts: [], saved: null, busy: false });
    r.store.refresh();
    await r.tick();
    expect(r.calls.filter((c) => c.m === 'browser.extensions.list')).toHaveLength(1);
  });
});

describe('after "Add to this desk"', () => {
  it('asks the list every 2 s until that manager is in, then stops; and gives up after 3 minutes', async () => {
    let now = 0;
    const calls: string[] = [];
    let installed = false;
    const link = {
      call: (m: string) => {
        calls.push(m);
        if (m === 'browser.extensions.list') return Promise.resolve(list(installed ? { [BW]: 'installed' } : {}));
        return Promise.reject(deskError('not_found'));
      },
    };
    const due = new Map<number, { fn: () => void; at: number }>();
    let seq = 0;
    const timers = {
      set: (fn: () => void, ms: number) => {
        seq += 1;
        due.set(seq, { fn, at: now + ms });
        return seq;
      },
      clear: (t: unknown) => void due.delete(t as number),
    };
    const advance = async (ms: number): Promise<void> => {
      now += ms;
      for (const [id, t] of [...due]) {
        if (t.at <= now) {
          due.delete(id);
          t.fn();
        }
      }
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };
    const store = new SignIns(timers, () => now);
    store.setLink(link as never);
    store.watchInstall(BW);
    await advance(2_000);
    await advance(2_000);
    const lists = (): number => calls.filter((c) => c === 'browser.extensions.list').length;
    expect(lists()).toBe(2);
    installed = true;
    await advance(2_000);
    expect(store.get().exts[0]?.state).toBe('installed');
    await advance(2_000);
    await advance(2_000);
    expect(lists()).toBe(3);
    // Never installed: it stops on its own.
    installed = false;
    const other = new SignIns(timers, () => now);
    other.setLink(link as never);
    other.watchInstall(OP);
    const before = lists();
    for (let i = 0; i < 100; i += 1) await advance(2_000);
    expect(lists() - before).toBe(90);
  });
});
