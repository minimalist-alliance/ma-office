// A paper's materials, opened inside the paper (the decision tray; the tray spec §4): the member never leaves to decide. A document
// or a write-up in the Documents viewer (pages paper-white in every theme, changed pages marked; "Read as text"), what an approval
// would do exactly as the Agent app's own card for that tool shows it, the last few messages of a conversation (read-only, from
// that desk's Courier at draw time, never kept), a to-do's own row. On a desk that's asleep it asks to wake it (the member's tap).
// Desktop: a pane beside the paper at reading width; a phone: a sheet over it with the paper's answers in its foot.
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { newIdem } from '../../../agent/src/client/agentClient';
import { useDeskStore } from '../../state/deskStore';
import { useLiveStore, linkOf, wakeDesk } from '../../desk/liveStore';
import { plain } from '../model';
import type { Material, Paper } from '../tray';
import { R } from '../words';
import { openApp } from './actions';
import { Glyph } from './Paper';
import { approvalOf } from './trayActions';

const DocView = lazy(() => import('./MaterialDoc'));

export interface MaterialsProps {
  paper: Paper;
  material: Material;
  onClose(): void;
  onPick(m: Material): void;
  phone: boolean;
  /** The paper's answers, docked in the phone sheet's foot. */
  dock?: ReactNode;
}

function Payload({ paper, material }: { paper: Paper; material: Material }) {
  const [view, setView] = useState<{ title: string; fields: { label: string; value: string; mono?: boolean }[]; note: string | null; untrusted: string | null } | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    const id = material.ref['approvalId'];
    if (!id) {
      setView('failed');
      return undefined;
    }
    void approvalOf(material.deskId, id).then(async (a) => {
      if (!live) return;
      if (!a) {
        setView('failed');
        return;
      }
      const { cardOf } = await import('../../../agent/src/model/approvals');
      const c = cardOf(a, paper.asker.agentId ? [{ id: paper.asker.agentId, name: paper.asker.name }] : []);
      if (live) setView({ title: c.title, fields: c.fields, note: c.note?.text ?? null, untrusted: c.untrustedLine });
    });
    return () => {
      live = false;
    };
  }, [material.deskId, material.ref, paper.asker.agentId, paper.asker.name]);
  if (view === null) return <p className="sh-mat-empty">{R.loadingMaterial}</p>;
  if (view === 'failed') return <p className="sh-mat-empty">{R.materialFailed}</p>;
  return (
    <div className="sh-mat-payload">
      <p className="sh-group-label">{R.payloadTitle}</p>
      <h4 className="sh-mat-title">{view.title}</h4>
      <dl className="sh-mat-fields">
        {view.fields.map((f, i) => (
          <div key={i} className="sh-mat-field">
            <dt>{f.label}</dt>
            <dd className={f.mono ? 'mono' : undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {view.note && <p className="sh-mat-note">{view.note}</p>}
      {view.untrusted && <p className="sh-mat-note">{view.untrusted}</p>}
    </div>
  );
}

function Thread({ material }: { material: Material }) {
  const [msgs, setMsgs] = useState<{ id: string; mine: boolean; text: string; at: number }[] | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    const link = linkOf(material.deskId);
    const channelId = material.ref['channelId'];
    if (!link || !channelId) {
      setMsgs('failed');
      return undefined;
    }
    void Promise.all([import('../../apps/courier/wire'), link.call('courier.thread' as never, { channelId, limit: 5 }, { deadlineMs: 15_000 })]).then(
      ([w, r]) => {
        if (!live) return;
        const t = w.readThread(r);
        setMsgs(
          (t?.messages ?? [])
            .slice(-5)
            .map((m) => ({ id: m.messageId, mine: m.direction === 'out', text: plain(m.text || m.snippet || m.subject || '', 400), at: m.at })),
        );
      },
      () => live && setMsgs('failed'),
    );
    return () => {
      live = false;
    };
  }, [material.deskId, material.ref]);
  if (msgs === null) return <p className="sh-mat-empty">{R.loadingMaterial}</p>;
  if (msgs === 'failed') return <p className="sh-mat-empty">{R.materialFailed}</p>;
  return (
    <div className="sh-mat-thread">
      <p className="sh-group-label">{R.conversationExcerpt}</p>
      <ol>
        {msgs.map((m) => (
          <li key={m.id} className={m.mine ? 'mine' : undefined}>
            {m.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TodoRow({ material, paper }: { material: Material; paper: Paper }) {
  return (
    <div className="sh-mat-todo">
      <p className="sh-group-label">To-do</p>
      <p className="sh-mat-title">{paper.title}</p>
      <button type="button" className="sh-btn quiet" onClick={() => openApp(material.deskId, 'todo')}>
        {R.openIn('To-do')}
      </button>
    </div>
  );
}

/** Which app a material's quiet "Open in …" goes to. */
const APP: Record<Material['kind'], [string, string]> = { doc: ['files', 'Documents'], writeup: ['files', 'Documents'], payload: ['agent', 'Agent'], thread: ['courier', 'Courier'], todo: ['todo', 'To-do'] };

export function Materials({ paper, material, onClose, onPick, phone, dock }: MaterialsProps) {
  const link = useLiveStore((s) => s.desks[material.deskId]?.link ?? 'idle');
  const deskName = useDeskStore((s) => plain(s.desks.find((d) => d.id === material.deskId)?.name ?? '', 40) || 'that');
  const asleep = link !== 'open';
  const [app, appName] = APP[material.kind];
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  let body: ReactNode;
  if (asleep) {
    body = (
      <div className="sh-mat-asleep">
        <p>{R.asleep(deskName)}</p>
        <div className="sh-acts">
          <button type="button" className="sh-btn primary" onClick={() => wakeDesk(material.deskId)}>
            {R.wake}
          </button>
          <button type="button" className="sh-btn quiet" onClick={onClose}>
            {R.notNowShort}
          </button>
        </div>
      </div>
    );
  } else if (material.kind === 'payload') body = <Payload paper={paper} material={material} />;
  else if (material.kind === 'thread') body = <Thread material={material} />;
  else if (material.kind === 'todo') body = <TodoRow paper={paper} material={material} />;
  else
    body = (
      <Suspense fallback={<p className="sh-mat-empty">{R.loadingMaterial}</p>}>
        <DocView deskId={material.deskId} docId={material.ref['docId'] ?? null} writeupId={material.ref['writeupId'] ?? null} phone={phone} onClose={onClose} idem={newIdem} />
      </Suspense>
    );
  return (
    <section className={`sh-material${phone ? ' phone' : ''}`} aria-label={material.label} data-testid="tray-material">
      {phone && <span className="sh-grab" aria-hidden="true" />}
      <header className="sh-mat-head">
        {paper.materials.length > 1 ? (
          <div className="sh-mat-tabs" role="tablist" aria-label={R.materials}>
            {paper.materials.map((m) => (
              <button key={m.materialId} type="button" role="tab" aria-selected={m.materialId === material.materialId} className={m.materialId === material.materialId ? 'on' : ''} onClick={() => onPick(m)}>
                <Glyph g={m.kind} />
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="sh-mat-name">
            <Glyph g={material.kind} />
            {material.label}
          </p>
        )}
        <button type="button" className="sh-icon-btn" aria-label={R.closeMaterial} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-ico">
            <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
          </svg>
        </button>
      </header>
      <div className="sh-mat-body">{body}</div>
      <footer className="sh-mat-foot">
        <button
          type="button"
          className="sh-btn quiet"
          onClick={() => {
            openApp(material.deskId, app);
            onClose();
          }}
        >
          {R.openIn(appName)}
        </button>
      </footer>
      {phone && dock && <div className="sh-mat-dock">{dock}</div>}
    </section>
  );
}
