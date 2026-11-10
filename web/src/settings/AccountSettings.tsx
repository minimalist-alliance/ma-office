// Account settings: a full-screen modal over the office, so the member's desks, windows and anything unsent stay as
// they are (ADR 0052). Two sections: "Account", the Platform app's account page in a frame, and "Your data", the
// office's own download, which has to run here because desk files go straight from the desks to this computer.
// Its own chunk, loaded on first open.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '../chrome/Avatar';
import { Icon } from '../chrome/icons';
import { accountUrl } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { useMyBadge, useMyTier, useTierNames } from '../platform/useTiers';
import { embedUrl, FRAME_WAIT_MS, frameRefused, frameState } from './accountFrame';
import { closeSettings, setHolding, showSection, useSettingsStore, type SettingsSection } from './settingsStore';
import './settings.css';

const ExportPanel = lazy(() => import('../export/ExportPage').then((m) => ({ default: m.ExportPanel })));

const SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'data', label: 'Your data' },
];

/** Who's signed in, as the account menu shows them: for the account page's own link while the frame isn't here. */
function Who() {
  const me = useSession((s) => s.me);
  const names = useTierNames();
  const tier = useMyTier();
  const badge = useMyBadge();
  const who = me?.displayName || me?.email;
  if (!me || !who) return null;
  const tierName = tier && names[tier];
  return (
    <div className="settings-who">
      <Avatar userId={me.userId} displayName={me.displayName} email={me.email} badge={badge} size={40} />
      <div className="settings-who-text">
        <p className="settings-who-name">{who}</p>
        {me.displayName && me.email && <p className="settings-who-sub">{me.email}</p>}
        {tierName && <p className="settings-who-sub">{tierName}</p>}
      </div>
    </div>
  );
}

type Frame = 'loading' | 'ready' | 'signed-out' | 'unavailable';

/**
 * The account page in a frame. It shows only once the page says it's ready, so a refused frame never shows the browser's
 * error. Refused, or silent for `FRAME_WAIT_MS`, the account page is offered as its own page instead. Signed out there,
 * the member signs in on its own page, and the frame tries again when they come back to this one.
 */
function AccountFrame({ url }: { url: string }) {
  const [state, setState] = useState<Frame>('loading');
  const [round, setRound] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = new URL(url).origin;

  // Before the frame can load, so its first word is never missed.
  useLayoutEffect(() => {
    setState('loading');
    const onMessage = (e: MessageEvent): void => {
      const s = frameState(e, frame.current?.contentWindow, origin);
      if (s === 'escape') closeSettings();
      else if (s) setState(s);
    };
    const onRefused = (e: SecurityPolicyViolationEvent): void => {
      if (frameRefused(e, origin)) setState((s) => (s === 'loading' ? 'unavailable' : s));
    };
    const timer = window.setTimeout(() => setState((s) => (s === 'loading' ? 'unavailable' : s)), FRAME_WAIT_MS);
    window.addEventListener('message', onMessage);
    document.addEventListener('securitypolicyviolation', onRefused);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('securitypolicyviolation', onRefused);
    };
  }, [origin, round]);

  useEffect(() => {
    if (state !== 'signed-out') return undefined;
    const again = (): void => setRound((r) => r + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [state]);

  return (
    <div className="settings-account" data-testid="account-section" data-frame={state}>
      {state !== 'unavailable' && (
        <iframe
          key={round}
          ref={frame}
          className={`settings-frame${state === 'ready' ? '' : ' waiting'}`}
          src={embedUrl(url)}
          title="Account settings"
          referrerPolicy="strict-origin"
          // No top navigation: nothing in the frame can take the office away. New tabs (billing, Stripe) still open.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          hidden={state === 'signed-out'}
          data-testid="account-frame"
        />
      )}
      {state === 'loading' && (
        <p className="settings-line settings-loading" role="status">
          Loading…
        </p>
      )}
      {state === 'signed-out' && (
        <div className="settings-fallback" data-testid="account-signed-out">
          <Who />
          <p className="settings-line">Sign in on your account page once, then come back here.</p>
          <a className="btn primary" href={url} target="_blank" rel="noopener" data-testid="account-sign-in">
            Sign in
          </a>
        </div>
      )}
      {state === 'unavailable' && (
        <div className="settings-fallback" data-testid="account-fallback">
          <Who />
          <p className="settings-line">Membership, billing, streaming and sign-in are on your account page.</p>
          <a className="btn primary" href={url} target="_blank" rel="noopener" data-testid="account-open">
            Open account settings
          </a>
        </div>
      )}
    </div>
  );
}

export default function AccountSettings() {
  const open = useSettingsStore((s) => s.open);
  const holding = useSettingsStore((s) => s.holding);
  const chosen = useSettingsStore((s) => s.section);
  const config = useSession((s) => s.config);
  const account = config ? accountUrl(config) : null;
  const data = config?.export?.enabled === true;
  const sections = SECTIONS.filter((s) => (s.id === 'account' ? !!account : data));
  const section: SettingsSection | null = sections.some((s) => s.id === chosen) ? chosen : (sections[0]?.id ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const onHolding = useCallback((h: boolean) => setHolding(h), []);

  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open]);

  // Esc closes it from anywhere in the office; the frame sends its own Esc as a message. Captured first, so the
  // office's Esc (closing a window, leaving a desk) never hears it as well.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (open && !section) closeSettings(); // nothing to show: client-config changed while it was open
  }, [open, section]);

  return (
    <div className="settings-away" hidden={!open} data-testid="account-settings-layer">
      <div ref={ref} tabIndex={-1} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="account-settings" data-section={section ?? undefined}>
        <div className="settings-head">
          <h2 id="settings-title">Account settings</h2>
          <button type="button" className="icon-btn sm" aria-label="Close" title="Close (Esc)" onClick={closeSettings} data-testid="account-settings-close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {sections.length > 1 && (
          <div className="settings-tabs" role="tablist" aria-label="Account settings">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`settings-tab-${s.id}`}
                aria-selected={section === s.id}
                aria-controls={`settings-panel-${s.id}`}
                className={`settings-tab${section === s.id ? ' on' : ''}`}
                onClick={() => showSection(s.id)}
                data-testid={`settings-tab-${s.id}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {account && open && (
          <div className="settings-panel settings-panel-account" id="settings-panel-account" role={sections.length > 1 ? 'tabpanel' : undefined} aria-labelledby={sections.length > 1 ? 'settings-tab-account' : undefined} hidden={section !== 'account'}>
            <AccountFrame url={account} />
          </div>
        )}
        {data && ((open && section === 'data') || holding) && (
          <div className="settings-panel settings-panel-data" id="settings-panel-data" role={sections.length > 1 ? 'tabpanel' : undefined} aria-labelledby={sections.length > 1 ? 'settings-tab-data' : undefined} hidden={section !== 'data'}>
            <Suspense fallback={<p className="settings-line settings-loading">Loading…</p>}>
              <ExportPanel inOffice onHolding={onHolding} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
