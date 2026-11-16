// Her handover card (the documents concept §8.2; deskd API.md §24 `docs_handover`): her reply carries a pointer only,
// `{deskId, docId}`, and the room draws the card from that desk itself (`docs.get`): the title, the reason in code's words and
// her one-line summary (italic, hers, with her small mark, never a star). A sensitive document shows code's fixed words
// instead of the summary, which only the viewer shows. Open (at the first changed page), What changed and Later.
import { useEffect, useMemo, useState } from 'react';
import { rpcDocsClient } from '../apps/documents/client';
import { itemParts } from '../apps/documents/model';
import { openDocument } from '../apps/documents/target';
import type { Doc } from '../apps/documents/types';
import { uuidv7 } from '../desk/idem';
import { useDeskLink, useLive } from '../desk/liveStore';
import type { DocPointer } from './source';
import { W } from './words';

export function HandoverCard({ doc: ptr, deskName }: { doc: DocPointer; deskName: string }) {
  const link = useDeskLink(ptr.deskId);
  const live = useLive(ptr.deskId);
  const open = live.link === 'open' && link !== null;
  const client = useMemo(() => (open && link ? rpcDocsClient(link, uuidv7) : null), [open, link]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [gone, setGone] = useState(false);
  const [held, setHeld] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    client.get(ptr.docId).then(
      (d) => alive && setDoc(d.doc),
      () => alive && setGone(true),
    );
    return () => {
      alive = false;
    };
  }, [client, ptr.docId]);

  const page = doc?.changedPages[0] ?? null;
  const parts = doc ? itemParts(doc) : null;
  const note = doc ? (doc.sensitive ? doc.sensitiveText : doc.summary?.line || null) : null;
  const label = doc ? `${W.docCard}: ${doc.title}` : W.docCard;

  if (gone) return null;
  return (
    <div className="mm-card mm-doc" role="group" aria-label={label} data-testid="mm-doc-card" data-doc={ptr.docId}>
      <p className="mm-card-lvl">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="mm-ico">
          <path d="M7 3.5h7.5L19 8v12.5H7z" />
          <path d="M14.5 3.5V8H19M10 12.5h6M10 16h4" />
        </svg>
        {W.docCard} · {deskName}
      </p>
      <p className="mm-card-title">{doc ? doc.title : '…'}</p>
      {parts?.reason && <p className="mm-card-meta">{parts.reason}</p>}
      {note &&
        (doc?.sensitive ? (
          <p className="mm-card-meta">{note}</p>
        ) : (
          <p className="mm-doc-note">
            <span className="mm-doc-mark" aria-hidden="true" />
            <span className="sr-only">{W.maiaNote} </span>
            <i>{note}</i>
          </p>
        ))}
      {held ? (
        <p className="mm-card-meta" role="status">{held}</p>
      ) : (
        <div className="mm-acts">
          <button type="button" className="mm-btn primary" onClick={() => openDocument(ptr.deskId, { docId: ptr.docId, page })}>
            {page ? W.openAtPage(page) : W.openShort}
          </button>
          {page && (
            <button type="button" className="mm-btn" onClick={() => openDocument(ptr.deskId, { docId: ptr.docId, page, changes: true })}>
              {W.whatChanged}
            </button>
          )}
          <button
            type="button"
            className="mm-btn quiet"
            disabled={!client}
            onClick={() => {
              void client?.tap(ptr.docId, 'not_now').then(
                (r) => setHeld(r.toast?.text ?? W.later),
                () => setHeld(W.later),
              );
            }}
          >
            {W.later}
          </button>
        </div>
      )}
    </div>
  );
}
