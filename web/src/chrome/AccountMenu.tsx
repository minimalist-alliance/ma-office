// The top bar's account menu: the member, theme, plain background, About this desk (the owner only), keyboard shortcuts,
// Account settings (a full-screen modal, ADR 0052), sign out, and sign out everywhere. Its button is the member's avatar,
// with their tier's badge (task 45).
import { useEffect, useRef, useState } from 'react';
import { refreshDeskStatus, useAbout, useLive } from '../desk/liveStore';
import { formatUptime, readJson, writeJson } from '../lib/util';
import { accountUrl, reportUrl } from '../platform/clientConfig';
import { signOut, useSession } from '../platform/session';
import { useMyBadge, useMyTier, useTierNames } from '../platform/useTiers';
import { openSettings } from '../settings/settingsStore';
import { useViewStore } from '../state/viewStore';
import { isFlatGround, setFlatGround } from '../theme/ground';
import type { ThemeMode } from '../theme/resolve';
import { setThemePref, useTheme } from '../theme/themeStore';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { Segmented, Switch } from './Segmented';

declare const __MA_VERSION__: string;

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'dark', label: 'Dark' },
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

function Shortcuts() {
  const [open, setOpen] = useState(false);
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
          </dl>
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

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [flat, setFlat] = useState(isFlatGround);
  /** Which sign-out is on its way. Either one holds the other back; a failed "everywhere" puts it back to null. */
  const [leaving, setLeaving] = useState<'here' | 'everywhere' | null>(null);
  const [everywhereFailed, setEverywhereFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pref = useTheme((s) => s.pref);
  const me = useSession((s) => s.me);
  const config = useSession((s) => s.config);
  const activeDesk = useViewStore((s) => s.activeDesk);

  useEffect(() => {
    if (!open) return undefined;
    const el = ref.current;
    const onDown = (e: PointerEvent): void => {
      if (!el?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    el?.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el?.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const who = me?.displayName || me?.email;
  const names = useTierNames();
  const tier = useMyTier();
  const badge = useMyBadge();
  const tierName = tier && names[tier];
  // The badge's text equivalent, as its tooltip says it: "Dana Example, Officer" (contract tiers.md section 5).
  const said = who && tierName ? `${who}, ${tierName}` : who;
  const leave = (): void => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const account = config && accountUrl(config);
  const report = config && reportUrl(config);
  // Account settings holds the account page and, where export is on, "Your data".
  const settings = !!account || config?.export?.enabled === true;
  const owner = me?.roles?.includes('owner') === true;

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn chrome account-btn${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-controls="account-panel"
        aria-label="Account"
        // The member and their tier, as a description: no words in the top bar, and the button's name stays "Account".
        aria-description={said || undefined}
        title="Account"
        onClick={() => setOpen((v) => !v)}
      >
        {me ? <Avatar userId={me.userId} displayName={me.displayName} email={me.email} badge={badge} size={32} /> : <Icon name="account" />}
      </button>
      {open && (
        <div className="menu" id="account-panel" role="dialog" aria-label="Account">
          {me && who && (
            <div className="menu-me">
              <Avatar userId={me.userId} displayName={me.displayName} email={me.email} badge={badge} size={40} title={said ?? undefined} />
              <div className="menu-me-text">
                <p className="menu-who">{who}</p>
                {tierName && <p className="menu-tier" data-testid="menu-tier">{tierName}</p>}
              </div>
            </div>
          )}
          <p className="menu-label" id="theme-label">Theme</p>
          <Segmented label="Theme" options={THEME_OPTIONS} value={pref.mode} onChange={(mode) => setThemePref({ mode })} className="theme-switch" />
          {pref.mode === 'system' && (
            <Switch
              id="pref-system-dusk"
              label="Use Dusk when the system is dark"
              checked={pref.systemDark === 'dusk'}
              onChange={(v) => setThemePref({ systemDark: v ? 'dusk' : 'dark' })}
            />
          )}
          <Switch
            id="pref-flat-ground"
            label="Plain background"
            hint="No gradient behind the desks. On by default on very large high-resolution screens"
            checked={flat}
            onChange={(v) => {
              setFlatGround(v);
              setFlat(v);
            }}
          />
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
      )}
    </div>
  );
}
