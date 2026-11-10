// The turn's stream (contract maia.md, `POST /v1/maia/turn`): `data: <json>\n\n` frames, read with `fetch` and a
// ReadableStream, since EventSource can't POST or send the token. Pure. Every field is checked, and a frame type
// this app doesn't know, or one that doesn't parse, is dropped.
import { readFree, when, type Free } from './gate';

export interface Proposal {
  proposalId: string;
  action: string;
  params: Record<string, unknown>;
  expiresAt: string | null;
}

/** Why a turn stopped. `attachments`: the server refused the files, so the turn did not happen. Others pass through as sent. */
export type StopReason = 'attachments' | 'too_long' | (string & {});

export type Frame =
  | { type: 'start'; conversationId: string | null; messageId: string | null; modelLabel: string | null; newConversation: boolean; free: Free | null }
  | { type: 'notice'; code: string; text: string; resetsAt: string | null; upgrade: boolean }
  | { type: 'status'; code: string; text: string | null }
  | { type: 'text'; text: string }
  | ({ type: 'proposal' } & Proposal)
  | { type: 'stop'; reason: StopReason; text: string; resetsAt: string | null; retryable: boolean; free: FreeStop | null }
  | { type: 'done'; messageId: string | null }
  | { type: 'animation'; messageId: string | null; score: unknown };

/** Why a turn past the member's limit didn't get free Maia either. Her stop text already says it. */
export type FreeStop = 'busy' | 'unavailable' | 'limit';
const FREE_STOPS: readonly string[] = ['busy', 'unavailable', 'limit'];
export type { Free };

/** More than this without a frame's end is no stream of ours: it's dropped rather than held. */
const MAX_PENDING = 1024 * 1024;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

/** One parsed `data` payload as a frame, or null. */
export function readFrame(data: unknown): Frame | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const f = data as Record<string, unknown>;
  switch (f['type']) {
    case 'start':
      return {
        type: 'start',
        conversationId: id(f['conversationId']),
        messageId: id(f['messageId']),
        modelLabel: str(f['modelLabel'])?.slice(0, 60) ?? null,
        newConversation: f['newConversation'] === true,
        free: readFree(f['free']),
      };
    case 'notice': {
      const text = str(f['text']);
      return text === null ? null : { type: 'notice', code: str(f['code']) ?? '', text, resetsAt: when(f['resetsAt']), upgrade: f['upgrade'] === true };
    }
    case 'status':
      // `free_queue` carries its own line: free Maia is waiting in line (ma-platform ADR 0104). Short text only.
      return { type: 'status', code: str(f['code']) ?? '', text: str(f['text'])?.slice(0, 160) ?? null };
    case 'text': {
      const text = str(f['text']);
      return text === null ? null : { type: 'text', text };
    }
    case 'proposal': {
      const proposalId = id(f['proposalId']);
      const action = str(f['action']);
      const params = f['params'];
      if (!proposalId || !action || !params || typeof params !== 'object' || Array.isArray(params)) return null;
      return { type: 'proposal', proposalId, action, params: params as Record<string, unknown>, expiresAt: str(f['expiresAt']) };
    }
    case 'stop':
      return {
        type: 'stop',
        reason: str(f['reason']) ?? 'error',
        text: str(f['text']) ?? '',
        resetsAt: str(f['resetsAt']),
        retryable: f['retryable'] === true,
        free: typeof f['free'] === 'string' && FREE_STOPS.includes(f['free']) ? (f['free'] as FreeStop) : null,
      };
    case 'done':
      return { type: 'done', messageId: id(f['messageId']) };
    case 'animation':
      return { type: 'animation', messageId: id(f['messageId']), score: f['score'] };
    default:
      return null;
  }
}

/** Server-sent events, as far as this stream uses them: each event's `data:` lines, joined, are one JSON frame. */
export class FrameReader {
  private pending = '';

  /** Text as it arrives, in any chunks. Returns the frames it completed. */
  push(chunk: string): Frame[] {
    this.pending += chunk.replace(/\r\n?/g, '\n');
    const out: Frame[] = [];
    let end = this.pending.indexOf('\n\n');
    while (end >= 0) {
      const frame = parseEvent(this.pending.slice(0, end));
      if (frame) out.push(frame);
      this.pending = this.pending.slice(end + 2);
      end = this.pending.indexOf('\n\n');
    }
    if (this.pending.length > MAX_PENDING) this.pending = '';
    return out;
  }

  /** The stream ended: a last event with no blank line after it still counts. */
  end(): Frame[] {
    const rest = this.pending;
    this.pending = '';
    const frame = rest.trim() ? parseEvent(rest) : null;
    return frame ? [frame] : [];
  }
}

function parseEvent(block: string): Frame | null {
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  }
  if (!data.length) return null; // a comment or a keep-alive
  try {
    return readFrame(JSON.parse(data.join('\n')));
  } catch {
    return null;
  }
}
