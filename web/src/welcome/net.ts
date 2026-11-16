// The welcome's calls to the interviewer (ma-platform contract maia.md "Welcome"), on support Maia's Function URL with the
// member's own token (`maia/net.ts`). Every answer is kept there, so a reload or another device can pick up (L3); the model's
// part comes back with it when there is one. Nothing here waits on the model: a turn that hasn't answered in 2.5 s is the
// scripted path's for this answer (CONCEPT.md §3.2 "Fallback"), and the late answer is dropped. Never sent: the member's name,
// to-dos, the names under Q4 (they stay in the browser), anything key-like (`secret.ts` cleared it), or a teen's anything.
import { maiaFetch } from '../maia/net';
import type { Answer, FollowUp } from './flow';

export const MODEL_WAIT_MS = 2500;
const PLAN_WAIT_MS = 6000;

export interface TurnReply {
  mode: 'model' | 'scripted';
  reason?: string;
  ack: string | null;
  echo: string | null;
  next: string | null;
  preAnswered: { q: string; choices: string[] }[];
  placed: { q?: string; choices: string[] } | null;
  followUp: { id: 'f1' | 'f2'; question: string; choices: string[] } | null;
  helper: { name: string; desk: 'work' | 'personal'; purpose: string } | null;
  cleared?: boolean;
}

export const SCRIPTED: TurnReply = Object.freeze({ mode: 'scripted', ack: null, echo: null, next: null, preAnswered: [], placed: null, followUp: null, helper: null }) as TurnReply;

export interface Kept {
  due: boolean;
  model: boolean;
  talk: { talkId: string; answers: Answer[]; followUps: FollowUp[]; startedAt: string } | null;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const strs = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= max).slice(0, n) : []);

/** A reply read defensively: anything malformed is as if the model said nothing (the office's own checks come after). */
export function readTurn(raw: unknown): TurnReply {
  if (!raw || typeof raw !== 'object') return SCRIPTED;
  const o = raw as Record<string, unknown>;
  const fu = o['followUp'] as Record<string, unknown> | null | undefined;
  const pl = o['placed'] as Record<string, unknown> | null | undefined;
  const he = o['helper'] as Record<string, unknown> | null | undefined;
  return {
    mode: o['mode'] === 'model' ? 'model' : 'scripted',
    ...(typeof o['reason'] === 'string' ? { reason: o['reason'] } : {}),
    ack: str(o['ack'], 20),
    echo: str(o['echo'], 60),
    next: str(o['next'], 4),
    preAnswered: Array.isArray(o['preAnswered'])
      ? (o['preAnswered'] as unknown[]).flatMap((p) => (p && typeof p === 'object' && str((p as Record<string, unknown>)['q'], 4) ? [{ q: (p as Record<string, string>)['q']!, choices: strs((p as Record<string, unknown>)['choices'], 6, 40) }] : [])).slice(0, 6)
      : [],
    placed: pl && typeof pl === 'object' ? { ...(str(pl['q'], 4) ? { q: pl['q'] as string } : {}), choices: strs(pl['choices'], 6, 40) } : null,
    followUp:
      fu && typeof fu === 'object' && (fu['id'] === 'f1' || fu['id'] === 'f2') && str(fu['question'], 60)
        ? { id: fu['id'], question: fu['question'] as string, choices: strs(fu['choices'], 4, 28) }
        : null,
    helper: he && typeof he === 'object' && str(he['name'], 24) && str(he['purpose'], 140) && (he['desk'] === 'work' || he['desk'] === 'personal') ? { name: he['name'] as string, desk: he['desk'], purpose: he['purpose'] as string } : null,
    ...(o['cleared'] === true ? { cleared: true } : {}),
  };
}

function readKept(raw: unknown): Kept {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const t = o['talk'] as Record<string, unknown> | null | undefined;
  const talk =
    t && typeof t === 'object' && typeof t['talkId'] === 'string'
      ? {
          talkId: t['talkId'],
          startedAt: typeof t['startedAt'] === 'string' ? t['startedAt'] : '',
          answers: (Array.isArray(t['answers']) ? (t['answers'] as unknown[]) : []).flatMap((a) => {
            if (!a || typeof a !== 'object') return [];
            const r = a as Record<string, unknown>;
            const q = str(r['q'], 4);
            return q ? [{ q, choices: strs(r['choices'], 8, 40), text: str(r['text'], 500), ...(r['skipped'] === true ? { skipped: true } : {}), ...(r['pre'] === true ? { pre: true } : {}) }] : [];
          }),
          followUps: (Array.isArray(t['followUps']) ? (t['followUps'] as unknown[]) : []).flatMap((f) => {
            if (!f || typeof f !== 'object') return [];
            const r = f as Record<string, unknown>;
            return (r['id'] === 'f1' || r['id'] === 'f2') && str(r['question'], 60) ? [{ id: r['id'] as 'f1' | 'f2', after: str(r['after'], 4) ?? '', question: r['question'] as string, choices: strs(r['choices'], 4, 28) }] : [];
          }),
        }
      : null;
  return { due: o['due'] === true, model: o['model'] === true, talk };
}

/** What the Platform kept, or null (no Maia URL, a refusal, a failure: the welcome then runs on this browser alone). */
export async function fetchKept(base: string | null): Promise<Kept | null> {
  if (!base) return null;
  try {
    const res = await maiaFetch(base, '/v1/maia/welcome');
    return res.ok ? readKept(await res.json()) : null;
  } catch {
    return null;
  }
}

/** Waits at most `ms` for the call; after that the answer is the scripted one, and a late reply is ignored. */
async function within<T>(ms: number, call: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), ms);
  try {
    return await call(ctl.signal);
  } catch {
    return fallback;
  } finally {
    window.clearTimeout(timer);
  }
}

export interface TurnBody {
  talkId: string;
  set: string[];
  answer: { q: string; choices: string[]; text: string | null; skipped: boolean };
  detail: string | null;
}

export function sendTurn(base: string | null, body: TurnBody, wait = MODEL_WAIT_MS): Promise<TurnReply> {
  if (!base) return Promise.resolve(SCRIPTED);
  return within(
    wait,
    async (signal) => {
      const res = await maiaFetch(base, '/v1/maia/welcome/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'answer', ...body }), signal });
      return res.ok ? readTurn(await res.json()) : SCRIPTED;
    },
    SCRIPTED,
  );
}

export function sendPlan(base: string | null, talkId: string, set: string[], detail: string | null): Promise<unknown> {
  if (!base) return Promise.resolve(null);
  return within(
    PLAN_WAIT_MS,
    async (signal) => {
      const res = await maiaFetch(base, '/v1/maia/welcome/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'plan', talkId, set, detail }), signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { mode?: unknown; plan?: unknown };
      return body.mode === 'model' ? (body.plan ?? null) : null;
    },
    null,
  );
}

/** The talk is deleted once the setup applies, or on Start over (§9). A failure leaves it to the 24-hour expiry. */
export async function forgetTalk(base: string | null): Promise<void> {
  if (!base) return;
  try {
    await maiaFetch(base, '/v1/maia/welcome', { method: 'DELETE' });
  } catch {
    /* it expires in a day */
  }
}

/** A talk id: a v4 UUID, as the Platform checks. */
export const newTalkId = (): string => crypto.randomUUID();
