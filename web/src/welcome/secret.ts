// What the member typed, checked in the browser before it goes anywhere (CONCEPT.md §3.4 P6, §9): text that looks like a key,
// a token or a password is cleared here and never sent. The Platform checks again (contract maia.md "Welcome"). Also the
// scripted path's reading of free text onto a question's ids, by plain words, for when no model is there.
import type { QId } from './catalogue';

const PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic (sk-ant-…), OpenRouter (sk-or-…)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passcode|passwd|pwd|pin|api[ _-]?key|secret|token)\s*(?:is|=|:)\s*\S+/i,
  /\b(?:\d[ -]?){13,19}\b/, // a card number's shape
];

/** One long run with letters, digits and symbols mixed and no spaces: a password's shape, not a word. */
function looksRandom(word: string): boolean {
  if (word.length < 20) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(word)).length;
  return kinds >= 3 && !/^https?:\/\//i.test(word);
}

export function looksSecret(text: string): boolean {
  if (PATTERNS.some((p) => p.test(text))) return true;
  return text.split(/\s+/).some(looksRandom);
}

/**
 * A line the model wrote that asks about a secret or a sign-in (Security's WEL-5): never shown, whatever else it says. Checked
 * on every model line the office shows or applies: the echo, a follow-up and its choices, a custom helper's name and purpose.
 */
export function asksSecret(line: string): boolean {
  return /pass ?words?|passcode|passwd|\bpins?\b|api ?keys?|\btokens?\b|secrets?|log ?in|sign ?in|\bbank|card number|social security|\bssn\b|verification code|one-time code|2fa|credentials?/i.test(line);
}

/** The text as it may leave the browser: trimmed, one line, at most 500 characters; null when empty or key-like. */
export function cleanText(raw: string): { text: string | null; cleared: boolean } {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return { text: null, cleared: false };
  if (looksSecret(text)) return { text: null, cleared: true };
  return { text, cleared: false };
}

/** Plain words that mean a choice, for the scripted path (no model): the first match of each id. */
const WORDS: Partial<Record<QId, Record<string, RegExp>>> = {
  q1: { light: /\blight|bright|white\b/i, zen: /\bzen|calm|photo|picture|scene\b/i, dark: /\bdark|night|black\b/i },
  q2: {
    email: /\be-?mails?|inbox|messages?|slack|chat\b/i,
    meetings: /\bmeetings?|calls?|zoom|calendar\b/i,
    writing: /\bwrit(e|ing)|docs?|articles?|reports?|blog\b/i,
    research: /\bresearch|reading|look(ing)? (things )?up|stud(y|ies)\b/i,
    numbers: /\bnumbers?|spreadsheets?|excel|finance|accounting|budgets?|data\b/i,
    code: /\bcod(e|ing)|program(ming)?|develop(er|ment)|software\b/i,
  },
  q3: {
    sorting: /\be-?mails?|inbox|mail\b/i,
    research: /\bresearch|look(ing)? (things )?up\b/i,
    drafts: /\bdrafts?|writ(e|ing)\b/i,
    errands: /\berrands?|bookings?|book|travel|shopping\b/i,
    todos: /\bto-?dos?|tasks?|list|remind(ers?)?\b/i,
  },
  q5: { three: /\bthree times|morning,? (noon|midday|middle)/i, two: /\bmorning and (evening|night|end)|twice\b/i, often: /\bhour(ly|s)\b|often|regularly/i, ask: /\bwhen i ask|only if|never\b/i },
  q7: { line: /\bshort|brief|one line|tl;?dr\b/i, paragraph: /\bparagraph|some detail|medium\b/i, full: /\bfull|everything|detail(ed)?|all of it\b/i },
  q8: { notes: /\bnotes?|to-?dos?|file\b/i, drafts: /\bdrafts?|replies\b/i, ask: /\bnothing|ask (me )?first|always ask\b/i },
  t2: { school: /\bschool|homework|class\b/i, making: /\bmak(e|ing)|art|music|build\b/i, learning: /\blearn(ing)?|course\b/i, games: /\bgames?|fun|play\b/i },
};

export function placeLocally(q: QId, text: string): string[] {
  const words = WORDS[q];
  if (!words) return [];
  return Object.entries(words)
    .filter(([, re]) => re.test(text))
    .map(([id]) => id);
}
