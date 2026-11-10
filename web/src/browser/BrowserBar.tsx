// Kiosk Chromium has no chrome of its own, so the window has it: tabs, back, forward, reload, the address bar.
// Titles and URLs come from web pages through the desk, so they only ever render as text.
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { Icon } from '../chrome/icons';
import type { BrowserTab } from '../desk/deskLink';
import { QualityMenu } from '../quality/QualityMenu';
import { addressShown, displayText } from './address';
import type { BrowserDriver, BrowserView } from './driver';
import type { SimpleUi } from '../simple/ui';

/**
 * The simplified view's switch and line (task 47), from the view's own chunk, which the window asks for as it opens. A
 * chunk that doesn't load draws no switch: the window has already stepped aside to the real page (`SimpleUnavailable`).
 */
const SimpleSwitch = lazy(() =>
  import('../simple/SimpleLayer').then(
    (m) => ({ default: m.BarSwitch }),
    () => ({ default: () => null }),
  ),
);


function TabStrip({ driver, view, disabled, onNewTab }: { driver: BrowserDriver; view: BrowserView; disabled: boolean; onNewTab: () => void }) {
  const closable = view.tabs.length > 1;
  return (
    <div className="br-tabs" role="tablist" aria-label="Tabs on this desk">
      {view.tabs.map((tab: BrowserTab) => {
        const title = displayText(tab.title) || addressShown(tab.url) || 'New tab';
        return (
          <div key={tab.tabId} className={`br-tab${tab.active ? ' active' : ''}${tab.loading ? ' loading' : ''}`} data-testid="browser-tab">
            <button type="button" className="br-tab-title" role="tab" aria-selected={tab.active} title={title} disabled={disabled} onClick={() => driver.activateTab(tab.tabId)}>
              {title}
            </button>
            {closable && (
              <button type="button" className="br-tab-close" aria-label={`Close ${title}`} disabled={disabled} onClick={() => driver.closeTab(tab.tabId)}>
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="icon-btn sm br-tab-new" aria-label="New tab" title="New tab" disabled={disabled} onClick={() => {
        driver.openTab();
        onNewTab();
      }}>
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}

function AddressBar({ driver, view, activeUrl, activeLoading, connected, disabled, inputRef, onLeave }: {
  driver: BrowserDriver;
  view: BrowserView;
  activeUrl: string;
  activeLoading: boolean;
  connected: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onLeave: () => void;
}) {
  // What's being typed. Null shows what the desk says. A page's own navigation never overwrites a draft.
  const [draft, setDraft] = useState<string | null>(null);
  const submitted = useRef(false);
  /** The desk couldn't take it, or may not have. It stays, through a click on a tab and any snapshot, until it's sent or dropped. */
  const kept = useRef(false);

  useEffect(() => {
    const failed = view.keptAddress;
    if (!failed) return;
    submitted.current = false;
    kept.current = true;
    // As typed if it's still there. It may have gone, if the tab moved first or it was typed while the desk woke.
    setDraft((now) => now ?? failed.url);
  }, [view.keptAddress]);

  useEffect(() => {
    // After Enter the typed text stays until the desk says the tab is on its way, so nothing flickers back.
    if (submitted.current && view.pendingAddress === null) {
      submitted.current = false;
      setDraft(null);
    }
  }, [activeUrl, activeLoading, view.pendingAddress]);

  const submit = (): void => {
    if (draft === null) {
      onLeave();
      return;
    }
    if (driver.navigate(draft)) {
      submitted.current = true;
      kept.current = false;
      onLeave();
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      kept.current = false;
      setDraft(null);
      onLeave();
    }
  };

  return (
    <form className="address" role="search" onSubmit={(e) => e.preventDefault()}>
      <input
        ref={inputRef}
        aria-label="Address"
        data-testid="browser-address"
        value={draft ?? activeUrl}
        placeholder="Search or type an address"
        disabled={disabled}
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // While the desk wakes, what's typed is a draft to keep. Otherwise it shows where the page really is.
          if (connected && !submitted.current && !kept.current) setDraft(null);
        }}
      />
    </form>
  );
}

export function BrowserBar({ driver, view, connected, closed, addressRef, isMac, onLeaveAddress, deskId, simple = null, covered = false, simpleShown = false }: {
  driver: BrowserDriver;
  view: BrowserView;
  /** A session is open, so what needs the desk can go. */
  connected: boolean;
  /** Asleep, still being set up, or refused: nothing typed could go anywhere, so the address takes nothing. */
  closed: boolean;
  addressRef: RefObject<HTMLInputElement | null>;
  isMac: boolean;
  onLeaveAddress: () => void;
  /** Whose stream, for the quality menu's word from the desk. */
  deskId?: string;
  /** The simple view's state, where client-config turns it on (task 47). */
  simple?: SimpleUi | null;
  /**
   * The simplified view is what the window shows, by the desk's yes and the member's choice. The picture-quality menu shows
   * only beside the real page: the view sends no picture to tune. While the window asks the desk, it's the real page, so
   * the menu shows as it always has.
   */
  simpleShown?: boolean;
  /** The simple view covers the stream: typing goes to the view, never the page under it (T47O-2). */
  covered?: boolean;
}) {
  const active = view.tabs.find((t) => t.active);
  const why = connected ? undefined : 'Not connected to this desk right now';
  return (
    <div className="br-chrome" data-testid="browser-chrome">
      <TabStrip driver={driver} view={view} disabled={!connected} onNewTab={() => addressRef.current?.focus()} />
      <div className="br-bar">
        <button type="button" className="icon-btn sm" aria-label="Back" title={why ?? 'Back'} disabled={!connected || !active?.canGoBack} onClick={() => driver.back()}>
          <Icon name="back" size={17} />
        </button>
        <button type="button" className="icon-btn sm" aria-label="Forward" title={why ?? 'Forward'} disabled={!connected || !active?.canGoForward} onClick={() => driver.forward()}>
          <Icon name="forward" size={17} />
        </button>
        <button type="button" className="icon-btn sm" aria-label="Reload" title={why ?? 'Reload'} disabled={!connected} onClick={() => driver.reload()}>
          <Icon name="reload" size={17} />
        </button>
        <AddressBar driver={driver} view={view} activeUrl={addressShown(active?.url)} activeLoading={active?.loading ?? false} connected={connected} disabled={closed} inputRef={addressRef} onLeave={onLeaveAddress} />
        {view.pendingAddress !== null && <span className="br-note" role="status" data-testid="browser-pending">Opens when the desk is ready</span>}
        {view.notice && <span className="br-note" role="status" title={view.notice} data-testid="browser-notice">{view.notice}</span>}
        {view.heldText !== null && (
          <>
            <button type="button" className="br-note-action" data-testid="browser-held-send" disabled={!connected} title={why} onClick={driver.sendHeldText}>Send text</button>
            <button type="button" className="br-note-action" data-testid="browser-held-drop" onClick={driver.dropHeldText}>Discard</button>
          </>
        )}
        {view.streamFocused && !covered && !view.notice && view.pendingAddress === null && (
          <span className="br-note hide-narrow" data-testid="browser-focus-hint">
            Typing goes to the page · {isMac ? '⌘L' : 'Ctrl+L'} to leave
          </span>
        )}
        {simple && connected && (
          <Suspense fallback={null}>
            <SimpleSwitch ui={simple} />
          </Suspense>
        )}
        {!simpleShown && <QualityMenu app="browser" deskId={deskId} />}
      </div>
    </div>
  );
}
