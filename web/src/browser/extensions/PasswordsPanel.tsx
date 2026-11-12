// Passwords and sign-ins (#11, spec section 9): a panel over the picture's right side, an `aside`. Focus goes to its title
// as it opens; Esc closes it and gives focus back to the key. Focus isn't trapped, so the page stays usable beside it on a
// computer. A phone has it at full width with Back in place of ✕. Its own chunk, fetched when it first opens.
//
// What it says is the Designer's words. Where deskd's wire differs from the spec (`docs/sub-status/signins-11.md`):
// adding a manager opens its Web Store page on the desk, where Add is the member's own click; nothing removes one yet
// (no `browser.extension.remove`); and the Stop section shows only where the desk answers `browser.passwords.count`.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DeskLink } from '../../desk/deskLink';
import { uuidv7 } from '../../desk/idem';
import { LinkIcon } from '../linkIcons';
import type { SignInsUi } from './ExtTools';
import { sendPasswordsFile } from './importPasswords';
import { deleteAskWords, deletedWords, importDoneWords, importErrorWords, savedWords, type DeskExtension } from './signIns';
import './panel.css';

/** The privacy page's "An honest limit" (spec 9.4), on the landing. */
export const HONEST_LIMIT_URL = 'https://minimalistalliance.com/privacy#an-honest-limit';

/** A question asked in place: focus on it, and the whole box in view, buttons included. */
function showAsk(question: HTMLElement | null): void {
  question?.focus({ preventScroll: true });
  question?.closest('.pw-ask')?.scrollIntoView({ block: 'nearest' });
}

type Import = { kind: 'idle' } | { kind: 'adding' } | { kind: 'done'; words: string } | { kind: 'failed'; words: string };

function ManagerRow({ ext, children, state }: { ext: DeskExtension; state?: string; children?: ReactNode }) {
  return (
    <div className="xm-row" data-testid="pw-manager" data-ext={ext.name}>
      <span className="xm-chip" aria-hidden="true">
        <LinkIcon name="key" />
      </span>
      <span className="xm-open" style={{ cursor: 'default' }}>
        <span className="xm-name">{ext.name}</span>
        {state ? <span className="xm-state">{state}</span> : ext.maker ? <span className="xm-by">by {ext.maker}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** 9.1: the password manager, from the desk's own allowlist, in its order. Adding one is asked first, in place. */
function ManagerSection({ ui, at }: { ui: SignInsUi; at: 'top' | 'add' }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [going, setGoing] = useState<string | null>(null);
  const askRef = useRef<HTMLParagraphElement>(null);
  const { exts } = ui.view;
  const installed = exts.filter((e) => e.state === 'installed');
  const others = exts.filter((e) => e.state !== 'installed');
  // With one installed the section is about it (still 17); "Add a password manager" also shows the others.
  const listOthers = installed.length === 0 || at === 'add';

  useLayoutEffect(() => {
    if (asking) showAsk(askRef.current);
  }, [asking]);

  const add = (ext: DeskExtension): void => {
    setGoing(ext.id);
    setFailed(null);
    // deskd opens the manager's Web Store page as the member's own tab, where Add is their own click (API.md section 10).
    // The panel steps aside so that page is all in view, and the list is asked until it's in (`watchInstall`).
    ui.store
      .open(ext.id)
      .then((page) => {
        setAsking(null);
        if (page === 'store') ui.store.watchInstall(ext.id);
        ui.closePanel(true);
      })
      .catch(() => setFailed(ext.id))
      .finally(() => setGoing(null));
  };

  return (
    <section className="pw-sec" aria-labelledby="pw-h-manager">
      <h3 className="pw-h" id="pw-h-manager">Password manager</h3>
      {installed.length === 0 && <p className="pw-p">A password manager fills in your passwords and passkeys on this desk, and keeps them in step with your other devices through its own account.</p>}
      {installed.length > 0 && (
        <>
          <div className="pw-list">
            {installed.map((e) => (
              <ManagerRow key={e.id} ext={e} state="On this desk">
                <button type="button" className="xm-add" onClick={() => ui.openExtension(e.id)}>Open</button>
              </ManagerRow>
            ))}
          </div>
          {/* The key's manager, or the first: the spec's sentence names one. */}
          {(() => {
            const one = ui.key ?? (installed[0] as DeskExtension);
            return <p className="pw-p">Sign in to {one.name} in its window to fill in your passwords here. It keeps them in step with your other devices through your {one.name} account.</p>;
          })()}
        </>
      )}
      {listOthers && others.length > 0 && (
        <>
          <div className="pw-list">
            {others.map((e) =>
              asking === e.id ? (
                <div key={e.id} className="pw-ask" data-testid="pw-ask">
                  <p className="pw-h" ref={askRef} tabIndex={-1}>Add {e.name} to this desk?</p>
                  <p className="pw-p">{e.name} will be able to read and change every page you open in this desk’s Browser. That’s how it fills in your sign-ins. It’s made by {e.maker ?? e.name}, not by Minimalist Alliance.</p>
                  {failed === e.id && <p className="pw-p pw-err" role="alert">Couldn’t add {e.name}. Try again.</p>}
                  <div className="pw-acts">
                    <button type="button" className="pw-btn primary" disabled={going === e.id} onClick={() => add(e)}>{failed === e.id ? 'Try again' : 'Continue'}</button>
                    <button type="button" className="pw-btn" onClick={() => {
                      setAsking(null);
                      setFailed(null);
                    }}>Cancel</button>
                  </div>
                </div>
              ) : e.state === 'off' ? (
                <ManagerRow key={e.id} ext={e} state="Turned off on this desk" />
              ) : (
                <ManagerRow key={e.id} ext={e}>
                  <button type="button" className="xm-add" aria-label={`Add ${e.name}`} onClick={() => {
                    setFailed(null);
                    setAsking(e.id);
                  }}>Add</button>
                </ManagerRow>
              ),
            )}
          </div>
          <p className="pw-p pw-quiet">Each is made by its own company, under its own terms. You sign in to it in its own window, on the desk.</p>
        </>
      )}
    </section>
  );
}

/** 9.2: one passwords file, read on this device and sent to the desk over its link only (`importPasswords.ts`). */
function BringSection({ link }: { link: DeskLink | null }) {
  const [state, setState] = useState<Import>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const onFile = (input: HTMLInputElement): void => {
    const file = input.files?.[0] ?? null;
    // The page lets go of the pick at once: no File stays on the input, and Try again is a new pick.
    input.value = '';
    if (!file || !link) return;
    setState({ kind: 'adding' });
    void file
      .arrayBuffer()
      .then((buf) => sendPasswordsFile(link, new Uint8Array(buf)))
      .then(
        (counts) => live.current && setState({ kind: 'done', words: importDoneWords(counts) }),
        (err: unknown) => live.current && setState({ kind: 'failed', words: importErrorWords(err) }),
      );
  };

  const choose = (label: string) => (
    <button type="button" className="pw-btn" disabled={state.kind === 'adding'} onClick={() => inputRef.current?.click()} data-testid="pw-choose">
      <LinkIcon name="file" size={16} />
      {state.kind === 'adding' ? 'Adding…' : label}
    </button>
  );

  return (
    <section className="pw-sec" aria-labelledby="pw-h-bring" data-testid="pw-bring">
      <h3 className="pw-h" id="pw-h-bring">Bring passwords from another browser</h3>
      <input ref={inputRef} className="pw-file" type="file" accept=".csv,text/csv" tabIndex={-1} aria-hidden="true" data-testid="pw-file" onChange={(e) => onFile(e.currentTarget)} />
      {state.kind === 'done' ? (
        <>
          <div className="pw-result" role="status" data-testid="pw-result">
            <LinkIcon name="check" />
            <span>{state.words}</span>
          </div>
          <p className="pw-p">Now delete the file you exported on this device. It holds your passwords as plain text.</p>
          {choose('Choose another file…')}
        </>
      ) : (
        <>
          <p className="pw-p">Export your passwords from Chrome, Edge, Safari or Firefox as a CSV file, then choose it here. Your desk adds them to this Browser and deletes the file.</p>
          {state.kind === 'failed' && <p className="pw-p pw-err" role="alert" data-testid="pw-error">{state.words}</p>}
          {choose('Choose a CSV file…')}
          <p className="pw-p pw-quiet below">The file goes to your desk over its encrypted connection, and is deleted there once it’s read.</p>
        </>
      )}
      {state.kind === 'adding' && <span className="sr-only" role="status">Adding…</span>}
    </section>
  );
}

/** 9.5: only where the desk serves the count and the clear. The member's own act, so ADR 0035 holds. */
function StopSection({ ui, link }: { ui: SignInsUi; link: DeskLink | null }) {
  const [asking, setAsking] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [going, setGoing] = useState(false);
  const askRef = useRef<HTMLParagraphElement>(null);
  const saved = ui.view.saved;
  useLayoutEffect(() => {
    if (asking) showAsk(askRef.current);
  }, [asking]);
  if (saved === null && deleted === null) return null;

  const clear = (): void => {
    if (!link) return;
    setGoing(true);
    setFailed(false);
    link
      .call('browser.passwords.clear', {}, { idem: uuidv7() })
      .then((r) => {
        const n = typeof r?.deleted === 'number' && r.deleted >= 0 ? Math.floor(r.deleted) : saved ?? 0;
        setDeleted(n);
        setAsking(false);
        ui.store.setSaved(0);
      })
      .catch(() => setFailed(true))
      .finally(() => setGoing(false));
  };

  return (
    <section className="pw-sec" aria-labelledby="pw-h-stop" data-testid="pw-stop">
      <h3 className="pw-h" id="pw-h-stop">Stop</h3>
      {deleted !== null ? (
        <p className="pw-p" role="status">{deletedWords(deleted)}</p>
      ) : asking ? (
        <div className="pw-ask">
          <p className="pw-h" ref={askRef} tabIndex={-1}>{deleteAskWords(saved ?? 0)}</p>
          <p className="pw-p">Sites you’re signed in to stay signed in. The last 7 days of snapshots still hold them until each expires. This can’t be undone.</p>
          {failed && <p className="pw-p pw-err" role="alert">Your desk couldn’t delete them. Try again in a moment.</p>}
          <div className="pw-acts">
            <button type="button" className="pw-btn danger" disabled={going} onClick={clear}>Delete passwords</button>
            <button type="button" className="pw-btn" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="pw-p">{savedWords(saved ?? 0)}</p>
          {(saved ?? 0) > 0 && (
            <p className="pw-p">
              <button type="button" className="pw-link danger" onClick={() => setAsking(true)}>Delete the passwords saved in this desk’s Browser</button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

export interface PasswordsPanelProps {
  ui: SignInsUi;
  link: DeskLink | null;
  at: 'top' | 'add';
}

export default function PasswordsPanel({ ui, link, at }: PasswordsPanelProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [at]);

  return (
    <aside
      className="pw-panel"
      aria-labelledby={`${id}-t`}
      data-testid="passwords-panel"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // The shell's own Esc (leaving the desk) never hears it.
        e.preventDefault();
        e.stopPropagation();
        ui.closePanel(true);
      }}
    >
      <div className="pw-head">
        <button type="button" className="icon-btn sm pw-back" aria-label="Back" title="Back" onClick={() => ui.closePanel(true)}>
          <LinkIcon name="back" size={18} />
        </button>
        <h2 id={`${id}-t`} ref={titleRef} tabIndex={-1}>Passwords and sign-ins</h2>
        <button type="button" className="icon-btn sm pw-x" aria-label="Close" title="Close" onClick={() => ui.closePanel(true)}>
          <LinkIcon name="close" size={18} />
        </button>
      </div>
      <div className="pw-body">
        <ManagerSection ui={ui} at={at} />
        <BringSection link={link} />
        <section className="pw-sec" aria-labelledby="pw-h-passkeys">
          <h3 className="pw-h" id="pw-h-passkeys">Passkeys</h3>
          <p className="pw-p">With a password manager here, sites can make and use passkeys on this desk. A passkey on your phone, or a security key, can't reach a desk: when a site asks for one of those, choose another way to sign in.</p>
        </section>
        <section className="pw-sec" aria-labelledby="pw-h-kept">
          <h3 className="pw-h" id="pw-h-kept">Where they’re kept</h3>
          <p className="pw-p">
            Passwords saved in this desk’s Browser stay on this desk, on its encrypted disk and in its daily snapshots, as your signed-in sessions do. Our systems don’t read them in normal operation.{' '}
            <a className="pw-link" href={HONEST_LIMIT_URL} target="_blank" rel="noopener noreferrer">An honest limit</a>, in our privacy page, says what full admin access could do.
          </p>
          <p className="pw-p">A password manager also keeps your passwords in its own account, under its own terms.</p>
        </section>
        <StopSection ui={ui} link={link} />
      </div>
    </aside>
  );
}
