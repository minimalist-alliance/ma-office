// File chips in Maia's composer and in the chat. Plain text and buttons: nothing here reads a file.
import { formatSize, type AttachedChip, type Pending, type Sent } from './attachments';
import { MaiaIcon } from './icons';

/** Files waiting to be sent: a list, each with a remove button. */
export function PendingChips({ files, onRemove }: { files: Pending[]; onRemove: (id: number) => void }) {
  if (!files.length) return null;
  return (
    <ul className="maia-chips" aria-label="Attached files">
      {files.map((f) => (
        <li key={f.id} className="maia-chip">
          <span className="maia-chip-name">{f.name}</span>
          <span className="maia-chip-size">{formatSize(f.size)}</span>
          <button type="button" className="maia-chip-x" aria-label={`Remove ${f.name}`} title={`Remove ${f.name}`} onClick={() => onRemove(f.id)}>
            <MaiaIcon name="close" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Files a message carried, as small chips that do nothing. */
export function SentChips({ files, past }: { files?: Sent[]; past?: AttachedChip[] }) {
  const list = [
    ...(files ?? []).map((f) => ({ name: f.name, meta: formatSize(f.size) })),
    ...(past ?? []).map((c) => ({ name: c.name, meta: `${c.type}, ${c.size}` })),
  ];
  if (!list.length) return null;
  return (
    <ul className="maia-chips maia-chips-sent" aria-label="Attached files">
      {list.map((c, i) => (
        <li key={`${i}-${c.name}`} className="maia-chip">
          <span className="maia-chip-name">{c.name}</span>
          <span className="maia-chip-size">{c.meta}</span>
        </li>
      ))}
    </ul>
  );
}
