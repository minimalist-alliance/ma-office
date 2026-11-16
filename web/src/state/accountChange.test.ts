// ISS-89's follow-up: a tab whose tokens become another account's (a sign-in in another tab) closes the last member's
// windows and forgets what the office kept of their desks. Here: every window at once, full-screen and closing ones too, with
// focus out of them and nothing written; the view's pointers at their desks and apps, with nothing written; and what their
// desks told the desk apps' door before the host was here. The session's own listener, which calls these and ends every
// desk's link, is `platform/session.signedOut.test.ts`; the Notebook, Files, the Browser's notes and its kept pictures each
// have their own; `tests/e2e/accountChange.shell.spec.ts` is the whole of it in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every key written to localStorage, in order. */
const writes: string[] = [];
const kept = new Map<string, string>();
const storage = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => {
    writes.push(k);
    kept.set(k, v);
  },
  removeItem: (k: string) => void kept.delete(k),
};
vi.stubGlobal('window', {
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: storage,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: number) => clearTimeout(id),
  matchMedia: () => ({ matches: false }),
});

const { closeAllWindows, openWindow, requestClose, toggleFull, useWindowStore, windowKey } = await import('./windowStore');
const { forgetDeskFocus, setView, useViewStore } = await import('./viewStore');

/** What has focus: a stand-in for an element in a window, or anywhere else. */
function focusOn(inWindow: boolean): { blur: ReturnType<typeof vi.fn> } {
  const el = { blur: vi.fn(), closest: (sel: string) => (inWindow && sel === '.window-layer' ? {} : null) };
  vi.stubGlobal('document', { activeElement: el });
  return el;
}

beforeEach(() => {
  useWindowStore.setState({ windows: {}, active: null });
  writes.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { innerWidth: 1440, innerHeight: 900, localStorage: storage, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) });
});

describe('the windows', () => {
  it('every one goes at once, full-screen, on another desk and closing ones too: none active, focus out of them, nothing written', () => {
    openWindow('d-a', 'notebook', 'd-a:notebook');
    openWindow('d-a', 'browser', 'd-a:browser');
    toggleFull(windowKey('d-a', 'browser'));
    openWindow('d-other', 'agent', 'd-other:agent');
    openWindow('d-a', 'files', 'd-a:files');
    requestClose(windowKey('d-a', 'files')); // mid-way through its close
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(4);
    writes.length = 0;
    const focused = focusOn(true);

    closeAllWindows();
    expect(useWindowStore.getState()).toEqual({ windows: {}, active: null });
    expect(focused.blur).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('focus anywhere else stays where it is', () => {
    openWindow('d-a', 'notebook', 'd-a:notebook');
    const focused = focusOn(false);
    closeAllWindows();
    expect(useWindowStore.getState().windows).toEqual({});
    expect(focused.blur).not.toHaveBeenCalled();
  });

  it('with none open, nothing changes', () => {
    const before = useWindowStore.getState();
    focusOn(true);
    closeAllWindows();
    expect(useWindowStore.getState()).toBe(before);
  });
});

describe('the view', () => {
  it("the keyboard's stop, a keyboard move, the desk menu, the hidden list and a rename go; the device's own view stays, and nothing is written", () => {
    setView({ scope: 'work', activeDesk: 'd-a', mode: 'desk' });
    setView({
      kbFocus: 'd-a:notebook',
      kbEdit: 'move',
      deskMenu: { deskId: 'd-a', itemId: 'd-a:notebook', x: 10, y: 10, fromKeyboard: true },
      hiddenList: { deskId: 'd-a', fromKeyboard: false },
      renaming: { deskId: 'd-a', fromKeyboard: true },
    });
    writes.length = 0;

    forgetDeskFocus();
    expect(useViewStore.getState()).toMatchObject({ scope: 'work', activeDesk: 'd-a', mode: 'desk', kbFocus: null, kbEdit: null, deskMenu: null, hiddenList: null, renaming: null });
    expect(writes).toEqual([]);
  });

  it('what the device keeps is still written when it changes, and only then', () => {
    setView({ scope: 'all', activeDesk: 'd-a', mode: 'overview' });
    writes.length = 0;
    setView({ kbFocus: 'd-a' });
    expect(writes).toEqual([]);
    setView({ mode: 'desk' });
    expect(writes).toEqual(['ma.view.v1']);
    // Stamped with the member it's for (ADR 0057), nobody here, since no token has said.
    expect(JSON.parse(kept.get('ma.view.v1')!)).toEqual({ scope: 'all', activeDesk: 'd-a', mode: 'desk', owner: null });
  });
});

describe("the desk apps' door", () => {
  it("what the last member's desks said before the host was here isn't handed to it; the new member's is", async () => {
    const door = await import('../deskapps/door');
    let handed: string[] = [];
    const host = { start: (_redraw: () => void, _deps: unknown, said: ReadonlyMap<string, unknown>) => void (handed = [...said.keys()]) };
    door.setHostImport(async () => host as never, async () => ({}) as never);
    door.noteApps('d-a', { available: false, reason: 'no_storage', apps: [{ id: 'com.minimalistalliance.bible', name: 'Bible' }] });
    door.forgetSaid();
    door.noteApps('d-b', { available: false, reason: 'no_storage', apps: [] });
    door.loadHost();
    await vi.waitFor(() => expect(door.useDoor.getState().host).not.toBeNull());
    expect(handed).toEqual(['d-b']);
  });
});
