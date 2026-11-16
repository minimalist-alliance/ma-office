// Maia Mode's rows in the account menu (CONCEPT.md §2, "Entering and leaving", "The setting"): a switch of its own under the
// themes, never a fourth theme ("Maia on my desks"); "Switch to Maia" while it's on and the member is on their desks; while it's
// on, "Ask at startup" and "Open in: Last used / Maia / Desks"; and "Delete Maia’s desk history" for anyone who accepted it. Only
// for a member the gate allows (ma-platform desks.md "Maia Mode": `/v1/me` lists them, under client-config's switch); when the
// gate closes on a member who had it on, the startup chunk turns it off on the home desk (`offIfGateClosed`). In the popovers
// chunk with the panel; turning it off and deleting the history are the small startup chunk's, never the room's.
import { useEffect, useRef, useState } from 'react';
import { Segmented, Switch } from '../chrome/Segmented';
import { useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { enterMaiaMode, openReachSettings, useMaiaMode } from './door';
import { allowedFor, currentPrefs, isOn, savePrefs, type StartMode } from './prefs';
import { AwayRows } from './awayRows';
import { R, W } from './words';

const OPEN_IN: { value: StartMode; label: string }[] = [
  { value: 'last', label: W.openLast },
  { value: 'maia', label: W.openMaia },
  { value: 'desk', label: W.openDesk },
];

const startup = () => import('./startup');

/** "Delete Maia’s desk history", asked once more first: her thread, her note log and her choice counts on the home desk (§23). */
function Forget() {
  const [step, setStep] = useState<'idle' | 'ask' | 'busy' | 'done' | 'failed'>('idle');
  // The keyboard never falls out of the menu: to Cancel when it asks, back to the row after, to the line when it's done.
  const row = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    if (step === 'ask') cancel.current?.focus();
    else if (step === 'idle' || step === 'failed') row.current?.focus();
    else if (step === 'done') done.current?.focus();
  }, [step]);
  const go = (next: typeof step): void => {
    moved.current = true;
    setStep(next);
  };
  if (step === 'done')
    return (
      <p className="about-line" role="status" tabIndex={-1} ref={done}>
        {W.forgotten}
      </p>
    );
  if (step === 'idle' || step === 'failed')
    return (
      <>
        <button type="button" className="menu-item" ref={row} onClick={() => go('ask')} data-testid="maia-mode-forget">
          {W.forget}
        </button>
        {step === 'failed' && (
          <p className="about-line" role="status">
            {W.forgetFailed}
          </p>
        )}
      </>
    );
  return (
    <div className="mm-forget" role="group" aria-labelledby="mm-forget-ask">
      <p className="about-line" id="mm-forget-ask">
        {W.forgetAsk}
      </p>
      <div className="mm-forget-acts">
        <button type="button" className="btn" ref={cancel} disabled={step === 'busy'} onClick={() => go('idle')}>
          {W.cancel}
        </button>
        <button
          type="button"
          className="btn"
          disabled={step === 'busy'}
          onClick={() => {
            setStep('busy');
            void startup()
              .then((m) => m.forgetHistory())
              .then(
                (ok) => go(ok ? 'done' : 'failed'),
                () => go('failed'),
              );
          }}
        >
          {step === 'busy' ? W.forgetting : W.forgetConfirm}
        </button>
      </div>
    </div>
  );
}

export function MaiaModeRows({ close }: { close: (focusBack: boolean) => void }) {
  const allowed = useSession((s) => allowedFor(s.me, s.config));
  useLayoutPrefs((s) => s['maiaMode']); // renders again when the document's value changes
  const prefs = currentPrefs();
  const room = useMaiaMode((s) => s.room);
  if (!allowed) return null;
  const on = isOn(prefs);
  const pending = prefs.offPending && !prefs.on;
  return (
    <div className="mm-menu" data-testid="menu-maia-mode">
      <div className="menu-sep" />
      <Switch
        id="pref-maia-mode"
        label={W.switchLabel}
        hint={W.switchHint}
        checked={on}
        onChange={(v) => {
          if (v) {
            close(false);
            enterMaiaMode(document.querySelector<HTMLElement>('.account-btn'));
          } else void startup().then((m) => m.turnOffMaiaMode(), () => undefined);
        }}
      />
      {pending && (
        <p className="about-line" role="status" data-testid="maia-mode-off-pending">
          {W.offPending}
        </p>
      )}
      {on && !room && (
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            close(false);
            enterMaiaMode(document.querySelector<HTMLElement>('.account-btn'));
          }}
        >
          {W.openRoom}
        </button>
      )}
      {on && (
        <>
          <Switch id="pref-maia-ask" label={W.askAtStartup} checked={prefs.startup.ask} onChange={(ask) => savePrefs({ startup: { ...prefs.startup, ask } })} />
          <p className="menu-label" id="mm-open-in">{W.openIn}</p>
          <Segmented label={W.openIn} options={OPEN_IN} value={prefs.startup.mode} onChange={(mode) => savePrefs({ startup: { ...prefs.startup, mode } })} className="theme-switch mm-open-in" />
          {/* What reaches you (the focus shield's settings): its own sheet, over the office or her room. */}
          <button
            type="button"
            className="menu-item"
            data-testid="maia-reach-settings"
            onClick={() => {
              close(false);
              openReachSettings();
            }}
          >
            {R.settings}
          </button>
          <AwayRows />
        </>
      )}
      {/* Ever turned on: an acceptance, or on while her home desk asks for the current disclosure (`deskSource.ts`). */}
      {(prefs.disclosure !== null || prefs.on) && <Forget />}
    </div>
  );
}
