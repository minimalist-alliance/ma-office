// The body of `POST /v1/maia/turn`, and nothing else (contract maia.md). The privacy promise: a turn carries only
// what the member typed to her and these four fields. Never page content, desk content, window titles, the
// clipboard, or anything typed in a desk. Pure, so a test can hold it to exactly this shape.

import type { WireFile } from './attachments';

export interface TurnBody {
  conversationId: string | null;
  message: string;
  clientContext: {
    surface: 'office';
    appVersion: string;
    route: 'home' | 'desk';
    lastErrorCode: string | null;
  };
  /** Only when the member attached files. Their bytes ride this one request and are kept nowhere. */
  attachments?: WireFile[];
}

export const MAX_MESSAGE_CHARS = 4000;
const VERSION = /^[0-9A-Za-z._-]{1,40}$/;
const CODE = /^[a-z0-9_]{1,40}$/;

/** This app's version as the contract's pattern allows it. */
export const appVersionFor = (v: unknown): string => (typeof v === 'string' && VERSION.test(v) ? v : 'unknown');

export interface TurnContext {
  appVersion: string;
  /** The office overview, or a desk filling the screen. */
  route: 'home' | 'desk';
  /** A Platform error code the member is seeing now, such as `connect`'s refusal of the desk on screen. */
  lastErrorCode: string | null;
}

export function turnBody(conversationId: string | null, message: string, ctx: TurnContext, attachments: readonly WireFile[] = []): TurnBody {
  const body: TurnBody = {
    conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
    message: message.slice(0, MAX_MESSAGE_CHARS),
    clientContext: {
      surface: 'office',
      appVersion: appVersionFor(ctx.appVersion),
      route: ctx.route === 'desk' ? 'desk' : 'home',
      lastErrorCode: typeof ctx.lastErrorCode === 'string' && CODE.test(ctx.lastErrorCode) ? ctx.lastErrorCode : null,
    },
  };
  if (attachments.length) body.attachments = attachments.map((a) => ({ name: a.name, type: a.type, data: a.data }));
  return body;
}

/** `connect`'s refusal codes (contract desks.md), from what the desk's link recorded. */
export function refusalCode(kind: 'suspended' | 'inactive' | 'unavailable' | 'data_guard' | null | undefined): string | null {
  switch (kind) {
    case 'suspended':
      return 'account_suspended';
    case 'inactive':
      return 'account_inactive';
    case 'unavailable':
      return 'desk_unavailable';
    case 'data_guard':
      return 'data_guard';
    default:
      return null;
  }
}

/** A plain line for a turn the server refused before it began (contract maia.md). */
export function refusedLine(status: number, code: string | null): string {
  if (status === 409 || code === 'turn_in_progress') return "Maia is still answering your last message. Try again in a moment.";
  if (status === 429 || code === 'rate_limited') return "That's a lot of messages at once. Try again in a minute.";
  if (status === 503 || code === 'busy') return 'Maia is busy right now. Try again in a moment.';
  if (status === 400) return "Maia couldn't read that message.";
  return "Maia can't answer right now. Try again in a moment.";
}
