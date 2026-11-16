// The welcome's talk as pure rules (CONCEPT.md §2 and §4): who gets which questions, which comes next, what Skip means, the
// fill steps while a desk still builds, and the 10-step cap. No browser, no network: `flow.test.ts` covers every rule.
import { QUESTIONS, type QId } from './catalogue';

/** What the office knows about this member, read once at the start (never asked: §4.1 "Never asked"). */
export interface Who {
  teen: boolean;
  /** `free`, `alliance`, `officer`, `lead` (Founder), or null. */
  tier: string | null;
  /** Maia's desk role is open to them (`maiamode/prefs.ts` `allowedFor`): Q5, Q8 and the consent sheet. */
  maia: boolean;
  /** The shield's stores exist (its seam, `seams.ts`): Q4 and Q6. The honesty rule (§5.1): without them, not asked. */
  shield: boolean;
  /** Officer or Founder: desks can be renamed (F1). */
  rename: boolean;
  /** Courier is on (F3, the Inbox helper's mail). */
  courier: boolean;
}

/** The questions this member gets, in the catalogue's order (§4.2 "Counts"). Teens: Q1 and their own Q2 (§4.4). */
export function questionSet(who: Who): QId[] {
  if (who.teen) return ['q1', 't2'];
  const set: QId[] = ['q1', 'q2', 'q3'];
  if (who.maia && who.shield) set.push('q4');
  if (who.maia) set.push('q5');
  if (who.maia && who.shield) set.push('q6');
  set.push('q7');
  if (who.maia) set.push('q8');
  return set;
}

/** Q1 to Q3 are always first, in order; the model may reorder the rest (§4.1 "Order"). */
const FIXED: readonly QId[] = ['q1', 'q2', 'q3', 't2'];

export interface Answer {
  q: string;
  choices: string[];
  /** The member's own words, as typed (never a key: `secret.ts` cleared it first). */
  text: string | null;
  skipped?: boolean;
  /** Filled in from an earlier answer's words by the model; shown in the summary like any other. */
  pre?: boolean;
}

export interface FollowUp {
  id: 'f1' | 'f2';
  /** The question it follows. */
  after: string;
  question: string;
  choices: string[];
}

/**
 * The next question: the fixed ones first, then the model's pick when it's one of this set's unanswered ones, else the set's
 * own order. Null when every question has an answer.
 */
export function nextQuestion(set: readonly QId[], answers: Readonly<Record<string, Answer>>, modelPick: string | null = null): QId | null {
  const open = set.filter((q) => !answers[q]);
  if (!open.length) return null;
  const fixed = open.find((q) => FIXED.includes(q));
  if (fixed) return fixed;
  if (modelPick && (open as string[]).includes(modelPick)) return modelPick as QId;
  return open[0]!;
}

/** What a tap does to the picks: single replaces, multi toggles, "only" clears the rest, and the max holds. */
export function toggle(q: QId, picks: readonly string[], id: string): string[] {
  const def = QUESTIONS[q];
  const choice = def.choices.find((c) => c.id === id);
  if (!choice) return [...picks];
  if (!def.multi) return [id];
  if (picks.includes(id)) return picks.filter((p) => p !== id);
  if (choice.only) return [id];
  const kept = picks.filter((p) => !def.choices.find((c) => c.id === p)?.only);
  if (def.max && kept.length >= def.max) return kept;
  return [...kept, id];
}

/** Skip applies the question's default (§4.2's last column). */
export const skipped = (q: QId): Answer => ({ q, choices: [...QUESTIONS[q].skip], text: null, skipped: true });

/** Every question's answer as it will apply: what was picked or placed, else the default (also for one never reached). */
export function resolved(set: readonly QId[], answers: Readonly<Record<string, Answer>>): Partial<Record<QId, string[]>> {
  const out: Partial<Record<QId, string[]>> = {};
  for (const q of set) {
    const a = answers[q];
    // A skip (as kept on the Platform, with no choices) and a question never reached take the default.
    if (!a || (a.skipped && !a.choices.length)) out[q] = [...QUESTIONS[q].skip];
    else out[q] = a.choices.length || !a.text ? onlyKnown(q, a.choices) : [];
  }
  return out;
}

/** Only the question's own ids, in its order, the max and "only" rules kept. */
export function onlyKnown(q: QId, ids: readonly string[]): string[] {
  let picks: string[] = [];
  for (const c of QUESTIONS[q].choices) if (ids.includes(c.id)) picks = toggle(q, picks, c.id);
  return picks;
}

export type Fill = 'names' | 'todos' | 'email' | 'breath';

/**
 * The fill steps (§4.3), only while a desk is still building, in this order: name your desks (Officer and Founder, two desks or
 * more), your list (everyone), which email (Q2 or Q3 said email, and Courier is on), then a breath. `done` are the ones taken.
 */
export function fillSteps(who: Who, ownDesks: number, mentionsEmail: boolean, done: readonly Fill[]): Fill[] {
  const all: Fill[] = [];
  if (!who.teen && who.rename && ownDesks >= 2) all.push('names');
  all.push('todos');
  if (!who.teen && who.courier && mentionsEmail) all.push('email');
  all.push('breath');
  return all.filter((f) => !done.includes(f));
}

/** The cap (§4.1): 10 steps in all, counting follow-ups and fill steps. */
export const STEP_CAP = 10;
export const FOLLOW_UP_CAP = 2;

export function stepsTaken(answers: Readonly<Record<string, Answer>>, fills: readonly Fill[]): number {
  return Object.keys(answers).length + fills.length;
}

/** The soft count's dots: the core set plus the follow-ups asked, and where we are. */
export function dots(set: readonly QId[], answers: Readonly<Record<string, Answer>>, current: string | null): { total: number; at: number } {
  const asked = Object.keys(answers).filter((k) => k === 'f1' || k === 'f2').length;
  const total = set.length + asked + (current === 'f1' || current === 'f2' ? 1 : 0);
  const done = set.filter((q) => answers[q]).length + asked;
  return { total, at: Math.min(total - 1, done) };
}

/** D2 (§3.3): every desk is ready with 3 or more core questions left. */
export const offerWrapUp = (set: readonly QId[], answers: Readonly<Record<string, Answer>>, allReady: boolean): boolean => allReady && set.filter((q) => !answers[q]).length >= 3;

/** The acknowledgement: the model's when it's not the last one used, else the next in the fixed rotation. */
export function pickAck(model: string | null, last: string | null, allowed: readonly string[], n: number): string {
  if (model && allowed.includes(model) && model !== last) return model;
  const pool = allowed.filter((a) => a !== last);
  return pool[n % pool.length]!;
}

/** Caption reading time (§11): max(1.5 s, characters ÷ speed), 20 a second for adults and 17 for teens. */
export const readMs = (text: string, teen: boolean): number => Math.max(1500, Math.round((text.length / (teen ? 17 : 20)) * 1000));

/** Words fit 2 caption lines of 42 characters: the line breaks at a space nearest the middle when it's longer than one line. */
export function captionLines(text: string, width = 42): string[] {
  if (text.length <= width) return [text];
  const mid = Math.floor(text.length / 2);
  let at = -1;
  for (let d = 0; d <= mid; d++) {
    if (text[mid - d] === ' ') {
      at = mid - d;
      break;
    }
    if (text[mid + d] === ' ') {
      at = mid + d;
      break;
    }
  }
  return at < 0 ? [text] : [text.slice(0, at), text.slice(at + 1)];
}
