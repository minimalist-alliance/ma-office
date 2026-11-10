// Dialogs for the Files window. Every one is a real dialog: labelled, modal inside the window, Tab kept within it, Escape
// closes it, and focus goes back to where it came from (the row, usually) when it closes. Destructive steps (emptying the
// trash, deleting for good, replacing) always ask; moving to the trash doesn't, as it can be undone from the trash.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { FilesApi } from './api';
import { FileIcon } from './FileIcon';
import { baseName, crumbs, isUnder, join, nameProblem, nfc, parent } from './paths';
import { errorWords, nameProblemWords } from './words';
import { toFilesError } from './api';
import type { FileEntry } from '../../desk/deskLink';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide = false, testId, toList = false }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; testId?: string; toList?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);

  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const returnTo = back.current;
    const root = el?.closest('.files-root');
    return () => {
      // Back to where it came from (the row, or the button pressed). If that has gone, or can't take focus now (a rename that
      // clears the selection leaves "Rename" disabled), to the list, so the keyboard is never dropped on the page.
      // `toList`: the thing that was acted on is about to change (a rename), so the button it came from is no place to land.
      if (!toList && returnTo instanceof HTMLElement && returnTo.isConnected && !(returnTo as HTMLButtonElement).disabled) returnTo.focus({ preventScroll: true });
      else root?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="files-scrim" onKeyDown={onKeyDown} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`files-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId ?? 'files-dialog'}>
        <h3 id={titleId}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Rename, and new folder: one name, checked against the grammar before it is sent. */
export function NameDialog({
  title,
  label,
  initial,
  submit,
  selectStem = false,
  toList = false,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  submit: string;
  selectStem?: boolean;
  /** Focus goes to the list afterwards, not back to the button (a rename changes what the button acts on). */
  toList?: boolean;
  /** Resolves null when done, or the words to show. */
  onSubmit(name: string): Promise<string | null>;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errId = useId();

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const name = nfc(value);
    const problem = nameProblem(name);
    if (problem) return setError(nameProblemWords(problem));
    if (name === initial) return onClose();
    setBusy(true);
    const words = await onSubmit(name);
    setBusy(false);
    if (words) setError(words);
    else onClose();
  };

  return (
    <Modal title={title} onClose={onClose} testId="files-name-dialog" toList={toList}>
      <form onSubmit={(e) => void send(e)} className="files-form">
        <label className="files-field">
          <span>{label}</span>
          <input ref={input} data-autofocus value={value} onChange={(e) => (setValue(e.target.value), setError(null))} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} autoComplete="off" spellCheck={false} maxLength={255} />
        </label>
        <p id={errId} className="files-error" role="alert">
          {error}
        </p>
        <div className="files-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({ title, body, confirm, danger = false, onConfirm, onClose }: { title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm(): void | Promise<void>; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} testId="files-confirm-dialog">
      <div className="files-form">
        <div className="files-body">{body}</div>
        <div className="files-actions">
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn primary${danger ? ' danger' : ''}`}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onConfirm()).finally(() => setBusy(false));
            }}
          >
            {confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** "Move to…": a folder picker, one level at a time. Drag is never the only way to move. */
export function MoveDialog({ api, paths, from, onMove, onClose }: { api: FilesApi; paths: string[]; from: string; onMove(folder: string): Promise<string | null>; onClose(): void }) {
  const [at, setAt] = useState(from);
  const [folders, setFolders] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const group = useId();

  useEffect(() => {
    let live = true;
    setFolders(null);
    api.list(at).then(
      (l) => live && setFolders(l.entries.filter((e) => e.type === 'dir' && !paths.some((p) => join(at, e.name) === p || isUnder(join(at, e.name), p)))),
      (err) => live && (setFolders([]), setError(errorWords(toFilesError(err), 'open that'))),
    );
    return () => {
      live = false;
    };
  }, [api, at, paths]);

  const here = crumbs(at);
  // Moving into the folder it is already in, or into itself, does nothing.
  const same = at === from || paths.some((p) => at === p || isUnder(at, p));
  const label = paths.length === 1 ? `Move "${baseName(paths[0]!)}" to` : `Move ${paths.length} items to`;

  return (
    <Modal title={label} onClose={onClose} wide testId="files-move-dialog">
      <div className="files-form">
        <nav aria-label="Folder you are choosing" className="files-crumbs small">
          <ol>
            {here.map((c, i) => (
              <li key={c.path}>
                {i === here.length - 1 ? (
                  <span aria-current="location">{c.name || 'Files'}</span>
                ) : (
                  <button type="button" className="link-btn" onClick={() => setAt(c.path)}>
                    {c.name || 'Files'}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <ul className="files-pick" aria-labelledby={group} data-autofocus tabIndex={-1}>
          {folders === null && <li className="files-quiet">Loading…</li>}
          {folders?.length === 0 && <li className="files-quiet">No folders in here.</li>}
          {folders?.map((f) => (
            <li key={f.name}>
              <button type="button" className="files-pick-row" onClick={() => setAt(join(at, f.name))}>
                <FileIcon name={f.name} type="dir" />
                <span className="files-name">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <span id={group} className="sr-only">
          Folders inside {at ? baseName(at) : 'Files'}
        </span>
        <p className="files-error" role="alert">
          {error}
        </p>
        <div className="files-actions">
          {at !== '' && (
            <button type="button" className="btn" onClick={() => setAt(parent(at))}>
              Up
            </button>
          )}
          <span className="files-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={same || busy}
            onClick={async () => {
              setBusy(true);
              const words = await onMove(at);
              setBusy(false);
              if (words) setError(words);
              else onClose();
            }}
          >
            Move here
          </button>
        </div>
      </div>
    </Modal>
  );
}
