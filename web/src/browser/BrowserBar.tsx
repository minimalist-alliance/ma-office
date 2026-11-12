// Kiosk Chromium has no chrome of its own, so the window has it: tabs, back, forward, reload, the address bar.
// Titles and URLs come from web pages through the desk, so they only ever render as text.
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { Icon } from '../chrome/icons';
import type { BrowserTab } from '../desk/deskLink';
import { useFree } from '../free/door';
import { QualityMenu, QualityNotice } from '../quality/QualityMenu';
import { addressShown, displayText } from './address';
import { LinkIcon } from './linkIcons';
import { deviceUrl, openOnDevice } from './openOnDevice';
import { ExtMenu, ExtRows, KeyButton, MENU_NOTE, useSideways, type SignInsUi } from './extensions/ExtTools';
import './bar.css';
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
    <div className="br-tabs" role="group" aria-label="Tabs on this desk">
      {view.tabs.map((tab: BrowserTab) => {
        const title = displayText(tab.title) || addressShown(tab.url) || 'New tab';
        return (
          <div key={tab.tabId} className={`br-tab${tab.active ? ' active' : ''}${tab.loading ? ' loading' : ''}`} data-testid="browser-tab">
            <button type="button" className="br-tab-title" aria-current={tab.active ? 'true' : undefined} title={title} disabled={disabled} onClick={() => driver.activateTab(tab.tabId)}>
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

function AddressBar({ driver, view, activeUrl, activeLoading, connected, ready, disabled, inputRef, onLeave, deviceHref, onOpenedOnDevice, placeholder }: {
  driver: BrowserDriver;
  view: BrowserView;
  activeUrl: string;
  activeLoading: boolean;
  connected: boolean;
  /** The Browser can take an address now. Until then what's typed is a draft to keep, and Enter holds it to send. */
  ready: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onLeave: () => void;
  /** The active tab's address when it can open on this device (http or https), else null. */
  deviceHref: string | null;
  onOpenedOnDevice: () => void;
  /** What the empty field says: a password manager's name while its page is on screen (#11), else the usual words. */
  placeholder: string;
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
        placeholder={placeholder}
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
          // While the desk wakes or the Browser starts, what's typed is a draft to keep. Otherwise it shows where the page really is.
          if (connected && ready && !submitted.current && !kept.current) setDraft(null);
        }}
      />
      {/* Open on this device (#9): about this address, so at its end. Not while a new one is typed: the field is about that. */}
      {draft === null && deviceHref && (
        <button
          type="button"
          className="address-out"
          aria-label="Open on this device"
          title="Open on this device"
          data-testid="browser-open-here"
          onClick={() => {
            // Inside the press, so no pop-up blocker stops it.
            if (openOnDevice(deviceHref)) onOpenedOnDevice();
          }}
        >
          <LinkIcon name="openOut" size={16} />
        </button>
      )}
    </form>
  );
}

export function BrowserBar({ driver, view, connected, ready = true, closed, addressRef, isMac, onLeaveAddress, deskId, simple = null, covered = false, simpleShown = false, openedNote = false, onOpenedOnDevice = () => {}, signIns = null }: {
  driver: BrowserDriver;
  view: BrowserView;
  /** A session is open, so what needs the desk can go. */
  connected: boolean;
  /** The Browser itself is up (not still starting): a typed address is sent at once, not held. */
  ready?: boolean;
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
  /** "Opened on this device" in the note slot for a moment, after the first time (#9). */
  openedNote?: boolean;
  onOpenedOnDevice?: () => void;
  /** Site sign-ins (#11): the key, Extensions and More's rows. Null where none of it shows. */
  signIns?: SignInsUi | null;
}) {
  const active = view.tabs.find((t) => t.active);
  // A manager's page is on screen in a tab `browser.tabs` never lists, so no tab is active: the bar names it (deskd API.md 10).
  const extOnScreen = !active ? (signIns?.installed.find((e) => e.open) ?? null) : null;
  // A phone on its side under 700 px: the key folds into More (`useSideways`).
  const sideways = useSideways();
  const anyExt = (signIns?.installed.length ?? 0) > 0;
  const moreExtras = !signIns ? null
    : anyExt ? { rows: (close: (giveBack: boolean) => void) => <ExtRows ui={signIns} close={close} />, note: MENU_NOTE }
    : sideways ? { rows: (close: (giveBack: boolean) => void) => <ExtRows ui={signIns} close={close} />, note: null, after: true }
    : null;
  const why = connected ? undefined : 'Not connected to this desk right now';
  // A free desk's one line about busy times (`free/door.ts`).
  const FreeLine = useFree((s) => s.BrowserLine);
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
        <AddressBar driver={driver} view={view} activeUrl={addressShown(active?.url)} activeLoading={active?.loading ?? false} connected={connected} ready={ready} disabled={closed} inputRef={addressRef} onLeave={onLeaveAddress} deviceHref={addressShown(active?.url) ? deviceUrl(active?.url) : null} onOpenedOnDevice={onOpenedOnDevice} placeholder={extOnScreen?.name ?? 'Search or type an address'} />
        {openedNote && <span className="br-note" role="status" data-testid="browser-opened-note">Opened on this device</span>}
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
        {FreeLine && <FreeLine deskId={deskId} />}
        {!simpleShown && <QualityNotice />}
        {/* The bar's right group (the spec's section 1): #12's keyboard (touch screens), #11's key and Extensions, Picture
            quality. Under 720 px of bar, Extensions and Picture quality fold into More; the key stays out. */}
        {!simpleShown && (
          <div className="br-tools">
            {signIns && !sideways && <KeyButton ui={signIns} />}
            {signIns && anyExt && <ExtMenu ui={signIns} className="br-wide" />}
            <QualityMenu app="browser" deskId={deskId} notice={false} className="br-wide" />
            <QualityMenu
              app="browser"
              deskId={deskId}
              notice={false}
              variant="more"
              className="br-more-wrap"
              extras={moreExtras}
            />
          </div>
        )}
      </div>
    </div>
  );
}
