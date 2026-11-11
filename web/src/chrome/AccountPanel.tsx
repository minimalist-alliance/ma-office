// The account menu's panel (`AccountMenu.tsx` is its button): the member, theme, background, plain background, About this desk
// (the owner only), keyboard shortcuts, Account settings (a full-screen modal, ADR 0052), sign out, and sign out everywhere.
// Shut, it draws nothing, so it's in the top bar's popovers chunk (`popoversChunk.ts`), fetched once the page is idle.
import { lazy, Suspense, useEffect, useState, type ComponentType, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Me } from '../platform/api';
import type { BadgeId } from '../platform/tiers';
import { refreshDeskStatus, useAbout, useLive } from '../desk/liveStore';
import { formatUptime, readJson, writeJson } from '../lib/util';
import { accountUrl, billingUrl, reportUrl } from '../platform/clientConfig';
import { PAY_NOW, UPDATE_CARD, menuNoteOf } from '../platform/billingNote';
import { linksOn } from '../open/intent';
import { signOut, useSession } from '../platform/session';
import { openSettings } from '../settings/settingsStore';
import { useViewStore } from '../state/viewStore';
import { canLockKeys, installedWindow } from '../shell/keyLock';
import { setFlatGround } from '../theme/ground';
import type { ThemeMode } from '../theme/resolve';
import { setThemePref, useTheme } from '../theme/themeStore';
import { THEME_IDS, THEME_LABELS } from '../theme/tokens';
import { Avatar } from './Avatar';
import { builtRecipeOf, pictureOf } from './avatar';
import { Icon } from './icons';
import { Segmented, Switch } from './Segmented';

declare const __MA_VERSION__: string;

// "Background" (ADR 0094): its own chunk beside the layer's, fetched when the menu opens. Nothing shows until it's here.
const BackgroundPicker = lazy(() => import('./BackgroundPicker').then((m) => ({ default: m.BackgroundPicker })));

// The themes' names come from `THEME_LABELS`, the one place they live (the `dusk` id reads "Zen").
const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  ...THEME_IDS.map((id) => ({ value: id, label: THEME_LABELS[id] })),
];

/**
 * Every key the office answers to, for the member and for screen readers, since the bottom bar's hint is short and
 * hidden from them. In step with `shell/useKeyboard.ts`, `shell/arrange.ts` and the Browser's ways out.
 */
const SHORTCUTS: readonly (readonly [keys: string, what: string])[] = [
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
    <>
      <button type="button" className="menu-item" onClick={install} data-testid="install-office">
        Install the office as an app
      </button>
      <p className="about-line">{mac ? 'In its own window, ⌘W and ⌘T go to your desk.' : 'In its own window, Ctrl+W and Ctrl+T go to your desk.'}</p>
    </>
  );
}

function Shortcuts() {
  const [open, setOpen] = useState(false);
  // Send to my desk (#9): a copied link, pasted on the office, behind Links in and out's kill switch.
  const pasteOpens = useSession((s) => linksOn(s.config));
  return (
    <>
      <button type="button" className="menu-item menu-disclosure" aria-expanded={open} aria-controls="shortcuts-list" onClick={() => setOpen((v) => !v)}>
        Keyboard shortcuts
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
      </button>
      {open && (
        <div id="shortcuts-list" className="shortcuts" data-testid="shortcuts">
          <p className="about-line">These work while your desks have focus: click them, or Tab to them.</p>
          <dl className="about">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className="about-row">
                <dt><kbd>{keys}</kbd></dt>
                <dd>{what}</dd>
              </div>
            ))}
            {pasteOpens && (
              <div className="about-row" data-testid="shortcut-paste-link">
                <dt><kbd>{isMac() ? '⌘V' : 'Ctrl+V'}</kbd></dt>
                <dd>Open a copied link on a desk</dd>
              </div>
            )}
          </dl>
          <p className="about-line">In an app</p>
          <dl className="about">
            {appShortcuts(isMac()).map(([keys, what]) => (
              <div key={keys} className="about-row">
                <dt><kbd>{keys}</kbd></dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          {canLockKeys() && <p className="about-line" data-testid="shortcuts-full-screen">{fullScreenKeysLine(isMac())}</p>}
          <InstallOffer mac={isMac()} />
        </div>
      )}
    </>
  );
}

/** Open or shut, remembered in this browser. Shut by default. */
const ABOUT_KEY = 'ma.menu.about.v1';

/**
 * "About this desk", for the owner only ("Only me", Nov 9): `roles` from `/v1/me` (contract desks.md). Members see none
 * of it. A disclosure, shut until he opens it ("Let me shrink it though"), and the desk's status is only asked for then.
 */
function About({ deskId }: { deskId: string | null }) {
  const [open, setOpen] = useState(() => readJson<boolean>(ABOUT_KEY) === true);
  const toggle = (): void => {
    setOpen((v) => {
      writeJson(ABOUT_KEY, !v);
      return !v;
    });
  };
  return (
    <>
      <button type="button" className="menu-item menu-disclosure" aria-expanded={open} aria-controls="about-desk" onClick={toggle} data-testid="about-toggle">
        About this desk
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={16} />
      </button>
      {open && (
        <div id="about-desk" className="about-panel">
          {deskId ? <AboutDesk deskId={deskId} /> : <p className="about-line" data-testid="about-desk">No desk yet.</p>}
          <p className="about-line about-version">App {__MA_VERSION__}</p>
        </div>
      )}
    </>
  );
}

function AboutDesk({ deskId }: { deskId: string }) {
  const live = useLive(deskId);
  const about = useAbout(deskId);
  const s = live.linkAvailable && live.link === 'open' ? about.status : null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => refreshDeskStatus(deskId), [deskId]);
  // Uptime ticks here between fetches, and only while this panel is open.
  useEffect(() => {
    if (!s) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [s]);
  const rtt = about.rttMs === null ? null : `${Math.max(1, Math.round(about.rttMs))} ms`;
  if (!s) {
    const lost = live.linkAvailable && (live.link === 'resuming' || live.link === 'retrying');
    if (!lost) return <p className="about-line" data-testid="about-desk">This desk isn't connected yet.</p>;
    const last = [about.path && `Last path ${about.path}`, rtt && `last round trip ${rtt}`].filter(Boolean).join(', ');
    return (
      <p className="about-line" data-testid="about-desk">
        {live.lostForSec >= 30 ? "Can't reach this desk." : 'Reconnecting to this desk.'}{last && ` ${last}.`}
      </p>
    );
  }
  return (
    <dl className="about" data-testid="about-desk">
      <dt>Service</dt><dd>deskd {s.deskdVersion}</dd>
      <dt>Streaming</dt><dd>desk-rtc {s.rtcVersion ?? 'not reported yet'}</dd>
      <dt>Uptime</dt><dd>{formatUptime(s.uptimeSec + Math.max(0, now - about.fetchedAt) / 1000)}</dd>
      <dt>Instance</dt><dd>{s.instanceType ?? 'not reported yet'}</dd>
      <dt>Java</dt><dd>{s.javaVersion}</dd>
      <dt>Desk</dt><dd>{s.deskId ?? deskId}</dd>
      <dt>Boot</dt><dd>{s.bootId}</dd>
      <dt>Connection</dt><dd>{[about.path, rtt].filter(Boolean).join(' · ') || 'measuring…'}</dd>
    </dl>
  );
}

export interface AccountPanelProps {
  me: Me | null;
  who: string | undefined;
  said: string | undefined;
  tierName: string | null | undefined;
  badge: BadgeId | null;
  /** A free member's tier line, the free tier's (`free/door.ts`), read by `AccountMenu` so this chunk doesn't import the door. */
  FreeTier: ComponentType | undefined;
  /** The setup circle's switch (`setup/door.ts`), read by `AccountMenu`: that import's place in the first load keeps the stylesheet's order. */
  SetupMenuSlot: ComponentType;
  /** The menu's own state, which outlives the panel: it's kept by `AccountMenu`, as it was before the panel had a chunk. */
  flat: boolean;
  setFlat: Dispatch<SetStateAction<boolean>>;
  leaving: 'here' | 'everywhere' | null;
  setLeaving: Dispatch<SetStateAction<'here' | 'everywhere' | null>>;
  everywhereFailed: boolean;
  setEverywhereFailed: Dispatch<SetStateAction<boolean>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  leave: () => void;
  btnRef: RefObject<HTMLButtonElement | null>;
}

export function AccountPanel({ me, who, said, tierName, badge, FreeTier, SetupMenuSlot, flat, setFlat, leaving, setLeaving, everywhereFailed, setEverywhereFailed, setOpen, leave, btnRef }: AccountPanelProps) {
  const pref = useTheme((s) => s.pref);
  const config = useSession((s) => s.config);
  const activeDesk = useViewStore((s) => s.activeDesk);
  const account = config && accountUrl(config);
  const report = config && reportUrl(config);
  // Account settings holds the account page and, where export is on, "Your data".
  const settings = !!account || config?.export?.enabled === true;
  const owner = me?.roles?.includes('owner') === true;
  // The billing launch features (still 32, option C2): one quiet line under the tier while the card expires before the next
  // charge, or, first, while a payment has failed. Only while Platform sends it; its link is the billing page, in its own tab.
  const note = menuNoteOf(me?.membership, billingUrl(config, me?.membership?.billingUrl));

  return (
    <div className="menu" id="account-panel" role="dialog" aria-label="Account">
      {me && who && (
        <div className="menu-me">
          <Avatar userId={me.userId} displayName={me.displayName} email={me.email} badge={badge} size={40} picture={pictureOf(me)} built={builtRecipeOf(me)} title={said ?? undefined} />
          <div className="menu-me-text">
            <p className="menu-who">{who}</p>
            {tierName ? <p className="menu-tier" data-testid="menu-tier">{tierName}</p> : FreeTier && <FreeTier />}
            {note && (
              <p className={`menu-note${note.kind === 'payment' ? ' menu-note-failed' : ''}`} data-testid="menu-billing-note">
                {note.text}{' '}
                <a href={note.link} target="_blank" rel="noopener noreferrer" aria-description="Opens in a new tab" onClick={leave}>
                  {note.kind === 'payment' ? PAY_NOW : UPDATE_CARD}
                </a>
              </p>
            )}
          </div>
        </div>
      )}
      <p className="menu-label" id="theme-label">Theme</p>
      <Segmented label="Theme" options={THEME_OPTIONS} value={pref.mode} onChange={(mode) => setThemePref({ mode })} className="theme-switch" />
      {pref.mode === 'system' && (
        <Switch
          id="pref-system-dusk"
          label={`Use ${THEME_LABELS.dusk} when the system is dark`}
          checked={pref.systemDark === 'dusk'}
          onChange={(v) => setThemePref({ systemDark: v ? 'dusk' : 'dark' })}
        />
      )}
      <Suspense fallback={null}>
        <BackgroundPicker />
      </Suspense>
      <Switch
        id="pref-flat-ground"
        label="Plain background"
        hint="No gradient or picture behind the desks. On by default on very large high-resolution screens"
        checked={flat}
        onChange={(v) => {
          setFlatGround(v);
          setFlat(v);
        }}
      />
      {/* The setup circle's switch, on by default, and on a phone too narrow for the circle, its row (S-121). */}
      <SetupMenuSlot />
      {owner && (
        <>
          <div className="menu-sep" />
          <About deskId={activeDesk} />
        </>
      )}
      <div className="menu-sep" />
      <Shortcuts />
      <div className="menu-sep" />
      {settings && (
        // Over the office, never in place of it: leaving this tab would close the member's windows and anything
        // unsent in them. "Your data" is in there too.
        <button
          type="button"
          className="menu-item"
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(false);
            openSettings(undefined, btnRef.current);
          }}
          data-testid="menu-account-settings"
        >
          Account settings
        </button>
      )}
      {report && (
        // Its own tab, for the same reason. The note is for screen readers only.
        <a className="menu-item" href={report} target="_blank" rel="noopener" aria-description="Opens in a new tab" onClick={leave}>
          Report a safety concern
        </a>
      )}
      <button
        type="button"
        className="menu-item"
        disabled={leaving !== null}
        onClick={() => {
          setLeaving('here');
          setEverywhereFailed(false);
          void signOut();
        }}
      >
        {leaving === 'here' ? 'Signing out…' : 'Sign out'}
      </button>
      {/*
        Every session the member has, this one too (contract auth.md section 6), for a lost laptop. No confirm: signing
        in again undoes it. aria-disabled rather than disabled while it works, so focus stays here for the line below.
      */}
      <button
        type="button"
        className="menu-item"
        aria-disabled={leaving !== null || undefined}
        onClick={() => {
          if (leaving) return;
          setLeaving('everywhere');
          setEverywhereFailed(false);
          signOut({ everywhere: true }).catch(() => {
            setLeaving(null);
            setEverywhereFailed(true);
          });
        }}
        data-testid="sign-out-everywhere"
      >
        {leaving === 'everywhere' ? 'Signing out everywhere…' : 'Sign out everywhere'}
      </button>
      {everywhereFailed && (
        <p className="about-line menu-failed" role="alert" data-testid="sign-out-everywhere-failed">
          We couldn't sign you out everywhere. Try again.
        </p>
      )}
    </div>
  );
}
