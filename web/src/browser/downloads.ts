// What the Browser window says of the desk's downloads (LS-31, ADR 0092): one quiet line, for a download while it goes and
// for a few seconds after it ends, and one polite announcement as each starts and ends. Pure, so it's tested without a desk.
// A download this window didn't see going, already ended in the first list it hears, is old news and says nothing.
import type { BrowserDownload } from '../desk/deskLink';
import { deviceUrl } from './openOnDevice';

/** How long the line stays once a download has ended. */
export const SHOWN_AFTER_END_MS = 6000;

export interface DownloadLine {
  id: string;
  kind: 'going' | 'saved' | 'canceled';
  /** The words, with the file's name as plain text. */
  text: string;
  /** Whole percent while going, when the size is known. */
  percent: number | null;
  /** Where the file is in Files, only when it landed there (no image puts Browser downloads there yet). */
  filesPath: string | null;
  /** The finished download's own http(s) address, for "Get it on this device" (#9), when the desk says it. Never `blob:` or `data:`. */
  deviceUrl: string | null;
}

function percentOf(d: BrowserDownload): number | null {
  if (!(d.totalBytes > 0) || !(d.receivedBytes >= 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((d.receivedBytes * 100) / d.totalBytes)));
}

function endWords(d: BrowserDownload): string {
  if (d.state === 'canceled') return `Download canceled: ${d.name}`;
  return d.filesPath ? `Saved ${d.name} to Files` : `Saved ${d.name} on your desk`;
}

/** Only what the desk could have sent: anything else is dropped, so a malformed entry can't break the window. */
function wellFormed(d: unknown): d is BrowserDownload {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  return (
    typeof x['id'] === 'string' &&
    typeof x['name'] === 'string' &&
    (x['state'] === 'inProgress' || x['state'] === 'completed' || x['state'] === 'canceled') &&
    typeof x['receivedBytes'] === 'number' &&
    typeof x['totalBytes'] === 'number' &&
    (x['filesPath'] === undefined || typeof x['filesPath'] === 'string') &&
    (x['url'] === undefined || typeof x['url'] === 'string')
  );
}

export class DownloadWatch {
  private list: BrowserDownload[] = [];
  private heard = false;
  private readonly seen = new Set<string>();
  /** Seen under way by this window, so its end is news. */
  private readonly going = new Set<string>();
  /** When this window learned each one ended. */
  private readonly ended = new Map<string, number>();

  /** The desk's whole list, newest first. Returns what to announce, if anything: the newest news wins. */
  take(downloads: unknown, now: number): string | null {
    const list = Array.isArray(downloads) ? downloads.filter(wellFormed) : [];
    const first = !this.heard;
    this.heard = true;
    let say: string | null = null;
    // Oldest first, so the newest's words are the ones kept.
    for (const d of [...list].reverse()) {
      const isNew = !this.seen.has(d.id);
      this.seen.add(d.id);
      if (d.state === 'inProgress') {
        if (!this.going.has(d.id)) {
          this.going.add(d.id);
          if (!first) say = `Downloading ${d.name}`;
        }
      } else if (!this.ended.has(d.id) && (this.going.has(d.id) || (isNew && !first))) {
        this.ended.set(d.id, now);
        say = endWords(d);
      }
    }
    this.list = list;
    return say;
  }

  /** The line to show now: a download that just ended, else the newest still going, else none. */
  line(now: number): DownloadLine | null {
    const done = this.list.find((d) => {
      const at = this.ended.get(d.id);
      return d.state !== 'inProgress' && at !== undefined && now - at < SHOWN_AFTER_END_MS;
    });
    if (done) {
      const completed = done.state === 'completed';
      return { id: done.id, kind: completed ? 'saved' : 'canceled', text: endWords(done), percent: null, filesPath: completed ? (done.filesPath ?? null) : null, deviceUrl: completed ? deviceUrl(done.url) : null };
    }
    const going = this.list.find((d) => d.state === 'inProgress');
    if (going) return { id: going.id, kind: 'going', text: `Downloading ${going.name}`, percent: percentOf(going), filesPath: null, deviceUrl: null };
    return null;
  }

  /** When the line next changes by itself (an ended download's line going away), or null if it won't. */
  nextChangeAt(now: number): number | null {
    let next: number | null = null;
    for (const d of this.list) {
      const at = this.ended.get(d.id);
      if (at === undefined) continue;
      const end = at + SHOWN_AFTER_END_MS;
      if (end > now && (next === null || end < next)) next = end;
    }
    return next;
  }
}
