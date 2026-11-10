// Files in the Agent composer (ADR 0049). Pure, so a test can hold it. The owner's rule: files are never retained.
// Nothing here writes to any storage, and nothing holds a file's bytes: the composer keeps a name, a size and an upload id.
import type { AttachCapsView, AttachLimits, SentFile } from '../client/types';
import type { AgentError } from '../client/agentClient';

export const IMAGE_EXT: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const isImageName = (name: string, type = ''): boolean => IMAGE_EXT.includes(extOf(name)) || (!extOf(name) && type.startsWith('image/'));

/** "1.2 MB", "340 KB", "12 B". The desk's limits are in MiB (8 MiB a file), and a member reads them as "8 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** What the composer holds of a file: never its bytes. `ready` means the desk has all of it. */
export interface Staged {
  id: number;
  uploadId: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready';
  /** 0 to 1, while uploading. */
  progress: number;
}

export type StagedAction =
  | { type: 'add'; file: Staged }
  | { type: 'progress'; id: number; progress: number }
  | { type: 'ready'; id: number }
  | { type: 'remove'; id: number }
  | { type: 'clear' };

export function stagedReducer(state: readonly Staged[], a: StagedAction): Staged[] {
  switch (a.type) {
    case 'add':
      return [...state, a.file];
    case 'progress':
      return state.map((f) => (f.id === a.id && f.state === 'uploading' ? { ...f, progress: a.progress } : f));
    case 'ready':
      return state.map((f) => (f.id === a.id ? { ...f, state: 'ready', progress: 1 } : f));
    case 'remove':
      return state.filter((f) => f.id !== a.id);
    case 'clear':
      return [];
  }
}

export interface Incoming {
  name: string;
  size: number;
  type: string;
}

export interface Plan {
  /** Indexes into the incoming list that fit. */
  accepted: number[];
  /** Plain lines, each once. */
  messages: string[];
}

export function capLine(caps: AttachLimits): string {
  return `You can attach up to ${caps.maxFiles} ${caps.maxFiles === 1 ? 'file' : 'files'}, ${formatSize(caps.maxTotalBytes)} in all.`;
}

/**
 * Which of `incoming` can join `current`. Over-cap files are left out and said so; the others still go in. Only the caps and
 * the picture rule are checked here: what a file is, is the desk's to judge, by content, when it reads it.
 */
export function planAdd(current: readonly { name: string; size: number }[], incoming: readonly Incoming[], view: Pick<AttachCapsView, 'caps' | 'vision'>): Plan {
  const { caps } = view;
  const accepted: number[] = [];
  const messages: string[] = [];
  const say = (m: string): void => {
    if (!messages.includes(m)) messages.push(m);
  };
  let count = current.length;
  let total = current.reduce((s, f) => s + f.size, 0);
  incoming.forEach((f, i) => {
    if (current.some((c) => c.name === f.name && c.size === f.size) || accepted.some((j) => incoming[j]!.name === f.name && incoming[j]!.size === f.size)) return;
    const image = isImageName(f.name, f.type);
    if (f.size === 0) {
      say(`${f.name} is empty.`);
      return;
    }
    if (image && view.vision === false) {
      say("This agent's model can't read pictures. Pick one that can in Keys, or attach a document.");
      return;
    }
    const limit = image ? Math.min(caps.maxImageBytes, caps.maxFileBytes) : caps.maxFileBytes;
    if (f.size > limit) {
      say(`${f.name} is over ${formatSize(limit)}.`);
      return;
    }
    if (count + 1 > caps.maxFiles || total + f.size > caps.maxTotalBytes) {
      say(capLine(caps));
      return;
    }
    accepted.push(i);
    count += 1;
    total += f.size;
  });
  return { accepted, messages };
}

const n = (v: number | null | undefined, fallback: string): string => (v ? formatSize(v) : fallback);

/**
 * What the desk's refusal of a file or a send says, in plain words, or null when it isn't about files. `file` is the name the
 * desk gave. `busy` isn't here: the caller says it with `BUSY_WITH_FILES` when files are staged.
 */
export function attachErrorText(err: Pick<AgentError, 'reason' | 'file' | 'limit'>): string | null {
  const f = err.file ? err.file : 'A file';
  switch (err.reason) {
    case 'too_many':
      return `You can attach up to ${err.limit ?? 'a few'} files to one message.`;
    case 'too_large':
      return `${f} is over ${n(err.limit, 'the limit')}.`;
    case 'total_too_large':
      return `Those files add up to more than ${n(err.limit, 'the limit')}.`;
    case 'too_long':
      return `${f} has more text than the agent can read at once.`;
    case 'unsupported_type':
      return `${f} isn't a kind of file the agent can read.`;
    case 'legacy_office':
      return `${f} is an old Office format. Save it as .docx, .xlsx or .pptx and attach that.`;
    case 'binary':
      return `${f} isn't text the agent can read.`;
    case 'empty':
      return `${f} is empty.`;
    case 'encrypted':
      return `${f} is password protected. Remove the password and attach it again.`;
    case 'no_text':
      return `${f} has no text the agent can read. Scanned pages can't be read yet.`;
    case 'unreadable':
      return `${f} couldn't be read.`;
    case 'too_complex':
      return `${f} is too complex to read.`;
    case 'timeout':
      return `${f} took too long to read.`;
    case 'image_too_big':
      return `${f} is a picture too large for the model.`;
    case 'no_vision':
      return "This agent's model can't read pictures. Pick one that can in Keys, or attach a document.";
    case 'missing':
      return `${f} is no longer on your desk, which keeps files for 10 minutes at most. Attach it again.`;
    case 'bad_upload':
      return `${f} didn't arrive whole. Attach it again.`;
    case 'staging_full':
      return 'Your desk is holding a lot of files right now. Try again in a moment.';
    default:
      return null;
  }
}

/**
 * Whether the desk still holds the staged files after a refused send. It reads and zeroes them as it takes them, so any refusal
 * after that point (a file it can't read, a limit, an agent cap) leaves nothing to retry with. What leaves them: a `busy` or
 * `staging_full` desk and a missing key (all checked before it takes them), and anything that isn't an answer from the desk
 * (a dropped link, a timeout), where the next try says `missing` if they went.
 */
export function desksKeepsFiles(err: unknown): boolean {
  const e = err as { code?: unknown; reason?: unknown } | null;
  if (!e || typeof e.code !== 'string') return true;
  if (e.reason === 'busy' || e.reason === 'staging_full' || e.reason === 'no_key') return true;
  return ['unavailable', 'deadline_exceeded', 'cancelled', 'internal', 'rate_limited', 'unauthorized', 'step_up_required'].includes(e.code);
}

/** The line a `busy` refusal gets when files are staged: they stay, and the same send works in a moment. */
export const BUSY_WITH_FILES = 'This agent is still answering, or your desk is busy with other files. Yours are still attached: send again in a moment.';

/** After a refusal that took the files off the desk. */
export const FILES_CLEARED = 'Your files were removed from your desk. Attach them again when you’re ready.';

/** A short line for a sent message's chip: size, and the desk's note if it has one. */
export function sentLabel(f: SentFile): string {
  return formatSize(f.size);
}
