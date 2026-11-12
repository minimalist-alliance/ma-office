import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDesk, overlaps, stackOrder } from '../../canvas/layout';
import { appItemId, fitDeskToApps, rowAction, sheetState } from './fit';
import { compareVersions, parseCatalog, pickVersion } from './wire';
import { appRecord } from './store';
import { installRefusalWords, notInstallableWords, sizeWords } from './words';

const TALLY = 'org.example.tally';

describe('fitDeskToApps', () => {
  const desk = defaultDesk('d-1', 0, 0);

  it('adds a tile per installed app at the first free spot, on top, keeping a gap from everything', () => {
    const fit = fitDeskToApps(desk, [TALLY]);
    const tile = fit.items.find((i) => i.app === `app:${TALLY}`)!;
    expect(tile.id).toBe(appItemId('d-1', TALLY));
    expect(tile.id).toBe(`d-1:app:${TALLY}`);
    for (const other of desk.items) expect(overlaps(tile, other)).toBe(false);
    expect(stackOrder(fit).at(-1)).toBe(tile.id);
  });

  it('is the same object when nothing changes, and takes a removed app off', () => {
    const fit = fitDeskToApps(desk, [TALLY]);
    expect(fitDeskToApps(fit, [TALLY])).toBe(fit);
    const gone = fitDeskToApps(fit, []);
    expect(gone.items.some((i) => i.app.startsWith('app:'))).toBe(false);
    expect(gone.items.length).toBe(desk.items.length);
    expect(fitDeskToApps(desk, [])).toBe(desk);
  });
});

describe("the sheet's states, from available, installable and reason", () => {
  const base = { open: true, asleep: false, available: true, load: 'ready' as const, rows: 2, detail: false };

  it('an asleep or connecting desk, apps off, a catalog that failed, loading, nothing to add, a detail, the list', () => {
    expect(sheetState({ ...base, open: false, asleep: true })).toBe('asleep');
    expect(sheetState({ ...base, open: false })).toBe('connecting');
    expect(sheetState({ ...base, available: false })).toBe('off');
    expect(sheetState({ ...base, rows: 0, load: 'failed' })).toBe('failed');
    expect(sheetState({ ...base, rows: 0, load: 'loading' })).toBe('loading');
    expect(sheetState({ ...base, rows: 0 })).toBe('none');
    expect(sheetState({ ...base, detail: true })).toBe('detail');
    expect(sheetState(base)).toBe('list');
    // Not heard yet: the catalog decides.
    expect(sheetState({ ...base, available: null })).toBe('list');
  });

  it("a row: Open with Remove for whoever manages apps, Open alone for a guild member, Add to desk, or why it can't be added", () => {
    expect(rowAction({ installed: true, installable: true, reason: null }, true)).toEqual({ kind: 'open', remove: true });
    expect(rowAction({ installed: true, installable: true, reason: null }, false)).toEqual({ kind: 'open', remove: false });
    expect(rowAction({ installed: false, installable: true, reason: null }, true)).toEqual({ kind: 'add' });
    expect(rowAction({ installed: false, installable: true, reason: null }, false)).toEqual({ kind: 'none' });
    expect(rowAction({ installed: false, installable: false, reason: 'not_supported' }, true)).toEqual({ kind: 'why', reason: 'not_supported' });
    expect(rowAction({ installed: false, installable: null, reason: null }, true)).toEqual({ kind: 'none' });
  });

  it('every reason has plain words', () => {
    expect(notInstallableWords('app_api')).toBe('Needs a newer desk.');
    expect(notInstallableWords('not_supported')).toBe('Asks for something desks can’t give yet.');
    expect(notInstallableWords('revoked')).toBe('No longer offered.');
    expect(installRefusalWords('unavailable', 'switched_off')).toBe('Apps are off on this desk for now.');
    expect(installRefusalWords('unavailable', 'no_sandbox')).toBe('This desk can’t add apps yet.');
    expect(installRefusalWords('precondition_failed', 'no_space')).toBe('Not enough room left on this desk.');
    expect(installRefusalWords('precondition_failed', 'no_hello')).toBe('It couldn’t start, so nothing was added.');
    expect(installRefusalWords('precondition_failed', 'signature')).toBe('It didn’t pass its checks, so nothing was added.');
    expect(installRefusalWords('forbidden', 'grant', 'Captain')).toBe('Only the guild’s Captain can add apps here.');
    expect(installRefusalWords('conflict', 'busy')).toBe('Another app is being added. Try again in a moment.');
    expect(sizeWords(7_549_747)).toBe('7.2 MB');
    expect(sizeWords(300_000)).toBe('293 KB');
    expect(sizeWords(0)).toBe('');
  });
});

describe('the catalog, read leniently', () => {
  it('picks the newest version that can be added, else the newest; falls back to description for the line and the detail', () => {
    const c = parseCatalog({
      available: true,
      catalog: {
        seq: 3,
        apps: [{
          id: TALLY, name: 'Tally', publisher: 'Example', description: 'Counts things.', future: { x: 1 },
          versions: [
            { version: '0.9.0', packageSha256: 'a'.repeat(64), bytes: 10, permissions: [], installable: true },
            { version: '0.10.0', packageSha256: 'b'.repeat(64), bytes: 20, permissions: ['net'], installable: false, reason: 'not_supported' },
            { version: '0.2.0', packageSha256: 'c'.repeat(64), bytes: 30, permissions: [] },
          ],
        }, { nope: true }],
      },
    });
    expect(c.available).toBe(true);
    expect(c.apps).toHaveLength(1);
    expect(c.apps![0]).toMatchObject({ id: TALLY, line: 'Counts things.', about: 'Counts things.', bundled: false, version: { version: '0.9.0', installable: true } });
    expect(pickVersion([{ version: '1.0.0', packageSha256: '', bytes: 0, permissions: [], net: [], installable: false, reason: 'revoked' }])?.reason).toBe('revoked');
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('no catalog is null apps; revoked keys and manifests are kept where the catalog says them', () => {
    expect(parseCatalog({ available: true, catalog: null }).apps).toBeNull();
    const c = parseCatalog({ available: true, catalog: { apps: [], revoked: { keys: ['0123456789abcdef'], packages: ['f'.repeat(64)] } } });
    expect([...c.revokedKeys]).toEqual(['0123456789abcdef']);
    expect([...c.revokedManifests]).toEqual(['f'.repeat(64)]);
  });
});

describe("the contract's sample apps never reach a member", () => {
  const SAMPLE = 'com.minimalistalliance.sample.tally';
  const BIBLE = 'com.minimalistalliance.bible';
  const said = { available: true, catalog: { apps: [SAMPLE, BIBLE].map((id) => ({ id, name: id, versions: [] })) } };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a production build drops them from the catalog and from what is installed, whatever a catalog lists', () => {
    vi.stubEnv('MODE', 'production');
    expect(parseCatalog(said).apps!.map((a) => a.id)).toEqual([BIBLE]);
    expect(appRecord({ id: SAMPLE, name: 'Tally' })).toBeNull();
    expect(appRecord({ id: BIBLE, name: 'Bible' })?.id).toBe(BIBLE);
  });

  it('dev, the tests and the harness keep them, for developers', () => {
    expect(parseCatalog(said).apps!.map((a) => a.id)).toEqual([SAMPLE, BIBLE]);
    expect(appRecord({ id: SAMPLE, name: 'Tally' })?.id).toBe(SAMPLE);
  });
});
