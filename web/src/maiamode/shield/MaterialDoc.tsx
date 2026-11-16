// A document or a write-up inside a paper (the decision tray §4): the Documents viewer itself, embedded, on that desk's own channel.
// Pages stay paper-white in every theme with the changed ones marked, it opens at the changed page, and "Read as text" is there.
// A write-up is found by its id (`docs.byPath {writeup}`), since write-ups are documents on their own desk. Its own chunk: the
// viewer and its stylesheet load only when a material opens.
import { useEffect, useState } from 'react';
import { loadDocumentsBody } from '../../apps/chunks';
import { rpcDocsClient } from '../../apps/documents/client';
import { Viewer } from '../../apps/documents/Viewer';
import { uuidv7 } from '../../desk/idem';
import { useDeskLink } from '../../desk/liveStore';
import { api } from '../../platform/api';
import { R } from '../words';

export interface MaterialDocProps {
  deskId: string;
  docId: string | null;
  writeupId: string | null;
  phone: boolean;
  onClose(): void;
  idem(): string;
}

export default function MaterialDoc({ deskId, docId, writeupId, phone, onClose }: MaterialDocProps) {
  const link = useDeskLink(deskId);
  const [id, setId] = useState<string | null>(docId);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [said, setSaid] = useState('');
  useEffect(() => {
    let live = true;
    // The viewer's stylesheet comes with Documents' own chunk.
    void loadDocumentsBody().then(
      () => live && setReady(true),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setId(docId);
    if (docId || !writeupId || !link) return undefined;
    void link.call('docs.byPath' as never, { writeup: writeupId }, { deadlineMs: 15_000 }).then(
      (r) => {
        const found = (r as { id?: unknown } | null)?.id;
        if (live) {
          if (typeof found === 'string') setId(found);
          else setFailed(true);
        }
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [docId, writeupId, link]);
  if (failed || (!link && !id)) return <p className="sh-mat-empty">{R.materialFailed}</p>;
  if (!ready || !id || !link) return <p className="sh-mat-empty">{R.loadingMaterial}</p>;
  return (
    <div className="sh-mat-doc">
      <Viewer
        deskId={deskId}
        client={rpcDocsClient(link, uuidv7)}
        docId={id}
        askedPage={null}
        withChanges
        offline={false}
        phone={phone}
        maiaOn
        compact
        changed={{ ids: null, n: 0 }}
        shell={{ idem: uuidv7, api, announce: setSaid, setBusy: () => undefined, browserOpen: false }}
        onClose={onClose}
        say={setSaid}
        onTap={() => undefined}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}
