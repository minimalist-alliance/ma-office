// A paper (the decision tray; the tray spec §1, §3, §5 and §8.5): one thing that needs the member's decision, raised on Maia's
// tray. Who's asking (the desk's etched name, then who), the time chip, the title, what it would do beyond the desk, her line in
// its sunken inset (labelled as hers, a tap shows where it came from), the supporting materials as soft pills, the answers that fit
// (one primary at most, her pick; none on a send), the free-form box addressed to whoever asked, and Later while the deadline
// allows. Send, pay, delete and share turn the answer row into the confirm strip that says exactly what goes where, with the
// button somewhere else from the first tap and asleep for 600 ms. Every answer is the member's own tap; nothing here is hers.
// Its look is the brand pass's (`design-drafts/maia-shield-brand/DIRECTION.md`) with the tray's own sheet.
import { useEffect, useId, useRef, useState } from 'react';
import { R } from '../words';
import { boxWords, chipWords, confirmWords, fillName, lineLabel, riskWords, type Material, type Paper as PaperT, type PaperAnswer } from '../tray';
import { nameOf } from './actions';
import { MaiaHalo, Source } from './Maia';
import { answerPaper, approvalOf, laterPaper } from './trayActions';
import { QuickReply, ReplyButton, useCanReply, useReplyGesture } from './QuickReply';
import { holdSend, type Held } from './quickReply';

/** The confirm button sleeps this long after the strip appears, so a double tap can't confirm (§5). */
export const CONFIRM_ARM_MS = 600;
/** The next paper's buttons ignore input this long after it rises (§5). */
export const RISE_MS = 400;

export interface PaperProps {
  paper: PaperT;
  /** The paper just rose from the stack: its buttons wait `RISE_MS`. */
  rising?: boolean;
  /** Someone else can see the screen: titles and lines are hidden. */
  hidden?: boolean;
  /** The material open beside or over it, if any. */
  open: string | null;
  onMaterial(m: Material | null): void;
  /** The member committed an answer: the stack files it now (the home desk drops it from its open papers at once). */
  onAnswering?(paper: PaperT, label: string): void;
  /** How it went: the stack's line says so; `changed` or `failed` puts the paper back on top. */
  onAnswered(paper: PaperT, label: string, delivered: string): void;
  /** This paper came back because its payload changed since it was shown. */
  wasChanged?: boolean;
  onLater(paper: PaperT): void;
  /** "Open Writer": the asker's own app (never needed to decide). */
  onOpenAsker(paper: PaperT): void;
  /** Docked in a phone's material sheet: only the answers, the box and Later. */
  dock?: boolean;
  className?: string;
}

type Mode = { kind: 'answers' } | { kind: 'confirm'; answer: PaperAnswer | 'custom'; text?: string } | { kind: 'note'; answer: PaperAnswer | null };

const GLYPH: Record<string, string> = {
  // a page: a document, a write-up
  doc: 'M7 3.5h7l3.5 3.5v13.5H7V3.5ZM14 3.5V7h3.5M9.5 11h5M9.5 14h5M9.5 17h3',
  writeup: 'M7 3.5h7l3.5 3.5v13.5H7V3.5ZM14 3.5V7h3.5M9.5 11h5M9.5 14h5M9.5 17h3',
  // a sheet of rows: exactly what it will do
  payload: 'M4.5 5.5h15v13h-15zM4.5 9.5h15M4.5 13.5h15M9.5 9.5v9',
  // a thread: speech bubbles
  thread: 'M6.5 4.5h11a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2H11l-4.5 3.5V16a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z',
  todo: 'M5 5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-13ZM8.5 12.2l2.4 2.4 4.6-4.8',
  // the time chip's clock
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4.4l2.8 1.8',
  // leaves the desk: a box with an arrow out
  out: 'M13 4.5h6.5V11M19.5 4.5 11 13M17.5 14v5.5h-13v-13H10',
  share: 'M13 4.5h6.5V11M19.5 4.5 11 13M17.5 14v5.5h-13v-13H10',
  coin: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM14.5 9.3c-.5-.8-1.4-1.3-2.5-1.3-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.9 2.5 2-1 2-2.5 2c-1.1 0-2-.5-2.5-1.3M12 6.5v11',
  bin: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7',
  lock: 'M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11M6 11h12v8.5H6z',
  check: 'm6.5 12.5 3.5 3.5 7.5-8',
  chevron: 'm10 7 5 5-5 5',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
};

export function Glyph({ g, className = 'sh-ico' }: { g: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d={GLYPH[g] ?? GLYPH['doc']} />
    </svg>
  );
}

/** Which pill an answer is: one primary (her pick, never a send's first tap, never Decline), Decline and Later quiet, else soft. */
function pillOf(p: PaperT, a: PaperAnswer, i: number): string {
  if (a.does === 'decline' || a.does === 'not_now') return 'quiet';
  if (p.pick === i && !a.confirm) return 'primary';
  return 'soft';
}

export function Paper({ paper, rising = false, hidden = false, open, onMaterial, onAnswering, onAnswered, onLater, onOpenAsker, dock = false, wasChanged = false, className = '' }: PaperProps) {
  const [name, setName] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'answers' });
  // A suggested reply would only ever fill the box (`freeform.draft`, the seam; none is sent today): the member sends.
  const [text, setText] = useState(paper.freeform.draft ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(wasChanged);
  const [armed, setArmed] = useState(true);
  const [awake, setAwake] = useState(!rising);
  const [title, setTitle] = useState<string | null>(null);
  // An approval's Approve shows only once its payload is loaded from the asking desk and hashes to what it asks about; its hash
  // goes with the answer, and the desk approves only that (Security's TRAY-M1).
  const [checked, setChecked] = useState<string | null>(null);
  // Whether the asking desk's tool can bring it back (a Trash): null until its approval is read.
  const [restorable, setRestorable] = useState<boolean | null>(null);
  const undoWords = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; foot: string; button: string } | null>(null);
  const [replying, setReplying] = useState(false);
  const [held, setHeld] = useState<Held | null>(null);
  const head = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const boxId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const deskName = paper.asker.label.split(' · ')[0] ?? 'your';

  useEffect(() => {
    let live = true;
    setName(null);
    void nameOf(paper.asker.who).then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, [paper.paperId, paper.asker.who]);

  // An approval's own words, from the asking desk at draw time: the Agent app's template for its tool (never the desk's title
  // stored anywhere), and the confirm strip's "what goes where" from the same payload.
  const approval = useRef<Awaited<ReturnType<typeof approvalOf>>>(null);
  useEffect(() => {
    let live = true;
    approval.current = null;
    undoWords.current = null;
    setTitle(null);
    setChecked(null);
    setRestorable(null);
    if (paper.kind !== 'approval' || !paper.reply.approvalId) return undefined;
    void approvalOf(paper.reply.deskId, paper.reply.approvalId).then(async (a) => {
      if (!live || !a) return;
      approval.current = a;
      const { cardOf, approvalChecks, toolWords } = await import('../../../agent/src/model/approvals');
      if (!live) return;
      setTitle(cardOf(a, paper.asker.agentId ? [{ id: paper.asker.agentId, name: paper.asker.name }] : []).title);
      const undo = toolWords(a.tool)?.undo?.((a.payload ?? {}) as Record<string, unknown>) ?? null;
      undoWords.current = undo;
      setRestorable(!!undo);
      if (a.state === 'pending' && (await approvalChecks(a)) && live) setChecked(a.sha256);
    });
    return () => {
      live = false;
    };
  }, [paper.paperId, paper.kind, paper.reply.deskId, paper.reply.approvalId, paper.asker.agentId, paper.asker.name]);

  // A paper that rose from the stack ignores input for a moment.
  useEffect(() => {
    if (!rising) return undefined;
    setAwake(false);
    const t = window.setTimeout(() => setAwake(true), RISE_MS);
    return () => window.clearTimeout(t);
  }, [rising, paper.paperId]);

  // The confirm strip's button sleeps, then takes the focus (never under the finger that tapped).
  useEffect(() => {
    if (mode.kind !== 'confirm') return undefined;
    setArmed(false);
    const t = window.setTimeout(() => {
      setArmed(true);
      confirmRef.current?.focus({ preventScroll: true });
    }, CONFIRM_ARM_MS);
    return () => window.clearTimeout(t);
  }, [mode]);

  useEffect(() => {
    if (mode.kind === 'note') noteRef.current?.focus({ preventScroll: true });
  }, [mode]);

  const to = fillName(paper.asker.name, name);
  // A person's message: quick reply (the arrow, Reply, a drag down or R), sent as this paper's answer after a 5 s Undo.
  const replyAnswer = paper.answers.find((a) => a.does === 'reply') ?? null;
  const replyTarget = useCanReply(paper.kind === 'reply' && paper.asker.who && paper.reply.channelId && replyAnswer ? { deskId: paper.reply.deskId, channelId: paper.reply.channelId, who: paper.asker.who } : null);
  useReplyGesture(head, sheet, replyTarget && !replying && !dock ? () => setReplying(true) : null);
  const shownTitle = hidden ? R.hidden(to) : fillName(title ?? paper.title, name);
  const chip = chipWords(paper, Date.now());
  const risk = riskWords(paper.risk, restorable);
  const herLabel = lineLabel(paper, name);
  const box = boxWords(paper, name);
  const fromMaterial = paper.line?.from ? paper.materials.find((m) => m.materialId === paper.line?.from) ?? null : null;

  // Until the payload is loaded and checks out, an approval offers Ask for changes, Decline and Later only.
  const shownAnswers = paper.kind === 'approval' && !checked ? paper.answers.filter((a) => a.does !== 'approve') : paper.answers;

  const send = async (answer: PaperAnswer | 'custom', words?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const label = answer === 'custom' ? (paper.kind === 'approval' ? 'Sent back with your note' : 'Your reply') : answer.label.replace(/…$/, '');
    // Filed now, as the home desk files it: the next paper rises while this one's answer is carried.
    onAnswering?.(paper, label);
    try {
      const r = await answerPaper(paper, answer, words, checked);
      if (r.delivered === 'changed') {
        setChanged(true);
        setMode({ kind: 'answers' });
        onAnswered(paper, label, 'changed');
        return;
      }
      if (r.delivered === 'failed') {
        setError(R.failed);
        setMode({ kind: 'answers' });
        onAnswered(paper, label, 'failed');
        return;
      }
      onAnswered(paper, label, r.delivered);
    } catch (e) {
      // Answered on another device or in the Agent app first: it simply leaves, never as an error.
      if (String((e as { code?: unknown })?.code ?? '') === 'conflict') onAnswered(paper, '', 'gone');
      else {
        setError(R.failed);
        setMode({ kind: 'answers' });
        onAnswered(paper, label, 'failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const tap = (a: PaperAnswer): void => {
    if (!awake || busy) return;
    if (a.does === 'open') {
      if (paper.materials[0]) onMaterial(paper.materials[0]);
      else onOpenAsker(paper);
      return;
    }
    if (a.confirm) {
      setConfirm(confirmWords(a.confirm, approval.current ? { tool: approval.current.tool, payload: approval.current.payload, target: approval.current.target, undo: undoWords.current } : null, deskName));
      // Asleep from its first frame: never live under the finger that tapped.
      setArmed(false);
      setMode({ kind: 'confirm', answer: a });
      return;
    }
    if (a.does === 'reply' && replyTarget) {
      setReplying(true);
      return;
    }
    if (a.does === 'revise' || a.does === 'reply') {
      setMode({ kind: 'note', answer: a });
      return;
    }
    void send(a);
  };

  /** The box's words go: an approval's as the note with a decline ("Send back"); a person's after the confirm strip. */
  const submitBox = (answer: PaperAnswer | null): void => {
    const words = text.trim();
    if (!words || busy) return;
    if (paper.kind === 'reply' || (paper.kind === 'doc' && paper.freeform.as === 'reply')) {
      // Typing and Send is deliberate: no second confirm; it waits 5 s with Undo (the owner, Nov 15).
      const h = holdSend(() => send(answer ?? 'custom', words));
      setHeld(h);
      void h.done.then((r) => {
        if (r === 'undone') setHeld(null);
      });
      return;
    }
    void send(answer ?? 'custom', words);
  };

  const noteMode = mode.kind === 'note' ? mode : null;
  const confirming = mode.kind === 'confirm' ? mode : null;

  return (
    <article
      ref={sheet}
      className={`sh-paper${dock ? ' docked' : ''}${noteMode ? ' noting' : ''}${confirming ? ' confirming' : ''}${replying ? ' replying' : ''} ${className}`}
      aria-label={R.paperName(shownTitle)}
      data-testid="tray-paper"
      data-paper={paper.paperId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && mode.kind !== 'answers') {
          e.stopPropagation();
          setMode({ kind: 'answers' });
        } else if (replyTarget && !replying && (e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as Element).closest('input, textarea')) {
          e.preventDefault();
          setReplying(true);
        }
      }}
    >
      {!dock && (
        <>
      <header ref={head} className={`sh-paper-head${replyTarget ? ' sh-pull' : ''}`}>
        <Source text={fillName(paper.asker.label, name)} />
        {chip && (
          <span className="sh-time-chip">
            <Glyph g="clock" />
            {chip}
          </span>
        )}
        {replyTarget && !replying && !hidden && <ReplyButton name={to} onClick={() => setReplying(true)} />}
      </header>
      <h3 className="sh-paper-title">{shownTitle}</h3>
      {!hidden && (risk || paper.untrusted) && (
        <div className="sh-paper-risks">
          {risk && (
            <p className="sh-paper-risk">
              <Glyph g={risk.glyph} />
              {risk.text}
            </p>
          )}
          {paper.untrusted && paper.kind === 'approval' && (
            <p className="sh-paper-risk">
              <Glyph g="eye" />
              {R.readWeb(to)}
            </p>
          )}
        </div>
      )}
      {hidden ? (
        <p className="sh-paper-hidden">{R.hiddenLine}</p>
      ) : (
        paper.line && (
          <div className={`sh-inset sh-her${herLabel ? '' : ' code'}`}>
            {herLabel && (
              <p className="sh-her-head">
                {paper.line.by === 'maia' || paper.line.by === 'reader' ? <MaiaHalo size="xs" /> : null}
                <span className="sh-her-label">{herLabel}</span>
              </p>
            )}
            <p className={herLabel ? 'sh-her-line' : 'sh-her-plain'}>{fillName(paper.line.text, name)}</p>
            {fromMaterial && (
              <button type="button" className="sh-her-from" onClick={() => onMaterial(fromMaterial)}>
                {paper.line.by === 'agent' || fromMaterial.kind === 'writeup' ? R.fromWriteup(to) : `From ${fromMaterial.label}`}
                <Glyph g="chevron" className="sh-ico sm" />
              </button>
            )}
          </div>
        )
      )}
      {!hidden && paper.materials.length > 0 && (
        <div className="sh-materials" role="group" aria-label={R.materials}>
          {paper.materials.map((m) => (
            <button key={m.materialId} type="button" className={`sh-material-pill${open === m.materialId ? ' on' : ''}`} aria-pressed={open === m.materialId} onClick={() => onMaterial(open === m.materialId ? null : m)}>
              <Glyph g={m.kind} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
        </>
      )}
      {changed && (
        <div className="sh-inset sh-changed" role="status">
          <p>{R.changed}</p>
          <button
            type="button"
            className="sh-btn quiet"
            onClick={() => {
              setChanged(false);
              const m = paper.materials.find((x) => x.kind === 'payload');
              if (m) onMaterial(m);
            }}
          >
            {R.showAgain}
          </button>
        </div>
      )}
      {held ? (
        <div className="sh-qr sh-qr-held" role="status" data-testid="quick-reply-held">
          <span className="sh-qr-sent">{R.sentTo(to)}</span>
          <button type="button" className="sh-btn quiet" onClick={() => held.undo()}>
            {R.undo}
          </button>
        </div>
      ) : replying && replyTarget && replyAnswer ? (
        <QuickReply
          target={replyTarget}
          name={name}
          onClose={() => setReplying(false)}
          onDone={() => undefined}
          send={(words) => send(replyAnswer, words)}
        />
      ) : confirming && confirm ? (
        <div className="sh-confirm" role="group" aria-label={confirm.title}>
          <p className="sh-confirm-title">{confirm.title}</p>
          <p className="sh-confirm-foot">{confirm.foot}</p>
          <div className="sh-confirm-acts">
            <button type="button" className="sh-btn quiet" disabled={busy} onClick={() => setMode(confirming.text ? { kind: 'note', answer: confirming.answer === 'custom' ? null : confirming.answer } : { kind: 'answers' })}>
              {confirming.text ? 'Edit' : R.back}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className="sh-btn primary"
              data-testid="tray-confirm"
              aria-disabled={!armed || busy}
              onClick={() => {
                if (!armed || busy) return;
                void send(confirming.answer, confirming.text);
              }}
            >
              {busy ? R.sending : confirm.button}
            </button>
          </div>
        </div>
      ) : (
        <>
          {!changed && (
            <div className={`sh-answers${noteMode ? ' chosen' : ''}`} role="group" aria-label={R.answersName}>
              {shownAnswers.map((a) => {
                const i = paper.answers.indexOf(a);
                const chosen = noteMode?.answer?.id === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`sh-btn ${chosen ? 'chosen' : pillOf(paper, a, i)}`}
                    aria-pressed={noteMode ? chosen : undefined}
                    aria-disabled={!awake || busy}
                    disabled={!!noteMode && !chosen}
                    onClick={() => (chosen ? setMode({ kind: 'answers' }) : tap(a))}
                  >
                    {chosen && <Glyph g="check" />}
                    {a.label}
                  </button>
                );
              })}
            </div>
          )}
          {noteMode ? (
            <div className="sh-note">
              <label className="sh-note-label" htmlFor={boxId}>
                {paper.freeform.as === 'note' ? `Note for ${to}` : `Reply to ${to}`}
              </label>
              <textarea
                id={boxId}
                ref={noteRef}
                className="sh-note-box"
                rows={3}
                maxLength={paper.freeform.max || 500}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitBox(noteMode.answer);
                  }
                }}
              />
              <p className="sh-note-hint">
                <Glyph g="lock" />
                {paper.freeform.as === 'note' ? R.noteHint(to, null) : R.replyHint(to)}
              </p>
              <div className="sh-note-acts">
                <button type="button" className="sh-btn quiet" onClick={() => setMode({ kind: 'answers' })}>
                  {R.cancel}
                </button>
                <button type="button" className="sh-btn primary" disabled={!text.trim() || busy} onClick={() => submitBox(noteMode.answer)}>
                  {paper.freeform.as === 'note' ? R.sendBackTo(to) : R.sendTo(to)}
                </button>
              </div>
            </div>
          ) : (
            (box || paper.later.allowed) && (
              <div className="sh-paper-foot">
                {box && (
                  <form
                    className="sh-reply"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitBox(null);
                    }}
                  >
                    <label className="sr-only" htmlFor={boxId}>
                      {box}
                    </label>
                    <input id={boxId} className="sh-reply-box" placeholder={box} maxLength={paper.freeform.max || 500} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
                    {text.trim() && (
                      <button type="submit" className="sh-btn quiet sh-reply-send" disabled={busy}>
                        {paper.freeform.as === 'note' ? R.sendBack : 'Send'}
                      </button>
                    )}
                  </form>
                )}
                {paper.later.allowed && (
                  <button
                    type="button"
                    className="sh-btn quiet sh-later"
                    aria-disabled={!awake || busy}
                    onClick={() => {
                      if (!awake || busy) return;
                      void laterPaper(paper).then(
                        () => onLater(paper),
                        () => setError(R.failed),
                      );
                    }}
                  >
                    {paper.later.kind === 'in_20' ? R.in20 : R.laterPaper}
                  </button>
                )}
              </div>
            )
          )}
        </>
      )}
      {error && (
        <p className="sh-paper-error" role="status">
          {error}
        </p>
      )}
    </article>
  );
}
