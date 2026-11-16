// The account menu's "Keyboard shortcuts" (`AccountPanel.tsx`): every key the office answers to, in a modal over the menu
// (the owner, Nov 16: "Configs and options should be tucked in expansions or modals"; a long list suits a modal), and the
// browser's install offer at its foot. A native <dialog> opened with showModal(), so it's in the top layer whatever the menu's
// box does, the rest of the page is inert under it, and Tab stays inside. Esc closes it and only it: the menu stays open, with
// the keyboard back on "Keyboard shortcuts"; a second Esc closes the menu. In the popovers chunk with the panel.
import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import { linksOn } from '../open/intent';
import { useSession } from '../platform/session';
import { useViewStore } from '../state/viewStore';
import { useDoor } from '../deskapps/door';
import { canLockKeys, installedWindow } from '../shell/keyLock';
import { Icon } from './icons';

/**
 * Every key the office answers to, for the member and for screen readers, since the bottom bar's hint is short and
 * hidden from them. In step with `shell/useKeyboard.ts`, `shell/arrange.ts` and the Browser's ways out.
 */
export const SHORTCUTS: readonly (readonly [keys: string, what: string])[] = [
  ['← → ↑ ↓', 'Move between desks and apps'],
  ['Enter', 'Go into a desk, or open an app'],
  ['Esc', 'Close a window, or show all desks'],
  ['Shift+Esc', 'Close any window, Browser too'],
  ['[  ]', 'Previous or next desk'],
  ['1 to 9', 'Go to a desk'],
  ['0', 'Fit the desks'],
  ['+  −', 'Zoom in or out'],
  ['\\', 'Privacy shield'],
  ['.', 'Menu for a desk or app'],
  ['m', 'Move a desk or app'],
  ['r', 'Resize a desk or app'],
];

/** Same test as the Browser's `isMacPlatform` (`browser/streamInput.ts`), kept here so the menu doesn't pull the Browser's input code into the main chunk. */
const isMac = (): boolean => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** The keys inside the apps, for the second list. Ctrl becomes ⌘ on a Mac. */
function appShortcuts(mac: boolean): readonly (readonly [keys: string, what: string])[] {
  return [
    [mac ? '⌘K' : 'Ctrl+K', 'Search your notes (Notebook)'],
    ['F2', 'Rename (Files)'],
    ['Delete', 'Move to the trash (Files)'],
    ['Enter', 'Send (Agent, Maia); Shift+Enter for a new line'],
    [mac ? '⌘L' : 'Ctrl+L', 'Leave the page for the address bar (Browser)'],
    ['Shift+F10', "Menu for what's selected"],
  ];
}

/** On a Chromium only, where full screen keeps these keys from the member's own browser (`shell/keyLock.ts`). */
function fullScreenKeysLine(mac: boolean): string {
  return mac ? 'In full screen, ⌘W, T, N and Ctrl+Tab go to your desk.' : 'In full screen, Ctrl+W, T, N and Tab go to your desk.';
}

/**
 * The browser's install offer, which Platform's loader keeps (`window.__maInstallPrompt`, ma-platform
 * `docs/sub-status/desk-install.md`): Chromium only, once a page, and gone once installed.
 */
interface InstallPrompt {
  prompt(): Promise<unknown>;
}
const heldOffer = (): InstallPrompt | null => {
  const p = (window as { __maInstallPrompt?: InstallPrompt | null }).__maInstallPrompt;
  return p && typeof p.prompt === 'function' && !installedWindow() ? p : null;
};

/** "Install the office as an app", while the browser offers it and the office isn't already its own window. */
function InstallOffer({ mac }: { mac: boolean }) {
  const [offer, setOffer] = useState(heldOffer);
  if (!offer) return null;
  const install = (): void => {
    (window as { __maInstallPrompt?: InstallPrompt | null }).__maInstallPrompt = null; // it answers one prompt()
    setOffer(null);
    try {
      offer.prompt().catch(() => undefined);
    } catch {
      // already answered: nothing to say
    }
  };
  return (
    <div className="shortcuts-install">
      <button type="button" className="menu-item" onClick={install} data-testid="install-office">
        Install the office as an app
      </button>
      <p className="about-line">{mac ? 'In its own window, ⌘W and ⌘T go to your desk.' : 'In its own window, Ctrl+W and Ctrl+T go to your desk.'}</p>
    </div>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <>
      {rows.map(([keys, what]) => (
        <div key={keys} className="about-row">
          <dt><kbd>{keys}</kbd></dt>
          <dd>{what}</dd>
        </div>
      ))}
    </>
  );
}

/** The lists themselves: the office's keys, the apps', each installed app's own group, the full-screen line, the install offer. */
function ShortcutsList() {
  // Send to my desk (#9): a copied link, pasted on the office, behind Links in and out's kill switch.
  const pasteOpens = useSession((s) => linksOn(s.config));
  // An installed app's own keys (ADR 0054), the Bible's first: where it's installed on the desk in front, or on any desk.
  const appsHost = useDoor((s) => s.host);
  useDoor((s) => s.rev);
  const front = useViewStore((s) => s.activeDesk);
  const appGroups = appsHost?.shortcutGroups(front) ?? [];
  const mac = isMac();
  return (
    <div className="shortcuts" data-testid="shortcuts">
      <p className="about-line">These work while your desks have focus: click them, or Tab to them.</p>
      <dl className="about">
        <Rows rows={SHORTCUTS} />
        {pasteOpens && (
          <div className="about-row" data-testid="shortcut-paste-link">
            <dt><kbd>{mac ? '⌘V' : 'Ctrl+V'}</kbd></dt>
            <dd>Open a copied link on a desk</dd>
          </div>
        )}
      </dl>
      <p className="about-line shortcuts-group">In an app</p>
      <dl className="about">
        <Rows rows={appShortcuts(mac)} />
      </dl>
      {appGroups.map(([name, keys]) => (
        <Fragment key={name}>
          <p className="about-line shortcuts-group">{name}</p>
          <dl className="about" data-testid={`shortcuts-app-${name}`}>
            <Rows rows={keys} />
          </dl>
        </Fragment>
      ))}
      {canLockKeys() && <p className="about-line" data-testid="shortcuts-full-screen">{fullScreenKeysLine(mac)}</p>}
      <InstallOffer mac={mac} />
    </div>
  );
}

/**
 * The modal itself. Mounted while open; `back` is the menu's "Keyboard shortcuts" button, where the keyboard goes on close.
 * Its own Esc listener sits on the dialog, inside the menu's, so it hears Esc first and keeps it from the menu and the office.
 */
export function ShortcutsDialog({ onClose, back }: { onClose: () => void; back: RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const to = back.current; // the menu's row, there for as long as this is
    if (!d) return undefined;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', ''); // not connected yet, or no <dialog> support: shown in place, still named and closable
      }
    }
    d.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        // Kept inside: past the last control back to the first, and the other way, never out to the browser's own bar.
        const stops = Array.from(d.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'));
        const first = stops[0];
        const last = stops[stops.length - 1];
        const at = document.activeElement;
        if (!first || !last) return;
        if (e.shiftKey && (at === first || at === d)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault(); // no `cancel`: this closes it, and the office's own Esc (`useKeyboard`) skips a handled one
      e.stopPropagation(); // the menu's Esc (`AccountMenu.tsx`) is on an ancestor: only this layer closes
      onClose();
    };
    // A press on the backdrop (the dialog itself, outside its box) closes it; inside the menu's tree, so the menu stays.
    const onClick = (e: MouseEvent): void => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
    };
    d.addEventListener('keydown', onKey);
    d.addEventListener('click', onClick);
    return () => {
      d.removeEventListener('keydown', onKey);
      d.removeEventListener('click', onClick);
      if (d.open) d.close();
      // After the close, so the menu is no longer inert under it.
      if (to?.isConnected) to.focus({ preventScroll: true });
    };
  }, [onClose, back]);
  return (
    <dialog ref={ref} className="shortcuts-dialog" aria-labelledby="shortcuts-title" tabIndex={-1} data-testid="shortcuts-dialog">
      <div className="shortcuts-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <button type="button" className="icon-btn sm" aria-label="Close" title="Close (Esc)" onClick={onClose} data-testid="shortcuts-close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <ShortcutsList />
    </dialog>
  );
}
