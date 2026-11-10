// Renaming a desk (task 45, words.md): from the desk's menu, its etched name becomes this field, in the same place, with
// the name selected. Enter saves, Esc cancels, and a click away saves a good new name or lets it go. A name Platform
// takes is everywhere at once (`deskRenamed`); one it refuses stays in the field with the reason in plain words.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { camera } from '../canvas/controller';
import { ETCH_BASELINE } from '../canvas/layout';
import { ApiError, patchDeskName } from '../platform/api';
import { deskRenamed } from '../platform/session';
import { useTierNames } from '../platform/useTiers';
import { focusBack } from '../shell/actions';
import { useDeskStore } from '../state/deskStore';
import { setView, useViewStore } from '../state/viewStore';
import { cleanName, kindLabel, MAX_DESK_NAME, nameProblem, renameFailure, withoutControls } from './rename';

const FIELD_H = 30; // matches .rename-field input
const MIN_W = 160;
const MAX_W = 320;
const EDGE = 8;
/** The field's middle sits on the etched name's: its baseline is ETCH_BASELINE up from the desk's foot, its caps about 10 px tall. */
const NAME_MIDDLE = ETCH_BASELINE + 5;

type At = { deskId: string; fromKeyboard: boolean };

function Field({ at }: { at: At }) {
  const desk = useDeskStore((s) => s.desks.find((d) => d.id === at.deskId));
  const names = useTierNames();
  const [value, setValue] = useState(() => desk?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  // Over the name, and with it on every camera write (a style write, nothing else). The stage's box doesn't move.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const box = camera.getStage()?.container().getBoundingClientRect();
    if (!el || !box) return undefined;
    const place = (): void => {
      const rect = camera.deskRect(at.deskId);
      if (!rect) return;
      const { s, x, y } = camera.cam;
      const width = Math.round(Math.max(MIN_W, Math.min(MAX_W, rect.w * s - 32)));
      const middle = box.left + (rect.x + rect.w / 2) * s + x;
      const top = box.top + (rect.y + rect.h) * s + y - NAME_MIDDLE - FIELD_H / 2;
      const left = Math.max(EDGE, Math.min(middle - width / 2, window.innerWidth - width - EDGE));
      el.style.width = `${width}px`;
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(EDGE, Math.min(top, window.innerHeight - FIELD_H - EDGE)))}px)`;
    };
    place();
    return camera.onMove(place);
  }, [at.deskId]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);

  // The desk went from the list while this was open: nothing to rename.
  useEffect(() => {
    if (!desk) setView({ renaming: null });
  }, [desk]);

  if (!desk) return null;

  const close = (): void => {
    setView({ renaming: null });
    if (at.fromKeyboard) focusBack(at.deskId);
  };

  const save = async (): Promise<void> => {
    if (busyRef.current) return;
    const name = cleanName(value);
    if (name === desk.name) {
      close();
      return;
    }
    const problem = nameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await patchDeskName(desk.id, name);
      deskRenamed(desk.id, typeof r.data?.name === 'string' && r.data.name ? r.data.name : name);
      close();
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      setError(renameFailure(err instanceof ApiError ? err : null, names));
      window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }));
    }
  };

  /** A click away, or Tab: a good new name is saved, anything else is let go, as Esc does. */
  const away = (): void => {
    if (busyRef.current) return;
    const name = cleanName(value);
    if (name !== desk.name && !nameProblem(name)) void save();
    else close();
  };

  const kind = kindLabel(desk.kind);
  return (
    <>
      <div className="desk-menu-away" onClick={away} onWheel={away} onContextMenu={(e) => { e.preventDefault(); away(); }} />
      <div ref={wrapRef} className="rename-field" data-testid="rename-field">
        <input
          ref={inputRef}
          type="text"
          value={value}
          aria-label="Desk name"
          title={kind}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'rename-kind rename-error' : 'rename-kind'}
          maxLength={MAX_DESK_NAME * 2}
          spellCheck={false}
          autoComplete="off"
          readOnly={busy}
          aria-busy={busy || undefined}
          onChange={(e) => {
            setValue(withoutControls(e.target.value));
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            // Esc belongs to the field here, not to the office's Esc (show all desks, close a window).
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              if (!busyRef.current) close();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void save();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              away();
            } else {
              e.stopPropagation();
            }
          }}
        />
        <span id="rename-kind" className="sr-only">{kind}</span>
        {error && (
          <p id="rename-error" className="rename-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

export function RenameField() {
  const at = useViewStore((s) => s.renaming);
  return at ? <Field key={at.deskId} at={at} /> : null;
}
