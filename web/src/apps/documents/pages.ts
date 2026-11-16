// The viewer's page images: asked of the desk only as pages come into view (two at a time), each drawn by the desk's sandbox
// at the width it shows at, its bytes over `bulk` and held as a Blob URL while the viewer is open. Closing revokes every URL and
// stops what's on its way, so nothing of a document is kept after (the concept's §18: "no cache after the session").
import { toDocsError, type DocsClient, type DocsError } from './client';
import type { PageHead } from './types';

export interface PageImage {
  url: string;
  head: PageHead;
}

const AT_ONCE = 2;

export class PageImages {
  private readonly got = new Map<number, PageImage>();
  private readonly failed = new Set<number>();
  private readonly flying = new Map<number, AbortController>();
  private queue: number[] = [];
  private closed = false;

  constructor(
    private readonly client: DocsClient,
    private readonly docId: string,
    private readonly width: () => number,
    private readonly changed: () => void,
    /** A refusal for the whole document (danger, sandbox, offline, gone): the viewer says it instead of the pages. */
    private readonly refused: (e: DocsError) => void,
  ) {}

  get(n: number): PageImage | null {
    return this.got.get(n) ?? null;
  }

  isFailed(n: number): boolean {
    return this.failed.has(n);
  }

  /** The first page drawn tells every page's shape and the page count. */
  first(): PageHead | null {
    for (const v of this.got.values()) return v.head;
    return null;
  }

  /** Page `n` is in view (or next to it): ask for it, if it isn't here or on its way. */
  want(n: number): void {
    if (this.closed || this.got.has(n) || this.flying.has(n) || this.failed.has(n) || this.queue.includes(n)) return;
    this.queue.push(n);
    this.pump();
  }

  /** Asks again for a page that failed (the member's "Try again"). */
  retry(): void {
    this.failed.clear();
    this.changed();
  }

  private pump(): void {
    while (!this.closed && this.flying.size < AT_ONCE && this.queue.length) {
      const n = this.queue.shift()!;
      const stop = new AbortController();
      this.flying.set(n, stop);
      this.client.page(this.docId, n, this.width(), stop.signal).then(
        ({ head, blob }) => {
          this.flying.delete(n);
          if (this.closed) return;
          this.got.set(n, { url: URL.createObjectURL(blob), head });
          this.changed();
          this.pump();
        },
        (e: unknown) => {
          this.flying.delete(n);
          if (this.closed) return;
          const err = toDocsError(e);
          if (err.code === 'cancelled') return;
          if (['danger', 'sandbox', 'offline', 'gone', 'paused', 'old', 'switched_off'].includes(err.code)) {
            this.queue = [];
            this.refused(err);
          } else {
            this.failed.add(n);
            this.changed();
          }
          this.pump();
        },
      );
    }
  }

  /** Every URL revoked and every transfer stopped. */
  close(): void {
    this.closed = true;
    this.queue = [];
    for (const c of this.flying.values()) c.abort();
    this.flying.clear();
    for (const v of this.got.values()) URL.revokeObjectURL(v.url);
    this.got.clear();
  }
}
