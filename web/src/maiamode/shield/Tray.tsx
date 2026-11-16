// The stack (the decision tray; the tray spec §8): papers gone through one at a time, like signing a stack. The catch-up's Needs
// you group *is* the stack: the top paper live, with two sheet edges under it while more wait, "1 of 3" beside the group label.
// An answered paper files away (up and out, 180 ms) leaving its one line ("X1 Carbon · sent to Scout"), and the next rises; Later
// sends one to the next catch-up. After the last, one tally line. A material opens beside the stack on a larger screen and as a
// sheet over it on a phone, with the paper's answers docked in its foot. No swipe or long-press answers anything.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useReach } from '../focusSource';
import { filedWords, tallyWords, type Filed, type Material, type Paper as PaperT, type Tray as TrayT } from '../tray';
import { onDnd, shareOn } from '../dnd';
import { R } from '../words';
import { nameOf, runGo } from './actions';
import { Materials } from './Materials';
import { Glyph, Paper } from './Paper';

export interface StackProps {
  tray: TrayT;
  /** The group's label row (in a catch-up and the sheet); off in her chat, which has its own words. */
  label?: boolean;
  /** The papers to go through, when not the whole tray (her chat's `[paper:…]`). */
  only?: readonly string[];
  className?: string;
}

const phoneNow = (): boolean => {
  try {
    return window.matchMedia('(max-width: 599px)').matches;
  } catch {
    return false;
  }
};

function FiledLine({ f }: { f: Filed }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void nameOf(f.who).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [f.who]);
  const w = filedWords(f, name);
  const at = f.at ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(f.at).replace(/\s?[AP]M$/i, '') : '';
  return (
    <li className={`sh-filed ${f.state}`} data-testid="tray-filed">
      <Glyph g={f.state === 'failed' || f.state === 'expired' ? 'clock' : 'check'} />
      <span className="sh-filed-lead">{w.lead}</span>
      <span className="sh-filed-rest">{` · ${w.rest}`}</span>
      {at && <span className="sh-filed-at">{at}</span>}
    </li>
  );
}

export function Stack({ tray, label = true, only, className = '' }: StackProps) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [local, setLocal] = useState<Filed[]>([]);
  const [answered, setAnswered] = useState(0);
  const [later, setLater] = useState(0);
  const [material, setMaterial] = useState<{ paperId: string; m: Material } | null>(null);
  const [rising, setRising] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [hidden, setHidden] = useState(shareOn());
  const [phone, setPhone] = useState(phoneNow());
  const live = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [right, setRight] = useState<number | null>(null);

  useEffect(() => onDnd(() => setHidden(shareOn())), []);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 599px)');
    const on = (): void => setPhone(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);

  const papers = useMemo(() => tray.papers.filter((p) => !gone.has(p.paperId) && (!only || only.includes(p.paperId))), [tray.papers, gone, only]);
  // The desk's filed lines win over this page's own once they come; the newest few, newest first.
  const filed = useMemo(() => {
    const seen = new Set<string>();
    const out: Filed[] = [];
    for (const f of [...tray.filed, ...local]) {
      if (seen.has(f.paperId) || (only && !only.includes(f.paperId))) continue;
      seen.add(f.paperId);
      out.push(f);
    }
    return out.slice(0, 3);
  }, [tray.filed, local, only]);
  const top = papers[0] ?? null;
  const total = answered + later + papers.length;
  const position = answered + later + 1;

  // On a larger screen the material opens beside the panel that holds the stack, at reading width.
  useEffect(() => {
    if (!material || phone) return;
    const panel = root.current?.closest('.sh-catchup, .sh-sheet, .sh-card, .sh-room, .mm-her') ?? root.current;
    const r = panel?.getBoundingClientRect();
    setRight(r ? Math.max(16, window.innerWidth - r.left + 12) : null);
  }, [material, phone]);
  // A material belongs to the paper on top: it closes when that paper leaves.
  useEffect(() => {
    if (material && material.paperId !== top?.paperId) setMaterial(null);
  }, [top?.paperId, material]);

  const file = useCallback((p: PaperT, f: Filed | null, counted: 'answered' | 'later') => {
    setLeaving(p.paperId);
    window.setTimeout(() => {
      setGone((g) => new Set(g).add(p.paperId));
      setLeaving(null);
      // A line the answer's outcome already wrote stays as it is.
      if (f) setLocal((l) => (l.some((x) => x.paperId === f.paperId) ? l : [f, ...l].slice(0, 5)));
      if (counted === 'answered') setAnswered((n) => n + 1);
      else setLater((n) => n + 1);
      const next = papers.find((x) => x.paperId !== p.paperId);
      setRising(next?.paperId ?? null);
      if (live.current && f) live.current.textContent = `${filedWords(f, null).lead}, ${filedWords(f, null).rest}`;
    }, phone || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
  }, [papers, phone]);

  const [changedIds, setChangedIds] = useState<Set<string>>(new Set());
  const answering = useRef<Set<string>>(new Set());
  const onAnswering = useCallback(
    (p: PaperT, labelText: string) => {
      answering.current.add(p.paperId);
      file(p, { paperId: p.paperId, kind: p.kind, label: labelText || null, to: p.asker.name, who: p.asker.who, state: 'sending', at: Date.now() }, 'answered');
    },
    [file],
  );
  const onAnswered = useCallback(
    (p: PaperT, labelText: string, delivered: string) => {
      const filedHere = answering.current.has(p.paperId);
      answering.current.delete(p.paperId);
      if (delivered === 'changed' || delivered === 'failed') {
        // Back on top: nothing went.
        setGone((g) => {
          const n = new Set(g);
          n.delete(p.paperId);
          return n;
        });
        setLocal((l) => l.filter((x) => x.paperId !== p.paperId));
        if (filedHere) setAnswered((n) => Math.max(0, n - 1));
        if (delivered === 'changed') setChangedIds((c) => new Set(c).add(p.paperId));
        return;
      }
      const state = delivered === 'gone' ? 'withdrawn' : delivered === 'queued' ? 'queued' : delivered === 'none' && /^Remind me/.test(labelText) ? 'answered' : 'sent';
      const f: Filed = { paperId: p.paperId, kind: p.kind, label: labelText || null, to: p.asker.name, who: p.asker.who, state, at: Date.now() };
      if (filedHere) setLocal((l) => [f, ...l.filter((x) => x.paperId !== p.paperId)].slice(0, 5));
      else file(p, f, 'answered');
    },
    [file],
  );
  const onLater = useCallback((p: PaperT) => file(p, null, 'later'), [file]);
  const onOpenAsker = useCallback((p: PaperT) => {
    const app = p.kind === 'reply' ? 'courier' : p.kind === 'todo' ? 'todo' : p.kind === 'doc' ? 'files' : 'agent';
    runGo({ kind: 'show', deskId: p.reply.deskId, app, ref: null }, null);
  }, []);

  const docked = phone && !!material && material.paperId === top?.paperId;
  const paperEl = top && (
    <Paper
      dock={docked}
      key={top.paperId}
      paper={top}
      rising={rising === top.paperId}
      hidden={hidden}
      open={material?.paperId === top.paperId ? material.m.materialId : null}
      onMaterial={(m) => setMaterial(m ? { paperId: top.paperId, m } : null)}
      onAnswering={onAnswering}
      onAnswered={onAnswered}
      wasChanged={changedIds.has(top.paperId)}
      onLater={onLater}
      onOpenAsker={onOpenAsker}
      className={leaving === top.paperId ? 'leaving' : rising === top.paperId ? 'rising' : ''}
    />
  );

  return (
    <div ref={root} className={`sh-stack${material && !phone ? ' widened' : ''} ${className}`} data-testid="tray-stack" aria-label={R.stackName} role="region">
      <span ref={live} className="sr-only" role="status" aria-live="polite" />
      {label && (
        <div className="sh-stack-head">
          <h3 className="sh-group-label">
            {R.needsYou}
            {total > 0 && <span className="sh-count">{total}</span>}
          </h3>
          {top && total > 1 && (
            <span className="sh-stack-pos">
              <span className="sh-dots" aria-hidden="true">
                {Array.from({ length: Math.min(total, 5) }, (_v, i) => (
                  <span key={i} className={i === Math.min(position, 5) - 1 ? 'on' : ''} />
                ))}
              </span>
              {R.ofN(position, total)}
            </span>
          )}
        </div>
      )}
      {filed.length > 0 && (
        <ul className="sh-filed-list" aria-label="Answered">
          {filed.map((f) => (
            <FiledLine key={f.paperId} f={f} />
          ))}
        </ul>
      )}
      {top ? (
        !docked && (
          <div className="sh-sheets" data-under={Math.min(2, papers.length - 1)}>
            {paperEl}
          </div>
        )
      ) : (
        (answered > 0 || later > 0) && <p className="sh-inset sh-stack-tally">{tallyWords(answered, later)}</p>
      )}
      {material &&
        top &&
        material.paperId === top.paperId &&
        createPortal(
        <div className={phone ? 'sh-mat-layer' : 'sh-mat-pane'} style={!phone && right !== null ? ({ ['--sh-mat-right' as string]: `${right}px` } as CSSProperties) : undefined}>
          <Materials paper={top} material={material.m} phone={phone} onClose={() => setMaterial(null)} onPick={(m) => setMaterial({ paperId: top.paperId, m })} dock={docked ? paperEl : undefined} />
        </div>,
          document.body,
        )}
    </div>
  );
}

/** The papers named in her chat's reply (`[paper:pp-…]`), drawn from the home desk's tray: her words never draw a paper. */
export function ChatPapers({ ids }: { ids: readonly string[] }) {
  const tray = useReach((s) => s.reach?.tray ?? null);
  if (!tray || !ids.some((id) => tray.papers.some((p) => p.paperId === id) || tray.filed.some((f) => f.paperId === id))) return null;
  return <Stack tray={tray} only={ids} label className="sh-chat-stack" />;
}
