// Chat text: plain words, with web addresses as plain links (never fetched, never previewed).
import type { ReactNode } from 'react';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Splits text into strings and links. Trailing punctuation stays out of a link. */
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    while (/[.,;:!?)\]}]$/.test(url)) url = url.slice(0, -1);
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a key={at} href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A stable member color (0 to 7) from a member id, for people who aren't connected. */
export function colorOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 8;
}

export function timeOf(at: number, now = Date.now()): string {
  const d = new Date(at);
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return t;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${t}`;
}
