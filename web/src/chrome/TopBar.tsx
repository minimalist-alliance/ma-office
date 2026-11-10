// The mark, scope switcher (only with more than one desk, design 3.2), privacy shield, full
// screen and the account menu. The canvas keeps all pointer input outside these controls. Nothing else goes in here:
// notices, such as a new version, go in the shell's stack above the bottom bar, so these never move for one.
import { useEffect, useState } from 'react';
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import { goOverview, inScopeDesks, setScope, togglePrivacy } from '../shell/actions';
import { useDeskStore } from '../state/deskStore';
import { useViewStore, type Scope } from '../state/viewStore';
import { AccountMenu } from './AccountMenu';
import { Icon } from './icons';
import { Segmented } from './Segmented';

const SCOPE_LABELS: Record<Scope, string> = { personal: 'Personal', work: 'Work', guild: 'Guild', all: 'All' };

/** The brand kit's mark for the active theme (ADR 0060); files are exact copies, never recolored. CSS picks by theme. */
function Mark() {
  return (
    <>
      <img className="home-mark-img on-light" src={markOnLight} alt="" width={45} height={28} />
      <img className="home-mark-img on-dark" src={markOnDark} alt="" width={45} height={28} />
    </>
  );
}

export function TopBar({ onNotice }: { onNotice: (text: string) => void }) {
  const desks = useDeskStore((s) => s.desks);
  const scope = useViewStore((s) => s.scope);
  const mode = useViewStore((s) => s.mode);
  const shield = useViewStore((s) => s.privacyShield);
  const [isFs, setIsFs] = useState(() => !!document.fullscreenElement);

  useEffect(() => {
    const on = (): void => setIsFs(!!document.fullscreenElement);
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
      <div className="top-actions">
        {desks.length > 1 && <Segmented label="Scope" options={options} value={scope} onChange={setScope} className="scope" />}
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
        <AccountMenu />
      </div>
    </header>
  );
}
