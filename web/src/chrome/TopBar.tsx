// The mark, scope switcher (only with more than one desk, design 3.2; one menu button beside the mark in short-viewport
// mode, `BarMenus.tsx`), privacy shield, full
// screen, the bell and the account menu. The canvas keeps all pointer input outside these controls. Nothing else goes
// in here: notices, such as a new version, go in the shell's stack above the bottom bar, so these never move for one.
// The bell is the one exception, and it isn't a notice: it holds the member's own notifications (ADR 0125), which
// arrive from every app they use, not the desk's word about itself.
import { useEffect, useState } from 'react';
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import markZen from '../assets/brand/ma-mark-zen.svg';
import { useIsShort } from '../canvas/phone';
import { goOverview, inScopeDesks, setScope, togglePrivacy } from '../shell/actions';
import { useDeskStore } from '../state/deskStore';
import { useViewStore, type Scope } from '../state/viewStore';
import { AccountMenu } from './AccountMenu';
import { BarMenu } from './BarMenus';
import { Bell } from './Bell';
import { Icon } from './icons';
import { Segmented } from './Segmented';

const SCOPE_LABELS: Record<Scope, string> = { personal: 'Personal', work: 'Work', guild: 'Guild', all: 'All' };

/** The brand kit's mark for the active theme (ADR 0060); files are exact copies, never recolored. CSS picks by theme: primary on Light, on-dark on Dark, and on Zen the on-dark mark with a soft blue right ribbon (`ma-mark-zen.svg`, the owner OK'd it on Nov 11, ADR 0066 and 0093). */
function Mark() {
  return (
    <>
      <img className="home-mark-img on-light" src={markOnLight} alt="" width={45} height={28} />
      <img className="home-mark-img on-dark" src={markOnDark} alt="" width={45} height={28} />
      <img className="home-mark-img on-zen" src={markZen} alt="" width={45} height={28} />
    </>
  );
}

export function TopBar({ onNotice }: { onNotice: (text: string) => void }) {
  const desks = useDeskStore((s) => s.desks);
  const scope = useViewStore((s) => s.scope);
  const mode = useViewStore((s) => s.mode);
  const shield = useViewStore((s) => s.privacyShield);
  const [isFs, setIsFs] = useState(() => !!document.fullscreenElement);
  const short = useIsShort();

  useEffect(() => {
    const on = (): void => {
      setIsFs(!!document.fullscreenElement);
      // The habit keys stay in the office while it's full screen (`shell/keyLock.ts`), in a chunk of its own.
      void import('../shell/keyLock').then((m) => m.followFullscreen(), () => undefined);
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      onNotice('Full screen is not available here.');
    }
  };

  const canGoHome = mode !== 'overview' && inScopeDesks().length > 1;
  const scopes = (['personal', 'work', 'guild'] as const).filter((k) => desks.some((d) => d.kind === k));
  const options = [...scopes.map((value) => ({ value, label: SCOPE_LABELS[value] })), { value: 'all' as const, label: SCOPE_LABELS.all }];

  return (
    <header className="topbar">
      <h1 className="home-mark">
        {canGoHome ? (
          <button type="button" className="home-mark-btn" aria-label="Your office, show all desks" title="All desks" onClick={() => goOverview()}>
            <Mark />
          </button>
        ) : (
          <span role="img" aria-label="Minimalist Alliance">
            <Mark />
          </span>
        )}
      </h1>
      {desks.length > 1 && short && (
        <BarMenu panel="ScopeList" options={options} value={scope}>
          <span className="sr-only">Scope: </span>
          <span className="chip-text">{SCOPE_LABELS[scope]}</span>
          <Icon name="chevronDown" size={16} />
        </BarMenu>
      )}
      <div className="top-actions">
        {desks.length > 1 && !short && <Segmented label="Scope" options={options} value={scope} onChange={setScope} className="scope" />}
        <button
          type="button"
          className={`icon-btn chrome${shield ? ' on' : ''}`}
          aria-pressed={shield}
          aria-label="Privacy shield"
          title="Privacy shield ( \ )"
          onClick={togglePrivacy}
        >
          <Icon name={shield ? 'shieldOn' : 'shield'} />
        </button>
        <button
          type="button"
          className="icon-btn chrome"
          aria-label={isFs ? 'Exit full screen' : 'Full screen'}
          title={isFs ? 'Exit full screen' : 'Full screen'}
          onClick={() => void toggleFullscreen()}
        >
          <Icon name={isFs ? 'exitFullscreen' : 'fullscreen'} />
        </button>
        <Bell />
        <AccountMenu />
      </div>
    </header>
  );
}
